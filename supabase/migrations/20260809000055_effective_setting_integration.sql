-- ============================================================
-- 20260809000055_effective_setting_integration.sql
-- P0-10:业务规则从 system_settings 读取,不再硬编码 10%
--   - 新增 get_effective_setting 助手(门店覆盖 → 租户默认 → 系统默认)
--   - create_invoice / confirm_invoice 读取 business.discount.approval.threshold
-- 应用方式:Supabase SQL Editor 按编号顺序执行(幂等)
-- ============================================================

-- ===== 1. get_effective_setting 助手 =====
-- security invoker:被 security definer 的 RPC(create_invoice 等)调用时继承调用者(即外层 definer 角色),
-- 直接对用户执行时受 system_settings 的 RLS 约束。
create or replace function public.get_effective_setting(
  p_tenant_id uuid,
  p_store_id uuid,
  p_namespace text,
  p_key text,
  p_default jsonb default 'null'::jsonb
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(
    (select value_json from public.system_settings
      where tenant_id = p_tenant_id and store_id = p_store_id
        and namespace = p_namespace and key = p_key),
    (select value_json from public.system_settings
      where tenant_id = p_tenant_id and store_id is null
        and namespace = p_namespace and key = p_key),
    p_default
  );
$$;

grant execute on function public.get_effective_setting(uuid, uuid, text, text, jsonb) to authenticated;

-- ===== 2. create_invoice:折扣审批阈值读取生效配置 =====
create or replace function public.create_invoice(
  p_tenant_id uuid,
  p_store_id uuid,
  p_customer_id uuid default null,
  p_pet_id uuid default null,
  p_encounter_id uuid default null,
  p_items jsonb default '[]'::jsonb,
  p_discount_amount numeric default 0,
  p_discount_reason text default null,
  p_tax_amount numeric default 0,
  p_payment_method text default null,
  p_due_date date default null,
  p_operator_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice public.invoices;
  v_invoice_no text;
  v_item record;
  v_subtotal numeric(12,2) := 0;
  v_total numeric(12,2) := 0;
  v_item_amount numeric(12,2);
  v_item_expected_amount numeric(12,2);
  v_items_count integer;
  v_discount_threshold numeric;
begin
  -- 参数校验
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'EMPTY_ITEMS' using errcode = 'P0003';
  end if;

  if p_discount_amount < 0 then
    raise exception 'INVALID_DISCOUNT' using errcode = 'P0003';
  end if;

  if p_tax_amount < 0 then
    raise exception 'INVALID_TAX' using errcode = 'P0003';
  end if;

  -- 生成发票号
  v_invoice_no := public.generate_invoice_no(p_tenant_id, p_store_id);

  -- 计算 subtotal = sum(items.amount),同时校验每条 amount = unit_price * quantity - discount_amount
  v_subtotal := 0;
  for v_item in select * from jsonb_array_elements(p_items) as t(item)
  loop
    v_item_amount := coalesce((v_item.item->>'amount')::numeric, 0);
    v_item_expected_amount := coalesce((v_item.item->>'unit_price')::numeric, 0)
      * coalesce((v_item.item->>'quantity')::numeric, 0)
      - coalesce((v_item.item->>'discount_amount')::numeric, 0);

    -- 金额一致性校验:允许 0.01 元容差(浮点误差)
    if abs(v_item_amount - v_item_expected_amount) > 0.01 then
      raise exception 'ITEM_AMOUNT_MISMATCH' using errcode = 'P0003',
        detail = format('item amount=%s, expected=%s', v_item_amount, v_item_expected_amount);
    end if;

    v_subtotal := v_subtotal + v_item_amount;
  end loop;

  -- 折扣不可超过 subtotal
  if p_discount_amount > v_subtotal then
    raise exception 'DISCOUNT_EXCEEDS_SUBTOTAL' using errcode = 'P0003';
  end if;

  v_total := v_subtotal - p_discount_amount + p_tax_amount;

  -- 写入发票
  insert into public.invoices (
    tenant_id, store_id, invoice_no,
    customer_id, pet_id, encounter_id,
    subtotal, discount_amount, discount_reason, tax_amount, total, paid_amount,
    status, payment_method, due_date, created_by
  )
  values (
    p_tenant_id, p_store_id, v_invoice_no,
    p_customer_id, p_pet_id, p_encounter_id,
    v_subtotal, p_discount_amount, p_discount_reason, p_tax_amount, v_total, 0,
    'draft', p_payment_method, p_due_date, p_operator_id
  )
  returning * into v_invoice;

  -- 写入明细
  v_items_count := 0;
  for v_item in select * from jsonb_array_elements(p_items) as t(item)
  loop
    insert into public.invoice_items (
      tenant_id, invoice_id, catalog_item_id, store_catalog_item_id,
      name, unit_price, quantity, discount_amount, amount, sort_order, category
    )
    values (
      p_tenant_id, v_invoice.id,
      nullif(v_item.item->>'catalog_item_id', '')::uuid,
      nullif(v_item.item->>'store_catalog_item_id', '')::uuid,
      v_item.item->>'name',
      coalesce((v_item.item->>'unit_price')::numeric, 0),
      coalesce((v_item.item->>'quantity')::numeric, 1),
      coalesce((v_item.item->>'discount_amount')::numeric, 0),
      coalesce((v_item.item->>'amount')::numeric, 0),
      coalesce((v_item.item->>'sort_order')::integer, 0),
      coalesce(v_item.item->>'category', 'service')
    );
    v_items_count := v_items_count + 1;
  end loop;

  -- 若折扣比例超过生效阈值(默认 10%),自动创建审批记录(需 manager 审批后才能 confirm)
  v_discount_threshold := coalesce(
    (public.get_effective_setting(p_tenant_id, p_store_id, 'business', 'discount.approval.threshold'))::numeric,
    0.10
  );
  if v_subtotal > 0 and p_discount_amount / v_subtotal > v_discount_threshold then
    insert into public.approvals (
      tenant_id, store_id, entity_type, entity_id,
      requested_by, reason, status, approval_metadata
    )
    values (
      p_tenant_id, p_store_id, 'invoice_discount', v_invoice.id,
      p_operator_id, p_discount_reason, 'pending',
      jsonb_build_object(
        'discount_amount', p_discount_amount,
        'discount_percent', round((p_discount_amount / v_subtotal * 100)::numeric, 2),
        'subtotal', v_subtotal
      )
    );
  end if;

  return jsonb_build_object(
    'invoiceId', v_invoice.id,
    'invoiceNo', v_invoice.invoice_no,
    'total', v_total,
    'itemsCount', v_items_count
  );
end;
$$;

revoke all on function public.create_invoice(uuid, uuid, uuid, uuid, uuid, jsonb, numeric, text, numeric, text, date, uuid) from public;
grant execute on function public.create_invoice(uuid, uuid, uuid, uuid, uuid, jsonb, numeric, text, numeric, text, date, uuid) to authenticated;

-- ===== 3. confirm_invoice:折扣审批判定读取生效阈值(与 create_invoice 同一来源) =====
create or replace function public.confirm_invoice(
  p_invoice_id uuid,
  p_operator_id uuid default null
)
returns public.invoices
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice public.invoices;
  v_pending_approval_count integer;
  v_discount_ratio numeric;
  v_discount_threshold numeric;
begin
  select * into v_invoice from public.invoices where id = p_invoice_id for update;
  if not found then
    raise exception 'INVOICE_NOT_FOUND' using errcode = 'P0002';
  end if;

  if v_invoice.status <> 'draft' then
    raise exception 'INVOICE_STATUS_INVALID' using errcode = 'P0003',
      detail = format('current status=%s, expected=draft', v_invoice.status);
  end if;

  -- 校验大额折扣审批(超过生效阈值需 manager 审批通过)
  v_discount_threshold := coalesce(
    (public.get_effective_setting(v_invoice.tenant_id, v_invoice.store_id, 'business', 'discount.approval.threshold'))::numeric,
    0.10
  );
  if v_invoice.subtotal > 0 and v_invoice.discount_amount / v_invoice.subtotal > v_discount_threshold then
    select count(*) into v_pending_approval_count
    from public.approvals
    where entity_type = 'invoice_discount'
      and entity_id = p_invoice_id
      and status = 'pending';

    if v_pending_approval_count > 0 then
      raise exception 'DISCOUNT_APPROVAL_PENDING' using errcode = 'P0003';
    end if;

    -- 校验是否存在已批准的审批记录
    select count(*) into v_pending_approval_count
    from public.approvals
    where entity_type = 'invoice_discount'
      and entity_id = p_invoice_id
      and status = 'approved';

    if v_pending_approval_count = 0 then
      raise exception 'DISCOUNT_APPROVAL_REQUIRED' using errcode = 'P0003';
    end if;
  end if;

  -- 状态转换:draft → confirmed
  update public.invoices
  set status = 'confirmed',
      confirmed_at = now(),
      confirmed_by = p_operator_id,
      updated_at = now()
  where id = p_invoice_id
  returning * into v_invoice;

  return v_invoice;
end;
$$;

revoke all on function public.confirm_invoice(uuid, uuid) from public;
grant execute on function public.confirm_invoice(uuid, uuid) to authenticated;
