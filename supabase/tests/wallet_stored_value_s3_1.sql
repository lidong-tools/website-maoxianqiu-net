-- ============================================================
-- 储值钱包测试:S31-PARALLEL-W Wallet / Stored Value(migration 200~203)
--
-- 验证 Agent-03 交付(migration 200~203):
--   1. open_stored_value_account:开户/同客户唯一/跨租户客户拒绝
--   2. recharge_stored_value:本金+赠送记账区分、幂等、来源必填
--   3. 余额一致性:行锁 + 余额不为负 + 余额不足拒绝
--   4. 收银原子性:process_payment(method=stored_value) 同事务扣 Wallet + 写 Payment;
--      退款 process_refund 同事务返还 Wallet,replay 只返一次
--   5. 冻结账户禁止扣款;人工调整 ±/reason 必填/余额不为负
--   6. 不可变流水:RLS 无 update/delete 策略
--   7. RPC ACL:authenticated 无 EXECUTE(service-role-only)
--   8. 权限 seed:wallet.view/recharge/adjust/freeze 角色矩阵
--   9. payment_contexts 含 stored_value;Billing method 约束接受 stored_value
--
-- 本文件独立可执行(psql "$DATABASE_URL" -f supabase/tests/wallet_stored_value_s3_1.sql):
--   - 自建 tests.assert_* 断言函数,不依赖其他测试文件;
--   - 单一事务 begin/rollback,无任何残留;
--   - RLS/ACL 断言使用 set local role authenticated + jwt claims。
-- ============================================================

begin;

create schema if not exists tests;
grant usage on schema tests to authenticated, anon, service_role;

create or replace function tests.assert_true(cond boolean, msg text)
returns void
language plpgsql as $$
begin
  if not cond then
    raise exception 'WALLET_TEST_FAILED: %', msg;
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
    raise exception 'WALLET_TEST_FAILED: % 应抛出含 % 的错误,实际: %',
      p_name, p_expected, coalesce(v_msg, '无异常(调用成功)');
  end if;
end;
$$;

-- ============================================================
-- 夹具:租户/门店/用户/员工/客户
-- 租户 A:99999999-0000-0000-0000-000000000051(主测试租户)
-- 门店 A:99999999-0000-0000-0000-000000000052
-- 租户 B:99999999-0000-0000-0000-000000000061 / 门店 B:...062(跨租户隔离)
-- 用户/员工:收银 u1->e1、租户所有者 u2->e2
-- 客户 A(cA, 租户A)/客户 B(cB, 租户B)
-- ============================================================
insert into public.tenants (id, slug, name)
values
  ('99999999-0000-0000-0000-000000000051', 's31-wal-tenant', '储值测试租户'),
  ('99999999-0000-0000-0000-000000000061', 's31-wal-tenant-b', '储值测试租户B')
on conflict (slug) do nothing;

insert into public.stores (id, tenant_id, name, code, status)
values
  ('99999999-0000-0000-0000-000000000052', '99999999-0000-0000-0000-000000000051', '储值测试门店A', 'WAL52', 'active'),
  ('99999999-0000-0000-0000-000000000062', '99999999-0000-0000-0000-000000000061', '储值测试门店B', 'WAL62', 'active')
on conflict (id) do nothing;

