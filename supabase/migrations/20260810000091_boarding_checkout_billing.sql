-- ============================================================
-- 20260810000091_boarding_checkout_billing.sql
-- Agent-07 集成修复(S3.1 收尾):寄养离店 → Billing Invoice(原子)
--
-- 需求(AGENT-06-HANDOFF 跨域 Hook 1 + Agent-07 规范 §9.2):
--   Boarding Checkout → 生成 Billing Invoice;
--   Invoice 创建失败 → Boarding 不得标 checked_out,禁止部分成功造成账务丢失。
-- 实现:在 boarding_checkout 同一事务内先调用 create_invoice;
--       发票失败 → 异常 → 整体回滚,寄养单保持未离店、笼位不释放、无孤儿发票。
-- 幂等:既有 idempotency_records 检查位于发票创建之前,重试不会重复计费。
-- create or replace 保留 migration 73 已授予的 service_role 权限;末尾 DO 块再次收紧(自包含)。
-- ============================================================

create or replace function public.boarding_checkout(
  p_stay_id uuid,
  p_operator_id uuid default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_stay public.boarding_stays;
  v_cage public.cages;
  v_days integer;
  v_daily_amount numeric(12,2) := 0;
  v_service_amount numeric(12,2) := 0;
  v_total numeric(12,2) := 0;
  v_existing jsonb;
  v_items jsonb := '[]'::jsonb;
  v_item jsonb;
  v_invoice jsonb;
  v_invoice_id uuid;
begin
  -- 幂等检查(先于发票创建,避免重试重复计费)
  if p_idempotency_key is not null and p_idempotency_key <> '' then
    select result_json into v_existing
    from public.idempotency_records
    where idempotency_key = p_idempotency_key
    limit 1;
    if v_existing is not null then
      return v_existing;
    end if;
  end if;

  select * into v_stay from public.boarding_stays
  where id = p_stay_id
  for update;
  if not found then
    raise exception 'BOARDING_STAY_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_stay.status not in ('checked_in', 'in_service', 'checkout_pending') then
    raise exception 'BOARDING_NOT_CHECKOUT_ABLE' using errcode = 'P0003';
  end if;

  select * into v_cage from public.cages
  where id = v_stay.cage_id
  for update;

  -- 汇总应收
  if v_cage is not null and v_cage.daily_rate > 0 then
    v_days := greatest(1, ceil(extract(epoch from (now() - v_stay.check_in_at)) / 86400)::integer);
    v_daily_amount := v_cage.daily_rate * v_days;
  end if;
  select coalesce(sum(amount), 0) into v_service_amount
  from public.boarding_service_charges
  where boarding_stay_id = p_stay_id;
  v_total := v_daily_amount + v_service_amount;

  -- 集成点:同一事务内创建 Billing Invoice(失败整体回滚)
  if v_total > 0 then
    -- 笼位日费行(手工行,不依赖 catalog 预置)
    if v_daily_amount > 0 then
      v_items := v_items || jsonb_build_object(
        'name', '寄养日费(笼位)',
        'unit_price', v_daily_amount,
        'quantity', 1,
        'amount', v_daily_amount,
        'category', 'service'
      );
    end if;
    -- 额外服务费逐条(amount = unit_price × 1,保证过 create_invoice 金额校验)
    for v_item in select jsonb_build_object(
        'name', coalesce(sc.description, '寄养服务费'),
        'catalog_item_id', sc.catalog_item_id,
        'unit_price', sc.amount,
        'quantity', 1,
        'amount', sc.amount,
        'category', 'service'
      )
      from public.boarding_service_charges sc
      where sc.boarding_stay_id = p_stay_id
      order by sc.created_at
    loop
      v_items := v_items || v_item;
    end loop;

    v_invoice := public.create_invoice(
      v_stay.tenant_id,
      v_stay.store_id,
      v_stay.customer_id,
      v_stay.pet_id,
      null,                       -- p_encounter_id
      v_items,
      0,                          -- p_discount_amount(寄养不参与审批阈值)
      null,                       -- p_discount_reason
      0,                          -- p_tax_amount
      null,                       -- p_payment_method(发票生成,支付另行处理)
      null,                       -- p_due_date
      p_operator_id,
      false                       -- p_apply_membership_discount(寄养不套会员折扣)
    );
    v_invoice_id := (v_invoice->>'invoiceId')::uuid;
    if v_invoice_id is null then
      raise exception 'BOARDING_INVOICE_FAILED' using errcode = 'P0003';
    end if;
  end if;

  update public.boarding_stays
  set status = 'checked_out',
      checked_out_at = now(),
      total_charge = v_total,
      updated_at = now()
  where id = p_stay_id
  returning * into v_stay;

  -- 释放笼位
  if v_cage is not null and v_cage.current_boarding_stay_id = p_stay_id then
    update public.cages
    set status = 'available',
        current_boarding_stay_id = null,
        updated_at = now()
    where id = v_cage.id;
  end if;

  -- 记录幂等结果(含 invoiceId)
  if p_idempotency_key is not null and p_idempotency_key <> '' then
    insert into public.idempotency_records (tenant_id, idempotency_key, action, entity_type, entity_id, result_json)
    values (v_stay.tenant_id, p_idempotency_key, 'boarding_checkout', 'boarding_stay', p_stay_id, jsonb_build_object(
      'stayId', p_stay_id,
      'boardingNo', v_stay.boarding_no,
      'status', v_stay.status,
      'totalCharge', v_total,
      'invoiceId', v_invoice_id,
      'checkedOutAt', v_stay.checked_out_at
    ))
    on conflict (tenant_id, idempotency_key) do nothing;
  end if;

  return jsonb_build_object(
    'stayId', p_stay_id,
    'boardingNo', v_stay.boarding_no,
    'stayDays', v_days,
    'dailyAmount', v_daily_amount,
    'serviceAmount', v_service_amount,
    'totalCharge', v_total,
    'invoiceId', v_invoice_id,
    'status', v_stay.status,
    'checkedOutAt', v_stay.checked_out_at
  );
end;
$$;

-- 权限收紧(自包含,幂等)
do $$
declare
  v_fn text;
  v_sig text;
begin
  foreach v_fn in array array['boarding_checkout']
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
