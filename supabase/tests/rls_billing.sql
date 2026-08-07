-- ============================================================
-- RLS 测试:billing 跨租户/跨门店隔离 + 幂等 + 状态机 + 金额一致性(MXQ-8001~8007)
--
-- 执行方式(需要可运行的 Supabase 数据库):
--   1) supabase db reset
--   2) psql "$DATABASE_URL" -f supabase/tests/rls_billing.sql
--
-- 断言矩阵:
--   B1  跨租户不可读(A 用户读取 B 租户发票 = 0)
--   B2  跨租户不可写(A 用户写入 B 租户发票 = 拒绝)
--   B3  无权门店发票不可读(A1 员工读取 A2 门店发票 = 0)
--   B4  合法门店发票可读(A1 员工读取本店发票 = 成功)
--   B5  支付/退款流水不可变(尝试 update/delete payments/refunds = 拒绝)
--   B6  支付幂等:同 idempotency_key 调 process_payment 两次,paid_amount 不重复增加
--   B7  退款幂等:同 idempotency_key 调 process_refund 两次,paid_amount 不重复扣减
--   B8  状态机:draft → confirmed → paid → refunded;draft → cancelled
--   B9  金额一致性:create_invoice 内校验 item amount 不匹配抛 ITEM_AMOUNT_MISMATCH
--   B10 大额折扣审批:>10% 折扣需 manager 审批,未审批 confirm 抛 DISCOUNT_APPROVAL_PENDING
--   B11 invoice_no 生成:格式 INV-{STORE_CODE}-{YYYYMM}-{6位序号},序号递增
--   B12 超管可读任意租户发票
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
  ('bbbbbbbb-0000-0000-0000-000000000001', 'tenant-a-bill', '租户 A(收银)'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'tenant-b-bill', '租户 B(收银)')
on conflict (slug) do nothing;

