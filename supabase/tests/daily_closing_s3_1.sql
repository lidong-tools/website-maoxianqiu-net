-- ============================================================
-- 日结测试:S31-PARALLEL-B Daily Closing(migration 39 + 40)
--
-- 验证 migration 39(daily_closing_base)+ 40(daily_closing_rpc):
--   - 权限码 seed + 角色授权矩阵(system_admin/tenant_owner 全量、
--     store_manager 读+关账不含调整、cashier 只读、doctor 无财务管理权限)
--   - close_daily_business:实时计算(gross/paid/refund/receivable/渠道拆分)
--     + 快照固化 + 幂等(同 idempotency_key 返回原结果)+ 唯一性
--     (tenant+store+business_date 只允许一份正式日结,重复执行返回现有快照)
--   - A/B 店隔离、租户间隔离
--   - adjust_daily_closing:closed -> adjusted、流水追加、非法状态/金额/原因拒绝
--   - RLS:日结只读策略(租户成员 + 门店范围 + daily_closing.read)
--
-- 本文件独立可执行(psql "$DATABASE_URL" -f supabase/tests/daily_closing_s3_1.sql):
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
    raise exception 'DAILY_CLOSING_TEST_FAILED: %', msg;
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
    raise exception 'DAILY_CLOSING_TEST_FAILED: % 应抛出含 % 的错误,实际: %',
      p_name, p_expected, coalesce(v_msg, '无异常(调用成功)');
  end if;
end;
$$;

-- ============================================================
-- 夹具:租户/门店/用户/员工/角色分配/发票/支付/退款
-- 租户 A:99999999-0000-0000-0000-000000000031(主测试租户)
-- 门店 A:99999999-0000-0000-0000-000000000032 / 门店 A2:...033(同租户隔离)
-- 租户 B:99999999-0000-0000-0000-000000000041 / 门店 B:...042(租户隔离)
-- 用户/员工(全合法 hex):店长 e1->e2、收银 c1->c2、无权限 f1->f2、
--   租户所有者 o1->o2(store_id IS NULL 租户级分配)、租户B店长 b1->b2
-- ============================================================
insert into public.tenants (id, slug, name)
values
  ('99999999-0000-0000-0000-000000000031', 's31-clo-tenant', '日结测试租户'),
  ('99999999-0000-0000-0000-000000000041', 's31-clo-tenant-b', '日结测试租户B')
on conflict (slug) do nothing;

insert into public.stores (id, tenant_id, name, code, status)
values
  ('99999999-0000-0000-0000-000000000032', '99999999-0000-0000-0000-000000000031', '日结测试门店A', 'CLO32', 'active'),
  ('99999999-0000-0000-0000-000000000033', '99999999-0000-0000-0000-000000000031', '日结测试门店A2', 'CLO33', 'active'),
  ('99999999-0000-0000-0000-000000000042', '99999999-0000-0000-0000-000000000041', '日结测试门店B', 'CLOB42', 'active')
on conflict (id) do nothing;

