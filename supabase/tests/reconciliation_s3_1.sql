-- ============================================================
-- 对账测试:S31-PARALLEL-B Reconciliation(migration 41 + 42 + 43)
--
-- 验证 migration 41(reconciliation_base)+ 42(reconciliation_rpc)
-- + 43(payment_channel_summary):
--   - 权限码 seed + 角色授权矩阵(system_admin/tenant_owner/store_manager 全量、
--     cashier 只读、doctor 无财务管理权限)
--   - save_reconciliation_actual:日结未关闭拒绝(CLOSING_REQUIRED)、
--     system_expected 由日结快照推导(不信任客户端)、
--     difference = actual - expected(0 -> matched,否则 pending)、
--     非法渠道/负数金额拒绝、更新路径、已确认记录锁定
--   - confirm_reconciliation:无差异 -> confirmed、有差异必填原因
--     (DIFFERENCE_REASON_REQUIRED)、有原因 -> difference_confirmed、
--     重复确认拒绝(RECONCILIATION_ALREADY_CONFIRMED)
--   - get_payment_channel_summary:真实 payments/refunds 聚合、退款按
--     关联支付渠道归并、附日结快照期望值
--   - RLS:对账只读策略(租户成员 + 门店范围 + reconciliation.read)
--   - 审计:actual_update / confirm(含 reason/actor/timestamp/request_id)
--
-- 本文件独立可执行(psql "$DATABASE_URL" -f supabase/tests/reconciliation_s3_1.sql):
--   - 自建 tests.assert_* 断言函数,不依赖其他测试文件;
--   - 单一事务 begin/rollback,无任何残留;
--   - RLS/权限断言使用 set local role authenticated + jwt claims。
-- ============================================================

begin;

create schema if not exists tests;
grant usage on schema tests to authenticated, anon, service_role;

create or replace function tests.assert_true(cond boolean, msg text)
returns void
language plpgsql as $$
begin
  if not cond then
    raise exception 'RECONCILIATION_TEST_FAILED: %', msg;
  end if;
end;
$$;

-- 期望:SQL 执行抛出包含指定文本的错误;无异常/不含文本均判失败
create or replace function tests.assert_raises(p_sql text, p_expected text, p_name text)
returns void
language plpgsql as $$
declare
  v_msg text;
begin
  begin
    execute p_sql;
  exception when others then
    v_msg := sqlerrm;
  end;
  if v_msg is null or position(p_expected in coalesce(v_msg, '')) = 0 then
    raise exception 'RECONCILIATION_TEST_FAILED: % 应抛出含 % 的错误,实际: %',
      p_name, p_expected, coalesce(v_msg, '无异常(调用成功)');
  end if;
end;
$$;

-- ============================================================
-- 夹具:租户/门店/用户/员工/角色分配/发票/支付/退款 + 已关账日结
-- 复用日结测试 fixture 语义:
--   门店 A(租户A) 2026-07-15:gross=600 paid=330 refund=50 receivable=320
--     cash=100 wechat=230
--   门店 A2(租户A) 2026-07-15:gross=700 cash=700(已关账)
-- 用户/员工:店长 e1->e2、收银 c1->c2、无权限 f1->f2、租户所有者 o1->o2
-- ============================================================
insert into public.tenants (id, slug, name)
values ('99999999-0000-0000-0000-000000000031', 's31-rec-tenant', '对账测试租户')
on conflict (slug) do nothing;

insert into public.stores (id, tenant_id, name, code, status)
values
  ('99999999-0000-0000-0000-000000000032', '99999999-0000-0000-0000-000000000031', '对账测试门店A', 'REC32', 'active'),
  ('99999999-0000-0000-0000-000000000033', '99999999-0000-0000-0000-000000000031', '对账测试门店A2', 'REC33', 'active')
on conflict (id) do nothing;

