-- ============================================================
-- 20260808000027_platform_admin_model.sql
-- S3.0 定向复审 S30-F01 / F02(数据库侧)
--
-- S30-F01 平台管理员独立模型
--   - 新增 platform_user_roles 平台授权表(platform_admin / platform_support / platform_auditor)
--   - is_system_admin() 只读取平台授权来源,不再从 employee_role_assignments / store_members 推导
--   - employee_role_assignments 禁止 scope='system' 角色(SYSTEM_ROLE_FORBIDDEN_ERA)
--   - legacy store_members / employee_role_assignments 中的 system_admin 不自动升级为平台管理员(仅清理分配)
--
-- S30-F02 RPC 默认拒绝(service-role-only)
--   - 补齐 11 个遗漏 Hono Command RPC revoke(与 api/lib/service-rpc-manifest.ts 对齐)
--   - 审计 generate_customer_no / generate_invoice_no / update_import_job:撤销 authenticated 授权,仅 service_role
--   - 原则:所有 Hono Command RPC revoke public/anon/authenticated + grant service_role;
--     不得依赖 SECURITY DEFINER + RLS 作为权限边界
-- ============================================================

-- ============================================================
-- 1. 平台授权表 platform_user_roles(S30-F01)
--    仅 service_role 可管理;普通 authenticated 无任何 RLS policy → 默认拒绝
-- ============================================================
create table if not exists public.platform_user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('platform_admin', 'platform_support', 'platform_auditor')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, role)
);

comment on table public.platform_user_roles is '平台级授权(独立于租户/门店角色体系)。仅 service_role 可管理;普通租户成员不可读写。';
comment on column public.platform_user_roles.role is '平台角色:platform_admin(超管) / platform_support(支持) / platform_auditor(审计)';
comment on column public.platform_user_roles.user_id is '登录用户 = auth.users.id';

alter table public.platform_user_roles enable row level security;

-- 平台授权变更审计触发器:任何增删改都写入 audit_logs(操作人由 current_setting 提供,service_role 场景可空)
create or replace function public.log_platform_role_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_operator uuid;
  v_sub text;
begin
  v_operator := auth.uid();
  if v_operator is null then
    -- service_role 场景:auth.uid() 为 null,尝试从 JWT claims 提取 sub(auth.users.id)
    begin
      v_sub := nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub';
      v_operator := nullif(v_sub, '')::uuid;
    exception when others then
      v_operator := null;
    end;
  end if;

  if tg_op = 'INSERT' then
    insert into public.audit_logs (tenant_id, user_id, action, entity_type, entity_id, metadata)
    values (null, coalesce(v_operator, new.user_id), 'platform_role.grant', 'platform_user_role', new.id,
            jsonb_build_object('user_id', new.user_id, 'role', new.role));
    return new;
  elsif tg_op = 'UPDATE' then
    insert into public.audit_logs (tenant_id, user_id, action, entity_type, entity_id, metadata)
    values (null, coalesce(v_operator, new.user_id), 'platform_role.update', 'platform_user_role', new.id,
            jsonb_build_object('user_id', new.user_id, 'role', new.role));
    return new;
  else
    insert into public.audit_logs (tenant_id, user_id, action, entity_type, entity_id, metadata)
    values (null, coalesce(v_operator, old.user_id), 'platform_role.revoke', 'platform_user_role', old.id,
            jsonb_build_object('user_id', old.user_id, 'role', old.role));
    return old;
  end if;
end;
$$;

drop trigger if exists trg_platform_role_audit on public.platform_user_roles;
create trigger trg_platform_role_audit
  after insert or update or delete on public.platform_user_roles
  for each row execute function public.log_platform_role_change();

-- ============================================================
-- 2. is_system_admin() 只读取平台授权来源(S30-F01)
--    不再通过 employee_role_assignments / store_members 推导平台管理员
-- ============================================================
create or replace function public.is_system_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.platform_user_roles pur
    where pur.user_id = auth.uid()
      and pur.role = 'platform_admin'
  );
$$;

