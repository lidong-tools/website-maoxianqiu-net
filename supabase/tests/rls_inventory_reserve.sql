-- ============================================================
-- RLS 测试:inventory reserve 过期/并发边界(AUD-007)
--
-- 覆盖审计 8.2 要求:
--   R1 reserve → 到期 → confirm 必须抛 RESERVATION_EXPIRED(过期即拒绝确认)
--   R2 reserve → 到期 → release worker 释放 → confirm 必须抛 RESERVATION_ALREADY_RELEASED
--   R3 同 reservation 双 confirm → 第二次必须抛 RESERVATION_ALREADY_CONFIRMED
--   R4 同 reservation confirm/release 并发(顺序模拟) → 后到者必须被拒绝
--   R5 两条 reserve 抢最后可用库存 → 后到者必须抛 INSUFFICIENT_STOCK
--   R6 回归:confirm 过期预留时,自身不得被 stale loop 重复 release(release + confirm 双写)
--
-- 执行方式(需要可运行的 Supabase 数据库):
--   1) supabase db reset
--   2) psql "$DATABASE_URL" -f supabase/tests/rls_inventory_reserve.sql
--
-- 依赖:migration 20260807000024/25(confirm 的过期拒绝 + stale loop 排除自身)
-- ============================================================

begin;

-- ---------- 断言辅助 ----------
create schema if not exists tests;
create or replace function tests.assert_true(cond boolean, msg text)
returns void
language plpgsql as $$
begin
  if not cond then
    raise exception 'RLS_TEST_FAILED: %', msg;
  end if;
end;
$$;

-- ---------- 夹具:独立租户/门店/仓库(独立前缀避免与既有测试冲突) ----------
insert into public.tenants (id, slug, name) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'tenant-ares', '预留测试租户')
on conflict (slug) do nothing;

insert into public.stores (id, tenant_id, name, code, status) values
  ('aaaaaaaa-0000-0000-0000-0000000000f1', 'aaaaaaaa-0000-0000-0000-000000000001', 'A1 店', 'A1R', 'active')
on conflict do nothing;

insert into public.warehouses (id, tenant_id, store_id, name, code, is_default, is_active) values
  ('aaaaaaaa-0000-0000-0000-0000000000e1', 'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000f1', 'A1 主仓', 'A1R-W', true, true)
on conflict do nothing;

-- 固定商品 id(跨 migration 无 FK)
-- catalog_item_id: 'aaaaaaaa-0000-0000-0000-0000000000c1'

-- 入库 100(打底)
do $$
begin
  perform public.post_goods_receipt(
    'aaaaaaaa-0000-0000-0000-000000000001'::uuid,
    'aaaaaaaa-0000-0000-0000-0000000000e1'::uuid,
    'aaaaaaaa-0000-0000-0000-0000000000c1'::uuid,
    'BATCH-AR-001', 100, 5.00, current_date + 60, '供应商', null, null, 'idem-ar-setup'
  );
end;
$$;

-- ---------- R1 reserve → 到期 → confirm 必须抛 RESERVATION_EXPIRED ----------
do $$
declare
  v_res jsonb;
  v_movement_id uuid;
  v_reserved numeric;
