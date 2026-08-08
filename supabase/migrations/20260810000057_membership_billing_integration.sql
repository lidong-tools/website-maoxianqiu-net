-- ============================================================
-- 20260810000057_membership_billing_integration.sql
-- Agent-02 会员中心产品化:Billing 真实接入会员折扣
--   - invoice_items 增加 membership_discount_percent 快照列
--   - get_effective_membership_discount:按优先级解析客户有效会员的折扣
--       具体 Catalog Item > Catalog Type > Tier Default
--       同维度下 Store 规则 > Tenant 全门店规则
--   - preview_membership_discount:批量预览(前端收银展示用)
--   - create_invoice 增加 p_apply_membership_discount:服务端权威重算快照
--       历史发票已落库,不受后续会员规则修改影响
-- 应用方式:Supabase SQL Editor 按编号顺序执行(幂等)
-- ============================================================

-- ===== 1. invoice_items 增加会员折扣快照列 =====
alter table public.invoice_items
  add column if not exists membership_discount_percent numeric(5,2);

-- ===== 2. get_effective_membership_discount =====
-- 语义:discount_percent = 收取比例(100 = 不打折,90 = 9折)
-- 输入客户 id + 项目维度,输出 { tier_id, tier_name, discount_percent, source, rule_id }
-- 找不到有效会员或项目时返回 NULL。
create or replace function public.get_effective_membership_discount(
  p_tenant_id uuid,
  p_store_id uuid,
  p_customer_id uuid,
  p_catalog_item_id uuid default null,
  p_catalog_type text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_tier_id uuid;
  v_tier_name text;
  v_tier_discount numeric(5,2);
  v_rule record;
  v_result jsonb;
begin
  -- 1) 客户有效会员(未过期 + 等级启用)
  select cm.tier_id, mt.name, mt.discount_percent
    into v_tier_id, v_tier_name, v_tier_discount
  from public.customer_memberships cm
  join public.membership_tiers mt
    on mt.id = cm.tier_id and mt.tenant_id = p_tenant_id and mt.is_active = true
  where cm.tenant_id = p_tenant_id
    and cm.customer_id = p_customer_id
    and (cm.expires_at is null or cm.expires_at > now())
  limit 1;

  if v_tier_id is null then
    return null;
  end if;

  -- 2) 具体项目规则(优先级最高)
  if p_catalog_item_id is not null then
    select id, discount_percent, store_id, priority, catalog_type, catalog_item_id
      into v_rule
    from public.membership_discount_rules
    where tenant_id = p_tenant_id
      and tier_id = v_tier_id
      and is_active = true
      and catalog_item_id = p_catalog_item_id
      and (store_id = p_store_id or store_id is null)
    order by
      case when store_id = p_store_id then 0 else 1 end,  -- store 优先
      priority asc,
      created_at asc
    limit 1;

    if found then
      v_result := jsonb_build_object(
        'tier_id', v_tier_id, 'tier_name', v_tier_name,
        'discount_percent', v_rule.discount_percent,
        'source', 'catalog_item', 'rule_id', v_rule.id
      );
      return v_result;
    end if;
  end if;

  -- 3) 目录类型规则
  if p_catalog_type is not null then
    select id, discount_percent, store_id, priority
      into v_rule
    from public.membership_discount_rules
    where tenant_id = p_tenant_id
      and tier_id = v_tier_id
      and is_active = true
      and catalog_type = p_catalog_type
      and catalog_item_id is null
      and (store_id = p_store_id or store_id is null)
    order by
      case when store_id = p_store_id then 0 else 1 end,
      priority asc,
      created_at asc
    limit 1;

    if found then
      v_result := jsonb_build_object(
        'tier_id', v_tier_id, 'tier_name', v_tier_name,
        'discount_percent', v_rule.discount_percent,
        'source', 'catalog_type', 'rule_id', v_rule.id
      );
      return v_result;
    end if;
  end if;

  -- 4) 等级默认折扣(最兜底)
  if v_tier_discount is not null and v_tier_discount < 100 then
    return jsonb_build_object(
      'tier_id', v_tier_id, 'tier_name', v_tier_name,
      'discount_percent', v_tier_discount,
      'source', 'tier_default', 'rule_id', null
    );
  end if;

  return null;
end;
$$;

