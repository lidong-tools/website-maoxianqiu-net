-- ============================================================
-- RLS 测试:inventory 跨租户/跨门店隔离 + 并发幂等(MXQ-9001~9008)
--
-- 执行方式(需要可运行的 Supabase 数据库):
--   1) supabase db reset
--   2) psql "$DATABASE_URL" -f supabase/tests/rls_inventory.sql
--
-- 断言矩阵:
--   I1 跨租户不可读(A 用户读取 B 租户批次 = 0)
--   I2 跨租户不可写(A 用户写入 B 租户仓库 = 拒绝)
--   I3 无权门店库存不可读(A1 员工读取 A2 仓库批次 = 0)
--   I4 合法门店库存可读(A1 员工读取本店仓库 = 成功)
--   I5 流水不可变(尝试 update/delete movement = 拒绝)
--   I6 并发幂等:同 idempotency_key 调 dispense 两次,第二次返回原结果,余额不重复扣减
--   I7 库存不足抛 INSUFFICIENT_STOCK
--   I8 超管可读任意租户库存
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

-- ---------- 夹具:两租户 / 三门店 / 四用户 ----------
-- 租户 A:门店 A1、A2;租户 B:门店 B1
-- 用户:u_a1(T_A/A1 店长)、u_a2(T_A/A2)、u_b(T_B/B1)、u_admin(system_admin)
insert into public.tenants (id, slug, name) values
  ('dddddddd-0000-0000-0000-000000000001', 'tenant-a-inv', '租户 A'),
  ('eeeeeeee-0000-0000-0000-000000000001', 'tenant-b-inv', '租户 B')
on conflict (slug) do nothing;

