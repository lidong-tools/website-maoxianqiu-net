-- ============================================================
-- 20260806000013_iam_completion.sql
-- MXQ-3008 门店归档:archive/restore RPC + 归档状态校验
-- MXQ-3009 员工邀请补偿:invite_employee RPC(事务化建成员/员工/分配/角色)
-- MXQ-3010 员工和角色 UI:has_permission 升级为 union(role_permissions + roles.permissions)
-- 幂等,可重复应用
-- ============================================================

-- ===== 1. has_permission 升级:同时检查 role_permissions 关联表与 roles.permissions 数组 =====
-- 迁移期 union 兼容,后续阶段可下线 roles.permissions 数组
create or replace function public.has_permission(p_tenant_id uuid, p_store_id uuid, p_permission text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_system_admin()
    or exists (
      select 1
      from public.employee_role_assignments era
      join public.employees e on e.id = era.employee_id
      join public.roles r on r.id = era.role_id
      where e.user_id = auth.uid()
        and e.status = 'active'
        and era.tenant_id = p_tenant_id
        and (p_store_id is null or era.store_id = p_store_id or era.store_id is null)
        and (
          -- 新模型:role_permissions 关联表
          exists (
            select 1
            from public.role_permissions rp
            join public.permissions p on p.id = rp.permission_id
            where rp.role_id = r.id and p.code = p_permission
          )
          -- 旧模型兼容:roles.permissions 数组
          or (r.permissions is not null and p_permission = any(r.permissions))
        )
    );
$$;

-- ===== 2. 新增权限码 =====
insert into public.permissions (code, name, module) values
  ('store.archive', '归档门店', 'store'),
  ('store.restore', '恢复门店', 'store'),
  ('employee.invite', '邀请员工', 'employee'),
  ('employee.disable', '停用员工', 'employee'),
  ('employee.enable', '启用员工', 'employee'),
  ('role.permission.update', '编辑角色权限', 'role'),
  ('store.update', '编辑门店', 'store')
on conflict (code) do update set
  name = excluded.name,
  module = excluded.module;

-- ===== 3. 系统角色补充新权限码到 role_permissions 关联表(幂等) =====
-- 同时写入 roles.permissions 数组(seed.sql 已维护,此处补 role_permissions 关联)
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'system_admin'
  and p.code in (
    'system:user:manage', 'system:role:manage', 'system:store:manage',
    'system.user.create', 'system.user.resetPassword',
    'store:view', 'store.create', 'store.update', 'store.archive', 'store.restore',
    'tenant.membership.create', 'tenant.membership.update',
    'employee.create', 'employee.update', 'employee.invite', 'employee.disable', 'employee.enable',
    'employee.assignStore', 'employee.changeRole',
    'role.create', 'role.update', 'role.permission.update'
  )
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'store_manager'
  and p.code in (
    'system:user:manage', 'system.user.create',
    'store:view', 'store.update',
    'employee.create', 'employee.update', 'employee.invite', 'employee.disable', 'employee.enable',
    'employee.assignStore', 'employee.changeRole'
  )
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

-- 同步把新权限码追加到系统角色的 roles.permissions 数组(兼容旧代码读取)
update public.roles
set permissions = array(
  select distinct unnest(permissions || array[
    'store.archive', 'store.restore',
    'employee.invite', 'employee.disable', 'employee.enable',
    'role.permission.update', 'store.update'
  ])
)
where code in ('system_admin', 'store_manager') and is_system = true;

-- ===== 4. 门店归档/恢复 RPC(MXQ-3008) =====
-- 归档:设置 archived_at + archived_by;唯一索引 idx_stores_tenant_code 已过滤 archived_at is null,
-- 归档后 code 可被新门店复用。
-- MXQ-3007 跨租户防护:p_tenant_id 必须与门店归属租户一致,否则拒绝(服务端二次校验)
create or replace function public.archive_store(
  p_tenant_id uuid,
  p_store_id uuid,
  p_archived_by uuid
)
returns public.stores
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.stores;
begin
  select * into v_row from public.stores where id = p_store_id for update;
  if not found then
    raise exception 'STORE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_row.tenant_id <> p_tenant_id then
    raise exception 'STORE_TENANT_MISMATCH' using errcode = 'P0003';
  end if;
  if v_row.archived_at is not null then
    raise exception 'STORE_ALREADY_ARCHIVED' using errcode = 'P0003';
  end if;

  update public.stores
  set archived_at = now(), archived_by = p_archived_by, status = 'archived'
  where id = p_store_id
  returning * into v_row;

  return v_row;
end;
$$;

-- 恢复:清除 archived_at + archived_by;若同租户 code 已被占用则报冲突
-- MXQ-3007 跨租户防护:p_tenant_id 必须与门店归属租户一致,否则拒绝(服务端二次校验)
create or replace function public.restore_store(
  p_tenant_id uuid,
  p_store_id uuid,
  p_restored_by uuid
)
returns public.stores
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.stores;
  v_conflict_count integer;
begin
  select * into v_row from public.stores where id = p_store_id for update;
  if not found then
    raise exception 'STORE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_row.tenant_id <> p_tenant_id then
    raise exception 'STORE_TENANT_MISMATCH' using errcode = 'P0003';
  end if;
  if v_row.archived_at is null then
    raise exception 'STORE_NOT_ARCHIVED' using errcode = 'P0003';
  end if;

  -- 检查 code 是否已被同租户其他活跃门店占用
  select count(*) into v_conflict_count
  from public.stores
  where tenant_id = v_row.tenant_id
    and code = v_row.code
    and id <> p_store_id
    and archived_at is null;

  if v_conflict_count > 0 then
    raise exception 'STORE_CODE_CONFLICT' using errcode = 'P0003';
  end if;

  update public.stores
  set archived_at = null, archived_by = null, status = 'active'
  where id = p_store_id
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function public.archive_store(uuid, uuid, uuid) from public;
revoke all on function public.restore_store(uuid, uuid, uuid) from public;
grant execute on function public.archive_store(uuid, uuid, uuid) to authenticated;
grant execute on function public.restore_store(uuid, uuid, uuid) to authenticated;

-- ===== 5. 员工邀请 RPC(MXQ-3009) =====
-- 事务化建:tenant_membership + employee + store_assignment + role_assignment
-- 调用方须先建好 auth.users(在 Hono 层完成),此处只负责组织数据
-- 失败整体 rollback,不留孤立记录
create or replace function public.invite_employee(
  p_tenant_id uuid,
  p_user_id uuid,
  p_employee_no text,
  p_name text,
  p_phone text default null,
  p_email text default null,
  p_title text default null,
  p_store_id uuid default null,
  p_role_id uuid default null,
  p_is_primary boolean default false,
  p_invited_by uuid default null
)
returns public.employees
language plpgsql
security definer
set search_path = public
as $$
declare
  v_employee public.employees;
  v_membership_exists integer;
begin
  -- 1) 租户成员(幂等)
  select count(*) into v_membership_exists
  from public.tenant_memberships
  where tenant_id = p_tenant_id and user_id = p_user_id;

  if v_membership_exists = 0 then
    insert into public.tenant_memberships (tenant_id, user_id, status, invited_by)
    values (p_tenant_id, p_user_id, 'active', p_invited_by);
  else
    update public.tenant_memberships
    set status = 'active'
    where tenant_id = p_tenant_id and user_id = p_user_id;
  end if;

  -- 2) 员工档案(唯一约束 (tenant_id, employee_no) 冲突时报错)
  insert into public.employees (tenant_id, user_id, employee_no, name, phone, email, title, status)
  values (p_tenant_id, p_user_id, p_employee_no, p_name, p_phone, p_email, p_title, 'active')
  returning * into v_employee;

  -- 3) 门店分配(若指定 store_id)
  if p_store_id is not null then
    insert into public.employee_store_assignments (tenant_id, employee_id, store_id, is_primary)
    values (p_tenant_id, v_employee.id, p_store_id, p_is_primary)
    on conflict (employee_id, store_id) do nothing;
  end if;

  -- 4) 角色分配(若指定 role_id)
  if p_role_id is not null then
    insert into public.employee_role_assignments (tenant_id, employee_id, role_id, store_id)
    values (p_tenant_id, v_employee.id, p_role_id, p_store_id)
    on conflict do nothing;
  end if;

  return v_employee;
