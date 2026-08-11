-- ============================================================
-- 20260811000006_points_revoke_refund_cancel.sql
-- R-C4(3.4.2.3-07):退款 / 发票作废按原发票积分扣回
-- 扣回规则:
--   * process_refund(paid/partially_paid 退款):按退款金额占发票总额比例扣回,
--     并扣除该发票已撤销量,避免多次部分退款累计超扣;余额不足按 0 截断(不为负)。
--   * cancel_invoice(draft/confirmed 作废):全额扣回该发票已得 purchase 积分。
--   * 开关 points.refund.revoke=false 时跳过扣回;发票无客户(customer_id 为空)自然跳过。
-- 扣回流水 reason='adjust'(流水不可变,原 reason 枚举不含 revoke,不扩展枚举),
-- reference_type='invoice' / reference_id=发票 id,便于对账。
-- 注意:旧迁移 20260810000203 / 20260806000020 不得修改,此处 CREATE OR REPLACE 覆盖最新版。
-- ============================================================

-- ============================================================
-- 1. process_refund(含 stored_value 完整逻辑 + 积分扣回)
-- ============================================================
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
  -- R-4 积分扣回
  v_membership public.customer_memberships;
  v_earned_points integer := 0;
  v_revoke_points integer := 0;
  v_revoked_points integer := 0;
  v_balance_after integer;
  v_revoke_enabled boolean;
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

  -- ===== R-4 积分扣回(退款按金额比例,扣除已撤销量防多次退款超扣) =====
  if v_invoice.customer_id is not null then
    v_revoke_enabled := coalesce(
      (public.get_effective_setting(v_invoice.tenant_id, v_invoice.store_id, 'points', 'refund.revoke'))::boolean,
      true
    );
    if v_revoke_enabled then
      -- 该发票已得 purchase 积分(原始获得量)
      select coalesce(sum(delta), 0) into v_earned_points
      from public.point_transactions
      where tenant_id = v_invoice.tenant_id
        and customer_id = v_invoice.customer_id
        and reference_type = 'invoice'
        and reference_id = p_invoice_id
        and reason = 'purchase'
        and delta > 0;

      if v_earned_points > 0 then
        -- 按退款金额比例应扣
        v_revoke_points := round(v_earned_points * p_amount / nullif(v_invoice.total, 0));
        -- 扣除该发票已扣回量(累计,防多次部分退款超扣)
        select coalesce(sum(abs(delta)), 0) into v_revoked_points
        from public.point_transactions
        where tenant_id = v_invoice.tenant_id
          and customer_id = v_invoice.customer_id
          and reference_type = 'invoice'
          and reference_id = p_invoice_id
          and reason = 'adjust'
          and delta < 0;
        v_revoke_points := greatest(v_revoke_points - v_revoked_points, 0);

        if v_revoke_points > 0 then
          -- 行锁会员积分账户
          select * into v_membership
          from public.customer_memberships
          where tenant_id = v_invoice.tenant_id and customer_id = v_invoice.customer_id
          for update;
          if found then
            v_balance_after := greatest(v_membership.points_balance - v_revoke_points, 0);
            update public.customer_memberships
            set points_balance = v_balance_after
            where id = v_membership.id;

            -- 写不可变积分流水(reason=adjust,负数扣回)
            insert into public.point_transactions (
              tenant_id, customer_id, delta, reason,
              reference_type, reference_id, balance_after, operator_id
            )
            values (
              v_invoice.tenant_id, v_invoice.customer_id, -v_revoke_points, 'adjust',
              'invoice', p_invoice_id, v_balance_after, p_operator_id
            );
          end if;
        end if;
      end if;
    end if;
  end if;

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
        'refundedToWallet', v_refund_to_wallet,
        'revokedPoints', v_revoke_points
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
    'refundedToWallet', v_refund_to_wallet,
    'revokedPoints', v_revoke_points
  );
end;
$$;

revoke all on function public.process_refund(uuid, numeric, text, uuid, text, uuid) from public;
grant execute on function public.process_refund(uuid, numeric, text, uuid, text, uuid) to authenticated;

-- ============================================================
-- 2. cancel_invoice(作废全额扣回已得积分)
-- ============================================================
create or replace function public.cancel_invoice(
  p_invoice_id uuid,
  p_operator_id uuid default null,
  p_reason text default null
)
returns public.invoices
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice public.invoices;
  -- R-4 积分扣回
  v_membership public.customer_memberships;
  v_earned_points integer := 0;
  v_revoke_points integer := 0;
  v_balance_after integer;
  v_revoke_enabled boolean;
begin
  select * into v_invoice from public.invoices where id = p_invoice_id for update;
  if not found then
    raise exception 'INVOICE_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- 已支付/部分支付/已退款的状态不可取消
  if v_invoice.status in ('paid', 'partially_paid', 'refunded') then
    raise exception 'INVOICE_STATUS_INVALID' using errcode = 'P0003',
      detail = format('cannot cancel invoice in status=%s', v_invoice.status);
  end if;

  if v_invoice.status = 'cancelled' then
    raise exception 'INVOICE_ALREADY_CANCELLED' using errcode = 'P0003';
  end if;

  update public.invoices
  set status = 'cancelled',
      updated_at = now()
  where id = p_invoice_id
  returning * into v_invoice;

  -- ===== R-4 积分扣回(作废全额撤销该发票已得 purchase 积分) =====
  if v_invoice.customer_id is not null then
    v_revoke_enabled := coalesce(
      (public.get_effective_setting(v_invoice.tenant_id, v_invoice.store_id, 'points', 'refund.revoke'))::boolean,
      true
    );
    if v_revoke_enabled then
      select coalesce(sum(delta), 0) into v_earned_points
      from public.point_transactions
      where tenant_id = v_invoice.tenant_id
        and customer_id = v_invoice.customer_id
        and reference_type = 'invoice'
        and reference_id = p_invoice_id
        and reason = 'purchase'
        and delta > 0;

      if v_earned_points > 0 then
        select * into v_membership
        from public.customer_memberships
        where tenant_id = v_invoice.tenant_id and customer_id = v_invoice.customer_id
        for update;
        if found then
          v_balance_after := greatest(v_membership.points_balance - v_earned_points, 0);
          v_revoke_points := v_earned_points;
          update public.customer_memberships
          set points_balance = v_balance_after
          where id = v_membership.id;

          insert into public.point_transactions (
            tenant_id, customer_id, delta, reason,
            reference_type, reference_id, balance_after, operator_id
          )
          values (
            v_invoice.tenant_id, v_invoice.customer_id, -v_earned_points, 'adjust',
            'invoice', p_invoice_id, v_balance_after, p_operator_id
          );
        end if;
      end if;
    end if;
  end if;

  return v_invoice;
end;
$$;

revoke all on function public.cancel_invoice(uuid, uuid, text) from public;
grant execute on function public.cancel_invoice(uuid, uuid, text) to authenticated;