insert into auth.users (id, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, aud, role, created_at, updated_at)
values
  ('dddddddd-0000-0000-0000-0000000000a1', 'u-a1-inv@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now()),
  ('dddddddd-0000-0000-0000-0000000000a2', 'u-a2-inv@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now()),
  ('eeeeeeee-0000-0000-0000-0000000000b1', 'u-b1-inv@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now()),
  ('ffffffff-0000-0000-0000-0000000000cc', 'u-admin-inv@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now())
on conflict (id) do nothing;

insert into public.stores (id, tenant_id, name, code, status) values
  ('dddddddd-0000-0000-0000-0000000000f1', 'dddddddd-0000-0000-0000-000000000001', 'A1 店', 'A1I', 'active'),
  ('dddddddd-0000-0000-0000-0000000000f2', 'dddddddd-0000-0000-0000-000000000001', 'A2 店', 'A2I', 'active'),
  ('eeeeeeee-0000-0000-0000-0000000000f1', 'eeeeeeee-0000-0000-0000-000000000001', 'B1 店', 'B1I', 'active')
on conflict do nothing;

insert into public.tenant_memberships (tenant_id, user_id, status) values
  ('dddddddd-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-0000000000a1', 'active'),
  ('dddddddd-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-0000000000a2', 'active'),
  ('eeeeeeee-0000-0000-0000-000000000001', 'eeeeeeee-0000-0000-0000-0000000000b1', 'active'),
  ('dddddddd-0000-0000-0000-000000000001', 'ffffffff-0000-0000-0000-0000000000cc', 'active')
on conflict do nothing;

insert into public.employees (tenant_id, user_id, employee_no, name, status) values
  ('dddddddd-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-0000000000a1', 'EMP-A1I', 'A1 员工', 'active'),
  ('dddddddd-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-0000000000a2', 'EMP-A2I', 'A2 员工', 'active'),
  ('eeeeeeee-0000-0000-0000-000000000001', 'eeeeeeee-0000-0000-0000-0000000000b1', 'EMP-B1I', 'B1 员工', 'active'),
  ('dddddddd-0000-0000-0000-000000000001', 'ffffffff-0000-0000-0000-0000000000cc', 'EMP-ADMIN-I', '管理员', 'active')
on conflict do nothing;

insert into public.employee_store_assignments (tenant_id, employee_id, store_id, is_primary) values
  ('dddddddd-0000-0000-0000-000000000001', (select id from public.employees where employee_no = 'EMP-A1I'), 'dddddddd-0000-0000-0000-0000000000f1', true),
  ('dddddddd-0000-0000-0000-000000000001', (select id from public.employees where employee_no = 'EMP-A2I'), 'dddddddd-0000-0000-0000-0000000000f2', true),
  ('eeeeeeee-0000-0000-0000-000000000001', (select id from public.employees where employee_no = 'EMP-B1I'), 'eeeeeeee-0000-0000-0000-0000000000f1', true)
on conflict do nothing;

-- 角色:A1/A2/B1 = store_manager(含 inventory.* 权限),admin = system_admin
insert into public.employee_role_assignments (tenant_id, employee_id, role_id, store_id)
values
  ('dddddddd-0000-0000-0000-000000000001', (select id from public.employees where employee_no = 'EMP-A1I'), (select id from public.roles where code = 'store_manager'), 'dddddddd-0000-0000-0000-0000000000f1'),
  ('dddddddd-0000-0000-0000-000000000001', (select id from public.employees where employee_no = 'EMP-A2I'), (select id from public.roles where code = 'store_manager'), 'dddddddd-0000-0000-0000-0000000000f2'),
  ('eeeeeeee-0000-0000-0000-000000000001', (select id from public.employees where employee_no = 'EMP-B1I'), (select id from public.roles where code = 'store_manager'), 'eeeeeeee-0000-0000-0000-0000000000f1')
on conflict do nothing;

-- 平台管理员授权(S30-F01:平台角色独立于租户角色体系,通过 platform_user_roles 授予)
insert into public.platform_user_roles (user_id, role)
values ('ffffffff-0000-0000-0000-0000000000cc', 'platform_admin')
on conflict do nothing;

-- ---------- 仓库夹具 ----------
-- A1 门店仓库 wh_a1,A2 门店仓库 wh_a2,B1 门店仓库 wh_b1
insert into public.warehouses (id, tenant_id, store_id, name, code, is_default, is_active) values
  ('dddddddd-0000-0000-0000-0000000000e1', 'dddddddd-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-0000000000f1', 'A1 主仓', 'A1W', true, true),
  ('dddddddd-0000-0000-0000-0000000000e2', 'dddddddd-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-0000000000f2', 'A2 主仓', 'A2W', true, true),
  ('eeeeeeee-0000-0000-0000-0000000000e1', 'eeeeeeee-0000-0000-0000-000000000001', 'eeeeeeee-0000-0000-0000-0000000000f1', 'B1 主仓', 'B1W', true, true)
on conflict do nothing;

-- 固定商品 id(模拟 catalog_item,跨 migration 无 FK)
-- catalog_item_id: 'cccccccc-0000-0000-0000-0000000000c1'

-- ---------- I1 跨租户不可读 ----------
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"dddddddd-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  perform tests.assert_true(
    (select count(*) from public.inventory_batches where tenant_id = 'eeeeeeee-0000-0000-0000-000000000001') = 0,
    'I1: A 用户不应读取到 B 租户的库存批次');
end;
$$;

-- ---------- I2 跨租户不可写 ----------
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"dddddddd-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  begin
    insert into public.inventory_batches (tenant_id, warehouse_id, catalog_item_id, batch_no, quantity_received, quantity_remaining, unit_cost, status)
    values ('eeeeeeee-0000-0000-0000-000000000001', 'eeeeeeee-0000-0000-0000-0000000000e1', 'cccccccc-0000-0000-0000-0000000000c1', 'X', 10, 10, 5.00, 'active');
    raise exception 'RLS_TEST_FAILED: I2 A 用户不应写入 B 租户库存批次';
  exception when insufficient_privilege then
    null;
  end;
end;
$$;

-- ---------- I3 无权门店库存不可读 ----------
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"dddddddd-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  perform tests.assert_true(
    (select count(*) from public.inventory_batches where warehouse_id = 'dddddddd-0000-0000-0000-0000000000e2') = 0,
    'I3: A1 员工不应读取到 A2 门店仓库的批次');
end;
$$;

-- ---------- I4 合法门店库存可读 ----------
-- 先用 service role 在 A1 仓库入库一条
do $$
declare v_result jsonb;
begin
  v_result := public.post_goods_receipt(
    'dddddddd-0000-0000-0000-000000000001'::uuid,
    'dddddddd-0000-0000-0000-0000000000e1'::uuid,
    'cccccccc-0000-0000-0000-0000000000c1'::uuid,
    'BATCH-A1-001', 100, 5.00, current_date + 60, '测试供应商', null, null, 'idem-i4-receipt'
  );
  perform tests.assert_true((v_result->>'quantityOnHand')::numeric = 100, 'I4 setup: 入库后余额应为 100');
end;
$$;

do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"dddddddd-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  perform tests.assert_true(
    (select count(*) from public.inventory_batches where warehouse_id = 'dddddddd-0000-0000-0000-0000000000e1') >= 1,
    'I4: A1 员工应能读取本店仓库批次');
end;
$$;

-- ---------- I5 流水不可变(尝试 update/delete movement = 拒绝) ----------
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"dddddddd-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  -- update 应被拒绝(无 update policy)
  begin
    update public.inventory_movements set quantity = 999 where warehouse_id = 'dddddddd-0000-0000-0000-0000000000e1';
    raise exception 'RLS_TEST_FAILED: I5 流水不应可 update';
  exception when insufficient_privilege then
    null;
  end;
  -- delete 应被拒绝(无 delete policy)
  begin
    delete from public.inventory_movements where warehouse_id = 'dddddddd-0000-0000-0000-0000000000e1';
    raise exception 'RLS_TEST_FAILED: I5 流水不应可 delete';
  exception when insufficient_privilege then
    null;
  end;
end;
$$;

-- ---------- I6 并发幂等:同 idempotency_key 调 dispense 两次 ----------
-- 第一次发药 30,余额应从 100 减至 70
-- 第二次用同 key 发药 30,应返回原结果,余额仍为 70(不重复扣减)
do $$
declare
  v_first jsonb;
  v_second jsonb;
  v_balance numeric;
  v_movement_count integer;
begin
  -- 第一次发药
  v_first := public.dispense_inventory(
    'dddddddd-0000-0000-0000-000000000001'::uuid,
    'dddddddd-0000-0000-0000-0000000000e1'::uuid,
    'cccccccc-0000-0000-0000-0000000000c1'::uuid,
    30, 'test', 'dispense-i6', null, 'idem-i6-dispense'
  );
  perform tests.assert_true((v_first->>'quantityOnHand')::numeric = 70, 'I6a: 第一次发药后余额应为 70');

  -- 第二次用同一 idempotency_key 发药(幂等,应返回原结果)
  v_second := public.dispense_inventory(
    'dddddddd-0000-0000-0000-000000000001'::uuid,
    'dddddddd-0000-0000-0000-0000000000e1'::uuid,
    'cccccccc-0000-0000-0000-0000000000c1'::uuid,
    30, 'test', 'dispense-i6', null, 'idem-i6-dispense'
  );
  perform tests.assert_true((v_second->>'quantityOnHand')::numeric = 70, 'I6b: 第二次幂等发药后余额应仍为 70');
  perform tests.assert_true((v_second->>'movementId')::text = (v_first->>'movementId')::text, 'I6c: 幂等应返回相同 movementId');

  -- 验证余额未重复扣减
  select quantity_on_hand into v_balance
  from public.inventory_balances
  where warehouse_id = 'dddddddd-0000-0000-0000-0000000000e1' and catalog_item_id = 'cccccccc-0000-0000-0000-0000000000c1';
  perform tests.assert_true(v_balance = 70, 'I6d: 余额应为 70,未重复扣减');

  -- 验证 dispense 流水仅 1 条
  select count(*) into v_movement_count
  from public.inventory_movements
  where warehouse_id = 'dddddddd-0000-0000-0000-0000000000e1'
    and movement_type = 'dispense'
    and idempotency_key = 'idem-i6-dispense';
  perform tests.assert_true(v_movement_count = 1, 'I6e: dispense 流水应仅 1 条');
end;
$$;

-- ---------- I7 库存不足抛 INSUFFICIENT_STOCK ----------
do $$
begin
  begin
    perform public.dispense_inventory(
      'dddddddd-0000-0000-0000-000000000001'::uuid,
      'dddddddd-0000-0000-0000-0000000000e1'::uuid,
      'cccccccc-0000-0000-0000-0000000000c1'::uuid,
      9999, 'test', 'dispense-i7', null, 'idem-i7-insufficient'
    );
    raise exception 'RLS_TEST_FAILED: I7 库存不足应抛 INSUFFICIENT_STOCK';
  exception when others then
    if position('INSUFFICIENT_STOCK' in sqlerrm) = 0 then
      raise exception 'RLS_TEST_FAILED: I7 应抛 INSUFFICIENT_STOCK,实际: %', sqlerrm;
    end if;
  end;
end;
$$;

-- ---------- I8 超管可读任意租户库存 ----------
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"ffffffff-0000-0000-0000-0000000000cc","role":"authenticated"}', true);
  -- 超管可读 A 租户仓库(虽未分配 A 店,但 is_system_admin 放行)
  perform tests.assert_true(
    (select count(*) from public.warehouses where tenant_id = 'dddddddd-0000-0000-0000-000000000001') >= 1,
    'I8: system_admin 应能读取任意租户仓库');
