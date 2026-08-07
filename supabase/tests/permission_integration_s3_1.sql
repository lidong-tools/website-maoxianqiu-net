-- ============================================================
-- 权限/RLS 回归测试:S31-MERGE-A(A03)
--
-- 验证 migration 33(permission_reconcile_integration)后的权限语义:
--
-- Part 1 can_access_store tenant-wide semantics(A02)
--   tenant A owner(scope=tenant, store_id IS NULL 分配,无 employee_store_assignment)
--     → A 门店 A1 PASS / A 门店 A2 PASS / B 门店 FAIL
--   store_manager(A1)
--     → A1 PASS / A2 FAIL(不放大 store role)
--
-- Part 2 tenant_owner 监管权限 reconciliation(A01)
--   10 个监管权限 + veterinarian_registration 保持 PASS(租户上下文)
--   跨租户 FAIL(tenant A owner ≠ tenant B 权限)
--
-- Part 3 annual regulatory report 权限矩阵
--   tenant_owner read/generate/submit PASS
--   store_manager read PASS / generate FAIL / submit FAIL
--   doctor submit FAIL
--
-- Part 4 veterinarian registration 权限矩阵(保持 FINAL-01 基线)
--   tenant_owner manage PASS / store_manager 租户上下文 manage FAIL
--   doctor manage FAIL / tenant A owner → tenant B FAIL
--
-- Part 5 RLS 端到端实测(监管表 institution_licenses)
--   tenant_owner 无 store 分配也可读本租户全部门店数据
--   store_manager 只读被授权门店
--   跨租户不可读
--
-- 本文件独立可执行(psql "$DATABASE_URL" -f supabase/tests/permission_integration_s3_1.sql):
--   - 自建 tests.assert_* 断言函数,不依赖其他测试文件;
--   - 单一事务 begin/rollback,无任何残留;
--   - 每个 DO 块以 execute 'reset role' 回到连接角色。
-- ============================================================

begin;

create schema if not exists tests;
grant usage on schema tests to authenticated, anon, service_role;

create or replace function tests.assert_true(cond boolean, msg text)
returns void
language plpgsql as $$
begin
  if not cond then
    raise exception 'PERMISSION_TEST_FAILED: %', msg;
  end if;
end;
$$;

-- ============================================================
-- 夹具:两租户 / 三门店 / 四个用户
-- 固定 UUID 前缀 f0000000 保证与其他测试文件隔离
-- ============================================================
insert into public.tenants (id, slug, name) values
  ('f0000000-0000-0000-0000-000000000001', 'mergea-tenant-a', '合并测试租户 A'),
  ('f0000000-0000-0000-0000-000000000002', 'mergea-tenant-b', '合并测试租户 B');