begin
  -- 预留 30,有效期设为过去(已过期)
  v_res := public.reserve_inventory(
    'aaaaaaaa-0000-0000-0000-000000000001'::uuid,
    'aaaaaaaa-0000-0000-0000-0000000000e1'::uuid,
    'aaaaaaaa-0000-0000-0000-0000000000c1'::uuid,
    30, 'prescription', 'rx-r1', null, 'idem-ar-r1-reserve',
    now() - interval '1 hour'
  );
  v_movement_id := (v_res->>'movementId')::uuid;
  perform tests.assert_true((v_res->>'quantityReserved')::numeric = 30, 'R1a: 预留后 quantity_reserved 应为 30');

  -- confirm 已过期的预留 → RESERVATION_EXPIRED
  begin
    perform public.confirm_inventory_reservation(
      'aaaaaaaa-0000-0000-0000-000000000001'::uuid,
      v_movement_id, null, 'idem-ar-r1-confirm'
    );
    raise exception 'RLS_TEST_FAILED: R1b 过期预留确认应抛 RESERVATION_EXPIRED';
  exception when others then
    if position('RESERVATION_EXPIRED' in sqlerrm) = 0 then
      raise exception 'RLS_TEST_FAILED: R1b 应抛 RESERVATION_EXPIRED,实际: %', sqlerrm;
    end if;
  end;

  -- 过期预留未被 confirm,也不应被 stale loop 自动写入 release(未进入 confirm 流程)
  select quantity_reserved into v_reserved
  from public.inventory_balances
  where warehouse_id = 'aaaaaaaa-0000-0000-0000-0000000000e1' and catalog_item_id = 'aaaaaaaa-0000-0000-0000-0000000000c1';
  perform tests.assert_true(v_reserved = 30, 'R1c: confirm 拒绝后 quantity_reserved 应仍为 30');
  perform tests.assert_true(
    (select count(*) from public.inventory_movements
     where reference_type = 'inventory_reservation' and reference_id = v_movement_id::text and movement_type in ('confirm', 'release')) = 0,
    'R1d: 被拒绝的 confirm 不应产生 confirm/release 流水');
end;
$$;

-- ---------- R2 reserve → 到期 → release worker 释放 → confirm 必须抛 RESERVATION_ALREADY_RELEASED ----------
do $$
declare
  v_movement_id uuid;
  v_reserved numeric;
begin
  -- 直接使用 R1 中已过期的预留,先由 release worker 批量释放
  select id into v_movement_id
  from public.inventory_movements
  where tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001'
    and movement_type = 'reserve'
    and idempotency_key = 'idem-ar-r1-reserve';

  perform public.release_expired_reservations(
    'aaaaaaaa-0000-0000-0000-000000000001'::uuid, null
  );

  select quantity_reserved into v_reserved
  from public.inventory_balances
  where warehouse_id = 'aaaaaaaa-0000-0000-0000-0000000000e1' and catalog_item_id = 'aaaaaaaa-0000-0000-0000-0000000000c1';
  perform tests.assert_true(v_reserved = 0, 'R2a: release worker 释放后 quantity_reserved 应为 0');

  -- 已释放的预留再 confirm → RESERVATION_ALREADY_RELEASED
  begin
    perform public.confirm_inventory_reservation(
      'aaaaaaaa-0000-0000-0000-000000000001'::uuid,
      v_movement_id, null, 'idem-ar-r2-confirm'
    );
    raise exception 'RLS_TEST_FAILED: R2b 已释放预留 confirm 应抛 RESERVATION_ALREADY_RELEASED';
  exception when others then
    if position('RESERVATION_ALREADY_RELEASED' in sqlerrm) = 0 then
      raise exception 'RLS_TEST_FAILED: R2b 应抛 RESERVATION_ALREADY_RELEASED,实际: %', sqlerrm;
    end if;
  end;
end;
$$;

-- ---------- R3 同 reservation 双 confirm → 第二次 RESERVATION_ALREADY_CONFIRMED ----------
do $$
declare
  v_res jsonb;
  v_movement_id uuid;
  v_balance numeric;
