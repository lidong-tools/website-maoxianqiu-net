-- ============================================================
-- MXQ-S31-PARALLEL-B: 日结与对账(员工 B / 并发任务 B)
--
-- Migration 39: 日结数据底座(表 + RLS + 权限码 + 角色授权)
-- 工作包: Daily Closing + Closing Snapshot + Closing Adjustment
--
-- 设计要点:
--   * 硬规则: tenant + store + business_date 只能存在一个正式日结,
--     unique(tenant_id, store_id, business_date) 约束兜底;
--   * 金额一律 numeric(12,2),数据库为账务真值,禁止 JS float 参与最终计算;
--   * 状态机: open -> calculating -> closed -> adjusted(调整后保持 adjusted);
--   * snapshot 一旦关闭即固化:关闭后历史读取快照,不重新实时计算覆盖历史;
--   * 写操作全部走 service-role-only RPC(migration 40),
--     本 migration 仅建表 + 只读 RLS + 权限码;
--   * 权限: daily_closing.read/close/adjust;
--     system_admin/tenant_owner 全量、store_manager 读+关账、
--     cashier 只读、doctor 不授予财务管理权限。
-- ============================================================

-- ============================================================
-- 1. daily_closings 每日日结主表
--    * status: open(待结算)/calculating(结算中)/closed(已关闭)/adjusted(已调整)
--    * 金额列: 应收(gross)/实收(paid)/退款(refund)/应收余额(receivable)
--    * 渠道拆分: cash/card/wechat/alipay/stored_value/other(stored_value 为储值卡预留)
--    * snapshot:关闭时固化的完整账务快照(含支付方式拆分/发票状态拆分),历史读取只读它
-- ============================================================
create table if not exists public.daily_closings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  business_date date not null,
  status text not null default 'open',
  gross_amount numeric(12,2) not null default 0,
  paid_amount numeric(12,2) not null default 0,
  refund_amount numeric(12,2) not null default 0,
  receivable_amount numeric(12,2) not null default 0,
  cash_amount numeric(12,2) not null default 0,
  card_amount numeric(12,2) not null default 0,
  wechat_amount numeric(12,2) not null default 0,
  alipay_amount numeric(12,2) not null default 0,
  stored_value_amount numeric(12,2) not null default 0,
  other_amount numeric(12,2) not null default 0,
  invoice_count integer not null default 0,
  snapshot jsonb not null default '{}'::jsonb,
  adjustment_summary jsonb not null default '{"count": 0, "total": 0, "items": []}'::jsonb,
  closed_at timestamptz,
  closed_by uuid references public.employees(id) on delete set null,
  adjusted_at timestamptz,
  adjusted_by uuid references public.employees(id) on delete set null,
  created_at timestamptz not null default now(),
  created_by uuid references public.employees(id) on delete set null,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.employees(id) on delete set null,
  constraint daily_closings_status_check
    check (status in ('open', 'calculating', 'closed', 'adjusted')),
  constraint daily_closings_amounts_check
    check (gross_amount >= 0 and paid_amount >= 0 and refund_amount >= 0 and receivable_amount >= 0),
  constraint daily_closings_tenant_store_date_unique
    unique (tenant_id, store_id, business_date)
);

comment on table public.daily_closings is '每日日结主表(tenant+store+business_date 唯一,关闭后读快照)';

create index if not exists idx_daily_closings_tenant_store_date
  on public.daily_closings (tenant_id, store_id, business_date desc);
create index if not exists idx_daily_closings_tenant_status
  on public.daily_closings (tenant_id, status);

-- ============================================================
-- 2. closing_adjustments 日结调整流水(追加式,不可覆盖)
--    * adjustment_type: cash_over(现金多款)/cash_short(现金短款)/
--      manual_correction(人工更正)/other(其他)
--    * amount 不可为 0;reason 必填(审计要求差异确认必须有原因)
-- ============================================================
create table if not exists public.closing_adjustments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  business_date date not null,
  closing_id uuid not null references public.daily_closings(id) on delete cascade,
  adjustment_type text not null,
  amount numeric(12,2) not null,
  reason text not null,
  operator_employee_id uuid references public.employees(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint closing_adjustments_type_check
    check (adjustment_type in ('cash_over', 'cash_short', 'manual_correction', 'other')),
  constraint closing_adjustments_amount_check
    check (amount <> 0),
  constraint closing_adjustments_reason_check
    check (length(btrim(reason)) > 0)
);