insert into auth.users (id, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, aud, role, created_at, updated_at)
values
  ('f0000000-0000-0000-0000-000000000101', 'mergea-owner@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now()),
  ('f0000000-0000-0000-0000-000000000102', 'mergea-mgr@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now()),
  ('f0000000-0000-0000-0000-000000000103', 'mergea-doc@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now()),
  ('f0000000-0000-0000-0000-000000000201', 'mergea-user-b@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now());

insert into public.stores (id, tenant_id, name, code, status) values
  ('f0000000-0000-0000-0000-0000000000a1', 'f0000000-0000-0000-0000-000000000001', 'A1 店', 'MA-A1', 'active'),
  ('f0000000-0000-0000-0000-0000000000a2', 'f0000000-0000-0000-0000-000000000001', 'A2 店', 'MA-A2', 'active'),
  ('f0000000-0000-0000-0000-0000000000b1', 'f0000000-0000-0000-0000-000000000002', 'B1 店', 'MA-B1', 'active');

insert into public.tenant_memberships (tenant_id, user_id, status) values
  ('f0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000101', 'active'),
  ('f0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000102', 'active'),
  ('f0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000103', 'active'),
  ('f0000000-0000-0000-0000-000000000002', 'f0000000-0000-0000-0000-000000000201', 'active');

insert into public.employees (id, tenant_id, user_id, employee_no, name, status) values
  ('f0000000-0000-0000-0000-000000000111', 'f0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000101', 'MA-OWNER', '租户A所有者', 'active'),
  ('f0000000-0000-0000-0000-000000000112', 'f0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000102', 'MA-MGR', 'A1店长', 'active'),
  ('f0000000-0000-0000-0000-000000000113', 'f0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000103', 'MA-DOC', 'A1医生', 'active'),
  ('f0000000-0000-0000-0000-000000000211', 'f0000000-0000-0000-0000-000000000002', 'f0000000-0000-0000-0000-000000000201', 'MA-BMGR', 'B1店长', 'active');

-- 角色分配(触发器 validate_era_scope 兜底:
--   tenant_owner 必须 store_id IS NULL;store_manager/doctor 必须带 store_id)
insert into public.employee_role_assignments (tenant_id, employee_id, role_id, store_id) values
  ('f0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000111',
   (select id from public.roles where code = 'tenant_owner'), null),
  ('f0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000112',
   (select id from public.roles where code = 'store_manager'), 'f0000000-0000-0000-0000-0000000000a1'),
  ('f0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000113',
   (select id from public.roles where code = 'doctor'), 'f0000000-0000-0000-0000-0000000000a1'),
  ('f0000000-0000-0000-0000-000000000002', 'f0000000-0000-0000-0000-000000000211',
   (select id from public.roles where code = 'store_manager'), 'f0000000-0000-0000-0000-0000000000b1');

-- 门店分配:owner 故意不分配任何门店(A02 核心:tenant-wide role 无需逐店分配)
insert into public.employee_store_assignments (tenant_id, employee_id, store_id, is_primary) values
  ('f0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000112', 'f0000000-0000-0000-0000-0000000000a1', true),
  ('f0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000113', 'f0000000-0000-0000-0000-0000000000a1', true),
  ('f0000000-0000-0000-0000-000000000002', 'f0000000-0000-0000-0000-000000000211', 'f0000000-0000-0000-0000-0000000000b1', true);

-- 监管数据 fixture(RLS 端到端实测用):租户 A 两门店 + 租户 B 一门店
insert into public.institution_licenses (tenant_id, store_id, license_no, issuing_authority, diagnosis_scope, issued_at, valid_from, valid_until, status) values
  ('f0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-0000000000a1', 'MA-A1-LIC', '测试局', '犬猫', (now() - interval '1 year')::date, (now() - interval '1 year')::date, (now() + interval '1 year')::date, 'active'),
  ('f0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-0000000000a2', 'MA-A2-LIC', '测试局', '犬猫', (now() - interval '1 year')::date, (now() - interval '1 year')::date, (now() + interval '1 year')::date, 'active'),
  ('f0000000-0000-0000-0000-000000000002', 'f0000000-0000-0000-0000-0000000000b1', 'MA-B1-LIC', '测试局', '犬猫', (now() - interval '1 year')::date, (now() - interval '1 year')::date, (now() + interval '1 year')::date, 'active');

-- ============================================================
-- Part 1:can_access_store tenant-wide semantics(A02)
-- ============================================================
do $$
begin
  execute 'reset role';
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"f0000000-0000-0000-0000-000000000101","role":"authenticated"}', true);
  -- tenant A owner 无 store 分配,仍应访问本租户全部门店(tenant-wide role)
  perform tests.assert_true(
    public.can_access_store('f0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-0000000000a1'),
    'P1: tenant A owner 应能访问 A1 门店(tenant-wide role,无 store 分配)');
  perform tests.assert_true(
    public.can_access_store('f0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-0000000000a2'),
    'P1: tenant A owner 应能访问 A2 门店(tenant-wide role,无 store 分配)');
  perform tests.assert_true(
    not public.can_access_store('f0000000-0000-0000-0000-000000000002', 'f0000000-0000-0000-0000-0000000000b1'),
    'P1: tenant A owner 不应访问租户 B 门店(跨租户隔离)');
end;
$$;

do $$
begin
  execute 'reset role';
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"f0000000-0000-0000-0000-000000000102","role":"authenticated"}', true);
  -- store_manager(A1):仅被授权门店,不放大为 tenant-wide
  perform tests.assert_true(
    public.can_access_store('f0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-0000000000a1'),
    'P1: A1 店长应能访问 A1 门店(store 分配)');
  perform tests.assert_true(
    not public.can_access_store('f0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-0000000000a2'),
    'P1: A1 店长不应访问 A2 门店(store role 不得提升为 tenant-wide)');
end;
$$;

do $$
begin
  execute 'reset role';
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"f0000000-0000-0000-0000-000000000103","role":"authenticated"}', true);
  -- doctor(A1):有门店分配即可访问目标门店
  perform tests.assert_true(
    public.can_access_store('f0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-0000000000a1'),
    'P1: A1 医生应能访问 A1 门店(store 分配)');
end;
$$;

-- ============================================================
-- Part 2:tenant_owner 监管权限 reconciliation(A01)
-- ============================================================
do $$
begin
  execute 'reset role';
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"f0000000-0000-0000-0000-000000000101","role":"authenticated"}', true);
  -- 监管 10 权限(租户上下文)
  perform tests.assert_true(public.has_permission('f0000000-0000-0000-0000-000000000001', null, 'license.read'), 'P2: owner 应持有 license.read');
  perform tests.assert_true(public.has_permission('f0000000-0000-0000-0000-000000000001', null, 'license.manage'), 'P2: owner 应持有 license.manage');
  perform tests.assert_true(public.has_permission('f0000000-0000-0000-0000-000000000001', null, 'regulatory_report.read'), 'P2: owner 应持有 regulatory_report.read');
  perform tests.assert_true(public.has_permission('f0000000-0000-0000-0000-000000000001', null, 'regulatory_report.generate'), 'P2: owner 应持有 regulatory_report.generate');
  perform tests.assert_true(public.has_permission('f0000000-0000-0000-0000-000000000001', null, 'regulatory_report.submit'), 'P2: owner 应持有 regulatory_report.submit');
  perform tests.assert_true(public.has_permission('f0000000-0000-0000-0000-000000000001', null, 'epidemic.read'), 'P2: owner 应持有 epidemic.read');
  perform tests.assert_true(public.has_permission('f0000000-0000-0000-0000-000000000001', null, 'epidemic.report'), 'P2: owner 应持有 epidemic.report');
  perform tests.assert_true(public.has_permission('f0000000-0000-0000-0000-000000000001', null, 'epidemic.resolve'), 'P2: owner 应持有 epidemic.resolve');
  perform tests.assert_true(public.has_permission('f0000000-0000-0000-0000-000000000001', null, 'waste.read'), 'P2: owner 应持有 waste.read');
  perform tests.assert_true(public.has_permission('f0000000-0000-0000-0000-000000000001', null, 'waste.manage'), 'P2: owner 应持有 waste.manage');
  -- veterinarian 保持(FINAL-01 基线)
  perform tests.assert_true(public.has_permission('f0000000-0000-0000-0000-000000000001', null, 'veterinarian_registration.read'), 'P2: owner 应持有 veterinarian_registration.read(保持)');
  perform tests.assert_true(public.has_permission('f0000000-0000-0000-0000-000000000001', null, 'veterinarian_registration.manage'), 'P2: owner 应持有 veterinarian_registration.manage(保持)');
  -- 跨租户 FAIL
  perform tests.assert_true(
    not public.has_permission('f0000000-0000-0000-0000-000000000002', null, 'license.manage'),
    'P2: tenant A owner 不应持有租户 B 的 license.manage(跨租户隔离)');
