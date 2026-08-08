-- ============================================================
-- RLS 测试:customers / pets / pet_weights / import_jobs 跨租户/跨门店隔离
-- MXQ-5001 / MXQ-5005 / MXQ-5010
--
-- 执行方式(需要可运行的 Supabase 数据库,本地 Docker 或 CI):
--   1) supabase db reset
--   2) psql "$DATABASE_URL" -f supabase/tests/rls_crm.sql
--
-- 断言矩阵:
--   C1 跨租户不可读客户(A 用户读取 B 租户客户 = 0)
--   C2 跨租户不可写客户(A 用户写入 B 租户客户 = 拒绝)
--   C3 无权门店客户不可读(A1 员工读取 A2 门店客户 = 0)
--   C4 合法门店客户可读(A1 员工读取 A1 门店客户 = 成功)
--   C5 宠物跟随客户隔离(跨租户宠物不可读)
--   C6 pet_weights 跟随宠物隔离
--   C7 import_jobs 跨租户不可读
--   C8 import_jobs 门店级隔离
-- ============================================================

begin;

-- ---------- 断言辅助 ----------
create schema if not exists tests;
grant usage on schema tests to authenticated, anon, service_role;
create or replace function tests.assert_true(cond boolean, msg text)
returns void
language plpgsql as $$
begin
  if not cond then
    raise exception 'RLS_TEST_FAILED: %', msg;
  end if;
end;
$$;

-- ---------- 复用夹具:两租户 / 三门店 ----------
-- 租户 A:门店 A1、A2;租户 B:门店 B1
-- 用户:u_a1(T_A/A1 店长)、u_a2(T_A/A2)、u_b(T_B/B1)、u_admin(system_admin)
insert into public.tenants (id, slug, name) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'tenant-a-crm', '租户 A'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'tenant-b-crm', '租户 B')
on conflict (slug) do nothing;

insert into auth.users (id, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, aud, role, created_at, updated_at)
values
  ('aaaaaaaa-0000-0000-0000-0000000000a1', 'u-a1-crm@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now()),
  ('aaaaaaaa-0000-0000-0000-0000000000a2', 'u-a2-crm@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now()),
  ('bbbbbbbb-0000-0000-0000-0000000000b1', 'u-b1-crm@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now()),
  ('cccccccc-0000-0000-0000-0000000000cc', 'u-admin-crm@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now())
on conflict (id) do nothing;

insert into public.stores (id, tenant_id, name, code, status) values
  ('aaaaaaaa-0000-0000-0000-0000000000f1', 'aaaaaaaa-0000-0000-0000-000000000001', 'A1 店', 'A1C', 'active'),
  ('aaaaaaaa-0000-0000-0000-0000000000f2', 'aaaaaaaa-0000-0000-0000-000000000001', 'A2 店', 'A2C', 'active'),
  ('bbbbbbbb-0000-0000-0000-0000000000f1', 'bbbbbbbb-0000-0000-0000-000000000001', 'B1 店', 'B1C', 'active')
on conflict do nothing;

insert into public.tenant_memberships (tenant_id, user_id, status) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'active'),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a2', 'active'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-0000000000b1', 'active'),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-0000000000cc', 'active')
on conflict do nothing;

insert into public.employees (tenant_id, user_id, employee_no, name, status) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'EMP-A1C', 'A1 员工', 'active'),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a2', 'EMP-A2C', 'A2 员工', 'active'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-0000000000b1', 'EMP-B1C', 'B1 员工', 'active'),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-0000000000cc', 'EMP-ADMIN-C', '管理员', 'active')
on conflict do nothing;

insert into public.employee_store_assignments (tenant_id, employee_id, store_id, is_primary) values
  ('aaaaaaaa-0000-0000-0000-000000000001', (select id from public.employees where employee_no = 'EMP-A1C'), 'aaaaaaaa-0000-0000-0000-0000000000f1', true),
  ('aaaaaaaa-0000-0000-0000-000000000001', (select id from public.employees where employee_no = 'EMP-A2C'), 'aaaaaaaa-0000-0000-0000-0000000000f2', true),
  ('bbbbbbbb-0000-0000-0000-000000000001', (select id from public.employees where employee_no = 'EMP-B1C'), 'bbbbbbbb-0000-0000-0000-0000000000f1', true)
on conflict do nothing;

-- 给员工分配 store_manager 角色(含 customer.*/pet.* 权限)
insert into public.employee_role_assignments (tenant_id, employee_id, role_id, store_id)
values
  ('aaaaaaaa-0000-0000-0000-000000000001', (select id from public.employees where employee_no = 'EMP-A1C'), (select id from public.roles where code = 'store_manager'), 'aaaaaaaa-0000-0000-0000-0000000000f1'),
  ('aaaaaaaa-0000-0000-0000-000000000001', (select id from public.employees where employee_no = 'EMP-A2C'), (select id from public.roles where code = 'store_manager'), 'aaaaaaaa-0000-0000-0000-0000000000f2'),
  ('bbbbbbbb-0000-0000-0000-000000000001', (select id from public.employees where employee_no = 'EMP-B1C'), (select id from public.roles where code = 'store_manager'), 'bbbbbbbb-0000-0000-0000-0000000000f1')
