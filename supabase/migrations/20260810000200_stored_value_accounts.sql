-- ============================================================
-- 20260810000200_stored_value_accounts.sql
-- Agent-03 Stage-04: 储值账户基础表 + 权限(Wallet / Stored Value)
--
-- 设计要点:
--   * stored_value_accounts 为储值余额真源(Account = 可快速读取快照,
--     Ledger = 审计真相,见 migration 201);
--   * customers.balance 是 CRM 历史兼容字段,不是 Wallet 真源,本表不与其双写;
--   * 账户为租户级(tenant_id + customer_id + currency 唯一),不绑定门店;
--   * 余额只允许通过 service-role-only RPC 变更(migration 202),
--     因此对 anon/authenticated/service_role 均 revoke INSERT/UPDATE/DELETE,
--     表级 RLS 仅开放 SELECT(租户成员),防止浏览器/服务端绕过 RPC 直改余额;
--   * 权限码细粒度拆分:wallet.view / wallet.recharge / wallet.adjust / wallet.freeze,
--     普通 cashier 不授予 wallet.adjust(人工调账仅限管理角色)。
-- ============================================================

-- ===== 1. stored_value_accounts 储值账户 =====
create table if not exists public.stored_value_accounts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  customer_id uuid not null,                              -- 跨模块不加 FK,RPC 内校验同租户
  currency text not null default 'CNY',
  balance numeric(14,2) not null default 0,
  status text not null default 'active',                  -- active / frozen / closed
  version bigint not null default 0,                      -- 乐观锁版本(CAS 预留)
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  created_by uuid,                                        -- auth.users id
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint stored_value_accounts_status_check check (status in ('active', 'frozen', 'closed')),
  constraint stored_value_accounts_balance_check check (balance >= 0),
  constraint stored_value_accounts_currency_check check (currency = 'CNY')
);

-- 一个客户一种币种只有一个账户
create unique index if not exists idx_sv_accounts_tenant_customer_currency
  on public.stored_value_accounts (tenant_id, customer_id, currency);
create index if not exists idx_sv_accounts_tenant_created
  on public.stored_value_accounts (tenant_id, created_at desc);
create index if not exists idx_sv_accounts_customer
  on public.stored_value_accounts (customer_id);

drop trigger if exists trg_stored_value_accounts_updated_at on public.stored_value_accounts;
create trigger trg_stored_value_accounts_updated_at
  before update on public.stored_value_accounts
  for each row execute procedure public.touch_updated_at();

-- ===== 2. RLS:仅租户成员可读;写入只允许 RPC(security definer),无 authenticated 写策略 =====
alter table public.stored_value_accounts enable row level security;

drop policy if exists "stored_value_accounts_select_tenant" on public.stored_value_accounts;
create policy "stored_value_accounts_select_tenant" on public.stored_value_accounts
  for select to authenticated
  using (public.is_tenant_member(tenant_id));

-- 表级 DML 收紧:余额只能经 RPC(函数 owner=postgres)变更,禁止任何角色直改
revoke insert, update, delete on public.stored_value_accounts from anon;
revoke insert, update, delete on public.stored_value_accounts from authenticated;
revoke insert, update, delete on public.stored_value_accounts from service_role;

-- ===== 3. 权限码(wallet.*) =====
insert into public.permissions (code, name, module) values
  ('wallet.view', '查看储值账户', 'wallet'),
  ('wallet.recharge', '储值充值', 'wallet'),
  ('wallet.adjust', '储值人工调整', 'wallet'),
  ('wallet.freeze', '储值冻结/解冻', 'wallet')
on conflict (code) do update set
  name = excluded.name,
  module = excluded.module;

-- system_admin / tenant_owner:全部 wallet 权限
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code in ('system_admin', 'tenant_owner')
  and p.code in ('wallet.view', 'wallet.recharge', 'wallet.adjust', 'wallet.freeze')
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

-- store_manager:全部 wallet 权限(含人工调整/冻结)
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'store_manager'
  and p.code in ('wallet.view', 'wallet.recharge', 'wallet.adjust', 'wallet.freeze')
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

-- cashier:查看 + 充值(不授予人工调账/冻结)
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'cashier'
  and p.code in ('wallet.view', 'wallet.recharge')
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

-- 同步 roles.permissions 数组(兼容旧代码读取)
update public.roles
set permissions = array(
  select distinct unnest(permissions || array[
    'wallet.view', 'wallet.recharge', 'wallet.adjust', 'wallet.freeze'
  ])
)
where code in ('system_admin', 'tenant_owner', 'store_manager') and is_system = true;

update public.roles
set permissions = array(
  select distinct unnest(permissions || array['wallet.view', 'wallet.recharge'])
)
where code = 'cashier' and is_system = true;
