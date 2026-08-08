-- ============================================================
-- 20260810000056_membership_discount_rules.sql
-- Agent-02 会员中心产品化:会员折扣规则
--   - 新增 membership_discount_rules 表
--   - 折扣匹配优先级:
--       具体 Catalog Item > Catalog Type > Tier Default
--       同维度下 Store 规则 > Tenant 全门店规则
--   - 新增 points.view 权限码(查看积分流水,读操作独立于 points.adjust)
--   - RLS:租户成员可读;membership.manage 可写
-- 应用方式:Supabase SQL Editor 按编号顺序执行(幂等)
-- ============================================================

-- ===== 1. membership_discount_rules 表 =====
create table if not exists public.membership_discount_rules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  tier_id uuid not null references public.membership_tiers(id) on delete cascade,
  store_id uuid references public.stores(id) on delete cascade,     -- null = 全门店(tenant 级)
  catalog_item_id uuid,                                             -- null = 不限定具体项目
  catalog_type text,                                                -- null = 不限定类型;否则匹配 billing_type(service/product/drug/vaccine/exam)
  discount_percent numeric(5,2) not null,                           -- 0-100,100 = 不打折(与 membership_tiers.discount_percent 语义一致)
  priority integer not null default 100,                            -- 数字越小优先级越高(同维度命中多条时)
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- 具体项目与类型互斥:同一规则只能定向一个维度
  constraint membership_discount_rules_target_check check (
    not (catalog_item_id is not null and catalog_type is not null)
  ),
  constraint membership_discount_rules_discount_check check (
    discount_percent >= 0 and discount_percent <= 100
  )
);

drop trigger if exists trg_membership_discount_rules_updated_at on public.membership_discount_rules;
create trigger trg_membership_discount_rules_updated_at
  before update on public.membership_discount_rules
  for each row execute procedure public.touch_updated_at();

create index if not exists idx_membership_discount_rules_tier
  on public.membership_discount_rules (tenant_id, tier_id, is_active, priority);
create index if not exists idx_membership_discount_rules_item
  on public.membership_discount_rules (tenant_id, catalog_item_id) where catalog_item_id is not null;
create index if not exists idx_membership_discount_rules_type
  on public.membership_discount_rules (tenant_id, catalog_type) where catalog_type is not null;

alter table public.membership_discount_rules enable row level security;

drop policy if exists "membership_discount_rules_select" on public.membership_discount_rules;
create policy "membership_discount_rules_select" on public.membership_discount_rules
  for select to authenticated
  using (public.is_tenant_member(tenant_id));

drop policy if exists "membership_discount_rules_insert" on public.membership_discount_rules;
create policy "membership_discount_rules_insert" on public.membership_discount_rules
  for insert to authenticated
  with check (public.is_tenant_member(tenant_id) and public.has_permission(tenant_id, null, 'membership.manage'));

drop policy if exists "membership_discount_rules_update" on public.membership_discount_rules;
create policy "membership_discount_rules_update" on public.membership_discount_rules
  for update to authenticated
  using (public.is_tenant_member(tenant_id) and public.has_permission(tenant_id, null, 'membership.manage'))
  with check (public.is_tenant_member(tenant_id) and public.has_permission(tenant_id, null, 'membership.manage'));

drop policy if exists "membership_discount_rules_delete" on public.membership_discount_rules;
create policy "membership_discount_rules_delete" on public.membership_discount_rules
  for delete to authenticated
  using (public.is_tenant_member(tenant_id) and public.has_permission(tenant_id, null, 'membership.manage'));

-- ===== 2. points.view 权限码 =====
insert into public.permissions (code, name, module) values
  ('points.view', '查看积分流水', 'points')
on conflict (code) do update set
  name = excluded.name,
  module = excluded.module;

-- 授权:system_admin / tenant_owner / store_manager(与 membership.manage 同一组角色)
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code in ('system_admin', 'tenant_owner', 'store_manager')
  and p.code = 'points.view'
  and not exists (
    select 1 from public.role_permissions rp
    where rp.role_id = r.id and rp.permission_id = p.id
  );

-- 旧模型兼容:roles.permissions 数组追加(幂等去重)
update public.roles
set permissions = array(
  select distinct unnest(permissions || array['points.view'])
)
where code in ('system_admin', 'tenant_owner', 'store_manager') and is_system = true;
