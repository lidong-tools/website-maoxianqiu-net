-- ============================================================
-- 20260810000095_trial_tenant_status_harmonization.sql
-- Agent-07 二轮收口(P0-03):Trial / Tenant Status 统一(数据库侧)
--
-- 背景:tenants.status 支持 active / trial / suspended,但三层行为不一致:
--   - resolveScopedAccess(Hono)只拦 suspended,trial 放行;
--   - Agent-01 migration 54 Helper 要求 status='active',trial 被 RLS 拦;
--   - /api/user/context 过滤 status='active',trial 不进上下文;
--   - resume_tenant 把 trial 也"恢复"成 active,状态语义错乱。
--
-- 统一业务可用模型(与 migration 93 is_tenant_business_active 一致):
--   active                        → 正常业务
--   trial 且 trial_ends_at 未过期  → 正常业务
--   trial 已过期                   → 受限/拦截
--   suspended                     → 禁止业务 Command
--
-- 本迁移只修 DB 侧状态转换:resume 仅允许 suspended→active。
-- Hono/Context 侧由 Fix Agent 同步(migration 93 helper + permission.ts + me-context.ts)。
-- ============================================================

-- ===== 1. resume_tenant 仅允许 suspended → active =====
-- 禁止 trial → active 的非法状态转换
create or replace function public.resume_tenant(
  p_tenant_id uuid,
  p_operator_id uuid,
  p_reason text
)
returns public.tenants
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant public.tenants%rowtype;
begin
  select * into v_tenant
  from public.tenants
  where id = p_tenant_id
  for update;
  if not found then
    raise exception 'TENANT_NOT_FOUND';
  end if;
  if v_tenant.status <> 'suspended' then
    raise exception 'TENANT_NOT_SUSPENDED';
  end if;
  update public.tenants
  set status = 'active', updated_at = now()
  where id = p_tenant_id;
  select * into v_tenant from public.tenants where id = p_tenant_id;
  return v_tenant;
end;
$$;

-- ===== 2. suspend_tenant 语义不变(active/trial 均可停用),保留原实现 =====
-- (仅复述,确保本迁移自包含可重复应用)
create or replace function public.suspend_tenant(
  p_tenant_id uuid,
  p_operator_id uuid,
  p_reason text
)
returns public.tenants
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant public.tenants%rowtype;
begin
  select * into v_tenant
  from public.tenants
  where id = p_tenant_id
  for update;
  if not found then
    raise exception 'TENANT_NOT_FOUND';
  end if;
  if v_tenant.status = 'suspended' then
    raise exception 'TENANT_ALREADY_SUSPENDED';
  end if;
  update public.tenants
  set status = 'suspended', updated_at = now()
  where id = p_tenant_id;
  select * into v_tenant from public.tenants where id = p_tenant_id;
  return v_tenant;
end;
$$;

-- ===== 3. service-role-only 授权(自包含,幂等) =====
do $$
declare
  v_fn text;
  v_sig text;
begin
  foreach v_fn in array array['resume_tenant', 'suspend_tenant']
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