end;
$$;

revoke all on function public.invite_employee(uuid, uuid, text, text, text, text, text, uuid, uuid, boolean, uuid) from public;
grant execute on function public.invite_employee(uuid, uuid, text, text, text, text, text, uuid, uuid, boolean, uuid) to authenticated;

-- ===== 6. 员工启用/停用 RPC(MXQ-3010) =====
create or replace function public.set_employee_status(
  p_employee_id uuid,
  p_status text,
  p_operator_id uuid default null
)
returns public.employees
language plpgsql
security definer
set search_path = public
as $$
declare
  v_employee public.employees;
begin
  if p_status not in ('active', 'disabled', 'invited', 'resigned') then
    raise exception 'INVALID_EMPLOYEE_STATUS' using errcode = 'P0003';
  end if;

  update public.employees
  set status = p_status, updated_at = now()
  where id = p_employee_id
  returning * into v_employee;

  if not found then
    raise exception 'EMPLOYEE_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- 同步停用租户成员关系(停用员工时)
  if p_status = 'disabled' or p_status = 'resigned' then
    update public.tenant_memberships
    set status = 'suspended'
    where tenant_id = v_employee.tenant_id and user_id = v_employee.user_id;
  elsif p_status = 'active' then
    update public.tenant_memberships
    set status = 'active'
    where tenant_id = v_employee.tenant_id and user_id = v_employee.user_id;
  end if;

  return v_employee;
end;
$$;

revoke all on function public.set_employee_status(uuid, text, uuid) from public;
grant execute on function public.set_employee_status(uuid, text, uuid) to authenticated;

-- ===== 7. 角色权限批量替换 RPC(MXQ-3010) =====
-- 事务化替换 role_permissions 关联表 + 同步 roles.permissions 数组
create or replace function public.replace_role_permissions(
  p_role_id uuid,
  p_permission_codes text[]
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- 删除旧关联
  delete from public.role_permissions where role_id = p_role_id;

  -- 写入新关联(只写入存在的权限码)
  insert into public.role_permissions (role_id, permission_id)
  select p_role_id, p.id
  from public.permissions p
  where p.code = any(p_permission_codes)
  on conflict do nothing;

  -- 同步 roles.permissions 数组(兼容旧代码读取)
  update public.roles
  set permissions = p_permission_codes
  where id = p_role_id;
end;
$$;

revoke all on function public.replace_role_permissions(uuid, text[]) from public;
grant execute on function public.replace_role_permissions(uuid, text[]) to authenticated;

-- ===== 8. stores 状态 check 约束(归档状态) =====
-- 允许:active / disabled / archived / trial
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'stores_status_check'
  ) then
    alter table public.stores add constraint stores_status_check
      check (status in ('active', 'disabled', 'archived', 'trial'));
  end if;
exception when duplicate_object then
  null;
end;
$$;
