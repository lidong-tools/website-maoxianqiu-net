-- ============================================================
-- MXQ-S31-PARALLEL-B: 日结与对账(员工 B / 并发任务 B)
--
-- Migration 41: 对账数据底座(表 + RLS + 权限码 + 角色授权)
-- 工作包: Reconciliation + Payment Channel Summary + Difference Confirmation
--
-- 设计要点:
--   * 第一版对账 = 系统账面金额(system_expected) vs 人工录入实际金额(actual_amount),
--     不接真实支付网关;
--   * system_expected 一律由服务端从日结快照 payment_method_breakdown 推导,
--     不信任客户端;
--   * 硬规则: tenant + store + business_date + channel 唯一;
--   * 状态机: pending(待确认,有差异) -> matched(无差异)/ confirmed(无差异已确认)/
--     difference_confirmed(有差异已确认);
--   * 差异确认必须有 difference_reason + actor + timestamp + request_id(审计);
--   * 写操作全部走 service-role-only RPC(migration 42),
--     本 migration 仅建表 + 只读 RLS + 权限码;
--   * 权限: reconciliation.read/edit/confirm;
--     system_admin/tenant_owner/store_manager 全量、cashier 只读、
--     doctor 不授予财务管理权限。
-- ============================================================

-- ============================================================
-- 1. reconciliation_records 对账记录(门店 + 业务日期 + 渠道唯一)
--    * channel: cash/card/wechat/alipay/stored_value/other
--    * system_expected:系统账面金额(来自日结快照,服务端推导)
--    * actual_amount:  人工核账后的实际金额(门店录入)
--    * difference:     actual - expected(0 表示无差异)
--    * status: pending/matched/confirmed/difference_confirmed
-- ============================================================
create table if not exists public.reconciliation_records (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  business_date date not null,
  closing_id uuid references public.daily_closings(id) on delete set null,
  channel text not null,
  system_expected numeric(12,2) not null default 0,
  actual_amount numeric(12,2) not null default 0,
  difference numeric(12,2) not null default 0,
  difference_reason text,
  status text not null default 'pending',
  confirmed_by uuid references public.employees(id) on delete set null,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references public.employees(id) on delete set null,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.employees(id) on delete set null,
  constraint reconciliation_records_channel_check
    check (channel in ('cash', 'card', 'wechat', 'alipay', 'stored_value', 'other')),
  constraint reconciliation_records_status_check
    check (status in ('pending', 'matched', 'confirmed', 'difference_confirmed')),
  constraint reconciliation_records_amounts_check
    check (system_expected >= 0 and actual_amount >= 0),
  constraint reconciliation_records_tenant_store_date_channel_unique
    unique (tenant_id, store_id, business_date, channel)
);

comment on table public.reconciliation_records is '支付渠道对账记录(tenant+store+business_date+channel 唯一)';

create index if not exists idx_reconciliation_records_closing
  on public.reconciliation_records (closing_id);
create index if not exists idx_reconciliation_records_tenant_store_date
  on public.reconciliation_records (tenant_id, store_id, business_date);
create index if not exists idx_reconciliation_records_status
  on public.reconciliation_records (tenant_id, status);

-- updated_at 触发器
drop trigger if exists trg_reconciliation_records_updated_at on public.reconciliation_records;
create trigger trg_reconciliation_records_updated_at
  before update on public.reconciliation_records
  for each row execute procedure public.touch_updated_at();

-- ============================================================
-- 2. RLS 策略(仅 SELECT,写操作走 service-role-only RPC)
--    读 = 租户成员 + 门店范围 + reconciliation.read
-- ============================================================
alter table public.reconciliation_records enable row level security;

drop policy if exists "reconciliation_records_select" on public.reconciliation_records;
create policy "reconciliation_records_select" on public.reconciliation_records
  for select to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and (store_id is null or public.can_access_store(tenant_id, store_id))
    and public.has_permission(tenant_id, store_id, 'reconciliation.read')
  );

-- ============================================================
-- 3. 新增权限码 + 系统角色授权
--
-- 默认授权矩阵(遵循任务文档第 8 节):
--   system_admin / tenant_owner / store_manager : reconciliation.read/edit/confirm(全量)
--   cashier  : reconciliation.read(只读)
--   doctor   : 不授予任何财务管理权限
-- ============================================================
insert into public.permissions (code, name, module) values
  ('reconciliation.read', '查看对账', 'closing'),
  ('reconciliation.edit', '录入对账实际金额', 'closing'),
  ('reconciliation.confirm', '确认对账差异', 'closing')
on conflict (code) do update set
  name = excluded.name,
  module = excluded.module;

-- system_admin + tenant_owner + store_manager:全量(读/录入/确认)
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code in ('system_admin', 'tenant_owner', 'store_manager')
  and p.code in ('reconciliation.read', 'reconciliation.edit', 'reconciliation.confirm')
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

-- cashier:只读
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'cashier'
  and p.code in ('reconciliation.read')
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

-- 同步 roles.permissions 数组(兼容旧代码读取)
update public.roles
set permissions = array(
  select distinct unnest(permissions || array[
    'reconciliation.read', 'reconciliation.edit', 'reconciliation.confirm'
  ])
)
where code in ('system_admin', 'tenant_owner', 'store_manager') and is_system = true;

update public.roles
set permissions = array(
  select distinct unnest(permissions || array[
    'reconciliation.read'
  ])
)
where code = 'cashier' and is_system = true;

-- ============================================================
-- 4. 表权限收紧
--     新表写入仅 service_role(通过 security definer RPC 执行);
--     新 RPC 的 revoke/grant 在 migration 42 统一处理(service-role-only manifest)
-- ============================================================
revoke all on table public.reconciliation_records from public;