insert into auth.users (id, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, aud, role, created_at, updated_at)
values
  ('99999999-0000-0000-0000-0000000000e1', 's31-clo-mgr@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now()),
  ('99999999-0000-0000-0000-0000000000c1', 's31-clo-cash@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now()),
  ('99999999-0000-0000-0000-0000000000f1', 's31-clo-out@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now()),
  ('99999999-0000-0000-0000-000000000001', 's31-clo-owner@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now()),
  ('99999999-0000-0000-0000-0000000000b1', 's31-clo-mgrb@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now())
on conflict (id) do nothing;

insert into public.employees (id, tenant_id, user_id, employee_no, name, status)
values
  ('99999999-0000-0000-0000-0000000000e2', '99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-0000000000e1', 'CLO-MGR', '日结测试店长', 'active'),
  ('99999999-0000-0000-0000-0000000000c2', '99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-0000000000c1', 'CLO-CASH', '日结测试收银', 'active'),
  ('99999999-0000-0000-0000-0000000000f2', '99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-0000000000f1', 'CLO-OUT', '日结测试无权限', 'active'),
  ('99999999-0000-0000-0000-000000000002', '99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-000000000001', 'CLO-OWNER', '日结测试租户所有者', 'active'),
  ('99999999-0000-0000-0000-0000000000b2', '99999999-0000-0000-0000-000000000041', '99999999-0000-0000-0000-0000000000b1', 'CLOB-MGR', '日结测试店长B', 'active')
on conflict (id) do nothing;

insert into public.tenant_memberships (tenant_id, user_id, status)
values
  ('99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-0000000000e1', 'active'),
  ('99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-0000000000c1', 'active'),
  ('99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-0000000000f1', 'active'),
  ('99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-000000000001', 'active'),
  ('99999999-0000-0000-0000-000000000041', '99999999-0000-0000-0000-0000000000b1', 'active')
on conflict (tenant_id, user_id) do nothing;

insert into public.employee_store_assignments (tenant_id, employee_id, store_id, is_primary)
values
  ('99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-0000000000e2', '99999999-0000-0000-0000-000000000032', true),
  ('99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-0000000000c2', '99999999-0000-0000-0000-000000000032', true),
  ('99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-0000000000f2', '99999999-0000-0000-0000-000000000032', true),
  ('99999999-0000-0000-0000-000000000041', '99999999-0000-0000-0000-0000000000b2', '99999999-0000-0000-0000-000000000042', true)
on conflict (employee_id, store_id) do nothing;

-- 角色分配:店长(store_manager)/收银(cashier)/租户所有者(tenant_owner,store_id IS NULL)
insert into public.employee_role_assignments (tenant_id, employee_id, role_id, store_id)
values
  ('99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-0000000000e2',
   (select id from public.roles where code = 'store_manager'), '99999999-0000-0000-0000-000000000032'),
  ('99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-0000000000c2',
   (select id from public.roles where code = 'cashier'), '99999999-0000-0000-0000-000000000032'),
  ('99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-000000000002',
   (select id from public.roles where code = 'tenant_owner'), null),
  ('99999999-0000-0000-0000-000000000041', '99999999-0000-0000-0000-0000000000b2',
   (select id from public.roles where code = 'store_manager'), '99999999-0000-0000-0000-000000000042')
on conflict do nothing;

-- ============================================================
-- 发票/支付/退款夹具(业务日期 2026-07-15,created_at 显式落当日窗口)
-- 门店 A(租户A):
--   INV-A1: 100 元, 现金付清(cash 100)
--   INV-A2: 200 元, 微信付清(wechat 200)
--   INV-A3: 300 元, 微信部分支付 30(partially_paid)
--   INV-A4: 50 元, cancelled(不计入 gross/invoice_count)
--   退款 50 关联 INV-A1 的现金支付
--   期望: gross=600 paid=330 refund=50 receivable=320
--         cash=100 wechat=230 invoice_count=3
-- 门店 A2(租户A):INV-B1: 700 元 现金付清(cash 700)
-- 门店 B(租户B):INV-C1: 900 元 微信付清(wechat 900)
-- ============================================================
insert into public.invoices (id, tenant_id, store_id, invoice_no, subtotal, discount_amount, tax_amount, total, paid_amount, status, payment_method, created_at)
values
  ('99999999-0000-0000-0000-0000000000a1', '99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-000000000032', 'CLO-INV-A1', 100, 0, 0, 100, 100, 'paid', 'cash', '2026-07-15 10:00:00+08'),
  ('99999999-0000-0000-0000-0000000000a2', '99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-000000000032', 'CLO-INV-A2', 200, 0, 0, 200, 200, 'paid', 'wechat', '2026-07-15 11:00:00+08'),
  ('99999999-0000-0000-0000-0000000000a3', '99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-000000000032', 'CLO-INV-A3', 300, 0, 0, 300, 30, 'partially_paid', 'wechat', '2026-07-15 12:00:00+08'),
  ('99999999-0000-0000-0000-0000000000a4', '99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-000000000032', 'CLO-INV-A4', 50, 0, 0, 50, 0, 'cancelled', null, '2026-07-15 09:00:00+08'),
  ('99999999-0000-0000-0000-0000000000b1', '99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-000000000033', 'CLO-INV-B1', 700, 0, 0, 700, 700, 'paid', 'cash', '2026-07-15 10:30:00+08'),
  ('99999999-0000-0000-0000-0000000000c1', '99999999-0000-0000-0000-000000000041', '99999999-0000-0000-0000-000000000042', 'CLO-INV-C1', 900, 0, 0, 900, 900, 'paid', 'wechat', '2026-07-15 10:00:00+08')
on conflict (id) do nothing;

insert into public.payments (id, tenant_id, invoice_id, amount, method, transaction_no, idempotency_key, created_at)
values
  ('99999999-0000-0000-0000-0000000000d1', '99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-0000000000a1', 100, 'cash', 'CLO-PAY-01', 'clo-pay-01', '2026-07-15 10:01:00+08'),
  ('99999999-0000-0000-0000-0000000000d2', '99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-0000000000a2', 200, 'wechat', 'CLO-PAY-02', 'clo-pay-02', '2026-07-15 11:01:00+08'),
  ('99999999-0000-0000-0000-0000000000d3', '99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-0000000000a3', 30, 'wechat', 'CLO-PAY-03', 'clo-pay-03', '2026-07-15 12:01:00+08'),
  ('99999999-0000-0000-0000-0000000000d4', '99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-0000000000b1', 700, 'cash', 'CLO-PAY-04', 'clo-pay-04', '2026-07-15 10:31:00+08'),
  ('99999999-0000-0000-0000-0000000000d5', '99999999-0000-0000-0000-000000000041', '99999999-0000-0000-0000-0000000000c1', 900, 'wechat', 'CLO-PAY-05', 'clo-pay-05', '2026-07-15 10:01:00+08')
on conflict (id) do nothing;

insert into public.refunds (id, tenant_id, invoice_id, payment_id, amount, reason, idempotency_key, created_at)
values
  ('99999999-0000-0000-0000-0000000000d6', '99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-0000000000a1', '99999999-0000-0000-0000-0000000000d1', 50, 'CLO-REFUND-01', 'clo-refund-01', '2026-07-15 14:00:00+08')
on conflict (id) do nothing;

-- ============================================================
-- Part 1:权限码 seed + 角色授权矩阵
-- ============================================================
do $$
declare
  v_cnt integer;
begin
  execute 'reset role';
  select count(*) into v_cnt from public.permissions
  where code in ('daily_closing.read', 'daily_closing.close', 'daily_closing.adjust');
  perform tests.assert_true(v_cnt = 3, 'migration 39 应注册 3 个日结权限码');
end;
$$;

-- 店长:读 + 关账,不含调整
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"99999999-0000-0000-0000-0000000000e1","role":"authenticated"}', true);
  perform tests.assert_true(public.has_permission('99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-000000000032', 'daily_closing.read'), '店长应持有 daily_closing.read');
  perform tests.assert_true(public.has_permission('99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-000000000032', 'daily_closing.close'), '店长应持有 daily_closing.close');
  perform tests.assert_true(not public.has_permission('99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-000000000032', 'daily_closing.adjust'), '店长不应持有 daily_closing.adjust(调整更敏感)');
end;
$$;

-- 收银:只读;无权限员工:全无;医生:无财务管理权限
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"99999999-0000-0000-0000-0000000000c1","role":"authenticated"}', true);
  perform tests.assert_true(public.has_permission('99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-000000000032', 'daily_closing.read'), '收银应持有 daily_closing.read');
  perform tests.assert_true(not public.has_permission('99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-000000000032', 'daily_closing.close'), '收银不应持有 daily_closing.close');
end;
$$;

do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"99999999-0000-0000-0000-0000000000f1","role":"authenticated"}', true);
  perform tests.assert_true(not public.has_permission('99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-000000000032', 'daily_closing.read'), '无权限员工不应持有 daily_closing.read');
end;
$$;

-- 医生角色:默认不得获得财务管理权限
do $$
declare
  v_doc_perms text[];
begin
  execute 'reset role';
  select permissions into v_doc_perms from public.roles where code = 'doctor';
  perform tests.assert_true(
    not coalesce(v_doc_perms, array[]::text[]) && array['daily_closing.read', 'daily_closing.close', 'daily_closing.adjust'],
    'doctor 角色不应获得任何日结权限'
  );
end;
$$;

-- 租户所有者:全量(读/关账/调整)
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"99999999-0000-0000-0000-000000000001","role":"authenticated"}', true);
  perform tests.assert_true(public.has_permission('99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-000000000032', 'daily_closing.read'), '租户所有者应持有 daily_closing.read');
  perform tests.assert_true(public.has_permission('99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-000000000032', 'daily_closing.close'), '租户所有者应持有 daily_closing.close');
  perform tests.assert_true(public.has_permission('99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-000000000032', 'daily_closing.adjust'), '租户所有者应持有 daily_closing.adjust');
end;
$$;

-- ============================================================
-- Part 2:close_daily_business 实时计算 + 快照固化
-- ============================================================
do $$
declare
  v_res jsonb;
  v_snap jsonb;
  v_pm jsonb;
  v_tot jsonb;
begin
  execute 'reset role';
  v_res := public.close_daily_business(
    p_tenant_id => '99999999-0000-0000-0000-000000000031'::uuid,
    p_store_id => '99999999-0000-0000-0000-000000000032'::uuid,
    p_business_date => date '2026-07-15',
    p_operator_employee_id => '99999999-0000-0000-0000-0000000000e2'::uuid,
    p_idempotency_key => 'clo-close-main-001'
  );
  perform tests.assert_true((v_res ->> 'duplicate') = 'false', '首次关账 duplicate 应为 false');
  perform tests.assert_true((v_res ->> 'status') = 'closed', '关账后状态应为 closed');

  v_snap := v_res -> 'snapshot';
  v_tot := v_snap -> 'totals';
  perform tests.assert_true((v_tot ->> 'gross_amount') = '600.00', 'gross 应为 600.00(非取消发票合计),实际: ' || (v_tot ->> 'gross_amount'));
  perform tests.assert_true((v_tot ->> 'paid_amount') = '330.00', 'paid 应为 330.00,实际: ' || (v_tot ->> 'paid_amount'));
  perform tests.assert_true((v_tot ->> 'refund_amount') = '50.00', 'refund 应为 50.00,实际: ' || (v_tot ->> 'refund_amount'));
  perform tests.assert_true((v_tot ->> 'receivable_amount') = '320.00', 'receivable 应为 320.00(gross-paid+refund),实际: ' || (v_tot ->> 'receivable_amount'));
  perform tests.assert_true((v_tot ->> 'invoice_count') = '3', 'invoice_count 应为 3(排除 cancelled),实际: ' || (v_tot ->> 'invoice_count'));

  v_pm := v_snap -> 'payment_method_breakdown';
  perform tests.assert_true((v_pm ->> 'cash') = '100.00', '现金渠道应为 100.00,实际: ' || (v_pm ->> 'cash'));
  perform tests.assert_true((v_pm ->> 'wechat') = '230.00', '微信渠道应为 230.00,实际: ' || (v_pm ->> 'wechat'));
  perform tests.assert_true((v_pm ->> 'card') = '0.00', '银行卡渠道应为 0.00');
  perform tests.assert_true((v_snap ->> 'source') = 'live-computed', '快照 source 应为 live-computed');

  -- 行级金额列同步固化
  perform tests.assert_true(
    (select (gross_amount = 600.00 and paid_amount = 330.00 and refund_amount = 50.00
      and receivable_amount = 320.00 and cash_amount = 100.00 and wechat_amount = 230.00
      and invoice_count = 3)
     from public.daily_closings
     where tenant_id = '99999999-0000-0000-0000-000000000031'::uuid
       and store_id = '99999999-0000-0000-0000-000000000032'::uuid
       and business_date = date '2026-07-15'),
    'daily_closings 行级金额列应同步固化'
  );
end;
$$;

-- ============================================================
-- Part 3:幂等 + 唯一性(重复关账返回现有快照,不重算不覆盖历史)
-- ============================================================
do $$
declare
  v_res jsonb;
  v_new_invoice uuid;
begin
  execute 'reset role';
  -- 重复执行(不同幂等键):返回 duplicate=true + 相同快照
  v_res := public.close_daily_business(
    p_tenant_id => '99999999-0000-0000-0000-000000000031'::uuid,
    p_store_id => '99999999-0000-0000-0000-000000000032'::uuid,
    p_business_date => date '2026-07-15',
    p_operator_employee_id => '99999999-0000-0000-0000-0000000000e2'::uuid,
    p_idempotency_key => 'clo-close-main-002'
  );
  perform tests.assert_true((v_res ->> 'duplicate') = 'true', '重复关账 duplicate 应为 true');
  perform tests.assert_true((v_res -> 'snapshot' -> 'totals' ->> 'gross_amount') = '600.00', '重复关账应返回原快照不重算');

  -- 同一幂等键:直接返回原结果
  v_res := public.close_daily_business(
    p_tenant_id => '99999999-0000-0000-0000-000000000031'::uuid,
    p_store_id => '99999999-0000-0000-0000-000000000032'::uuid,
    p_business_date => date '2026-07-15',
    p_operator_employee_id => '99999999-0000-0000-0000-0000000000e2'::uuid,
    p_idempotency_key => 'clo-close-main-001'
  );
  perform tests.assert_true((v_res ->> 'duplicate') = 'false', '幂等键命中应返回原结果(duplicate=false)');
  perform tests.assert_true((v_res ->> 'closingId') is not null, '幂等键命中应返回 closingId');

  -- 关账后再新增发票:历史快照不更新(关闭后读快照,不重算覆盖历史)
  insert into public.invoices (id, tenant_id, store_id, invoice_no, subtotal, discount_amount, tax_amount, total, paid_amount, status, payment_method, created_at)
  values ('99999999-0000-0000-0000-0000000000a5', '99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-000000000032', 'CLO-INV-A5', 999, 0, 0, 999, 0, 'confirmed', null, '2026-07-15 15:00:00+08')
  on conflict (id) do nothing;
  v_res := public.close_daily_business(
    p_tenant_id => '99999999-0000-0000-0000-000000000031'::uuid,
    p_store_id => '99999999-0000-0000-0000-000000000032'::uuid,
    p_business_date => date '2026-07-15',
    p_operator_employee_id => '99999999-0000-0000-0000-0000000000e2'::uuid,
    p_idempotency_key => 'clo-close-main-003'
  );
  perform tests.assert_true((v_res -> 'snapshot' -> 'totals' ->> 'gross_amount') = '600.00', '关账后新增发票不应改变历史快照');
end;
$$;

-- ============================================================
-- Part 4:门店隔离(同租户 A2)与租户隔离(B)
-- ============================================================
do $$
declare
  v_res jsonb;
begin
  execute 'reset role';
  -- 门店 A2:gross=700 cash=700 receivable=0
  v_res := public.close_daily_business(
    p_tenant_id => '99999999-0000-0000-0000-000000000031'::uuid,
    p_store_id => '99999999-0000-0000-0000-000000000033'::uuid,
    p_business_date => date '2026-07-15',
    p_operator_employee_id => '99999999-0000-0000-0000-0000000000e2'::uuid,
    p_idempotency_key => 'clo-close-b1'
  );
  perform tests.assert_true((v_res -> 'snapshot' -> 'totals' ->> 'gross_amount') = '700.00', '门店 A2 gross 应为 700.00');
  perform tests.assert_true((v_res -> 'snapshot' -> 'payment_method_breakdown' ->> 'cash') = '700.00', '门店 A2 现金渠道应为 700.00');
  perform tests.assert_true((v_res -> 'snapshot' -> 'totals' ->> 'receivable_amount') = '0.00', '门店 A2 receivable 应为 0.00');

  -- 门店 A 快照不受 A2 关账影响(仍为 600)
  select (snapshot -> 'totals' ->> 'gross_amount') into v_res
  from public.daily_closings
  where tenant_id = '99999999-0000-0000-0000-000000000031'::uuid
    and store_id = '99999999-0000-0000-0000-000000000032'::uuid
    and business_date = date '2026-07-15';
  perform tests.assert_true(v_res = '600.00', '门店 A 快照不应受门店 A2 关账影响');

  -- 租户 B:gross=900 wechat=900
  v_res := public.close_daily_business(
    p_tenant_id => '99999999-0000-0000-0000-000000000041'::uuid,
    p_store_id => '99999999-0000-0000-0000-000000000042'::uuid,
    p_business_date => date '2026-07-15',
    p_operator_employee_id => '99999999-0000-0000-0000-0000000000b2'::uuid,
    p_idempotency_key => 'clo-close-c1'
  );
  perform tests.assert_true((v_res -> 'snapshot' -> 'totals' ->> 'gross_amount') = '900.00', '租户 B 门店 gross 应为 900.00');
  perform tests.assert_true((v_res -> 'snapshot' -> 'payment_method_breakdown' ->> 'wechat') = '900.00', '租户 B 门店微信渠道应为 900.00');

  -- 跨租户门店:store 不属于该租户 -> STORE_NOT_FOUND
  perform tests.assert_raises(
    'select public.close_daily_business(''99999999-0000-0000-0000-000000000031''::uuid, ''99999999-0000-0000-0000-000000000042''::uuid, date ''2026-07-15'', ''99999999-0000-0000-0000-0000000000e2''::uuid, ''clo-x-tenant'')',
    'STORE_NOT_FOUND',
    '跨租户门店关账应拒绝'
  );
end;
$$;

-- ============================================================
-- Part 5:adjust_daily_closing 状态机 + 流水追加
-- ============================================================
do $$
declare
  v_closing_id uuid;
  v_res jsonb;
  v_cnt integer;
begin
  execute 'reset role';
  select id into v_closing_id
  from public.daily_closings
  where tenant_id = '99999999-0000-0000-0000-000000000031'::uuid
    and store_id = '99999999-0000-0000-0000-000000000032'::uuid
    and business_date = date '2026-07-15';

  -- 现金短款 -20:closed -> adjusted,summary 追加
  v_res := public.adjust_daily_closing(
    p_closing_id => v_closing_id,
    p_adjustment_type => 'cash_short',
    p_amount => -20,
    p_reason => '测试:现金短款 20',
    p_operator_employee_id => '99999999-0000-0000-0000-000000000002'::uuid
  );
  perform tests.assert_true((v_res ->> 'status') = 'adjusted', '调整后状态应为 adjusted');
  perform tests.assert_true((v_res -> 'adjustment_summary' ->> 'count') = '1', '调整 summary count 应为 1');
  perform tests.assert_true((v_res -> 'adjustment_summary' ->> 'total') = '-20.00', '调整 summary total 应为 -20.00');

  -- 再调整一次:append 式不覆盖
  v_res := public.adjust_daily_closing(
    p_closing_id => v_closing_id,
    p_adjustment_type => 'manual_correction',
    p_amount => 10,
    p_reason => '测试:人工更正 +10',
    p_operator_employee_id => '99999999-0000-0000-0000-000000000002'::uuid
  );
  perform tests.assert_true((v_res -> 'adjustment_summary' ->> 'count') = '2', '再次调整 summary count 应为 2');
  perform tests.assert_true((v_res -> 'adjustment_summary' ->> 'total') = '-10.00', '调整 summary total 应为 -10.00(-20+10)');
  select count(*) into v_cnt from public.closing_adjustments where closing_id = v_closing_id;
  perform tests.assert_true(v_cnt = 2, 'closing_adjustments 应追加 2 条流水');

  -- 非法状态:open 行不可调整(直接插入 open 占位行)
  insert into public.daily_closings (tenant_id, store_id, business_date, status, created_by)
  values ('99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-000000000032', date '2026-07-16', 'open', '99999999-0000-0000-0000-0000000000e2')
  on conflict (tenant_id, store_id, business_date) do nothing;
  perform tests.assert_raises(
    'select public.adjust_daily_closing(''' || (select id from public.daily_closings where tenant_id = '99999999-0000-0000-0000-000000000031'::uuid and store_id = '99999999-0000-0000-0000-000000000032'::uuid and business_date = date '2026-07-16')::text || ''', ''cash_short'', -10, ''测试'', ''99999999-0000-0000-0000-000000000002''::uuid)',
    'CLOSING_NOT_CLOSED',
    'open 状态日结不可调整'
  );

  -- 金额为 0 拒绝
  perform tests.assert_raises(
    'select public.adjust_daily_closing(''' || v_closing_id || ''', ''cash_short'', 0, ''测试'', ''99999999-0000-0000-0000-000000000002''::uuid)',
    'INVALID_ADJUSTMENT_AMOUNT',
    '调整金额为 0 应拒绝'
  );

  -- 原因必填
  perform tests.assert_raises(
    'select public.adjust_daily_closing(''' || v_closing_id || ''', ''cash_short'', -10, '' '', ''99999999-0000-0000-0000-000000000002''::uuid)',
    'ADJUSTMENT_REASON_REQUIRED',
    '调整原因必填'
  );

  -- 非法调整类型
  perform tests.assert_raises(
    'select public.adjust_daily_closing(''' || v_closing_id || ''', ''discount'', -10, ''测试'', ''99999999-0000-0000-0000-000000000002''::uuid)',
    'INVALID_ADJUSTMENT_TYPE',
    '非法调整类型应拒绝'
  );

  -- 日结不存在
  perform tests.assert_raises(
    'select public.adjust_daily_closing(''99999999-0000-0000-0000-0000000000ff''::uuid, ''cash_short'', -10, ''测试'', ''99999999-0000-0000-0000-000000000002''::uuid)',
    'CLOSING_NOT_FOUND',
    '不存在的日结应拒绝'
  );
end;
$$;

-- ============================================================
-- Part 6:RLS 只读策略(authenticated 视角)
-- ============================================================
do $$
declare
  v_cnt integer;
begin
  -- 店长:可见门店 A 日结(1 行)
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"99999999-0000-0000-0000-0000000000e1","role":"authenticated"}', true);
  select count(*) into v_cnt from public.daily_closings
  where tenant_id = '99999999-0000-0000-0000-000000000031'::uuid;
  perform tests.assert_true(v_cnt >= 1, '店长应可见本租户授权门店的日结');

  -- 无权限员工:不可见(RLS 返回 0 行)
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"99999999-0000-0000-0000-0000000000f1","role":"authenticated"}', true);
  select count(*) into v_cnt from public.daily_closings
  where tenant_id = '99999999-0000-0000-0000-000000000031'::uuid;
  perform tests.assert_true(v_cnt = 0, '无权限员工不应看到任何日结');

  -- 租户所有者:租户级分配(store_id IS NULL)可见全门店(含门店 A2)
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"99999999-0000-0000-0000-000000000001","role":"authenticated"}', true);
  select count(*) into v_cnt from public.daily_closings
  where tenant_id = '99999999-0000-0000-0000-000000000031'::uuid;
  perform tests.assert_true(v_cnt = 3, '租户所有者应可见本租户全部门店日结(3 行:032/033 已关账 + 032/07-16 open 占位),实际: ' || v_cnt);
end;
$$;

-- ============================================================
-- Part 7:审计留痕(close/adjust)
-- ============================================================
do $$
declare
  v_cnt integer;
begin
  execute 'reset role';
  select count(*) into v_cnt from public.audit_logs
  where tenant_id = '99999999-0000-0000-0000-000000000031'::uuid
    and action in ('daily_closing.close', 'daily_closing.adjust')
    and entity_type = 'daily_closing';
  perform tests.assert_true(v_cnt >= 3, '应至少存在 3 条日结审计(close + 2 次 adjust)');
end;
$$;

rollback;
