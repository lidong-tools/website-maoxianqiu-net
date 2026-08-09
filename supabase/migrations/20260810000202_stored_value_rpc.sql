-- ============================================================
-- 20260810000202_stored_value_rpc.sql
-- Agent-03 Stage-04: 储值领域 Command RPC(service-role-only)
--
-- RPC 清单:
--   1) open_stored_value_account        开户(租户内客户唯一账户,幂等)
--   2) recharge_stored_value            充值(本金 + 赠送金,记账区分,幂等)
--   3) adjust_stored_value              人工调整(±,reason 必填,幂等)
--   4) set_stored_value_account_status  冻结/解冻/销户
--
-- 安全模型(遵循 AGENTS.md):
--   * SECURITY DEFINER + set search_path = public;
--   * revoke public/anon/authenticated + grant service_role;
--   * 权限码校验在 Hono 层(requireScopedPermission),RPC 校验租户/状态/余额;
--   * 余额一致性:SELECT ... FOR UPDATE → 校验 → insert ledger → update balance/version,
--     禁止 Node 端读-算-写;
--   * 幂等:idempotency_records 命中返回原结果;并发:account 行锁 + 唯一索引兜底;
--   * RPC 内必须校验 Customer 归属(service role 绕过 RLS,不能只依赖 UUID 存在)。
-- ============================================================