on conflict do nothing;

-- ---------- 测试数据:客户 ----------
-- A1 门店客户
insert into public.customers (id, tenant_id, store_id, customer_no, name, phone, status)
values
  ('aaaaaaaa-c000-0000-0000-0000000000c1', 'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000f1', 'A1C-CUST-001', 'A1 客户1', '13800000001', 'active'),
  ('aaaaaaaa-c000-0000-0000-0000000000c2', 'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000f1', 'A1C-CUST-002', 'A1 客户2', '13800000002', 'active')
on conflict do nothing;

-- A2 门店客户
insert into public.customers (id, tenant_id, store_id, customer_no, name, phone, status)
values
  ('aaaaaaaa-c000-0000-0000-0000000000c3', 'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000f2', 'A2C-CUST-001', 'A2 客户1', '13800000003', 'active')
on conflict do nothing;

-- B1 门店客户
insert into public.customers (id, tenant_id, store_id, customer_no, name, phone, status)
values
  ('bbbbbbbb-c000-0000-0000-0000000000b1', 'bbbbbbbb-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-0000000000f1', 'B1C-CUST-001', 'B1 客户1', '13900000001', 'active')
on conflict do nothing;

-- ---------- 测试数据:宠物 ----------
insert into public.pets (id, tenant_id, customer_id, name, species, status)
values
  ('aaaaaaaa-e000-0000-0000-0000000000e1', 'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-c000-0000-0000-0000000000c1', 'A1 宠物1', 'dog', 'active'),
  ('bbbbbbbb-e000-0000-0000-0000000000e1', 'bbbbbbbb-0000-0000-0000-000000000001', 'bbbbbbbb-c000-0000-0000-0000000000b1', 'B1 宠物1', 'cat', 'active')
on conflict do nothing;

-- ---------- 测试数据:体重记录 ----------
insert into public.pet_weights (id, tenant_id, pet_id, weight, recorded_at)
values
  ('aaaaaaaa-d000-0000-0000-0000000000d1', 'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-e000-0000-0000-0000000000e1', 5.5, now())
on conflict do nothing;

-- ---------- 测试数据:导入任务 ----------
insert into public.import_jobs (id, tenant_id, store_id, type, status, total_rows)
values
  ('aaaaaaaa-b000-0000-0000-0000000000b2', 'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000f1', 'customer', 'completed', 10),
  ('bbbbbbbb-b000-0000-0000-0000000000b2', 'bbbbbbbb-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-0000000000f1', 'customer', 'completed', 5)
on conflict do nothing;

-- ======================================================================
-- C1: 跨租户不可读客户(A1 员工读取 B 租户客户 = 0)
-- ======================================================================
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-0000000000a1","role":"authenticated"}', true);

  perform tests.assert_true(
    (select count(*) from public.customers where tenant_id = 'bbbbbbbb-0000-0000-0000-000000000001') = 0,
    'C1: A1 员工不应读到 B 租户客户'
  );

  perform tests.assert_true(
    (select count(*) from public.customers where store_id = 'aaaaaaaa-0000-0000-0000-0000000000f1') >= 2,
    'C4: A1 员工应能读到 A1 门店客户'
  );

  perform tests.assert_true(
    (select count(*) from public.customers where store_id = 'aaaaaaaa-0000-0000-0000-0000000000f2') = 0,
    'C3: A1 员工不应读到 A2 门店客户'
  );

  perform tests.assert_true(
    (select count(*) from public.pets where tenant_id = 'bbbbbbbb-0000-0000-0000-000000000001') = 0,
    'C5: A1 员工不应读到 B 租户宠物'
  );

  perform tests.assert_true(
    (select count(*) from public.pet_weights where tenant_id = 'bbbbbbbb-0000-0000-0000-000000000001') = 0,
    'C6: A1 员工不应读到 B 租户体重记录'
  );

  perform tests.assert_true(
    (select count(*) from public.import_jobs where tenant_id = 'bbbbbbbb-0000-0000-0000-000000000001') = 0,
    'C7: A1 员工不应读到 B 租户导入任务'
  );

  perform tests.assert_true(
    (select count(*) from public.import_jobs where store_id = 'aaaaaaaa-0000-0000-0000-0000000000f1') >= 1,
    'C8: A1 员工应能读到 A1 门店导入任务'
  );

  -- C2: 跨租户不可写客户
  begin
    begin
      insert into public.customers (tenant_id, store_id, customer_no, name, status)
      values ('bbbbbbbb-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-0000000000f1', 'TEST-CROSS-TENANT', '测试跨租户', 'active');
      raise exception 'C2: A1 员工不应能写入 B 租户客户';
    exception
      when insufficient_privilege or check_violation then
        null;
    end;
  end;
end;
$$;

reset role;

-- ---------- 打印成功 ----------
do $$
begin
  raise notice 'RLS CRM 测试全部通过';
end;
$$;

rollback;