end;
$$;

-- ============================================================
-- Part 3:annual regulatory report 权限矩阵
-- ============================================================
do $$
declare
  v_tenant uuid := 'f0000000-0000-0000-0000-000000000001';
begin
  execute 'reset role';
  -- tenant_owner:read/generate/submit 全 PASS
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"f0000000-0000-0000-0000-000000000101","role":"authenticated"}', true);
  perform tests.assert_true(public.has_permission(v_tenant, null, 'regulatory_report.read'), 'P3: owner read PASS');
  perform tests.assert_true(public.has_permission(v_tenant, null, 'regulatory_report.generate'), 'P3: owner generate PASS');
  perform tests.assert_true(public.has_permission(v_tenant, null, 'regulatory_report.submit'), 'P3: owner submit PASS');
end;
$$;

do $$
declare
  v_tenant uuid := 'f0000000-0000-0000-0000-000000000001';
  v_store uuid := 'f0000000-0000-0000-0000-0000000000a1';
begin
  execute 'reset role';
  -- store_manager(A1):read PASS / generate FAIL / submit FAIL
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"f0000000-0000-0000-0000-000000000102","role":"authenticated"}', true);
  perform tests.assert_true(public.has_permission(v_tenant, v_store, 'regulatory_report.read'), 'P3: store_manager read PASS');
  perform tests.assert_true(not public.has_permission(v_tenant, v_store, 'regulatory_report.generate'), 'P3: store_manager generate FAIL');
  perform tests.assert_true(not public.has_permission(v_tenant, v_store, 'regulatory_report.submit'), 'P3: store_manager submit FAIL');