-- ===== 1. open_stored_value_account 开户 =====
create or replace function public.open_stored_value_account(
  p_tenant_id uuid,
  p_customer_id uuid,
  p_currency text default 'CNY',
  p_operator_id uuid default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_customer_ok boolean;
  v_existing jsonb;
  v_account public.stored_value_accounts;
  v_created boolean := true;
begin
  -- 币种仅支持 CNY
  if p_currency is null or p_currency <> 'CNY' then
    raise exception 'UNSUPPORTED_CURRENCY' using errcode = 'P0003';
  end if;

  -- 幂等检查:同一 idempotency_key 命中直接返回原结果
  if p_idempotency_key is not null and p_idempotency_key <> '' then
    select result_json into v_existing
    from public.idempotency_records
    where tenant_id = p_tenant_id and idempotency_key = p_idempotency_key
    limit 1;
    if v_existing is not null then
      return v_existing;
    end if;
  end if;

  -- 客户归属校验:customers.tenant_id 必须等于账户租户(不能只依赖 UUID 存在)
  select exists(
    select 1 from public.customers
    where id = p_customer_id and tenant_id = p_tenant_id
  ) into v_customer_ok;
  if not v_customer_ok then
    raise exception 'CUSTOMER_NOT_FOUND' using errcode = 'P0002',
      detail = format('customer=%s not in tenant=%s', p_customer_id, p_tenant_id);
  end if;

  -- 已存在账户直接返回(开户天然幂等,unique 约束兜底)
  select * into v_account
  from public.stored_value_accounts
  where tenant_id = p_tenant_id and customer_id = p_customer_id and currency = p_currency;
  if v_account.id is not null then
    v_created := false;
    return jsonb_build_object(
      'accountId', v_account.id,
      'created', false,
      'tenantId', v_account.tenant_id,
      'customerId', v_account.customer_id,
      'currency', v_account.currency,
      'balance', v_account.balance,
      'status', v_account.status
    );
  end if;

  insert into public.stored_value_accounts (tenant_id, customer_id, currency, created_by)
  values (p_tenant_id, p_customer_id, p_currency, p_operator_id)
  on conflict (tenant_id, customer_id, currency) do nothing
  returning * into v_account;

  -- on conflict do nothing 可能不返回行,重取一次
  if v_account.id is null then
    select * into v_account
    from public.stored_value_accounts
    where tenant_id = p_tenant_id and customer_id = p_customer_id and currency = p_currency;
    v_created := false;
  end if;

  -- 幂等记录
  if p_idempotency_key is not null and p_idempotency_key <> '' then
    insert into public.idempotency_records (tenant_id, idempotency_key, action, entity_type, entity_id, result_json)
    values (p_tenant_id, p_idempotency_key, 'open_stored_value_account', 'stored_value_account', v_account.id,
            jsonb_build_object('accountId', v_account.id, 'created', v_created,
                               'balance', v_account.balance, 'status', v_account.status))
    on conflict (tenant_id, idempotency_key) do nothing;
  end if;

  return jsonb_build_object(
    'accountId', v_account.id,
    'created', v_created,
    'tenantId', v_account.tenant_id,
    'customerId', v_account.customer_id,
    'currency', v_account.currency,
    'balance', v_account.balance,
    'status', v_account.status
  );
end;
$$;

-- ===== 2. recharge_stored_value 充值(本金 + 赠送) =====
create or replace function public.recharge_stored_value(
  p_account_id uuid,
  p_amount numeric,
  p_bonus_amount numeric default 0,
  p_source text default null,
  p_external_method text default null,
  p_external_txn_no text default null,
  p_operator_id uuid default null,
  p_idempotency_key text default null,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_account public.stored_value_accounts;
  v_existing jsonb;
  v_balance_before numeric(14,2);
  v_balance_after numeric(14,2);
  v_recharge_ledger uuid;
  v_bonus_ledger uuid;
  v_total numeric(14,2);
begin
  -- 参数校验:本金或赠送至少一项为正
  if coalesce(p_amount, 0) <= 0 and coalesce(p_bonus_amount, 0) <= 0 then
    raise exception 'INVALID_AMOUNT' using errcode = 'P0003';
  end if;
  if p_source is null or btrim(p_source) = '' then
    raise exception 'RECHARGE_SOURCE_REQUIRED' using errcode = 'P0003';
  end if;
  if coalesce(p_amount, 0) < 0 or coalesce(p_bonus_amount, 0) < 0 then
    raise exception 'INVALID_AMOUNT' using errcode = 'P0003';
  end if;

  -- 幂等检查
  if p_idempotency_key is not null and p_idempotency_key <> '' then
    select result_json into v_existing
    from public.idempotency_records
    where tenant_id = (select tenant_id from public.stored_value_accounts where id = p_account_id)
      and idempotency_key = p_idempotency_key
    limit 1;
    if v_existing is not null then
      return v_existing;
    end if;
  end if;

  -- 行锁账户
  select * into v_account from public.stored_value_accounts where id = p_account_id for update;
  if not found then
    raise exception 'WALLET_ACCOUNT_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_account.status <> 'active' then
    raise exception 'WALLET_ACCOUNT_FROZEN' using errcode = 'P0003',
      detail = format('account status=%s', v_account.status);
  end if;

  v_balance_before := v_account.balance;
  v_total := coalesce(p_amount, 0) + coalesce(p_bonus_amount, 0);
  v_balance_after := v_balance_before + v_total;

  -- 本金流水(幂等键加后缀,与赠送流水共享同一业务 key 且不冲突)
  if coalesce(p_amount, 0) > 0 then
    insert into public.stored_value_ledger (
      tenant_id, account_id, customer_id, direction, type, amount,
      balance_before, balance_after, reference_type, idempotency_key,
      operator_id, reason, metadata
    )
    values (
      v_account.tenant_id, v_account.id, v_account.customer_id, 'credit', 'recharge', p_amount,
      v_balance_before, v_balance_before + p_amount, 'wallet_recharge',
      case when p_idempotency_key is not null and p_idempotency_key <> '' then p_idempotency_key || ':recharge' else null end,
      p_operator_id, p_reason,
      jsonb_build_object('source', p_source, 'external_method', p_external_method, 'external_txn_no', p_external_txn_no)
    )
    returning id into v_recharge_ledger;
  end if;

  -- 赠送金流水(本金与赠送在 ledger type 上区分,当前不拆分余额,仅记账区分)
  if coalesce(p_bonus_amount, 0) > 0 then
    insert into public.stored_value_ledger (
      tenant_id, account_id, customer_id, direction, type, amount,
      balance_before, balance_after, reference_type, idempotency_key,
      operator_id, reason, metadata
    )
    values (
      v_account.tenant_id, v_account.id, v_account.customer_id, 'credit', 'bonus', p_bonus_amount,
      v_balance_before, v_balance_after, 'wallet_recharge',
      case when p_idempotency_key is not null and p_idempotency_key <> '' then p_idempotency_key || ':bonus' else null end,
      p_operator_id, p_reason,
      jsonb_build_object('source', p_source, 'external_method', p_external_method, 'external_txn_no', p_external_txn_no)
    )
    returning id into v_bonus_ledger;
  end if;

  -- 更新余额快照 + 乐观锁版本
  update public.stored_value_accounts
  set balance = v_balance_after,
      version = v_account.version + 1
  where id = p_account_id
  returning * into v_account;

  -- 幂等记录
  if p_idempotency_key is not null and p_idempotency_key <> '' then
    insert into public.idempotency_records (tenant_id, idempotency_key, action, entity_type, entity_id, result_json)
    values (v_account.tenant_id, p_idempotency_key, 'recharge_stored_value', 'stored_value_account', v_account.id,
            jsonb_build_object('accountId', v_account.id, 'amount', p_amount, 'bonusAmount', p_bonus_amount,
                               'balance', v_account.balance, 'rechargeLedgerId', v_recharge_ledger,
                               'bonusLedgerId', v_bonus_ledger))
    on conflict (tenant_id, idempotency_key) do nothing;
  end if;

  return jsonb_build_object(
    'accountId', v_account.id,
    'amount', p_amount,
    'bonusAmount', p_bonus_amount,
    'balance', v_account.balance,
    'rechargeLedgerId', v_recharge_ledger,
    'bonusLedgerId', v_bonus_ledger
  );
end;
$$;

-- ===== 3. adjust_stored_value 人工调整(±) =====
create or replace function public.adjust_stored_value(
  p_account_id uuid,
  p_delta numeric,
  p_reason text,
  p_operator_id uuid default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_account public.stored_value_accounts;
  v_existing jsonb;
  v_direction text;
  v_balance_before numeric(14,2);
  v_balance_after numeric(14,2);
  v_ledger_id uuid;
begin
  -- 参数校验
  if p_delta is null or p_delta = 0 then
    raise exception 'INVALID_DELTA' using errcode = 'P0003';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'ADJUST_REASON_REQUIRED' using errcode = 'P0003';
  end if;

  -- 幂等检查
  if p_idempotency_key is not null and p_idempotency_key <> '' then
    select result_json into v_existing
    from public.idempotency_records
    where tenant_id = (select tenant_id from public.stored_value_accounts where id = p_account_id)
      and idempotency_key = p_idempotency_key
    limit 1;
    if v_existing is not null then
      return v_existing;
    end if;
  end if;

  -- 行锁账户
  select * into v_account from public.stored_value_accounts where id = p_account_id for update;
  if not found then
    raise exception 'WALLET_ACCOUNT_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_account.status <> 'active' then
    raise exception 'WALLET_ACCOUNT_FROZEN' using errcode = 'P0003',
      detail = format('account status=%s', v_account.status);
  end if;

  v_direction := case when p_delta > 0 then 'credit' else 'debit' end;
  v_balance_before := v_account.balance;
  v_balance_after := v_balance_before + p_delta;
  if v_balance_after < 0 then
    raise exception 'INSUFFICIENT_WALLET_BALANCE' using errcode = 'P0003';
  end if;

  -- 写调整流水
  insert into public.stored_value_ledger (
    tenant_id, account_id, customer_id, direction, type, amount,
    balance_before, balance_after, reference_type, idempotency_key,
    operator_id, reason, metadata
  )
  values (
    v_account.tenant_id, v_account.id, v_account.customer_id,
    v_direction, 'adjustment', abs(p_delta),
    v_balance_before, v_balance_after, 'manual_adjust',
    case when p_idempotency_key is not null and p_idempotency_key <> '' then p_idempotency_key || ':adjust' else null end,
    p_operator_id, p_reason, '{}'::jsonb
  )
  returning id into v_ledger_id;

  -- 更新余额快照 + 乐观锁版本
  update public.stored_value_accounts
  set balance = v_balance_after,
      version = v_account.version + 1
  where id = p_account_id
  returning * into v_account;

  -- 幂等记录
  if p_idempotency_key is not null and p_idempotency_key <> '' then
    insert into public.idempotency_records (tenant_id, idempotency_key, action, entity_type, entity_id, result_json)
    values (v_account.tenant_id, p_idempotency_key, 'adjust_stored_value', 'stored_value_account', v_account.id,
            jsonb_build_object('accountId', v_account.id, 'delta', p_delta, 'balance', v_account.balance,
                               'ledgerId', v_ledger_id))
    on conflict (tenant_id, idempotency_key) do nothing;
  end if;

  return jsonb_build_object(
    'accountId', v_account.id,
    'delta', p_delta,
    'balance', v_account.balance,
    'ledgerId', v_ledger_id
  );
end;
$$;

-- ===== 4. set_stored_value_account_status 冻结/解冻/销户 =====
create or replace function public.set_stored_value_account_status(
  p_account_id uuid,
  p_status text,
  p_reason text,
  p_operator_id uuid default null
)
returns public.stored_value_accounts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_account public.stored_value_accounts;
begin
  if p_status not in ('active', 'frozen', 'closed') then
    raise exception 'INVALID_STATUS' using errcode = 'P0003';
  end if;
  if p_status <> 'active' and (p_reason is null or btrim(p_reason) = '') then
    raise exception 'STATUS_REASON_REQUIRED' using errcode = 'P0003';
  end if;

  select * into v_account from public.stored_value_accounts where id = p_account_id for update;
  if not found then
    raise exception 'WALLET_ACCOUNT_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- 销户须余额清零,防止余额悬空
  if p_status = 'closed' and v_account.balance > 0 then
    raise exception 'CLOSING_BALANCE_NOT_ZERO' using errcode = 'P0003',
      detail = format('balance=%s', v_account.balance);
  end if;

  update public.stored_value_accounts
  set status = p_status,
      closed_at = case when p_status = 'closed' then now() else closed_at end,
      version = v_account.version + 1
  where id = p_account_id
  returning * into v_account;

  return v_account;
end;
$$;

-- ============================================================
-- RPC 权限收紧(service-role-only,manifest 同步登记)
-- ============================================================
do $$
declare
  v_fn text;
  v_sig text;
begin
  foreach v_fn in array array[
    'open_stored_value_account',
    'recharge_stored_value',
    'adjust_stored_value',
    'set_stored_value_account_status'
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