insert into auth.users (id, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, aud, role, created_at, updated_at)
values
  ('bbbbbbbb-0000-0000-0000-0000000000a1', 'u-a1-bill@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now()),
  ('bbbbbbbb-0000-0000-0000-0000000000a2', 'u-a2-bill@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now()),
  ('bbbbbbbb-0000-0000-0000-0000000000b1', 'u-b1-bill@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now()),
  ('bbbbbbbb-0000-0000-0000-0000000000cc', 'u-admin-bill@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now())
on conflict (id) do nothing;

insert into public.stores (id, tenant_id, name, code, status) values
  ('bbbbbbbb-0000-0000-0000-0000000000f1', 'bbbbbbbb-0000-0000-0000-000000000001', 'A1 店', 'A1B', 'active'),
  ('bbbbbbbb-0000-0000-0000-0000000000f2', 'bbbbbbbb-0000-0000-0000-000000000001', 'A2 店', 'A2B', 'active'),
  ('bbbbbbbb-0000-0000-0000-0000000000f3', 'bbbbbbbb-0000-0000-0000-000000000002', 'B1 店', 'B1B', 'active')
on conflict do nothing;

insert into public.tenant_memberships (tenant_id, user_id, status) values
  ('bbbbbbbb-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-0000000000a1', 'active'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-0000000000a2', 'active'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'bbbbbbbb-0000-0000-0000-0000000000b1', 'active'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-0000000000cc', 'active')
on conflict do nothing;

insert into public.employees (tenant_id, user_id, employee_no, name, status) values
  ('bbbbbbbb-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-0000000000a1', 'EMP-A1B', 'A1 收银员', 'active'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-0000000000a2', 'EMP-A2B', 'A2 收银员', 'active'),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'bbbbbbbb-0000-0000-0000-0000000000b1', 'EMP-B1B', 'B1 收银员', 'active'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-0000000000cc', 'EMP-ADMIN-B', '管理员', 'active')
on conflict do nothing;

insert into public.employee_store_assignments (tenant_id, employee_id, store_id, is_primary) values
  ('bbbbbbbb-0000-0000-0000-000000000001', (select id from public.employees where employee_no = 'EMP-A1B'), 'bbbbbbbb-0000-0000-0000-0000000000f1', true),
  ('bbbbbbbb-0000-0000-0000-000000000001', (select id from public.employees where employee_no = 'EMP-A2B'), 'bbbbbbbb-0000-0000-0000-0000000000f2', true),
  ('bbbbbbbb-0000-0000-0000-000000000002', (select id from public.employees where employee_no = 'EMP-B1B'), 'bbbbbbbb-0000-0000-0000-0000000000f3', true)
on conflict do nothing;

-- 角色:A1/A2/B1 = store_manager(含 billing.* 权限),admin = system_admin
insert into public.employee_role_assignments (tenant_id, employee_id, role_id, store_id)
values
  ('bbbbbbbb-0000-0000-0000-000000000001', (select id from public.employees where employee_no = 'EMP-A1B'), (select id from public.roles where code = 'store_manager'), 'bbbbbbbb-0000-0000-0000-0000000000f1'),
  ('bbbbbbbb-0000-0000-0000-000000000001', (select id from public.employees where employee_no = 'EMP-A2B'), (select id from public.roles where code = 'store_manager'), 'bbbbbbbb-0000-0000-0000-0000000000f2'),
  ('bbbbbbbb-0000-0000-0000-000000000002', (select id from public.employees where employee_no = 'EMP-B1B'), (select id from public.roles where code = 'store_manager'), 'bbbbbbbb-0000-0000-0000-0000000000f3')
on conflict do nothing;

-- 平台管理员授权(S30-F01:平台角色独立于租户角色体系,通过 platform_user_roles 授予)
insert into public.platform_user_roles (user_id, role)
values ('bbbbbbbb-0000-0000-0000-0000000000cc', 'platform_admin')
on conflict do nothing;


-- ============================================================
-- B11 invoice_no 生成:格式 INV-{STORE_CODE}-{YYYYMM}-{6位序号},序号递增
-- ============================================================
do $$
declare
  v_no1 text;
  v_no2 text;
  v_period text := to_char(now(), 'YYYYMM');
begin
  v_no1 := public.generate_invoice_no(
    'bbbbbbbb-0000-0000-0000-000000000001'::uuid,
    'bbbbbbbb-0000-0000-0000-0000000000f1'::uuid
  );
  -- 校验格式:INV-A1B-{YYYYMM}-000001
  perform tests.assert_true(
    v_no1 = 'INV-A1B-' || v_period || '-000001',
    'B11a: 第一张发票号格式应为 INV-A1B-' || v_period || '-000001,实际: ' || v_no1
  );

  v_no2 := public.generate_invoice_no(
    'bbbbbbbb-0000-0000-0000-000000000001'::uuid,
    'bbbbbbbb-0000-0000-0000-0000000000f1'::uuid
  );
  perform tests.assert_true(
    v_no2 = 'INV-A1B-' || v_period || '-000002',
    'B11b: 第二张发票号序号应递增为 000002,实际: ' || v_no2
  );
end;
$$;


-- ============================================================
-- B9 金额一致性:create_invoice 校验 item amount 不匹配抛 ITEM_AMOUNT_MISMATCH
-- ============================================================
do $$
begin
  begin
    -- item amount 故意填错:unit_price=100 * qty=2 - discount=0 = 200,但 amount 填 999
    perform public.create_invoice(
      'bbbbbbbb-0000-0000-0000-000000000001'::uuid,
      'bbbbbbbb-0000-0000-0000-0000000000f1'::uuid,
      null, null, null,
      '[{"name":"测试项目","unit_price":100,"quantity":2,"discount_amount":0,"amount":999,"category":"service"}]'::jsonb,
      0, null, 0, null, null, null
    );
    raise exception 'RLS_TEST_FAILED: B9 金额不一致应抛 ITEM_AMOUNT_MISMATCH';
  exception when others then
    if position('ITEM_AMOUNT_MISMATCH' in sqlerrm) = 0 then
      raise exception 'RLS_TEST_FAILED: B9 应抛 ITEM_AMOUNT_MISMATCH,实际: %', sqlerrm;
    end if;
  end;
end;
$$;


-- ============================================================
-- 创建测试发票(B4/B6/B7/B8 共用)
-- 发票 INV-TEST-1:subtotal=200,total=200,用于状态机 + 支付幂等测试
-- ============================================================
do $$
declare
  v_result jsonb;
begin
  v_result := public.create_invoice(
    'bbbbbbbb-0000-0000-0000-000000000001'::uuid,
    'bbbbbbbb-0000-0000-0000-0000000000f1'::uuid,
    null, null, null,
    '[{"name":"诊疗费","unit_price":200,"quantity":1,"discount_amount":0,"amount":200,"category":"service","sort_order":1}]'::jsonb,
    0, null, 0, 'cash', null,
    'bbbbbbbb-0000-0000-0000-0000000000a1'::uuid
  );
  perform tests.assert_true((v_result->>'total')::numeric = 200, 'B4 setup: 发票总额应为 200');
  perform tests.assert_true((v_result->>'itemsCount')::integer = 1, 'B4 setup: 明细数应为 1');
end;
$$;


-- ============================================================
-- B4 合法门店发票可读(A1 员工读取本店发票)
-- ============================================================
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  perform tests.assert_true(
    (select count(*) from public.invoices
     where tenant_id = 'bbbbbbbb-0000-0000-0000-000000000001'
       and store_id = 'bbbbbbbb-0000-0000-0000-0000000000f1') >= 1,
    'B4: A1 员工应能读取本店发票');
end;
$$;


-- ============================================================
-- B1 跨租户不可读(A 用户读取 B 租户发票 = 0)
-- ============================================================
-- 先在 B 租户创建一张发票(service role)
do $$
declare
  v_result jsonb;
begin
  v_result := public.create_invoice(
    'bbbbbbbb-0000-0000-0000-000000000002'::uuid,
    'bbbbbbbb-0000-0000-0000-0000000000f3'::uuid,
    null, null, null,
    '[{"name":"B租户项目","unit_price":50,"quantity":1,"discount_amount":0,"amount":50,"category":"service"}]'::jsonb,
    0, null, 0, null, null, null
  );
  perform tests.assert_true((v_result->>'total')::numeric = 50, 'B1 setup: B 租户发票应为 50');
end;
$$;

do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  perform tests.assert_true(
    (select count(*) from public.invoices where tenant_id = 'bbbbbbbb-0000-0000-0000-000000000002') = 0,
    'B1: A 用户不应读取到 B 租户的发票');
end;
$$;


-- ============================================================
-- B2 跨租户不可写(A 用户写入 B 租户发票 = 拒绝)
-- ============================================================
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  begin
    insert into public.invoices (tenant_id, store_id, invoice_no, subtotal, total, status)
    values ('bbbbbbbb-0000-0000-0000-000000000002', 'bbbbbbbb-0000-0000-0000-0000000000f3', 'INV-X-CROSS', 10, 10, 'draft');
    raise exception 'RLS_TEST_FAILED: B2 A 用户不应写入 B 租户发票';
  exception when insufficient_privilege then
    null;
  end;
end;
$$;


-- ============================================================
-- B3 无权门店发票不可读(A1 员工读取 A2 门店发票 = 0)
-- ============================================================
-- 先在 A2 门店创建发票(service role)
do $$
declare
  v_result jsonb;
begin
  v_result := public.create_invoice(
    'bbbbbbbb-0000-0000-0000-000000000001'::uuid,
    'bbbbbbbb-0000-0000-0000-0000000000f2'::uuid,
    null, null, null,
    '[{"name":"A2项目","unit_price":80,"quantity":1,"discount_amount":0,"amount":80,"category":"service"}]'::jsonb,
    0, null, 0, null, null, null
  );
  perform tests.assert_true((v_result->>'total')::numeric = 80, 'B3 setup: A2 门店发票应为 80');
end;
$$;

do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  perform tests.assert_true(
    (select count(*) from public.invoices where store_id = 'bbbbbbbb-0000-0000-0000-0000000000f2') = 0,
    'B3: A1 员工不应读取到 A2 门店的发票');
end;
$$;


-- ============================================================
-- B8 状态机:draft → confirmed → paid → refunded;draft → cancelled
-- ============================================================
-- 发票 1:draft → confirmed → paid → refunded
do $$
declare
  v_invoice_id uuid;
  v_result jsonb;
  v_confirmed public.invoices;
  v_status text;
begin
  -- 创建发票
  v_result := public.create_invoice(
    'bbbbbbbb-0000-0000-0000-000000000001'::uuid,
    'bbbbbbbb-0000-0000-0000-0000000000f1'::uuid,
    null, null, null,
    '[{"name":"状态机测试","unit_price":100,"quantity":1,"discount_amount":0,"amount":100,"category":"service"}]'::jsonb,
    0, null, 0, null, null, null
  );
  v_invoice_id := (v_result->>'invoiceId')::uuid;

  -- 初始状态应为 draft
  select status into v_status from public.invoices where id = v_invoice_id;
  perform tests.assert_true(v_status = 'draft', 'B8a: 初始状态应为 draft');

  -- draft → confirmed
  select * into v_confirmed from public.confirm_invoice(v_invoice_id, 'bbbbbbbb-0000-0000-0000-0000000000a1'::uuid);
  perform tests.assert_true(v_confirmed.status = 'confirmed', 'B8b: 确认后状态应为 confirmed');

  -- confirmed → paid(全额支付)
  v_result := public.process_payment(v_invoice_id, 100, 'cash', 'bbbbbbbb-0000-0000-0000-0000000000a1'::uuid, 'idem-b8-pay', null);
  perform tests.assert_true((v_result->>'status')::text = 'paid', 'B8c: 全额支付后状态应为 paid');

  -- paid → refunded(全额退款)
  v_result := public.process_refund(v_invoice_id, 100, '测试退款', 'bbbbbbbb-0000-0000-0000-0000000000a1'::uuid, 'idem-b8-refund', null);
  perform tests.assert_true((v_result->>'status')::text = 'refunded', 'B8d: 全额退款后状态应为 refunded');
end;
$$;

-- 发票 2:draft → cancelled
do $$
declare
  v_result jsonb;
  v_invoice_id uuid;
  v_cancelled public.invoices;
begin
  v_result := public.create_invoice(
    'bbbbbbbb-0000-0000-0000-000000000001'::uuid,
    'bbbbbbbb-0000-0000-0000-0000000000f1'::uuid,
    null, null, null,
    '[{"name":"取消测试","unit_price":50,"quantity":1,"discount_amount":0,"amount":50,"category":"service"}]'::jsonb,
    0, null, 0, null, null, null
  );
  v_invoice_id := (v_result->>'invoiceId')::uuid;

  -- draft → cancelled
  select * into v_cancelled from public.cancel_invoice(v_invoice_id, 'bbbbbbbb-0000-0000-0000-0000000000a1'::uuid, '测试取消');
  perform tests.assert_true(v_cancelled.status = 'cancelled', 'B8e: 取消后状态应为 cancelled');
end;
$$;

-- 状态机非法转换:paid 状态不可 cancel
do $$
declare
  v_result jsonb;
  v_invoice_id uuid;
begin
  v_result := public.create_invoice(
    'bbbbbbbb-0000-0000-0000-000000000001'::uuid,
    'bbbbbbbb-0000-0000-0000-0000000000f1'::uuid,
    null, null, null,
    '[{"name":"非法取消测试","unit_price":50,"quantity":1,"discount_amount":0,"amount":50,"category":"service"}]'::jsonb,
    0, null, 0, null, null, null
  );
  v_invoice_id := (v_result->>'invoiceId')::uuid;
  perform public.confirm_invoice(v_invoice_id, null);
  perform public.process_payment(v_invoice_id, 50, 'cash', null, 'idem-b8-cancel-invalid', null);

  begin
    perform public.cancel_invoice(v_invoice_id, null, '尝试取消已支付');
    raise exception 'RLS_TEST_FAILED: B8f 已支付发票不应可取消';
  exception when others then
    if position('INVOICE_STATUS_INVALID' in sqlerrm) = 0 then
      raise exception 'RLS_TEST_FAILED: B8f 应抛 INVOICE_STATUS_INVALID,实际: %', sqlerrm;
    end if;
  end;
end;
$$;


-- ============================================================
-- B6 支付幂等:同 idempotency_key 调 process_payment 两次
-- 第一次支付 60,第二次用同 key 应返回原结果,paid_amount 不重复增加
-- ============================================================
do $$
declare
  v_result jsonb;
  v_invoice_id uuid;
  v_first jsonb;
  v_second jsonb;
  v_paid_amount numeric;
  v_payment_count integer;
begin
  -- 创建并确认发票(total=120)
  v_result := public.create_invoice(
    'bbbbbbbb-0000-0000-0000-000000000001'::uuid,
    'bbbbbbbb-0000-0000-0000-0000000000f1'::uuid,
    null, null, null,
    '[{"name":"幂等支付测试","unit_price":120,"quantity":1,"discount_amount":0,"amount":120,"category":"service"}]'::jsonb,
    0, null, 0, null, null, null
  );
  v_invoice_id := (v_result->>'invoiceId')::uuid;
  perform public.confirm_invoice(v_invoice_id, null);

  -- 第一次支付 60(部分支付)
  v_first := public.process_payment(v_invoice_id, 60, 'cash', null, 'idem-b6-payment', null);
  perform tests.assert_true((v_first->>'paidAmount')::numeric = 60, 'B6a: 第一次支付后 paid_amount 应为 60');
  perform tests.assert_true((v_first->>'status')::text = 'partially_paid', 'B6b: 部分支付后状态应为 partially_paid');

  -- 第二次用同一 idempotency_key 支付(幂等,应返回原结果)
  v_second := public.process_payment(v_invoice_id, 60, 'cash', null, 'idem-b6-payment', null);
  perform tests.assert_true((v_second->>'paidAmount')::numeric = 60, 'B6c: 幂等支付后 paid_amount 应仍为 60');
  perform tests.assert_true((v_second->>'paymentId')::text = (v_first->>'paymentId')::text, 'B6d: 幂等应返回相同 paymentId');

  -- 验证 paid_amount 未重复增加
  select paid_amount into v_paid_amount from public.invoices where id = v_invoice_id;
  perform tests.assert_true(v_paid_amount = 60, 'B6e: 发票 paid_amount 应为 60,未重复增加');

  -- 验证支付记录仅 1 条
  select count(*) into v_payment_count from public.payments
  where invoice_id = v_invoice_id and idempotency_key = 'idem-b6-payment';
  perform tests.assert_true(v_payment_count = 1, 'B6f: 支付记录应仅 1 条');
end;
$$;


-- ============================================================
-- B7 退款幂等:同 idempotency_key 调 process_refund 两次
-- 先全额支付,再退款 40,第二次用同 key 应返回原结果,paid_amount 不重复扣减
-- ============================================================
do $$
declare
  v_result jsonb;
  v_invoice_id uuid;
  v_first jsonb;
  v_second jsonb;
  v_paid_amount numeric;
  v_refund_count integer;
begin
  -- 创建、确认、全额支付发票(total=100)
  v_result := public.create_invoice(
    'bbbbbbbb-0000-0000-0000-000000000001'::uuid,
    'bbbbbbbb-0000-0000-0000-0000000000f1'::uuid,
    null, null, null,
    '[{"name":"幂等退款测试","unit_price":100,"quantity":1,"discount_amount":0,"amount":100,"category":"service"}]'::jsonb,
    0, null, 0, null, null, null
  );
  v_invoice_id := (v_result->>'invoiceId')::uuid;
  perform public.confirm_invoice(v_invoice_id, null);
  perform public.process_payment(v_invoice_id, 100, 'cash', null, 'idem-b7-pay', null);

  -- 第一次退款 40(部分退款)
  v_first := public.process_refund(v_invoice_id, 40, '测试退款', null, 'idem-b7-refund', null);
  perform tests.assert_true((v_first->>'paidAmount')::numeric = 60, 'B7a: 第一次退款后 paid_amount 应为 60');
  perform tests.assert_true((v_first->>'status')::text = 'partially_paid', 'B7b: 部分退款后状态应为 partially_paid');

  -- 第二次用同一 idempotency_key 退款(幂等)
  v_second := public.process_refund(v_invoice_id, 40, '测试退款', null, 'idem-b7-refund', null);
  perform tests.assert_true((v_second->>'paidAmount')::numeric = 60, 'B7c: 幂等退款后 paid_amount 应仍为 60');
  perform tests.assert_true((v_second->>'refundId')::text = (v_first->>'refundId')::text, 'B7d: 幂等应返回相同 refundId');

  -- 验证 paid_amount 未重复扣减
  select paid_amount into v_paid_amount from public.invoices where id = v_invoice_id;
  perform tests.assert_true(v_paid_amount = 60, 'B7e: 发票 paid_amount 应为 60,未重复扣减');

  -- 验证退款记录仅 1 条
  select count(*) into v_refund_count from public.refunds
  where invoice_id = v_invoice_id and idempotency_key = 'idem-b7-refund';
  perform tests.assert_true(v_refund_count = 1, 'B7f: 退款记录应仅 1 条');
end;
$$;


-- ============================================================
-- B10 大额折扣审批:>10% 折扣需 manager 审批
--   - create_invoice 自动创建 pending approval
--   - 未审批 confirm 抛 DISCOUNT_APPROVAL_PENDING
--   - approve_discount 后 confirm 成功
-- ============================================================
do $$
declare
  v_result jsonb;
  v_invoice_id uuid;
  v_approval_id uuid;
  v_approval public.approvals;
  v_confirmed public.invoices;
  v_approval_count integer;
begin
  -- 创建发票:subtotal=100, discount=20(20% > 10%,需审批)
  v_result := public.create_invoice(
    'bbbbbbbb-0000-0000-0000-000000000001'::uuid,
    'bbbbbbbb-0000-0000-0000-0000000000f1'::uuid,
    null, null, null,
    '[{"name":"大额折扣测试","unit_price":100,"quantity":1,"discount_amount":0,"amount":100,"category":"service"}]'::jsonb,
    20, 'VIP 客户折扣', 0, null, null, null
  );
  v_invoice_id := (v_result->>'invoiceId')::uuid;
  perform tests.assert_true((v_result->>'total')::numeric = 80, 'B10a: 折扣后总额应为 80(100-20)');

  -- 验证自动创建了 pending approval
  select count(*) into v_approval_count from public.approvals
  where entity_type = 'invoice_discount' and entity_id = v_invoice_id and status = 'pending';
  perform tests.assert_true(v_approval_count = 1, 'B10b: 大额折扣应自动创建 1 条 pending 审批');

  -- 未审批时 confirm 应抛 DISCOUNT_APPROVAL_PENDING
  begin
    perform public.confirm_invoice(v_invoice_id, null);
    raise exception 'RLS_TEST_FAILED: B10c 未审批的大额折扣不应可 confirm';
  exception when others then
    if position('DISCOUNT_APPROVAL_PENDING' in sqlerrm) = 0 then
      raise exception 'RLS_TEST_FAILED: B10c 应抛 DISCOUNT_APPROVAL_PENDING,实际: %', sqlerrm;
    end if;
  end;

  -- 审批通过
  select id into v_approval_id from public.approvals
  where entity_type = 'invoice_discount' and entity_id = v_invoice_id and status = 'pending'
  limit 1;
  select * into v_approval from public.approve_discount(v_approval_id, 'approved', 'bbbbbbbb-0000-0000-0000-0000000000a1'::uuid, '同意折扣');
  perform tests.assert_true(v_approval.status = 'approved', 'B10d: 审批状态应为 approved');

  -- 审批通过后 confirm 成功
  select * into v_confirmed from public.confirm_invoice(v_invoice_id, null);
  perform tests.assert_true(v_confirmed.status = 'confirmed', 'B10e: 审批通过后 confirm 应成功');
end;
$$;

-- 小额折扣(<=10%)无需审批
do $$
declare
  v_result jsonb;
  v_invoice_id uuid;
  v_confirmed public.invoices;
  v_approval_count integer;
begin
  -- 创建发票:subtotal=100, discount=10(10% = 10%,无需审批)
  v_result := public.create_invoice(
    'bbbbbbbb-0000-0000-0000-000000000001'::uuid,
    'bbbbbbbb-0000-0000-0000-0000000000f1'::uuid,
    null, null, null,
    '[{"name":"小额折扣测试","unit_price":100,"quantity":1,"discount_amount":0,"amount":100,"category":"service"}]'::jsonb,
    10, '常规折扣', 0, null, null, null
  );
  v_invoice_id := (v_result->>'invoiceId')::uuid;

  -- 验证未创建 approval
  select count(*) into v_approval_count from public.approvals
  where entity_type = 'invoice_discount' and entity_id = v_invoice_id;
  perform tests.assert_true(v_approval_count = 0, 'B10f: 小额折扣(<=10%)不应创建审批');

  -- 直接 confirm 成功(无需审批)
  select * into v_confirmed from public.confirm_invoice(v_invoice_id, null);
  perform tests.assert_true(v_confirmed.status = 'confirmed', 'B10g: 小额折扣应可直接 confirm');
end;
$$;


-- ============================================================
-- B5 支付/退款流水不可变(update/delete 拒绝)
-- ============================================================
do $$
declare
  v_payment_id uuid;
  v_refund_id uuid;
begin
  -- 准备:创建、确认、支付、退款的发票(service role)
  declare
    v_result jsonb;
    v_invoice_id uuid;
  begin
    v_result := public.create_invoice(
      'bbbbbbbb-0000-0000-0000-000000000001'::uuid,
      'bbbbbbbb-0000-0000-0000-0000000000f1'::uuid,
      null, null, null,
      '[{"name":"流水不可变测试","unit_price":100,"quantity":1,"discount_amount":0,"amount":100,"category":"service"}]'::jsonb,
      0, null, 0, null, null, null
    );
    v_invoice_id := (v_result->>'invoiceId')::uuid;
    perform public.confirm_invoice(v_invoice_id, null);
    v_result := public.process_payment(v_invoice_id, 100, 'cash', null, 'idem-b5-pay', null);
    v_payment_id := (v_result->>'paymentId')::uuid;
    v_result := public.process_refund(v_invoice_id, 30, '流水测试退款', null, 'idem-b5-refund', null);
    v_refund_id := (v_result->>'refundId')::uuid;
  end;

  -- 以 authenticated 身份尝试 update/delete payments
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-0000-0000-0000000000a1","role":"authenticated"}', true);

  -- update payments 应被拒绝(无 update policy)
  begin
    update public.payments set amount = 999 where id = v_payment_id;
    raise exception 'RLS_TEST_FAILED: B5a 支付流水不应可 update';
  exception when insufficient_privilege then
    null;
  end;

  -- delete payments 应被拒绝(无 delete policy)
  begin
    delete from public.payments where id = v_payment_id;
    raise exception 'RLS_TEST_FAILED: B5b 支付流水不应可 delete';
  exception when insufficient_privilege then
    null;
  end;

  -- update refunds 应被拒绝
  begin
    update public.refunds set amount = 999 where id = v_refund_id;
    raise exception 'RLS_TEST_FAILED: B5c 退款流水不应可 update';
  exception when insufficient_privilege then
    null;
  end;

  -- delete refunds 应被拒绝
  begin
    delete from public.refunds where id = v_refund_id;
    raise exception 'RLS_TEST_FAILED: B5d 退款流水不应可 delete';
  exception when insufficient_privilege then
    null;
  end;
end;
$$;


-- ============================================================
-- B12 超管可读任意租户发票
-- ============================================================
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-0000-0000-0000000000cc","role":"authenticated"}', true);
  -- 超管可读 A 租户发票(虽未分配 A 店,但 is_system_admin 放行)
  perform tests.assert_true(
    (select count(*) from public.invoices where tenant_id = 'bbbbbbbb-0000-0000-0000-000000000001') >= 1,
    'B12: system_admin 应能读取任意租户发票');
  -- 超管可读 B 租户发票
  perform tests.assert_true(
    (select count(*) from public.invoices where tenant_id = 'bbbbbbbb-0000-0000-0000-000000000002') >= 1,
    'B12: system_admin 应能读取 B 租户发票');
end;
$$;


-- ============================================================
-- 附加:generate_receipt 生成小票数据完整性(MXQ-8007)
-- ============================================================
do $$
declare
  v_result jsonb;
  v_invoice_id uuid;
  v_create_result jsonb;
begin
  -- 创建、确认、支付
  v_create_result := public.create_invoice(
    'bbbbbbbb-0000-0000-0000-000000000001'::uuid,
    'bbbbbbbb-0000-0000-0000-0000000000f1'::uuid,
    null, null, null,
    '[{"name":"小票测试项目","unit_price":150,"quantity":2,"discount_amount":30,"amount":270,"category":"service","sort_order":1}]'::jsonb,
    0, null, 0, 'cash', null, null
  );
  v_invoice_id := (v_create_result->>'invoiceId')::uuid;
  perform public.confirm_invoice(v_invoice_id, null);
  perform public.process_payment(v_invoice_id, 270, 'cash', null, 'idem-b-receipt', null);

  -- 生成小票
  v_result := public.generate_receipt(v_invoice_id);

  -- 校验小票字段完整性
  perform tests.assert_true((v_result->>'invoiceNo') is not null, 'R1: 小票应包含 invoiceNo');
  perform tests.assert_true((v_result->>'total')::numeric = 270, 'R2: 小票 total 应为 270');
  perform tests.assert_true((v_result->>'paidAmount')::numeric = 270, 'R3: 小票 paidAmount 应为 270');
  perform tests.assert_true(jsonb_array_length(v_result->'items') = 1, 'R4: 小票应包含 1 条明细');
  perform tests.assert_true(jsonb_array_length(v_result->'payments') = 1, 'R5: 小票应包含 1 条支付记录');
  perform tests.assert_true((v_result->'store'->>'name') is not null, 'R6: 小票应包含门店名称');
  perform tests.assert_true((v_result->>'change')::numeric = 0, 'R7: 找零应为 0(足额支付)');
end;
$$;


-- 全部断言通过
select 'RLS_BILLING_TEST_PASSED' as result;

rollback;