insert into auth.users (id, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, aud, role, created_at, updated_at)
values
  ('99999999-0000-0000-0000-0000000000e1', 's31-rec-mgr@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now()),
  ('99999999-0000-0000-0000-0000000000c1', 's31-rec-cash@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now()),
  ('99999999-0000-0000-0000-0000000000f1', 's31-rec-out@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now()),
  ('99999999-0000-0000-0000-000000000001', 's31-rec-owner@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now())
on conflict (id) do nothing;

insert into public.employees (id, tenant_id, user_id, employee_no, name, status)
values
  ('99999999-0000-0000-0000-0000000000e2', '99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-0000000000e1', 'REC-MGR', '对账测试店长', 'active'),
  ('99999999-0000-0000-0000-0000000000c2', '99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-0000000000c1', 'REC-CASH', '对账测试收银', 'active'),
  ('99999999-0000-0000-0000-0000000000f2', '99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-0000000000f1', 'REC-OUT', '对账测试无权限', 'active'),
  ('99999999-0000-0000-0000-000000000002', '99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-000000000001', 'REC-OWNER', '对账测试租户所有者', 'active')
on conflict (id) do nothing;

insert into public.tenant_memberships (tenant_id, user_id, status)
values
  ('99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-0000000000e1', 'active'),
  ('99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-0000000000c1', 'active'),
  ('99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-0000000000f1', 'active'),
  ('99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-000000000001', 'active')
on conflict (tenant_id, user_id) do nothing;

insert into public.employee_store_assignments (tenant_id, employee_id, store_id, is_primary)
values
  ('99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-0000000000e2', '99999999-0000-0000-0000-000000000032', true),
  ('99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-0000000000c2', '99999999-0000-0000-0000-000000000032', true),
  ('99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-0000000000f2', '99999999-0000-0000-0000-000000000032', true)
on conflict (employee_id, store_id) do nothing;

insert into public.employee_role_assignments (tenant_id, employee_id, role_id, store_id)
values
  ('99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-0000000000e2',
   (select id from public.roles where code = 'store_manager'), '99999999-0000-0000-0000-000000000032'),
  ('99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-0000000000c2',
   (select id from public.roles where code = 'cashier'), '99999999-0000-0000-0000-000000000032'),
  ('99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-000000000002',
   (select id from public.roles where code = 'tenant_owner'), null)
on conflict do nothing;

-- 发票/支付/退款(业务日期 2026-07-15,created_at 落当日窗口)
insert into public.invoices (id, tenant_id, store_id, invoice_no, subtotal, discount_amount, tax_amount, total, paid_amount, status, payment_method, created_at)
values
  ('99999999-0000-0000-0000-0000000000a1', '99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-000000000032', 'REC-INV-A1', 100, 0, 0, 100, 100, 'paid', 'cash', '2026-07-15 10:00:00+08'),
  ('99999999-0000-0000-0000-0000000000a2', '99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-000000000032', 'REC-INV-A2', 200, 0, 0, 200, 200, 'paid', 'wechat', '2026-07-15 11:00:00+08'),
  ('99999999-0000-0000-0000-0000000000a3', '99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-000000000032', 'REC-INV-A3', 300, 0, 0, 300, 30, 'partially_paid', 'wechat', '2026-07-15 12:00:00+08'),
  ('99999999-0000-0000-0000-0000000000b1', '99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-000000000033', 'REC-INV-B1', 700, 0, 0, 700, 700, 'paid', 'cash', '2026-07-15 10:30:00+08')
on conflict (id) do nothing;

insert into public.payments (id, tenant_id, invoice_id, amount, method, transaction_no, idempotency_key, created_at)
values
  ('99999999-0000-0000-0000-0000000000d1', '99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-0000000000a1', 100, 'cash', 'REC-PAY-01', 'rec-pay-01', '2026-07-15 10:01:00+08'),
  ('99999999-0000-0000-0000-0000000000d2', '99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-0000000000a2', 200, 'wechat', 'REC-PAY-02', 'rec-pay-02', '2026-07-15 11:01:00+08'),
  ('99999999-0000-0000-0000-0000000000d3', '99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-0000000000a3', 30, 'wechat', 'REC-PAY-03', 'rec-pay-03', '2026-07-15 12:01:00+08'),
  ('99999999-0000-0000-0000-0000000000d4', '99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-0000000000b1', 700, 'cash', 'REC-PAY-04', 'rec-pay-04', '2026-07-15 10:31:00+08')
on conflict (id) do nothing;

insert into public.refunds (id, tenant_id, invoice_id, payment_id, amount, reason, idempotency_key, created_at)
values
  ('99999999-0000-0000-0000-0000000000d6', '99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-0000000000a1', '99999999-0000-0000-0000-0000000000d1', 50, 'REC-REFUND-01', 'rec-refund-01', '2026-07-15 14:00:00+08')
on conflict (id) do nothing;

-- 预先关账(门店 A 与 A2),对账依赖已关闭的日结
select public.close_daily_business(
  '99999999-0000-0000-0000-000000000031'::uuid,
  '99999999-0000-0000-0000-000000000032'::uuid,
  date '2026-07-15',
  '99999999-0000-0000-0000-0000000000e2'::uuid,
  'rec-close-main'
);
select public.close_daily_business(
  '99999999-0000-0000-0000-000000000031'::uuid,
  '99999999-0000-0000-0000-000000000033'::uuid,
  date '2026-07-15',
  '99999999-0000-0000-0000-0000000000e2'::uuid,
  'rec-close-b1'
);

-- ============================================================
-- Part 1:权限码 seed + 角色授权矩阵
-- ============================================================
do $$
declare
  v_cnt integer;
begin
  execute 'reset role';
  select count(*) into v_cnt from public.permissions
  where code in ('reconciliation.read', 'reconciliation.edit', 'reconciliation.confirm');
  perform tests.assert_true(v_cnt = 3, 'migration 41 应注册 3 个对账权限码');
end;
$$;

-- 店长:对账全量(读/录入/确认)
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"99999999-0000-0000-0000-0000000000e1","role":"authenticated"}', true);
  perform tests.assert_true(public.has_permission('99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-000000000032', 'reconciliation.read'), '店长应持有 reconciliation.read');
  perform tests.assert_true(public.has_permission('99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-000000000032', 'reconciliation.edit'), '店长应持有 reconciliation.edit');
  perform tests.assert_true(public.has_permission('99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-000000000032', 'reconciliation.confirm'), '店长应持有 reconciliation.confirm');
end;
$$;

-- 收银:只读;无权限员工:全无;医生:无财务管理权限
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"99999999-0000-0000-0000-0000000000c1","role":"authenticated"}', true);
  perform tests.assert_true(public.has_permission('99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-000000000032', 'reconciliation.read'), '收银应持有 reconciliation.read');
  perform tests.assert_true(not public.has_permission('99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-000000000032', 'reconciliation.edit'), '收银不应持有 reconciliation.edit');
  perform tests.assert_true(not public.has_permission('99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-000000000032', 'reconciliation.confirm'), '收银不应持有 reconciliation.confirm');
end;
$$;

do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"99999999-0000-0000-0000-0000000000f1","role":"authenticated"}', true);
  perform tests.assert_true(not public.has_permission('99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-000000000032', 'reconciliation.read'), '无权限员工不应持有 reconciliation.read');
end;
$$;

do $$
declare
  v_doc_perms text[];
begin
  execute 'reset role';
  select permissions into v_doc_perms from public.roles where code = 'doctor';
  perform tests.assert_true(
    not coalesce(v_doc_perms, array[]::text[]) && array['reconciliation.read', 'reconciliation.edit', 'reconciliation.confirm'],
    'doctor 角色不应获得任何对账权限'
  );
end;
$$;

-- 租户所有者:对账全量
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"99999999-0000-0000-0000-000000000001","role":"authenticated"}', true);
  perform tests.assert_true(public.has_permission('99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-000000000032', 'reconciliation.edit'), '租户所有者应持有 reconciliation.edit');
  perform tests.assert_true(public.has_permission('99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-000000000032', 'reconciliation.confirm'), '租户所有者应持有 reconciliation.confirm');