begin
  -- 重新预留 10(未过期)
  v_res := public.reserve_inventory(
    'aaaaaaaa-0000-0000-0000-000000000001'::uuid,
    'aaaaaaaa-0000-0000-0000-0000000000e1'::uuid,
    'aaaaaaaa-0000-0000-0000-0000000000c1'::uuid,
    10, 'prescription', 'rx-r3', null, 'idem-ar-r3-reserve',
    now() + interval '1 hour'
  );
  v_movement_id := (v_res->>'movementId')::uuid;

  -- 第一次 confirm 成功(预留转正式扣减)
  perform public.confirm_inventory_reservation(
    'aaaaaaaa-0000-0000-0000-000000000001'::uuid,
    v_movement_id, null, 'idem-ar-r3-confirm-1'
  );

  -- 第二次 confirm → RESERVATION_ALREADY_CONFIRMED
  begin
    perform public.confirm_inventory_reservation(
      'aaaaaaaa-0000-0000-0000-000000000001'::uuid,
      v_movement_id, null, 'idem-ar-r3-confirm-2'
    );
    raise exception 'RLS_TEST_FAILED: R3 双 confirm 第二次应抛 RESERVATION_ALREADY_CONFIRMED';
  exception when others then
    if position('RESERVATION_ALREADY_CONFIRMED' in sqlerrm) = 0 then
      raise exception 'RLS_TEST_FAILED: R3 应抛 RESERVATION_ALREADY_CONFIRMED,实际: %', sqlerrm;
    end if;
  end;

  -- confirm 流水仅 1 条,余额不重复扣减
  perform tests.assert_true(
    (select count(*) from public.inventory_movements
     where reference_type = 'inventory_reservation' and reference_id = v_movement_id::text and movement_type = 'confirm') = 1,
    'R3c: confirm 流水应仅 1 条');
  select quantity_on_hand into v_balance
  from public.inventory_balances
  where warehouse_id = 'aaaaaaaa-0000-0000-0000-0000000000e1' and catalog_item_id = 'aaaaaaaa-0000-0000-0000-0000000000c1';
  perform tests.assert_true(v_balance = 60, 'R3d: confirm 后 quantity_on_hand 应为 60(100-30-10)');
end;
$$;

-- ---------- R4 同 reservation confirm/release 并发(顺序模拟) ----------
do $$
declare
  v_res jsonb;
  v_movement_id uuid;
begin
  v_res := public.reserve_inventory(
    'aaaaaaaa-0000-0000-0000-000000000001'::uuid,
    'aaaaaaaa-0000-0000-0000-0000000000e1'::uuid,
    'aaaaaaaa-0000-0000-0000-0000000000c1'::uuid,
    5, 'prescription', 'rx-r4', null, 'idem-ar-r4-reserve',
    now() + interval '1 hour'
  );
  v_movement_id := (v_res->>'movementId')::uuid;

  -- confirm 先到
  perform public.confirm_inventory_reservation(
    'aaaaaaaa-0000-0000-0000-000000000001'::uuid,
    v_movement_id, null, 'idem-ar-r4-confirm'
  );

  -- release 后到 → RESERVATION_ALREADY_RELEASED(已 confirm 不可再释放)
  begin
    perform public.release_inventory_reservation(
      'aaaaaaaa-0000-0000-0000-000000000001'::uuid,
      v_movement_id, null, 'idem-ar-r4-release'
    );
    raise exception 'RLS_TEST_FAILED: R4 confirm 后 release 应被拒绝';
  exception when others then
    if position('RESERVATION_ALREADY_RELEASED' in sqlerrm) = 0 then
      raise exception 'RLS_TEST_FAILED: R4 应抛 RESERVATION_ALREADY_RELEASED,实际: %', sqlerrm;
    end if;
  end;
end;
$$;

-- ---------- R5 两条 reserve 抢最后可用库存 → 后到者 INSUFFICIENT_STOCK ----------
-- 当前可用:100-30(已过期已释放)-10(已确认)-5(已确认)= 55
-- 第一条 reserve 50 成功;第二条 reserve 10 应失败(可用仅 5)
do $$
declare
  v_second jsonb;
begin
  perform public.reserve_inventory(
    'aaaaaaaa-0000-0000-0000-000000000001'::uuid,
    'aaaaaaaa-0000-0000-0000-0000000000e1'::uuid,
    'aaaaaaaa-0000-0000-0000-0000000000c1'::uuid,
    50, 'prescription', 'rx-r5a', null, 'idem-ar-r5-reserve-a',
    now() + interval '1 hour'
  );

  begin
    v_second := public.reserve_inventory(
      'aaaaaaaa-0000-0000-0000-000000000001'::uuid,
      'aaaaaaaa-0000-0000-0000-0000000000e1'::uuid,
      'aaaaaaaa-0000-0000-0000-0000000000c1'::uuid,
      10, 'prescription', 'rx-r5b', null, 'idem-ar-r5-reserve-b',
      now() + interval '1 hour'
    );
    raise exception 'RLS_TEST_FAILED: R5 第二条 reserve 应抛 INSUFFICIENT_STOCK';
  exception when others then
    if position('INSUFFICIENT_STOCK' in sqlerrm) = 0 then
      raise exception 'RLS_TEST_FAILED: R5 应抛 INSUFFICIENT_STOCK,实际: %', sqlerrm;
    end if;
  end;
