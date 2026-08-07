-- ============================================================
-- 20260807000026_scoped_permission_hardening.sql
-- S3.0 定向复审 S30-R01 / R02 / R03 / R04(数据库侧)
--
-- S30-R01 重建 has_permission():严格区分角色 scope
--   - tenant 上下文(p_store_id IS NULL):仅接受 tenant/system scope 的 tenant-wide 分配
--   - store 上下文(p_store_id 给定):接受 目标门店的 store 分配 或 tenant/system scope 的 tenant-wide 分配
--   - 杜绝 store role → tenant 权限提升
--
-- S30-R02 非法 role assignment 约束
--   - role.scope = store  → store_id 必须非空
--   - role.scope = system/tenant → store_id 必须为空
--   - 租户自定义角色(role.tenant_id 非空)必须与分配 tenant 一致
--   - 存量非法数据幂等修复
--
-- S30-R03 高危 Command RPC 权限收紧
--   - revoke public / anon / authenticated
--   - grant service_role(仅 Hono 服务端可调用,不得依赖 SECURITY DEFINER+RLS 作为权限边界)
--
-- S30-R04 员工档案 id / 登录用户 id 语义固化(COMMENT ON COLUMN)
-- ============================================================

-- ============================================================
-- 1. 重建 has_permission()(v3:scope 感知)
-- ============================================================
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
        and (
          -- tenant 上下文:仅 tenant/system scope 的 tenant-wide 分配(禁止 store role 越权)
          (p_store_id is null and era.store_id is null and r.scope in ('system', 'tenant'))
          -- store 上下文:目标门店的 store 分配(role.scope = store)
          --            或 tenant/system scope 的 tenant-wide 分配(store_id IS NULL)
          or (p_store_id is not null and (
                (era.store_id = p_store_id and r.scope = 'store')
                or (era.store_id is null and r.scope in ('system', 'tenant'))
              ))
        )
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

-- ============================================================
-- 2. 系统角色 scope 归一(S30-R01/R02)
--    门店级角色显式标记为 scope='store';平台角色标记为 scope='system'
--    必须在触发器创建前执行,保证存量数据库(seed 未重跑)语义一致
-- ============================================================
update public.roles
set scope = 'system'
where code = 'system_admin' and is_system = true;

update public.roles
set scope = 'store'
where code in ('store_manager', 'staff', 'cashier', 'doctor')
  and is_system = true;

-- ============================================================
-- 3. 非法 role assignment 约束(role.scope ↔ assignment.store_id)
-- ============================================================
create or replace function public.validate_era_scope()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_scope text;
  v_role_tenant_id uuid;
begin
  select scope, tenant_id into v_scope, v_role_tenant_id
  from public.roles
  where id = new.role_id;

  if v_scope is null then
    raise exception 'ROLE_NOT_FOUND' using errcode = 'P0002',
      detail = format('role %s 不存在', new.role_id);
  end if;

  -- 角色 scope 与分配 scope 一致性(S30-R02)
  if v_scope = 'store' and new.store_id is null then
    raise exception 'STORE_ROLE_REQUIRES_STORE' using errcode = 'P0003',
      detail = format('role %s scope=store 必须分配 store_id', new.role_id);
  end if;
  if v_scope in ('system', 'tenant') and new.store_id is not null then
    raise exception 'TENANT_ROLE_FORBIDS_STORE' using errcode = 'P0003',
      detail = format('role %s scope=%s 不允许分配门店', new.role_id, v_scope);
  end if;

  -- 租户自定义角色必须与分配租户一致(S30-R02 纵深防御)
  if v_role_tenant_id is not null and v_role_tenant_id <> new.tenant_id then
    raise exception 'ROLE_TENANT_MISMATCH' using errcode = 'P0003',
      detail = format('role %s 归属租户 %s 与分配租户 %s 不一致',
        new.role_id, v_role_tenant_id, new.tenant_id);
  end if;

  return new;
end;
$$;

drop trigger if exists trg_era_scope on public.employee_role_assignments;
create trigger trg_era_scope
  before insert or update on public.employee_role_assignments
  for each row execute function public.validate_era_scope();

