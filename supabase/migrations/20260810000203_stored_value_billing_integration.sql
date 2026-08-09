-- ============================================================
-- 20260810000203_stored_value_billing_integration.sql
-- Agent-03 Stage-04: 储值 × Billing 集成(Forward Migration)
--
-- 目标(对齐 Agent-03 DEEP 文档 §8/§9/§10):
--   * Billing Schema 统一:payments / invoices / payment_contexts 的
--     method 约束全部加入 stored_value,保证"只改前端 enum"不成立;
--   * 收银原子性:重定义 process_payment,当 p_method='stored_value' 时在
--     同一个 PostgreSQL 事务内 锁发票 → 锁储值账户 → 扣 Wallet →
--     写 payments → 更新 invoice,禁止"先 /wallet/debit 再 /billing/payments";
--   * 退款返还:重定义 process_refund,当原支付方式为 stored_value 时
--     同一事务内 Wallet credit(refund 流水)→ 写 refunds → 更新 invoice;
--   * payment_contexts:为现存租户门店补插 stored_value 上下文,并提供
--     ensure_stored_value_payment_context RPC 供新租户按需启用;
--   * 幂等:支付/退款幂等键沿用原逻辑;Wallet ledger 使用幂等键 + 业务后缀,
--     避免与 idempotency_records 及多条 ledger 唯一索引冲突。
--
-- 约束(遵循总编排):
--   * 不修改历史 Migration(121 及以前),本文件为独立高位段 200-209;
--   * RPC 全部 service-role-only:revoke public/anon/authenticated + grant service_role,
--     并登记到 api/lib/service-rpc-manifest.ts;
--   * 余额一致性:SELECT ... FOR UPDATE → 校验 → insert ledger → update balance/version,
--     禁止 Node 端读-算-写。
-- ============================================================

-- ===== 1. Billing method 约束统一(Forward Migration) =====
-- 1.1 payments.method
alter table public.payments
  drop constraint if exists payments_method_check;
alter table public.payments
  add constraint payments_method_check
  check (method in ('cash', 'wechat', 'alipay', 'card', 'other', 'stored_value'));

-- 1.2 invoices.payment_method
alter table public.invoices
  drop constraint if exists invoices_payment_method_check;
alter table public.invoices
  add constraint invoices_payment_method_check
  check (payment_method is null or payment_method in ('cash', 'wechat', 'alipay', 'card', 'other', 'stored_value'));

-- 1.3 payment_contexts.method(列内联约束,PG 自动命名为 payment_contexts_method_check)
alter table public.payment_contexts
  drop constraint if exists payment_contexts_method_check;
alter table public.payment_contexts
  add constraint payment_contexts_method_check
  check (method in ('cash', 'card', 'wechat', 'alipay', 'other', 'stored_value'));

-- ===== 2. 为现存租户门店补插 stored_value 支付上下文 =====
-- 收银台支付方式列表读取自 payment_contexts(见 cashier loadPaymentMethods),
-- 因此需为已有门店补插;新租户初始化后由 ensure_stored_value_payment_context
-- (或设置页新增支付方式)按需启用。
insert into public.payment_contexts (tenant_id, store_id, method, label, is_default, is_active)
select t.id, s.id, 'stored_value', '储值', false, true
from public.stores s
join public.tenants t on t.id = s.tenant_id
on conflict (tenant_id, store_id, method) do update set
  label = excluded.label,
  is_active = excluded.is_active;