-- 调用者是否为指定平台角色(供 RLS/RPC 使用同一平台授权来源)
create or replace function public.is_platform_role(p_role text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.platform_user_roles pur
    where pur.user_id = auth.uid()
      and pur.role = p_role
  );
$$;

revoke all on function public.is_system_admin() from public;
revoke all on function public.is_platform_role(text) from public;
grant execute on function public.is_system_admin() to authenticated;
grant execute on function public.is_platform_role(text) to authenticated;

-- ============================================================
-- 3. employee_role_assignments 禁止 scope='system' 角色(S30-F01)
--    平台角色只能通过 platform_user_roles 授予,租户员工分配一律拒绝
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

  -- S30-F01:scope='system' 的角色(如 system_admin)是平台级授权,禁止通过员工分配授予(SYSTEM_ROLE_FORBIDDEN_ERA)
  if v_scope = 'system' then
    raise exception 'SYSTEM_ROLE_FORBIDDEN_ERA' using errcode = 'P0003',
      detail = format('role %s scope=system 不允许通过 employee_role_assignments 分配,请使用 platform_user_roles', new.role_id);
  end if;

  -- 角色 scope 与分配 scope 一致性(S30-R02)
  if v_scope = 'store' and new.store_id is null then
    raise exception 'STORE_ROLE_REQUIRES_STORE' using errcode = 'P0003',
      detail = format('role %s scope=store 必须分配 store_id', new.role_id);
  end if;
  if v_scope = 'tenant' and new.store_id is not null then
    raise exception 'TENANT_ROLE_FORBIDS_STORE' using errcode = 'P0003',
      detail = format('role %s scope=tenant 不允许分配门店', new.role_id);
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
-- 4. 存量清理(S30-F01)
--    legacy employee_role_assignments / store_members 中的 system_admin
--    不自动升级为平台管理员:仅删除 scope='system' 的员工分配,
--    平台管理员由运维通过 platform_user_roles 显式授予
-- ============================================================
delete from public.employee_role_assignments era
using public.roles r
where era.role_id = r.id
  and r.scope = 'system';

-- ============================================================
-- 5. RPC 权限收紧(S30-F02)
--    全部 Hono Command RPC(manifest:api/lib/service-rpc-manifest.ts)revoke public/anon/authenticated
--    + grant service_role;含审计结论:generate_customer_no / generate_invoice_no / update_import_job
--    前端无直连调用,撤销 authenticated,仅保留 service_role
-- ============================================================
do $$
declare
  v_fn text;
  v_sig text;
begin
  foreach v_fn in array array[
    -- billing
    'create_invoice', 'confirm_invoice', 'cancel_invoice', 'approve_discount',
    'process_payment', 'process_refund', 'generate_receipt', 'release_inventory_reservation',
    -- clinical
    'transition_appointment', 'sign_encounter', 'revise_encounter',
    'save_prescription', 'dispense_prescription', 'confirm_inventory_reservation', 'dispense_inventory',
    -- crm
    'create_customer', 'update_customer', 'archive_customer', 'merge_customers', 'create_import_job',
    -- catalog
    'migrate_catalog_to_store',
    -- iam(员工/角色/门店)
    'invite_employee', 'set_employee_status', 'replace_role_permissions',
    'archive_store', 'restore_store',
    -- diagnostics
    'publish_lab_results', 'review_lab_results',
    'issue_vaccine_certificate', 'scan_diag_reminders',
    -- files
    'create_upload_intent', 'complete_upload', 'archive_file',
    -- inpatient
    'admit_patient', 'transfer_cage', 'discharge_patient',
    'create_handover', 'generate_daily_charges',
    -- inventory
    'post_goods_receipt', 'post_stock_count', 'transfer_inventory',
    'reserve_inventory', 'release_expired_reservations',
    -- operations
    'adjust_points', 'scan_reminders', 'send_delivery',
    'create_import_task', 'create_print_job', 'generate_report_snapshot',
    -- pets
    'create_pet', 'update_pet', 'archive_pet',
    -- 审计结论:仅服务端/内部辅助,撤销 authenticated(S30-F02)
    'generate_customer_no', 'generate_invoice_no', 'update_import_job'
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