end;
$$;

-- ============================================================
-- Part 2:save_reconciliation_actual(system_expected 由快照推导)
-- ============================================================
do $$
declare
  v_res jsonb;
begin
  execute 'reset role';
  -- 现金渠道:expected=100(快照),录入 100 -> matched
  v_res := public.save_reconciliation_actual(
    p_tenant_id => '99999999-0000-0000-0000-000000000031'::uuid,
    p_store_id => '99999999-0000-0000-0000-000000000032'::uuid,
    p_business_date => date '2026-07-15',
    p_channel => 'cash',
    p_actual_amount => 100,
    p_operator_employee_id => '99999999-0000-0000-0000-0000000000e2'::uuid
  );
  perform tests.assert_true((v_res ->> 'systemExpected') = '100.00', 'cash systemExpected 应为 100.00(快照推导),实际: ' || (v_res ->> 'systemExpected'));
  perform tests.assert_true((v_res ->> 'difference') = '0.00', 'cash 差异应为 0.00');
  perform tests.assert_true((v_res ->> 'status') = 'matched', 'cash 应 matched');

  -- 微信渠道:expected=230,录入 200 -> pending(差异 -30)
  v_res := public.save_reconciliation_actual(
    p_tenant_id => '99999999-0000-0000-0000-000000000031'::uuid,
    p_store_id => '99999999-0000-0000-0000-000000000032'::uuid,
    p_business_date => date '2026-07-15',
    p_channel => 'wechat',
    p_actual_amount => 200,
    p_operator_employee_id => '99999999-0000-0000-0000-0000000000e2'::uuid
  );
  perform tests.assert_true((v_res ->> 'systemExpected') = '230.00', 'wechat systemExpected 应为 230.00,实际: ' || (v_res ->> 'systemExpected'));
  perform tests.assert_true((v_res ->> 'difference') = '-30.00', 'wechat 差异应为 -30.00,实际: ' || (v_res ->> 'difference'));
  perform tests.assert_true((v_res ->> 'status') = 'pending', 'wechat 应 pending(有差异)');

  -- 更新路径:cash 改为 90 -> difference -10 -> pending
  v_res := public.save_reconciliation_actual(
    p_tenant_id => '99999999-0000-0000-0000-000000000031'::uuid,
    p_store_id => '99999999-0000-0000-0000-000000000032'::uuid,
    p_business_date => date '2026-07-15',
    p_channel => 'cash',
    p_actual_amount => 90,
    p_operator_employee_id => '99999999-0000-0000-0000-0000000000e2'::uuid
  );
  perform tests.assert_true((v_res ->> 'difference') = '-10.00', 'cash 更新后差异应为 -10.00,实际: ' || (v_res ->> 'difference'));
  perform tests.assert_true((v_res ->> 'status') = 'pending', 'cash 更新后应 pending');

  -- 日结未关闭(2026-07-16 无日结) -> CLOSING_REQUIRED
  perform tests.assert_raises(
    'select public.save_reconciliation_actual(''99999999-0000-0000-0000-000000000031''::uuid, ''99999999-0000-0000-0000-000000000032''::uuid, date ''2026-07-16'', ''cash'', 100, null, ''99999999-0000-0000-0000-0000000000e2''::uuid)',
    'CLOSING_REQUIRED',
    '日结未关闭应拒绝对账'
  );

  -- 非法渠道
  perform tests.assert_raises(
    'select public.save_reconciliation_actual(''99999999-0000-0000-0000-000000000031''::uuid, ''99999999-0000-0000-0000-000000000032''::uuid, date ''2026-07-15'', ''bitcoin'', 100, null, ''99999999-0000-0000-0000-0000000000e2''::uuid)',
    'INVALID_RECONCILIATION_CHANNEL',
    '非法渠道应拒绝'
  );

  -- 负数金额
  perform tests.assert_raises(
    'select public.save_reconciliation_actual(''99999999-0000-0000-0000-000000000031''::uuid, ''99999999-0000-0000-0000-000000000032''::uuid, date ''2026-07-15'', ''cash'', -5, null, ''99999999-0000-0000-0000-0000000000e2''::uuid)',
    'INVALID_ACTUAL_AMOUNT',
    '负数金额应拒绝'
  );

  -- closingId 不匹配(传 A2 的日结给 A) -> CLOSING_MISMATCH
  perform tests.assert_raises(
    'select public.save_reconciliation_actual(''99999999-0000-0000-0000-000000000031''::uuid, ''99999999-0000-0000-0000-000000000032''::uuid, date ''2026-07-15'', ''card'', 0, (select id from public.daily_closings where tenant_id = ''99999999-0000-0000-0000-000000000031''::uuid and store_id = ''99999999-0000-0000-0000-000000000033''::uuid and business_date = date ''2026-07-15''), ''99999999-0000-0000-0000-0000000000e2''::uuid)',
    'CLOSING_MISMATCH',
    'closingId 与门店/日期不匹配应拒绝'
  );