-- ============================================================
-- 4. 存量非法数据幂等修复
--    system/tenant scope 角色的门店级分配:优先归并为 tenant-wide
-- ============================================================
-- 4a) 同一员工已存在该角色的 tenant-wide 分配时,删除门店级重复
delete from public.employee_role_assignments era
using public.roles r,
     public.employee_role_assignments tw
where era.role_id = r.id
  and r.scope in ('system', 'tenant')
  and era.store_id is not null
  and tw.employee_id = era.employee_id
  and tw.tenant_id = era.tenant_id
  and tw.role_id = era.role_id
  and tw.store_id is null;

-- 4b) 无 tenant-wide 重复时,将门店级分配归并为 tenant-wide(保留角色)
update public.employee_role_assignments era
set store_id = null
from public.roles r
where era.role_id = r.id
  and r.scope in ('system', 'tenant')
  and era.store_id is not null;

-- ============================================================
-- 5. 员工档案 id / 登录用户 id 语义固化(S30-R04)
--    约定:XX_id = employees.id(员工档案);XX_user = auth.users.id(登录用户)
-- ============================================================
comment on column public.encounters.doctor_id is '主治医生 = auth.users.id(登录用户),非 employees.id';
comment on column public.encounters.signed_by is '签署人 = auth.users.id(登录用户),非 employees.id';
comment on column public.encounters.nurse_id is '护士 = auth.users.id(登录用户),非 employees.id';
comment on column public.appointments.doctor_id is '预约医生 = auth.users.id(登录用户),非 employees.id';
comment on column public.nurse_tasks.assigned_to is '任务指派对象 = auth.users.id(登录用户),非 employees.id';
comment on column public.admissions.doctor_id is '住院主治医生 = employees.id(员工档案),非 auth.users.id';
comment on column public.shift_handovers.outgoing_user is '交班人 = auth.users.id(登录用户),非 employees.id';
comment on column public.shift_handovers.incoming_user is '接班人 = auth.users.id(登录用户),非 employees.id';
comment on column public.shift_handovers.acknowledged_by is '确认人 = auth.users.id(登录用户),非 employees.id';
comment on column public.prescriptions.doctor_id is '处方医生 = auth.users.id(登录用户),非 employees.id';

-- ============================================================
-- 6. 高危 Command RPC 权限收紧(S30-R03)
--    仅 Hono 服务端(service_role)可执行;禁止浏览器(anon/authenticated)直连
--    不得依赖 SECURITY DEFINER + RLS 作为权限边界
-- ============================================================
do $$
declare
  v_fn text;
  v_sig text;
begin
  foreach v_fn in array array[
    -- billing
    'create_invoice', 'confirm_invoice', 'cancel_invoice', 'approve_discount',
    'process_payment', 'process_refund', 'generate_receipt',
    -- inventory
    'post_goods_receipt', 'dispense_inventory', 'post_stock_count', 'transfer_inventory',
    'reserve_inventory', 'confirm_inventory_reservation',
    'release_inventory_reservation', 'release_expired_reservations',
    -- clinical
    'transition_appointment', 'sign_encounter', 'revise_encounter',
    'save_prescription', 'dispense_prescription',
    -- inpatient
    'admit_patient', 'transfer_cage', 'discharge_patient',
    'create_handover', 'generate_daily_charges',
    -- diagnostics
    'publish_lab_results', 'review_lab_results',
    'issue_vaccine_certificate', 'scan_diag_reminders',
    -- crm
    'create_customer', 'update_customer', 'archive_customer',
    'create_pet', 'update_pet', 'archive_pet',
    -- operations
    'adjust_points', 'scan_reminders', 'send_delivery',
    'create_import_task', 'create_print_job', 'generate_report_snapshot'
  ]
  loop
    for v_sig in
      select p.oid::regprocedure::text
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname = v_fn
        and p.prokind = 'f'
    loop
      execute format('revoke all on function %s from public', v_sig);
      execute format('revoke all on function %s from anon', v_sig);
      execute format('revoke all on function %s from authenticated', v_sig);
      execute format('grant execute on function %s to service_role', v_sig);
    end loop;
  end loop;
end;
$$;
