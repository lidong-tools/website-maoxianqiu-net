-- ============================================================
-- 20260811000005_points_earn_invoice.sql
-- R-C4(3.4.2.3-07):create_invoice 内新增消费积分获得逻辑
-- 规则:可积分金额(实收 v_total)× points.earn.ratio(每元积分基数,默认 1)
--       × 客户有效会员等级 points_multiplier(无会员/无等级 → 1.00)
-- 幂等:同发票已有 reason='purchase' 的积分流水则跳过(重试/重复调用不重复积分);
--       积分写入与发票创建同一事务,失败整单回滚。
-- 注意:旧迁移 20260810000057 不得修改,此处 CREATE OR REPLACE 覆盖。
-- ============================================================
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
  -- R-4 积分获得
  v_earn_ratio numeric(10,2);
  v_points_multiplier numeric(3,2);
  v_earn_points integer := 0;
  v_existing_points integer;
  v_membership public.customer_memberships;
  v_balance_after integer;
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

  -- ===== R-4 消费积分获得:multiplier × 可积分金额(实收 v_total),发票维度幂等 =====
  if p_customer_id is not null then
    v_earn_ratio := coalesce(
      (public.get_effective_setting(p_tenant_id, p_store_id, 'points', 'earn.ratio'))::numeric,
      1
    );
    if v_earn_ratio <= 0 then
      v_earn_ratio := 1;
    end if;

    -- 幂等:该发票已有 purchase 积分流水则跳过(重试/重复调用不重复积分)
    select coalesce(count(*), 0) into v_existing_points
    from public.point_transactions
    where tenant_id = p_tenant_id
      and customer_id = p_customer_id
      and reference_type = 'invoice'
      and reference_id = v_invoice.id
      and reason = 'purchase';

    if v_existing_points = 0 then
      -- 客户有效会员等级倍率(无会员/无等级/等级停用 → 1.00)
      select coalesce(mt.points_multiplier, 1.00) into v_points_multiplier
      from public.customer_memberships cm
      left join public.membership_tiers mt on mt.id = cm.tier_id and mt.is_active = true
      where cm.tenant_id = p_tenant_id and cm.customer_id = p_customer_id
      limit 1;
      v_points_multiplier := coalesce(v_points_multiplier, 1.00);

      v_earn_points := floor(v_total * v_earn_ratio * v_points_multiplier);
      if v_earn_points > 0 then
        -- 取/建会员积分账户(行锁,与 adjust_points 一致)
        select * into v_membership
        from public.customer_memberships
        where tenant_id = p_tenant_id and customer_id = p_customer_id
        for update;
        if not found then
          insert into public.customer_memberships (tenant_id, customer_id, points_balance)
          values (p_tenant_id, p_customer_id, 0)
          on conflict (tenant_id, customer_id) do nothing
          returning * into v_membership;
          if not found then
            select * into v_membership
            from public.customer_memberships
            where tenant_id = p_tenant_id and customer_id = p_customer_id
            for update;
          end if;
        end if;

        v_balance_after := v_membership.points_balance + v_earn_points;
        update public.customer_memberships
        set points_balance = v_balance_after
        where id = v_membership.id;

        -- 写不可变积分流水(reason=purchase,reference=invoice)
        insert into public.point_transactions (
          tenant_id, customer_id, delta, reason,
          reference_type, reference_id, balance_after, operator_id
        )
        values (
          p_tenant_id, p_customer_id, v_earn_points, 'purchase',
          'invoice', v_invoice.id, v_balance_after, p_operator_id
        );
      end if;
    end if;
  end if;

  return jsonb_build_object(
    'invoiceId', v_invoice.id,
    'invoiceNo', v_invoice.invoice_no,
    'total', v_total,
    'itemsCount', v_items_count,
    'earnPoints', v_earn_points
  );
end;
$$;

revoke all on function public.create_invoice(uuid, uuid, uuid, uuid, uuid, jsonb, numeric, text, numeric, text, date, uuid, boolean) from public;
grant execute on function public.create_invoice(uuid, uuid, uuid, uuid, uuid, jsonb, numeric, text, numeric, text, date, uuid, boolean) to authenticated;