end;
$$;

do $$
declare
  v_tenant uuid := 'f0000000-0000-0000-0000-000000000001';
  v_store uuid := 'f0000000-0000-0000-0000-0000000000a1';
begin
  execute 'reset role';
  -- doctor(A1):submit FAIL(租户上下文与门店上下文均应 FAIL)
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"f0000000-0000-0000-0000-000000000103","role":"authenticated"}', true);
  perform tests.assert_true(not public.has_permission(v_tenant, v_store, 'regulatory_report.submit'), 'P3: doctor submit FAIL(store 上下文)');
  perform tests.assert_true(not public.has_permission(v_tenant, null, 'regulatory_report.submit'), 'P3: doctor submit FAIL(tenant 上下文)');
end;
$$;

-- ============================================================
-- Part 4:veterinarian registration 权限矩阵(保持 FINAL-01 基线)
-- ============================================================
do $$
declare
  v_tenant uuid := 'f0000000-0000-0000-0000-000000000001';
begin
  execute 'reset role';
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"f0000000-0000-0000-0000-000000000101","role":"authenticated"}', true);
  -- tenant_owner manage PASS(租户上下文)
  perform tests.assert_true(public.has_permission(v_tenant, null, 'veterinarian_registration.manage'), 'P4: tenant_owner 租户上下文 manage PASS');
  -- tenant A owner → 租户 B FAIL
  perform tests.assert_true(
    not public.has_permission('f0000000-0000-0000-0000-000000000002', null, 'veterinarian_registration.manage'),
    'P4: tenant A owner 访问租户 B 备案 FAIL(跨租户隔离)');
end;
$$;

do $$
declare
  v_tenant uuid := 'f0000000-0000-0000-0000-000000000001';
begin
  execute 'reset role';
  -- store_manager 租户上下文 manage FAIL(store role 不得提升)
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"f0000000-0000-0000-0000-000000000102","role":"authenticated"}', true);
  perform tests.assert_true(not public.has_permission(v_tenant, null, 'veterinarian_registration.manage'), 'P4: store_manager 租户上下文 manage FAIL');
end;
$$;

do $$
declare
  v_tenant uuid := 'f0000000-0000-0000-0000-000000000001';
begin
  execute 'reset role';
  -- doctor manage FAIL
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"f0000000-0000-0000-0000-000000000103","role":"authenticated"}', true);
  perform tests.assert_true(not public.has_permission(v_tenant, null, 'veterinarian_registration.manage'), 'P4: doctor manage FAIL');
end;
$$;

-- ============================================================
-- Part 5:RLS 端到端实测(监管表 institution_licenses)
-- ============================================================
do $$
begin
  execute 'reset role';
  -- tenant A owner(无 store 分配):应读本租户全部门店许可证(2 条),跨租户不可读
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"f0000000-0000-0000-0000-000000000101","role":"authenticated"}', true);
  perform tests.assert_true(
    (select count(*) from public.institution_licenses where tenant_id = 'f0000000-0000-0000-0000-000000000001') = 2,
    'P5: tenant A owner 应读到本租户 A1+A2 两张许可证(tenant-wide RLS)');
  perform tests.assert_true(
    (select count(*) from public.institution_licenses where tenant_id = 'f0000000-0000-0000-0000-000000000002') = 0,
    'P5: tenant A owner 不应读到租户 B 许可证(跨租户 RLS)');
end;
$$;

do $$
begin
  execute 'reset role';
  -- store_manager(A1):只读被授权门店 A1(1 条),A2 被 RLS 遮挡
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"f0000000-0000-0000-0000-000000000102","role":"authenticated"}', true);
  perform tests.assert_true(
    (select count(*) from public.institution_licenses where tenant_id = 'f0000000-0000-0000-0000-000000000001') = 1,
    'P5: A1 店长应只读到 A1 许可证(A2 被 RLS 遮挡)');
  perform tests.assert_true(
    (select count(*) from public.institution_licenses where store_id = 'f0000000-0000-0000-0000-0000000000a2') = 0,
    'P5: A1 店长不应读到 A2 门店许可证');
end;
$$;

-- 全部断言通过(事务 rollback 撤销夹具与函数,数据库无残留)
select 'PERMISSION_INTEGRATION_TEST_PASSED' as result;

rollback;