comment on table public.closing_adjustments is '日结调整流水(追加式,调整必须带原因并审计)';

create index if not exists idx_closing_adjustments_closing
  on public.closing_adjustments (closing_id, created_at desc);
create index if not exists idx_closing_adjustments_tenant_store
  on public.closing_adjustments (tenant_id, store_id, business_date);

-- updated_at 触发器
drop trigger if exists trg_daily_closings_updated_at on public.daily_closings;
create trigger trg_daily_closings_updated_at
  before update on public.daily_closings
  for each row execute procedure public.touch_updated_at();

-- ============================================================
-- 3. RLS 策略(仅 SELECT,写操作走 service-role-only RPC)
--    读 = 租户成员 + 门店范围 + daily_closing.read
-- ============================================================
alter table public.daily_closings enable row level security;
alter table public.closing_adjustments enable row level security;

drop policy if exists "daily_closings_select" on public.daily_closings;
create policy "daily_closings_select" on public.daily_closings
  for select to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and (store_id is null or public.can_access_store(tenant_id, store_id))
    and public.has_permission(tenant_id, store_id, 'daily_closing.read')
  );

-- 调整流水无独立权限码,跟随所属日结的读权限(RLS 子查询收敛)
drop policy if exists "closing_adjustments_select" on public.closing_adjustments;
create policy "closing_adjustments_select" on public.closing_adjustments
  for select to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and (store_id is null or public.can_access_store(tenant_id, store_id))
    and public.has_permission(tenant_id, store_id, 'daily_closing.read')
  );

-- ============================================================
-- 4. 新增权限码 + 系统角色授权
--
-- 默认授权矩阵(遵循任务文档第 8 节):
--   system_admin / tenant_owner : daily_closing.read/close/adjust(全量)
--   store_manager              : daily_closing.read/close(调整更敏感,不授予)
--   cashier                    : daily_closing.read(只读)
--   doctor                     : 不授予任何财务管理权限
-- ============================================================
insert into public.permissions (code, name, module) values
  ('daily_closing.read', '查看日结', 'closing'),
  ('daily_closing.close', '执行日结', 'closing'),
  ('daily_closing.adjust', '调整日结', 'closing')
on conflict (code) do update set
  name = excluded.name,
  module = excluded.module;

-- system_admin + tenant_owner:全量(读/关账/调整)
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code in ('system_admin', 'tenant_owner')
  and p.code in ('daily_closing.read', 'daily_closing.close', 'daily_closing.adjust')
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

-- store_manager:读 + 关账(不授调整)
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'store_manager'
  and p.code in ('daily_closing.read', 'daily_closing.close')
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

-- cashier:只读
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'cashier'
  and p.code in ('daily_closing.read')
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

-- 同步 roles.permissions 数组(兼容旧代码读取)
update public.roles
set permissions = array(
  select distinct unnest(permissions || array[
    'daily_closing.read', 'daily_closing.close', 'daily_closing.adjust'
  ])
)
where code in ('system_admin', 'tenant_owner') and is_system = true;

update public.roles
set permissions = array(
  select distinct unnest(permissions || array[
    'daily_closing.read', 'daily_closing.close'
  ])
)
where code = 'store_manager' and is_system = true;

update public.roles
set permissions = array(
  select distinct unnest(permissions || array[
    'daily_closing.read'
  ])
)
where code = 'cashier' and is_system = true;

-- ============================================================
-- 5. 表权限收紧
--     新表写入仅 service_role(通过 security definer RPC 执行);
--     新 RPC 的 revoke/grant 在 migration 40 统一处理(service-role-only manifest)
-- ============================================================
revoke all on table public.daily_closings from public;
revoke all on table public.closing_adjustments from public;