end;
$$;

-- ============================================================
-- Part 3:confirm_reconciliation(无差异/有差异/重复确认)
-- ============================================================
do $$
declare
  v_cash_id uuid;
  v_wechat_id uuid;
  v_res jsonb;
begin
  execute 'reset role';
  select id into v_cash_id from public.reconciliation_records
  where tenant_id = '99999999-0000-0000-0000-000000000031'::uuid
    and store_id = '99999999-0000-0000-0000-000000000032'::uuid
    and business_date = date '2026-07-15' and channel = 'cash';
  select id into v_wechat_id from public.reconciliation_records
  where tenant_id = '99999999-0000-0000-0000-000000000031'::uuid
    and store_id = '99999999-0000-0000-0000-000000000032'::uuid
    and business_date = date '2026-07-15' and channel = 'wechat';

  -- 先修正 cash=100(无差异)再确认 -> confirmed(无需 reason)
  v_res := public.save_reconciliation_actual(
    p_tenant_id => '99999999-0000-0000-0000-000000000031'::uuid,
    p_store_id => '99999999-0000-0000-0000-000000000032'::uuid,
    p_business_date => date '2026-07-15',
    p_channel => 'cash',
    p_actual_amount => 100,
    p_operator_employee_id => '99999999-0000-0000-0000-0000000000e2'::uuid
  );
  v_res := public.confirm_reconciliation(
    p_record_id => v_cash_id,
    p_difference_reason => null,
    p_request_id => 'req-cash-confirm',
    p_operator_employee_id => '99999999-0000-0000-0000-0000000000e2'::uuid
  );
  perform tests.assert_true((v_res ->> 'status') = 'confirmed', '无差异确认应 -> confirmed');
  perform tests.assert_true((v_res ->> 'confirmedAt') is not null, '确认后应记录 confirmedAt');

  -- 有差异但无 reason -> DIFFERENCE_REASON_REQUIRED
  perform tests.assert_raises(
    'select public.confirm_reconciliation(''' || v_wechat_id || ''', null, ''req-wechat-confirm'', ''99999999-0000-0000-0000-0000000000e2''::uuid)',
    'DIFFERENCE_REASON_REQUIRED',
    '有差异不填原因应拒绝确认'
  );

  -- 有差异且有 reason -> difference_confirmed
  v_res := public.confirm_reconciliation(
    p_record_id => v_wechat_id,
    p_difference_reason => '微信渠道收银机短款 30 元',
    p_request_id => 'req-wechat-confirm',
    p_operator_employee_id => '99999999-0000-0000-0000-0000000000e2'::uuid
  );
  perform tests.assert_true((v_res ->> 'status') = 'difference_confirmed', '有差异且填原因应 -> difference_confirmed');
  perform tests.assert_true((v_res ->> 'differenceReason') = '微信渠道收银机短款 30 元', '应保存差异原因');

  -- 重复确认 -> RECONCILIATION_ALREADY_CONFIRMED
  perform tests.assert_raises(
    'select public.confirm_reconciliation(''' || v_cash_id || ''', null, ''req-cash-confirm-2'', ''99999999-0000-0000-0000-0000000000e2''::uuid)',
    'RECONCILIATION_ALREADY_CONFIRMED',
    '重复确认应拒绝'
  );

  -- 已确认记录不可再修改实际金额 -> RECONCILIATION_LOCKED
  perform tests.assert_raises(
    'select public.save_reconciliation_actual(''99999999-0000-0000-0000-000000000031''::uuid, ''99999999-0000-0000-0000-000000000032''::uuid, date ''2026-07-15'', ''cash'', 120, null, ''99999999-0000-0000-0000-0000000000e2''::uuid)',
    'RECONCILIATION_LOCKED',
    '已确认记录不可修改实际金额'
  );

  -- 不存在的对账记录
  perform tests.assert_raises(
    'select public.confirm_reconciliation(''99999999-0000-0000-0000-0000000000ff''::uuid, null, ''req-x'', ''99999999-0000-0000-0000-0000000000e2''::uuid)',
    'RECONCILIATION_NOT_FOUND',
    '不存在的对账记录应拒绝'
  );
end;
$$;

-- ============================================================
-- Part 4:get_payment_channel_summary(真实 payments/refunds 聚合)
-- ============================================================
do $$
declare
  v_res jsonb;
  v_cash jsonb;
  v_wechat jsonb;
  v_tot jsonb;
begin
  execute 'reset role';
  v_res := public.get_payment_channel_summary(
    p_tenant_id => '99999999-0000-0000-0000-000000000031'::uuid,
    p_store_id => '99999999-0000-0000-0000-000000000032'::uuid,
    p_business_date => date '2026-07-15'
  );
  perform tests.assert_true((v_res ->> 'closingStatus') = 'closed', 'summary closingStatus 应为 closed');

  -- cash 渠道:实收 100 - 退款 50(关联 cash 支付)= 净 50;期望 100
  v_cash := (select c from jsonb_array_elements(v_res -> 'channels') c where c ->> 'channel' = 'cash');
  perform tests.assert_true((v_cash ->> 'payment') = '100.00', 'cash 实收应为 100.00,实际: ' || (v_cash ->> 'payment'));
  perform tests.assert_true((v_cash ->> 'refund') = '50.00', 'cash 退款应为 50.00(退款按关联支付渠道归并),实际: ' || (v_cash ->> 'refund'));
  perform tests.assert_true((v_cash ->> 'net') = '50.00', 'cash 净额应为 50.00,实际: ' || (v_cash ->> 'net'));
  perform tests.assert_true((v_cash ->> 'closingExpected') = '100.00', 'cash 快照期望应为 100.00');

  -- wechat 渠道:实收 230 - 0 = 净 230
  v_wechat := (select c from jsonb_array_elements(v_res -> 'channels') c where c ->> 'channel' = 'wechat');
  perform tests.assert_true((v_wechat ->> 'payment') = '230.00', 'wechat 实收应为 230.00,实际: ' || (v_wechat ->> 'payment'));
  perform tests.assert_true((v_wechat ->> 'net') = '230.00', 'wechat 净额应为 230.00');
  perform tests.assert_true((v_wechat ->> 'closingExpected') = '230.00', 'wechat 快照期望应为 230.00');

  -- totals
  v_tot := v_res -> 'totals';
  perform tests.assert_true((v_tot ->> 'payment') = '330.00', 'summary 总实收应为 330.00,实际: ' || (v_tot ->> 'payment'));
  perform tests.assert_true((v_tot ->> 'refund') = '50.00', 'summary 总退款应为 50.00,实际: ' || (v_tot ->> 'refund'));
  perform tests.assert_true((v_tot ->> 'net') = '280.00', 'summary 总净额应为 280.00,实际: ' || (v_tot ->> 'net'));

  -- 未关账日期:closingStatus 为 null
  v_res := public.get_payment_channel_summary(
    p_tenant_id => '99999999-0000-0000-0000-000000000031'::uuid,
    p_store_id => '99999999-0000-0000-0000-000000000032'::uuid,
    p_business_date => date '2026-07-17'
  );
  perform tests.assert_true((v_res ->> 'closingStatus') is null, '未关账日期 closingStatus 应为 null');
end;
$$;

-- ============================================================
-- Part 5:RLS 只读策略 + 审计留痕
-- ============================================================
do $$
declare
  v_cnt integer;
begin
  -- 店长:可见对账记录
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"99999999-0000-0000-0000-0000000000e1","role":"authenticated"}', true);
  select count(*) into v_cnt from public.reconciliation_records
  where tenant_id = '99999999-0000-0000-0000-000000000031'::uuid;
  perform tests.assert_true(v_cnt = 2, '店长应可见本租户对账记录(2 行)');

  -- 收银:只读可见
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"99999999-0000-0000-0000-0000000000c1","role":"authenticated"}', true);
  select count(*) into v_cnt from public.reconciliation_records
  where tenant_id = '99999999-0000-0000-0000-000000000031'::uuid;
  perform tests.assert_true(v_cnt = 2, '收银应可见对账记录(只读)');

  -- 无权限员工:不可见
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"99999999-0000-0000-0000-0000000000f1","role":"authenticated"}', true);
  select count(*) into v_cnt from public.reconciliation_records
  where tenant_id = '99999999-0000-0000-0000-000000000031'::uuid;
  perform tests.assert_true(v_cnt = 0, '无权限员工不应看到对账记录');
end;
$$;

do $$
declare
  v_cnt integer;
begin
  execute 'reset role';
  -- actual_update + confirm 审计(confirm 审计含 request_id)
  select count(*) into v_cnt from public.audit_logs
  where tenant_id = '99999999-0000-0000-0000-000000000031'::uuid
    and action in ('reconciliation.actual_update', 'reconciliation.confirm')
    and entity_type = 'reconciliation_record';
  perform tests.assert_true(v_cnt >= 5, '应至少存在 5 条对账审计(录入 3 + 确认 2)');

  -- confirm 审计应带 request_id 与差异原因
  select count(*) into v_cnt from public.audit_logs
  where tenant_id = '99999999-0000-0000-0000-000000000031'::uuid
    and action = 'reconciliation.confirm'
    and (metadata ->> 'request_id') = 'req-wechat-confirm'
    and (metadata ->> 'difference_reason') = '微信渠道收银机短款 30 元';
  perform tests.assert_true(v_cnt = 1, 'confirm 审计应记录 request_id 与差异原因');
end;
$$;

rollback;
