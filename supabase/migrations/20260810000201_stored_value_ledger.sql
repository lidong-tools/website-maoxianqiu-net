-- ============================================================
-- 20260810000201_stored_value_ledger.sql
-- Agent-03 Stage-04: 储值流水(不可变审计真相)
--
-- 设计要点:
--   * stored_value_ledger 只追加,禁止 UPDATE/DELETE:
--     - RLS 无 update/delete 策略(authenticated 默认拒绝);
--     - 表级 revoke UPDATE/DELETE(含 service_role),写入仅能经 RPC(owner=postgres);
--   * 幂等:partial unique (tenant_id, idempotency_key)。
--     同一业务操作(充值含本金+赠送)写多条流水时,内部用 key 后缀区分,
--     见 migration 202 recharge_stored_value。
--   * 余额一致性:
--     SELECT account FOR UPDATE → 校验 → insert ledger(balance_before/after) →
--     update account.balance/version → commit,全程单事务,禁止 Node 读-算-写。
-- ============================================================

-- ===== 1. stored_value_ledger 储值流水 =====
create table if not exists public.stored_value_ledger (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  account_id uuid not null references public.stored_value_accounts(id) on delete restrict,
  customer_id uuid not null,
  direction text not null,                                -- credit / debit
  type text not null,                                     -- recharge/bonus/payment/refund/adjustment/reversal
  amount numeric(14,2) not null,                          -- 恒为正数,方向由 direction 表达
  balance_before numeric(14,2) not null,
  balance_after numeric(14,2) not null,
  reference_type text,                                    -- invoice / refund / ...
  reference_id uuid,
  idempotency_key text,
  operator_id uuid,                                       -- auth.users id
  reason text,
  metadata jsonb not null default '{}'::jsonb,            -- recharge source/external 交易号等
  created_at timestamptz not null default now(),
  constraint sv_ledger_direction_check check (direction in ('credit', 'debit')),
  constraint sv_ledger_type_check check (type in ('recharge', 'bonus', 'payment', 'refund', 'adjustment', 'reversal')),
  constraint sv_ledger_amount_check check (amount > 0),
  constraint sv_ledger_balance_after_check check (balance_after >= 0)
);

create unique index if not exists idx_sv_ledger_tenant_idem
  on public.stored_value_ledger (tenant_id, idempotency_key)
  where idempotency_key is not null;
create index if not exists idx_sv_ledger_account_time
  on public.stored_value_ledger (account_id, created_at desc);
create index if not exists idx_sv_ledger_customer_time
  on public.stored_value_ledger (tenant_id, customer_id, created_at desc);
create index if not exists idx_sv_ledger_reference
  on public.stored_value_ledger (reference_type, reference_id)
  where reference_type is not null;

-- ===== 2. RLS:仅租户成员可读;无 insert/update/delete 策略(不可变) =====
alter table public.stored_value_ledger enable row level security;

drop policy if exists "stored_value_ledger_select_tenant" on public.stored_value_ledger;
create policy "stored_value_ledger_select_tenant" on public.stored_value_ledger
  for select to authenticated
  using (public.is_tenant_member(tenant_id));

-- 流水不可变:禁止任何角色(含 service_role)直接 INSERT/UPDATE/DELETE
revoke insert, update, delete on public.stored_value_ledger from anon;
revoke insert, update, delete on public.stored_value_ledger from authenticated;
revoke insert, update, delete on public.stored_value_ledger from service_role;