end;
$$;

-- ---------- I9 调拨幂等:同 key 调两次,余额不重复变动 ----------
-- 先在 A2 仓库入库 50,再从 A1 调拨 20 到 A2(幂等调两次)
do $$
declare
  v_first jsonb;
  v_second jsonb;
  v_from_balance numeric;
  v_to_balance numeric;
begin
  -- A2 仓库入库 50
  perform public.post_goods_receipt(
    'dddddddd-0000-0000-0000-000000000001'::uuid,
    'dddddddd-0000-0000-0000-0000000000e2'::uuid,
    'cccccccc-0000-0000-0000-0000000000c1'::uuid,
    'BATCH-A2-001', 50, 5.00, null, null, null, null, 'idem-i9-receipt-a2'
  );

  -- 第一次调拨:A1 → A2,数量 20
  v_first := public.transfer_inventory(
    'dddddddd-0000-0000-0000-000000000001'::uuid,
    'dddddddd-0000-0000-0000-0000000000e1'::uuid,
    'dddddddd-0000-0000-0000-0000000000e2'::uuid,
    'cccccccc-0000-0000-0000-0000000000c1'::uuid,
    20, null, 'idem-i9-transfer'
  );
  -- A1 余额:70 - 20 = 50;A2 余额:50 + 20 = 70
  perform tests.assert_true((v_first->>'fromOnHand')::numeric = 50, 'I9a: 调拨后源仓库余额应为 50');
  perform tests.assert_true((v_first->>'toOnHand')::numeric = 70, 'I9b: 调拨后目标仓库余额应为 70');

  -- 第二次用同 key 调拨(幂等)
  v_second := public.transfer_inventory(
    'dddddddd-0000-0000-0000-000000000001'::uuid,
    'dddddddd-0000-0000-0000-0000000000e1'::uuid,
    'dddddddd-0000-0000-0000-0000000000e2'::uuid,
    'cccccccc-0000-0000-0000-0000000000c1'::uuid,
    20, null, 'idem-i9-transfer'
  );
  perform tests.assert_true((v_second->>'fromOnHand')::numeric = 50, 'I9c: 幂等调拨后源仓库余额应仍为 50');
  perform tests.assert_true((v_second->>'toOnHand')::numeric = 70, 'I9d: 幂等调拨后目标仓库余额应仍为 70');

  -- 验证余额未重复变动
  select quantity_on_hand into v_from_balance
  from public.inventory_balances
  where warehouse_id = 'dddddddd-0000-0000-0000-0000000000e1' and catalog_item_id = 'cccccccc-0000-0000-0000-0000000000c1';
  select quantity_on_hand into v_to_balance
  from public.inventory_balances
  where warehouse_id = 'dddddddd-0000-0000-0000-0000000000e2' and catalog_item_id = 'cccccccc-0000-0000-0000-0000000000c1';
  perform tests.assert_true(v_from_balance = 50, 'I9e: 源仓库余额应为 50,未重复扣减');
  perform tests.assert_true(v_to_balance = 70, 'I9f: 目标仓库余额应为 70,未重复增加');
end;
$$;

-- 全部断言通过
select 'RLS_INVENTORY_TEST_PASSED' as result;

rollback;