revoke all on function public.get_effective_membership_discount(uuid, uuid, uuid, uuid, text) from public;
grant execute on function public.get_effective_membership_discount(uuid, uuid, uuid, uuid, text) to authenticated;

-- ===== 3. preview_membership_discount:批量定价预览 =====
-- 输入:tenant/store/customer + items[{catalog_item_id?, store_catalog_item_id?, catalog_type?, unit_price, quantity, name?}]
-- 输出:每项 effective 折扣 + 折后金额 + 汇总(会员折扣总额,应收)
create or replace function public.preview_membership_discount(
  p_tenant_id uuid,
  p_store_id uuid,
  p_customer_id uuid,
  p_items jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item record;
  v_eff jsonb;
  v_discount_percent numeric(5,2);
  v_item_discount numeric(12,2);
  v_member_discount_total numeric(12,2) := 0;
  v_amount_total numeric(12,2) := 0;
  v_result_items jsonb := '[]'::jsonb;
  v_catalog_id uuid;
begin
  if p_items is null or jsonb_array_length(p_items) = 0 then
    return jsonb_build_object('items', '[]'::jsonb, 'memberDiscountTotal', 0, 'amountTotal', 0);
  end if;

  for v_item in select * from jsonb_array_elements(p_items) as t(item)
  loop
    v_catalog_id := nullif(v_item.item->>'catalog_item_id', '')::uuid;
    if v_catalog_id is null then
      v_catalog_id := nullif(v_item.item->>'store_catalog_item_id', '')::uuid;
    end if;

    v_eff := public.get_effective_membership_discount(
      p_tenant_id, p_store_id, p_customer_id,
      v_catalog_id,
      nullif(v_item.item->>'catalog_type', '')
    );

    if v_eff is not null then
      v_discount_percent := (v_eff->>'discount_percent')::numeric(5,2);
      v_item_discount := round(
        coalesce((v_item.item->>'unit_price')::numeric, 0)
        * coalesce((v_item.item->>'quantity')::numeric, 1)
        * (100 - v_discount_percent) / 100,
        2
      );
      v_member_discount_total := v_member_discount_total + v_item_discount;
      v_amount_total := v_amount_total
        + coalesce((v_item.item->>'unit_price')::numeric, 0)
        * coalesce((v_item.item->>'quantity')::numeric, 1)
        - v_item_discount;
    else
      v_amount_total := v_amount_total
        + coalesce((v_item.item->>'unit_price')::numeric, 0)
        * coalesce((v_item.item->>'quantity')::numeric, 1);
    end if;

    v_result_items := v_result_items || jsonb_build_object(
      'catalog_item_id', v_catalog_id,
      'name', v_item.item->>'name',
      'unit_price', coalesce((v_item.item->>'unit_price')::numeric, 0),
      'quantity', coalesce((v_item.item->>'quantity')::numeric, 1),
      'discount_percent', coalesce(v_eff->>'discount_percent', '100')::numeric,
      'discount_amount', v_item_discount,
      'source', v_eff->>'source',
      'tier_name', v_eff->>'tier_name'
    );
  end loop;

  return jsonb_build_object(
    'items', v_result_items,
    'memberDiscountTotal', v_member_discount_total,
    'amountTotal', round(v_amount_total, 2)
  );
end;
$$;

revoke all on function public.preview_membership_discount(uuid, uuid, uuid, jsonb) from public;
grant execute on function public.preview_membership_discount(uuid, uuid, uuid, jsonb) to authenticated;

-- ===== 4. create_invoice 服务端权威应用会员折扣 =====
-- 新增可选参数 p_apply_membership_discount:
--   - 启用且客户有有效会员时,服务端按规则重算每个 item 的折扣快照
--   - item.discount_amount = 手动折扣 + 会员折扣(服务端计算)
--   - item.membership_discount_percent 记录应用比例(可追溯)
--   - invoice.discount_amount 仅统计手动折扣(会员折扣不触发审批阈值)
--   - 一致性校验仅在未启用会员折扣时执行(启用时服务端权威)
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
  p_operator_id uuid default null,
  p_apply_membership_discount boolean default false
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
  v_eff jsonb;
  v_eff_discount numeric(5,2);
  v_member_discount numeric(12,2);
  v_manual_discount numeric(12,2);
  v_catalog_id uuid;
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
    v_manual_discount := coalesce((v_item.item->>'discount_amount')::numeric, 0);
    v_item_amount := coalesce((v_item.item->>'amount')::numeric, 0);

    if p_apply_membership_discount and p_customer_id is not null then
      -- 服务端权威:忽略前端 amount,按规则重算(快照)
      v_catalog_id := nullif(v_item.item->>'catalog_item_id', '')::uuid;
      if v_catalog_id is null then
        v_catalog_id := nullif(v_item.item->>'store_catalog_item_id', '')::uuid;
      end if;
      v_eff := public.get_effective_membership_discount(
        p_tenant_id, p_store_id, p_customer_id,
        v_catalog_id,
        nullif(v_item.item->>'catalog_type', '')
      );
      if v_eff is not null then
        v_eff_discount := (v_eff->>'discount_percent')::numeric(5,2);
        v_member_discount := round(
          coalesce((v_item.item->>'unit_price')::numeric, 0)
          * coalesce((v_item.item->>'quantity')::numeric, 1)
          * (100 - v_eff_discount) / 100,
          2
        );
      else
        v_member_discount := 0;
      end if;
      v_item_amount := coalesce((v_item.item->>'unit_price')::numeric, 0)
        * coalesce((v_item.item->>'quantity')::numeric, 1)
        - v_manual_discount - v_member_discount;
      v_item_amount := round(greatest(v_item_amount, 0), 2);
    else
      v_item_expected_amount := coalesce((v_item.item->>'unit_price')::numeric, 0)
        * coalesce((v_item.item->>'quantity')::numeric, 1)
        - v_manual_discount;
      if abs(v_item_amount - v_item_expected_amount) > 0.01 then
        raise exception 'ITEM_AMOUNT_MISMATCH' using errcode = 'P0003',
          detail = format('item amount=%s, expected=%s', v_item_amount, v_item_expected_amount);
      end if;
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
    v_manual_discount := coalesce((v_item.item->>'discount_amount')::numeric, 0);
    v_member_discount := 0;
    v_eff_discount := null;
    v_catalog_id := nullif(v_item.item->>'catalog_item_id', '')::uuid;
    if v_catalog_id is null then
      v_catalog_id := nullif(v_item.item->>'store_catalog_item_id', '')::uuid;
    end if;

    if p_apply_membership_discount and p_customer_id is not null then
      v_eff := public.get_effective_membership_discount(
        p_tenant_id, p_store_id, p_customer_id,
        v_catalog_id,
        nullif(v_item.item->>'catalog_type', '')
      );
      if v_eff is not null then
        v_eff_discount := (v_eff->>'discount_percent')::numeric(5,2);
        v_member_discount := round(
          coalesce((v_item.item->>'unit_price')::numeric, 0)
          * coalesce((v_item.item->>'quantity')::numeric, 1)
          * (100 - v_eff_discount) / 100,
          2
        );
      end if;
    end if;

    v_item_amount := round(greatest(
      coalesce((v_item.item->>'unit_price')::numeric, 0)
      * coalesce((v_item.item->>'quantity')::numeric, 1)
      - v_manual_discount - v_member_discount,
      0
    ), 2);

    insert into public.invoice_items (
      tenant_id, invoice_id, catalog_item_id, store_catalog_item_id,
      name, unit_price, quantity, discount_amount, amount, sort_order, category,
      membership_discount_percent
    )
    values (
      p_tenant_id, v_invoice.id,
      nullif(v_item.item->>'catalog_item_id', '')::uuid,
      nullif(v_item.item->>'store_catalog_item_id', '')::uuid,
      v_item.item->>'name',
      coalesce((v_item.item->>'unit_price')::numeric, 0),
      coalesce((v_item.item->>'quantity')::numeric, 1),
      round(v_manual_discount + v_member_discount, 2),
      v_item_amount,
      coalesce((v_item.item->>'sort_order')::integer, 0),
      coalesce(v_item.item->>'category', 'service'),
      v_eff_discount
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

revoke all on function public.create_invoice(uuid, uuid, uuid, uuid, uuid, jsonb, numeric, text, numeric, text, date, uuid, boolean) from public;
grant execute on function public.create_invoice(uuid, uuid, uuid, uuid, uuid, jsonb, numeric, text, numeric, text, date, uuid, boolean) to authenticated;