end;
$$;

-- ---------- R6 回归:确认过期预留时,自身不得被 stale loop 重复 release ----------
do $$
declare
  v_stale jsonb;
  v_fresh jsonb;
  v_stale_id uuid;
  v_fresh_id uuid;
  v_reserved numeric;
begin
  -- 重新打底:先释放 R5 的 50,再入库 100 → 在库充足
  perform public.release_expired_reservations('aaaaaaaa-0000-0000-0000-000000000001'::uuid, null);
  perform public.post_goods_receipt(
    'aaaaaaaa-0000-0000-0000-000000000001'::uuid,
    'aaaaaaaa-0000-0000-0000-0000000000e1'::uuid,
    'aaaaaaaa-0000-0000-0000-0000000000c1'::uuid,
    'BATCH-AR-002', 100, 5.00, current_date + 90, '供应商', null, null, 'idem-ar-r6-receipt'
  );

  -- 同仓同品:先放一条过期 reserve(20),再放一条未过期 reserve(20)
  v_stale := public.reserve_inventory(
    'aaaaaaaa-0000-0000-0000-000000000001'::uuid,
    'aaaaaaaa-0000-0000-0000-0000000000e1'::uuid,
    'aaaaaaaa-0000-0000-0000-0000000000c1'::uuid,
    20, 'prescription', 'rx-r6-stale', null, 'idem-ar-r6-reserve-stale',
    now() - interval '1 hour'
  );
  v_stale_id := (v_stale->>'movementId')::uuid;
  v_fresh := public.reserve_inventory(
    'aaaaaaaa-0000-0000-0000-000000000001'::uuid,
    'aaaaaaaa-0000-0000-0000-0000000000e1'::uuid,
    'aaaaaaaa-0000-0000-0000-0000000000c1'::uuid,
    20, 'prescription', 'rx-r6-fresh', null, 'idem-ar-r6-reserve-fresh',
    now() + interval '1 hour'
  );
  v_fresh_id := (v_fresh->>'movementId')::uuid;

  -- 确认未过期的 reserve:stale loop 应只释放另一条过期 reserve,不得处理当前确认的这条
  perform public.confirm_inventory_reservation(
    'aaaaaaaa-0000-0000-0000-000000000001'::uuid,
    v_fresh_id, null, 'idem-ar-r6-confirm-fresh'
  );

  -- 被确认的 fresh reserve:只有 1 条 confirm,不允许有 release 流水
  perform tests.assert_true(
    (select count(*) from public.inventory_movements
     where reference_type = 'inventory_reservation' and reference_id = v_fresh_id::text and movement_type = 'confirm') = 1,
    'R6a: fresh reserve 应有且仅 1 条 confirm 流水');
  perform tests.assert_true(
    (select count(*) from public.inventory_movements
     where reference_type = 'inventory_reservation' and reference_id = v_fresh_id::text and movement_type = 'release') = 0,
    'R6b: fresh reserve 不应有 release 流水(自身不得被 stale loop 释放)');

  -- 过期的 stale reserve:confirm 流程中应被自动释放,且只有 release 流水
  perform tests.assert_true(
    (select count(*) from public.inventory_movements
     where reference_type = 'inventory_reservation' and reference_id = v_stale_id::text and movement_type = 'release') = 1,
    'R6c: 过期 stale reserve 应被自动 release');

  -- quantity_reserved 应为 0(fresh 已确认、stale 已释放)
  select quantity_reserved into v_reserved
  from public.inventory_balances
  where warehouse_id = 'aaaaaaaa-0000-0000-0000-0000000000e1' and catalog_item_id = 'aaaaaaaa-0000-0000-0000-0000000000c1';
  perform tests.assert_true(v_reserved = 0, 'R6d: 全部处理后 quantity_reserved 应为 0');
end;
$$;

-- 全部断言通过
select 'RLS_INVENTORY_RESERVE_TEST_PASSED' as result;

rollback;