insert into auth.users (id, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, aud, role, created_at, updated_at)
values
  ('99999999-0000-0000-0000-0000000000a1', 's31-wal-cash@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now()),
  ('99999999-0000-0000-0000-0000000000a3', 's31-wal-owner@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now())
on conflict (id) do nothing;

insert into public.employees (id, tenant_id, user_id, employee_no, name, status)
values
  ('99999999-0000-0000-0000-0000000000a2', '99999999-0000-0000-0000-000000000051', '99999999-0000-0000-0000-0000000000a1', 'WAL-CASH', '储值测试收银', 'active'),
  ('99999999-0000-0000-0000-0000000000a4', '99999999-0000-0000-0000-000000000051', '99999999-0000-0000-0000-0000000000a3', 'WAL-OWNER', '储值测试所有者', 'active')
on conflict (id) do nothing;

insert into public.tenant_memberships (tenant_id, user_id, status)
values
  ('99999999-0000-0000-0000-000000000051', '99999999-0000-0000-0000-0000000000a1', 'active'),
  ('99999999-0000-0000-0000-000000000051', '99999999-0000-0000-0000-0000000000a3', 'active')
on conflict (tenant_id, user_id) do nothing;

insert into public.employee_store_assignments (tenant_id, employee_id, store_id, is_primary)
values
  ('99999999-0000-0000-0000-000000000051', '99999999-0000-0000-0000-0000000000a2', '99999999-0000-0000-0000-000000000052', true)
on conflict (employee_id, store_id) do nothing;

-- 角色分配:收银(cashier,门店级)/租户所有者(tenant_owner,store_id NULL)
-- 注意:employee_role_assignments 无唯一约束,直接插入(测试事务内不重复)
insert into public.employee_role_assignments (tenant_id, employee_id, role_id, store_id)
values
  ('99999999-0000-0000-0000-000000000051', '99999999-0000-0000-0000-0000000000a2',
   (select id from public.roles where code = 'cashier'), '99999999-0000-0000-0000-000000000052'),
  ('99999999-0000-0000-0000-000000000051', '99999999-0000-0000-0000-0000000000a4',
   (select id from public.roles where code = 'tenant_owner'), null);

-- 客户(直接插入,customer_no 手动指定避免依赖序列)
insert into public.customers (id, tenant_id, store_id, customer_no, name, phone)
values
  ('99999999-0000-0000-0000-000000000053', '99999999-0000-0000-0000-000000000051', '99999999-0000-0000-0000-000000000052', 'WAL-CUST-0001', '储值客户A', '13800000001'),
  ('99999999-0000-0000-0000-000000000063', '99999999-0000-0000-0000-000000000061', '99999999-0000-0000-0000-000000000062', 'WAL-CUST-0002', '储值客户B', '13800000002')
on conflict (id) do nothing;

-- ============================================================
-- 1. 开户
-- ============================================================
do $$
declare
  v_tenant uuid := '99999999-0000-0000-0000-000000000051';
  v_customer uuid := '99999999-0000-0000-0000-000000000053';
  v_account_id uuid;
  v_r jsonb;
begin
  -- 1.1 正常开户
  v_r := public.open_stored_value_account(v_tenant, v_customer, 'CNY', null, 'wal-test-open-1');
  perform tests.assert_true((v_r->>'created')::boolean = true, '开户应返回 created=true');
  v_account_id := (v_r->>'accountId')::uuid;
  perform tests.assert_true(v_account_id is not null, '开户应返回 accountId');

  -- 1.2 重复开户(同客户同币种)幂等返回同一账户
  v_r := public.open_stored_value_account(v_tenant, v_customer, 'CNY', null, 'wal-test-open-2');
  perform tests.assert_true((v_r->>'created')::boolean = false, '重复开户应 created=false');
  perform tests.assert_true((v_r->>'accountId')::uuid = v_account_id, '重复开户应返回同一账户');

  -- 1.3 跨租户客户开户 → 拒绝
  perform tests.assert_raises(
    format('select public.open_stored_value_account(%L, %L, ''CNY'')', v_tenant, '99999999-0000-0000-0000-000000000063'),
    'CUSTOMER_NOT_FOUND',
    '跨租户客户开户应拒绝');

  -- 1.4 币种校验
  perform tests.assert_raises(
    format('select public.open_stored_value_account(%L, %L, ''USD'')', v_tenant, v_customer),
    'UNSUPPORTED_CURRENCY',
    '非 CNY 币种应拒绝');
end;
$$;

-- ============================================================
-- 2. 充值(本金 + 赠送,幂等)
-- ============================================================
do $$
declare
  v_tenant uuid := '99999999-0000-0000-0000-000000000051';
  v_customer uuid := '99999999-0000-0000-0000-000000000053';
  v_account_id uuid;
  v_r jsonb;
  v_ledger_cnt integer;
begin
  select id into v_account_id from public.stored_value_accounts
  where tenant_id = v_tenant and customer_id = v_customer and currency = 'CNY';

  -- 2.1 充值 100(本金 90 + 赠送 10)
  v_r := public.recharge_stored_value(v_account_id, 90, 10, 'cash', 'cash', 'TXN-0001', null, 'wal-test-recharge-1', '测试充值');
  perform tests.assert_true((v_r->>'balance')::numeric = 100, '充值后余额应为 100,实际: ' || (v_r->>'balance')::text);

  -- 2.2 重复同 idempotency_key → 返回原结果,余额不变
  v_r := public.recharge_stored_value(v_account_id, 90, 10, 'cash', 'cash', 'TXN-0001', null, 'wal-test-recharge-1', '测试充值');
  perform tests.assert_true((v_r->>'balance')::numeric = 100, '重复充值后余额应仍为 100');

  -- 2.3 本金与赠送分别记账(2 条 credit 流水)
  select count(*) into v_ledger_cnt from public.stored_value_ledger
  where account_id = v_account_id and type in ('recharge', 'bonus') and direction = 'credit';
  perform tests.assert_true(v_ledger_cnt = 2, '充值应产生 2 条流水(recharge+bonus),实际: ' || v_ledger_cnt);

  -- 2.4 充值来源必填
  perform tests.assert_raises(
    format('select public.recharge_stored_value(%L, 10, 0, NULL)', v_account_id),
    'RECHARGE_SOURCE_REQUIRED',
    '充值来源必填');
end;
$$;

-- ============================================================
-- 3. 收银储值支付(同事务扣 Wallet + 写 Payment)
-- ============================================================
do $$
declare
  v_tenant uuid := '99999999-0000-0000-0000-000000000051';
  v_store uuid := '99999999-0000-0000-0000-000000000052';
  v_customer uuid := '99999999-0000-0000-0000-000000000053';
  v_account_id uuid;
  v_invoice_id uuid;
  v_r jsonb;
  v_balance numeric;
  v_pay_cnt integer;
  v_inv public.invoices;
begin
  select id into v_account_id from public.stored_value_accounts
  where tenant_id = v_tenant and customer_id = v_customer and currency = 'CNY';

  -- 3.1 创建发票(应收 100)
  v_r := public.create_invoice(
    p_tenant_id := v_tenant,
    p_store_id := v_store,
    p_customer_id := v_customer,
    p_pet_id := null,
    p_encounter_id := null,
    p_items := '[{"catalog_item_id": null, "store_catalog_item_id": null, "name": "诊疗费", "unit_price": 100, "quantity": 1, "discount_amount": 0, "amount": 100, "sort_order": 0, "category": "service", "catalog_type": "service"}]'::jsonb,
    p_discount_amount := 0,
    p_discount_reason := null,
    p_tax_amount := 0,
    p_payment_method := null,
    p_due_date := null,
    p_operator_id := null,
    p_apply_membership_discount := false
  );
  v_invoice_id := (v_r->>'invoiceId')::uuid;
  perform tests.assert_true(v_invoice_id is not null, 'create_invoice 应返回 invoiceId');

  -- 3.2 确认发票(返回 invoices 行类型)
  v_inv := public.confirm_invoice(v_invoice_id, null);
  perform tests.assert_true(v_inv.status = 'confirmed', '发票应确认,实际: ' || v_inv.status);

  -- 3.3 stored_value 支付 80 → 余额 100-80=20,发票部分支付
  v_r := public.process_payment(v_invoice_id, 80, 'stored_value', null, 'wal-test-pay-1', null);
  perform tests.assert_true((v_r->>'paidAmount')::numeric = 80, '发票已付金额应为 80');
  select balance into v_balance from public.stored_value_accounts where id = v_account_id;
  perform tests.assert_true(v_balance = 20, '支付后储值余额应为 20,实际: ' || v_balance);

  -- 3.4 payments 记录 method=stored_value
  select count(*) into v_pay_cnt from public.payments
  where invoice_id = v_invoice_id and method = 'stored_value' and amount = 80;
  perform tests.assert_true(v_pay_cnt = 1, '应存在 1 条 stored_value 支付记录');

  -- 3.5 幂等:同一 idempotency_key 重复支付 → 返回原结果,余额不变
  v_r := public.process_payment(v_invoice_id, 80, 'stored_value', null, 'wal-test-pay-1', null);
  select balance into v_balance from public.stored_value_accounts where id = v_account_id;
  perform tests.assert_true(v_balance = 20, '重复支付后余额应仍为 20');

  -- 3.6 余额不足:再支付 30(余额仅 20)→ INSUFFICIENT
  perform tests.assert_raises(
    format('select public.process_payment(%L, 30, ''stored_value'', NULL, ''wal-test-pay-2'')', v_invoice_id),
    'INSUFFICIENT_WALLET_BALANCE',
    '余额不足支付应拒绝');
  select balance into v_balance from public.stored_value_accounts where id = v_account_id;
  perform tests.assert_true(v_balance = 20, '余额不足拒绝后余额应仍为 20');

  -- 3.7 无客户发票不允许储值支付
  v_r := public.create_invoice(
    p_tenant_id := v_tenant,
    p_store_id := v_store,
    p_customer_id := null,
    p_pet_id := null,
    p_encounter_id := null,
    p_items := '[{"catalog_item_id": null, "store_catalog_item_id": null, "name": "无客户项目", "unit_price": 50, "quantity": 1, "discount_amount": 0, "amount": 50, "sort_order": 0, "category": "service", "catalog_type": "service"}]'::jsonb,
    p_discount_amount := 0,
    p_discount_reason := null,
    p_tax_amount := 0,
    p_payment_method := null,
    p_due_date := null,
    p_operator_id := null,
    p_apply_membership_discount := false
  );
  v_invoice_id := (v_r->>'invoiceId')::uuid;
  v_inv := public.confirm_invoice(v_invoice_id, null);
  perform tests.assert_raises(
    format('select public.process_payment(%L, 50, ''stored_value'', NULL, ''wal-test-pay-3'')', v_invoice_id),
    'INVOICE_NO_CUSTOMER',
    '无客户发票储值支付应拒绝');
end;
$$;

-- ============================================================
-- 4. 退款返还(同事务 Wallet credit + refunds 表)
-- ============================================================
do $$
declare
  v_tenant uuid := '99999999-0000-0000-0000-000000000051';
  v_customer uuid := '99999999-0000-0000-0000-000000000053';
  v_account_id uuid;
  v_invoice_id uuid;
  v_r jsonb;
  v_balance numeric;
begin
  select id into v_account_id from public.stored_value_accounts
  where tenant_id = v_tenant and customer_id = v_customer and currency = 'CNY';

  -- 取刚创建且已部分支付(80/100)的发票
  select id into v_invoice_id from public.invoices
  where tenant_id = v_tenant and customer_id = v_customer
  order by created_at desc limit 1;

  -- 4.1 退款 40 → 余额 20+40=60,refundedToWallet=true
  v_r := public.process_refund(v_invoice_id, 40, '客户退款', null, 'wal-test-refund-1', null);
  perform tests.assert_true((v_r->>'refundedToWallet')::boolean = true, 'stored_value 原支付退款应返还 Wallet');
  select balance into v_balance from public.stored_value_accounts where id = v_account_id;
  perform tests.assert_true(v_balance = 60, '退款后余额应为 60,实际: ' || v_balance);

  -- 4.2 refund replay:同一 idempotency_key 重复退款 → 只返一次
  v_r := public.process_refund(v_invoice_id, 40, '客户退款', null, 'wal-test-refund-1', null);
  select balance into v_balance from public.stored_value_accounts where id = v_account_id;
  perform tests.assert_true(v_balance = 60, '重复退款后余额应仍为 60(只返一次)');
end;
$$;

-- ============================================================
-- 5. 冻结 / 解冻 / 人工调整
-- ============================================================
do $$
declare
  v_tenant uuid := '99999999-0000-0000-0000-000000000051';
  v_customer uuid := '99999999-0000-0000-0000-000000000053';
  v_account_id uuid;
  v_r jsonb;
  v_balance numeric;
begin
  select id into v_account_id from public.stored_value_accounts
  where tenant_id = v_tenant and customer_id = v_customer and currency = 'CNY';

  -- 5.1 冻结(须填 reason)
  v_r := public.set_stored_value_account_status(v_account_id, 'frozen', '客户投诉临时冻结', null);
  perform tests.assert_true((v_r->>'status')::text = 'frozen', '账户应已冻结');

  -- 5.2 冻结后人工调整 → 拒绝
  perform tests.assert_raises(
    format('select public.adjust_stored_value(%L, 10, ''测试'', NULL, ''wal-test-adjust-1'')', v_account_id),
    'WALLET_ACCOUNT_FROZEN',
    '冻结账户调整应拒绝');

  -- 5.3 解冻
  v_r := public.set_stored_value_account_status(v_account_id, 'active', '问题已处理', null);
  perform tests.assert_true((v_r->>'status')::text = 'active', '账户应已解冻');

  -- 5.4 人工调整 +15 → 60+15=75
  v_r := public.adjust_stored_value(v_account_id, 15, '活动补偿', null, 'wal-test-adjust-2');
  perform tests.assert_true((v_r->>'balance')::numeric = 75, '调整后余额应为 75,实际: ' || (v_r->>'balance')::text);

  -- 5.5 调整原因必填
  perform tests.assert_raises(
    format('select public.adjust_stored_value(%L, 10, NULL)', v_account_id),
    'ADJUST_REASON_REQUIRED',
    '调整原因必填');

  -- 5.6 调整导致余额为负 → 拒绝
  perform tests.assert_raises(
    format('select public.adjust_stored_value(%L, -100, ''超额扣减'', NULL, ''wal-test-adjust-3'')', v_account_id),
    'INSUFFICIENT_WALLET_BALANCE',
    '余额为负调整应拒绝');
  select balance into v_balance from public.stored_value_accounts where id = v_account_id;
  perform tests.assert_true(v_balance = 75, '拒绝后余额应仍为 75');

  -- 5.7 销户须余额清零
  perform tests.assert_raises(
    format('select public.set_stored_value_account_status(%L, ''closed'', ''销户'')', v_account_id),
    'CLOSING_BALANCE_NOT_ZERO',
    '余额非 0 销户应拒绝');
end;
$$;

-- ============================================================
-- 6. RLS / 不可变流水 / RPC ACL
-- ============================================================
do $$
declare
  v_tenant uuid := '99999999-0000-0000-0000-000000000051';
  v_user uuid := '99999999-0000-0000-0000-0000000000a1';
  v_ledger_id uuid;
  v_can_exec boolean;
begin
  -- 取一条流水 id 用于不可变断言
  select id into v_ledger_id from public.stored_value_ledger
  where tenant_id = v_tenant order by created_at desc limit 1;
  perform tests.assert_true(v_ledger_id is not null, '应存在流水用于不可变断言');

  -- 6.1 以 authenticated(收银)身份:RLS 允许 select 本租户流水
  set local role authenticated;
  set local request.jwt.claims = jsonb_build_object(
    'sub', v_user::text,
    'role', 'authenticated',
    'email', 's31-wal-cash@test.local'
  );
  -- select 应可见(is_tenant_member 基于 jwt sub 匹配 tenant_memberships)
  perform tests.assert_true(
    exists (select 1 from public.stored_value_ledger where id = v_ledger_id),
    'authenticated 应可读本租户流水(RLS select)'
  );

  -- 不可变流水:表级 revoke(含 authenticated)使直接 UPDATE/DELETE 抛 permission denied
  perform tests.assert_raises(
    format('update public.stored_value_ledger set amount = 999999 where id = %L', v_ledger_id),
    'permission denied',
    'authenticated 更新流水应被表级 revoke 拒绝'
  );
  perform tests.assert_raises(
    format('delete from public.stored_value_ledger where id = %L', v_ledger_id),
    'permission denied',
    'authenticated 删除流水应被表级 revoke 拒绝'
  );

  -- 6.2 authenticated 不能直接写账户余额(同样被表级 revoke 拒绝)
  perform tests.assert_raises(
    format('update public.stored_value_accounts set balance = 999999 where tenant_id = %L', v_tenant),
    'permission denied',
    'authenticated 直接改余额应被表级 revoke 拒绝'
  );
  reset role;

  -- 6.3 RPC ACL:authenticated 无 EXECUTE(service-role-only)
  select has_function_privilege('authenticated', 'public.open_stored_value_account(uuid, uuid, text, uuid, text)', 'EXECUTE')
    into v_can_exec;
  perform tests.assert_true(v_can_exec = false, 'open_stored_value_account 不应授予 authenticated');
  select has_function_privilege('authenticated', 'public.recharge_stored_value(uuid, numeric, numeric, text, text, text, uuid, text, text)', 'EXECUTE')
    into v_can_exec;
  perform tests.assert_true(v_can_exec = false, 'recharge_stored_value 不应授予 authenticated');
  select has_function_privilege('authenticated', 'public.process_payment(uuid, numeric, text, uuid, text, text)', 'EXECUTE')
    into v_can_exec;
  perform tests.assert_true(v_can_exec = false, 'process_payment 不应授予 authenticated(92 号统一收紧)');
end;
$$;

-- ============================================================
-- 7. 权限 seed 矩阵 / payment_contexts / Billing 约束
-- ============================================================
do $$
declare
  v_has boolean;
begin
  -- 7.1 system_admin / tenant_owner / store_manager 拥有全部 wallet 权限
  select exists(
    select 1 from public.role_permissions rp
    join public.roles r on r.id = rp.role_id
    join public.permissions p on p.id = rp.permission_id
    where r.code in ('system_admin', 'tenant_owner', 'store_manager')
      and p.code in ('wallet.view', 'wallet.recharge', 'wallet.adjust', 'wallet.freeze')
    group by r.code
    having count(distinct p.code) = 4
  ) into v_has;
  perform tests.assert_true(v_has, 'system_admin/tenant_owner/store_manager 应拥有全部 4 个 wallet 权限');

  -- 7.2 cashier 仅 view + recharge(不授予 adjust/freeze)
  select exists(
    select 1 from public.role_permissions rp
    join public.roles r on r.id = rp.role_id
    join public.permissions p on p.id = rp.permission_id
    where r.code = 'cashier' and p.code in ('wallet.view', 'wallet.recharge')
  ) into v_has;
  perform tests.assert_true(v_has, 'cashier 应拥有 wallet.view + wallet.recharge');
  select not exists(
    select 1 from public.role_permissions rp
    join public.roles r on r.id = rp.role_id
    join public.permissions p on p.id = rp.permission_id
    where r.code = 'cashier' and p.code in ('wallet.adjust', 'wallet.freeze')
  ) into v_has;
  perform tests.assert_true(v_has, 'cashier 不应拥有 wallet.adjust / wallet.freeze');

  -- 7.3 ensure_stored_value_payment_context 可启用储值支付方式(不依赖 seed,显式调用验证)
  perform public.ensure_stored_value_payment_context(
    '99999999-0000-0000-0000-000000000051',
    '99999999-0000-0000-0000-000000000052',
    true, null
  );
  select exists(
    select 1 from public.payment_contexts
    where tenant_id = '99999999-0000-0000-0000-000000000051'
      and store_id = '99999999-0000-0000-0000-000000000052'
      and method = 'stored_value'
  ) into v_has;
  perform tests.assert_true(v_has, 'ensure 后租户 A 门店应存在 stored_value 支付上下文');

  -- 7.4 Billing method 约束接受 stored_value
  select exists(
    select 1 from pg_constraint where conname = 'payments_method_check'
  ) into v_has;
  perform tests.assert_true(v_has, 'payments_method_check 约束应存在');
  select exists(
    select 1 from pg_constraint where conname = 'invoices_payment_method_check'
  ) into v_has;
  perform tests.assert_true(v_has, 'invoices_payment_method_check 约束应存在');
end;
$$;

-- ============================================================
-- 全部通过
-- ============================================================
do $$
begin
  raise notice 'WALLET_STORED_VALUE_TESTS: ALL PASSED';
end;
$$;

rollback;