-- ===== 3. ensure_stored_value_payment_context RPC(service-role-only,幂等) =====
-- 为指定租户门店启用/停用 stored_value 支付上下文;供新租户初始化完成后调用,
-- 避免重定义大型已交付 RPC initialize_tenant。
create or replace function public.ensure_stored_value_payment_context(
  p_tenant_id uuid,
  p_store_id uuid,
  p_is_active boolean default true,
  p_operator_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store_ok boolean;
  v_context jsonb;
begin
  -- 门店归属校验(service role 绕过 RLS,不能只依赖 UUID 存在)
  select exists(
    select 1 from public.stores where id = p_store_id and tenant_id = p_tenant_id
  ) into v_store_ok;
  if not v_store_ok then
    raise exception 'STORE_NOT_FOUND' using errcode = 'P0002',
      detail = format('store=%s not in tenant=%s', p_store_id, p_tenant_id);
  end if;

  insert into public.payment_contexts (tenant_id, store_id, method, label, is_default, is_active)
  values (p_tenant_id, p_store_id, 'stored_value', '储值', false, p_is_active)
  on conflict (tenant_id, store_id, method) do update set
    label = excluded.label,
    is_active = excluded.is_active
  returning jsonb_build_object(
    'tenantId', tenant_id,
    'storeId', store_id,
    'method', method,
    'label', label,
    'isActive', is_active
  ) into v_context;

  return coalesce(v_context, jsonb_build_object(
    'tenantId', p_tenant_id, 'storeId', p_store_id, 'method', 'stored_value',
    'label', '储值', 'isActive', p_is_active
  ));
end;
$$;

-- ===== 4. 重定义 process_payment:支持 stored_value(同事务扣 Wallet + 写 Payment) =====
create or replace function public.process_payment(
  p_invoice_id uuid,
  p_amount numeric,
  p_method text,
  p_operator_id uuid default null,
  p_idempotency_key text default null,
  p_transaction_no text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice public.invoices;
  v_existing jsonb;
  v_payment public.payments;
  v_new_paid_amount numeric(12,2);
  v_new_status text;
  v_wallet public.stored_value_accounts;
begin
  -- 参数校验
  if p_amount <= 0 then
    raise exception 'INVALID_AMOUNT' using errcode = 'P0003';
  end if;
  if p_method not in ('cash', 'wechat', 'alipay', 'card', 'other', 'stored_value') then
    raise exception 'INVALID_METHOD' using errcode = 'P0003';
  end if;

  -- 幂等检查:命中已存在记录直接返回原结果
  if p_idempotency_key is not null and p_idempotency_key <> '' then
    select result_json into v_existing
    from public.idempotency_records
    where tenant_id = (select tenant_id from public.invoices where id = p_invoice_id)
      and idempotency_key = p_idempotency_key
    limit 1;
    if v_existing is not null then
      return v_existing;
    end if;
  end if;

  -- 行锁发票
  select * into v_invoice from public.invoices where id = p_invoice_id for update;
  if not found then
    raise exception 'INVOICE_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- 状态校验:仅 confirmed / partially_paid 可支付
  if v_invoice.status not in ('confirmed', 'partially_paid') then
    raise exception 'INVOICE_STATUS_INVALID' using errcode = 'P0003',
      detail = format('current status=%s, expected=confirmed or partially_paid', v_invoice.status);
  end if;

  -- 校验支付金额不超过未付余额(允许 0.01 容差)
  if p_amount > (v_invoice.total - v_invoice.paid_amount) + 0.01 then
    raise exception 'AMOUNT_EXCEEDS_DUE' using errcode = 'P0003';
  end if;

  -- ===== stored_value:同一事务内扣减储值账户 =====
  -- 原子性保证:本函数整体为单事务,任意一步失败整体回滚,
  -- 不会出现"余额已扣但发票未支付"或"发票已付但余额未扣"。
  if p_method = 'stored_value' then
    -- 储值支付必须绑定客户(账户按客户维度建立)
    if v_invoice.customer_id is null then
      raise exception 'INVOICE_NO_CUSTOMER' using errcode = 'P0003';
    end if;

    -- 行锁储值账户(真源为 stored_value_accounts,禁止读-算-写)
    select * into v_wallet
    from public.stored_value_accounts
    where tenant_id = v_invoice.tenant_id
      and customer_id = v_invoice.customer_id
      and currency = 'CNY'
    for update;
    if not found then
      raise exception 'WALLET_ACCOUNT_NOT_FOUND' using errcode = 'P0002';
    end if;
    if v_wallet.status <> 'active' then
      raise exception 'WALLET_ACCOUNT_FROZEN' using errcode = 'P0003',
        detail = format('account status=%s', v_wallet.status);
    end if;
    if v_wallet.balance + 0.01 < p_amount then
      raise exception 'INSUFFICIENT_WALLET_BALANCE' using errcode = 'P0003',
        detail = format('balance=%s, need=%s', v_wallet.balance, p_amount);
    end if;

    -- 写扣款流水(reference 指向发票;幂等键加业务后缀避免与多条 ledger 冲突)
    insert into public.stored_value_ledger (
      tenant_id, account_id, customer_id, direction, type, amount,
      balance_before, balance_after, reference_type, reference_id,
      idempotency_key, operator_id, reason, metadata
    )
    values (
      v_wallet.tenant_id, v_wallet.id, v_wallet.customer_id, 'debit', 'payment', p_amount,
      v_wallet.balance, v_wallet.balance - p_amount, 'invoice', p_invoice_id,
      case when p_idempotency_key is not null and p_idempotency_key <> ''
           then p_idempotency_key || ':wallet_payment' else null end,
      p_operator_id, '收银储值支付',
      jsonb_build_object('invoice_id', p_invoice_id, 'transaction_no', p_transaction_no)
    );

    -- 更新账户余额快照 + 乐观锁版本
    update public.stored_value_accounts
    set balance = v_wallet.balance - p_amount,
        version = v_wallet.version + 1
    where id = v_wallet.id;
  end if;

  -- 写支付记录(唯一索引兜底防重复)
  insert into public.payments (
    tenant_id, invoice_id, amount, method, transaction_no, idempotency_key, operator_id
  )
  values (
    v_invoice.tenant_id, p_invoice_id, p_amount, p_method, p_transaction_no, p_idempotency_key, p_operator_id
  )
  returning * into v_payment;

  -- 更新发票已付金额与状态
  v_new_paid_amount := v_invoice.paid_amount + p_amount;
  if v_new_paid_amount >= v_invoice.total - 0.01 then
    v_new_status := 'paid';
  else
    v_new_status := 'partially_paid';
  end if;

  update public.invoices
  set paid_amount = v_new_paid_amount,
      status = v_new_status,
      payment_method = coalesce(v_invoice.payment_method, p_method),
      updated_at = now()
  where id = p_invoice_id;

  -- 记录幂等结果(service role 绕过 RLS 写入)
  if p_idempotency_key is not null and p_idempotency_key <> '' then
    insert into public.idempotency_records (tenant_id, idempotency_key, action, entity_type, entity_id, result_json)
    values (
      v_invoice.tenant_id, p_idempotency_key, 'process_payment', 'payment', v_payment.id,
      jsonb_build_object(
        'paymentId', v_payment.id,
        'invoiceId', p_invoice_id,
        'amount', p_amount,
        'method', p_method,
        'paidAmount', v_new_paid_amount,
        'status', v_new_status,
        'transactionNo', p_transaction_no
      )
    )
    on conflict (tenant_id, idempotency_key) do nothing;
  end if;

  return jsonb_build_object(
    'paymentId', v_payment.id,
    'invoiceId', p_invoice_id,
    'amount', p_amount,
    'method', p_method,
    'paidAmount', v_new_paid_amount,
    'status', v_new_status,
    'transactionNo', p_transaction_no
  );
end;
$$;

-- ===== 5. 重定义 process_refund:原支付为 stored_value 时同事务返还 Wallet =====
create or replace function public.process_refund(
  p_invoice_id uuid,
  p_amount numeric,
  p_reason text,
  p_operator_id uuid default null,
  p_idempotency_key text default null,
  p_payment_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice public.invoices;
  v_existing jsonb;
  v_refund public.refunds;
  v_new_paid_amount numeric(12,2);
  v_new_status text;
  v_wallet public.stored_value_accounts;
  v_pay_method text;
  v_refund_to_wallet boolean := false;
begin
  -- 参数校验
  if p_amount <= 0 then
    raise exception 'INVALID_AMOUNT' using errcode = 'P0003';
  end if;
  if p_reason is null or trim(p_reason) = '' then
    raise exception 'REFUND_REASON_REQUIRED' using errcode = 'P0003';
  end if;

  -- 幂等检查
  if p_idempotency_key is not null and p_idempotency_key <> '' then
    select result_json into v_existing
    from public.idempotency_records
    where tenant_id = (select tenant_id from public.invoices where id = p_invoice_id)
      and idempotency_key = p_idempotency_key
    limit 1;
    if v_existing is not null then
      return v_existing;
    end if;
  end if;

  -- 行锁发票
  select * into v_invoice from public.invoices where id = p_invoice_id for update;
  if not found then
    raise exception 'INVOICE_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- 状态校验:仅 paid / partially_paid 可退款
  if v_invoice.status not in ('paid', 'partially_paid') then
    raise exception 'INVOICE_STATUS_INVALID' using errcode = 'P0003',
      detail = format('current status=%s, expected=paid or partially_paid', v_invoice.status);
  end if;

  -- 退款金额不可超过已付金额
  if p_amount > v_invoice.paid_amount then
    raise exception 'REFUND_EXCEEDS_PAID' using errcode = 'P0003';
  end if;

  -- 判断是否退回储值:优先按指定 payment 的 method,否则按发票首笔支付方式
  if p_payment_id is not null then
    select method into v_pay_method
    from public.payments
    where id = p_payment_id and tenant_id = v_invoice.tenant_id;
    if v_pay_method = 'stored_value' then
      v_refund_to_wallet := true;
    end if;
  elsif v_invoice.payment_method = 'stored_value' then
    v_refund_to_wallet := true;
  end if;

  -- ===== stored_value:同一事务内返还储值账户(退款必须回 Wallet) =====
  if v_refund_to_wallet then
    if v_invoice.customer_id is null then
      raise exception 'INVOICE_NO_CUSTOMER' using errcode = 'P0003';
    end if;

    -- 行锁储值账户
    select * into v_wallet
    from public.stored_value_accounts
    where tenant_id = v_invoice.tenant_id
      and customer_id = v_invoice.customer_id
      and currency = 'CNY'
    for update;
    if not found then
      raise exception 'WALLET_ACCOUNT_NOT_FOUND' using errcode = 'P0002';
    end if;
    -- 已销户账户不再接收退款
    if v_wallet.status = 'closed' then
      raise exception 'WALLET_ACCOUNT_CLOSED' using errcode = 'P0003';
    end if;

    -- 写返还流水(credit/refund)
    insert into public.stored_value_ledger (
      tenant_id, account_id, customer_id, direction, type, amount,
      balance_before, balance_after, reference_type, reference_id,
      idempotency_key, operator_id, reason, metadata
    )
    values (
      v_wallet.tenant_id, v_wallet.id, v_wallet.customer_id, 'credit', 'refund', p_amount,
      v_wallet.balance, v_wallet.balance + p_amount, 'invoice', p_invoice_id,
      case when p_idempotency_key is not null and p_idempotency_key <> ''
           then p_idempotency_key || ':wallet_refund' else null end,
      p_operator_id, p_reason,
      jsonb_build_object('invoice_id', p_invoice_id, 'payment_id', p_payment_id)
    );

    -- 更新账户余额快照 + 乐观锁版本
    update public.stored_value_accounts
    set balance = v_wallet.balance + p_amount,
        version = v_wallet.version + 1
    where id = v_wallet.id;
  end if;

  -- 写退款记录
  insert into public.refunds (
    tenant_id, invoice_id, payment_id, amount, reason, idempotency_key, operator_id
  )
  values (
    v_invoice.tenant_id, p_invoice_id, p_payment_id, p_amount, p_reason, p_idempotency_key, p_operator_id
  )
  returning * into v_refund;

  -- 扣减已付金额,更新状态
  v_new_paid_amount := v_invoice.paid_amount - p_amount;
  if v_new_paid_amount <= 0.01 then
    v_new_paid_amount := 0;
    v_new_status := 'refunded';
  else
    v_new_status := 'partially_paid';
  end if;

  update public.invoices
  set paid_amount = v_new_paid_amount,
      status = v_new_status,
      updated_at = now()
  where id = p_invoice_id;

  -- 记录幂等结果
  if p_idempotency_key is not null and p_idempotency_key <> '' then
    insert into public.idempotency_records (tenant_id, idempotency_key, action, entity_type, entity_id, result_json)
    values (
      v_invoice.tenant_id, p_idempotency_key, 'process_refund', 'refund', v_refund.id,
      jsonb_build_object(
        'refundId', v_refund.id,
        'invoiceId', p_invoice_id,
        'amount', p_amount,
        'reason', p_reason,
        'paidAmount', v_new_paid_amount,
        'status', v_new_status,
        'refundedToWallet', v_refund_to_wallet
      )
    )
    on conflict (tenant_id, idempotency_key) do nothing;
  end if;

  return jsonb_build_object(
    'refundId', v_refund.id,
    'invoiceId', p_invoice_id,
    'amount', p_amount,
    'reason', p_reason,
    'paidAmount', v_new_paid_amount,
    'status', v_new_status,
    'refundedToWallet', v_refund_to_wallet
  );
end;
$$;

-- ============================================================
-- RPC 权限收紧(service-role-only,manifest 同步登记)
--   process_payment / process_refund 已在 migration 92 统一收紧,
--   此处重定义后再次锁定,确保新增 stored_value 分支不放开权限。
-- ============================================================
do $$
declare
  v_fn text;
  v_sig text;
begin
  foreach v_fn in array array[
    'ensure_stored_value_payment_context',
    'process_payment',
    'process_refund'
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
