-- ============================================================
-- RLS 测试:跨租户 / 跨门店隔离(MXQ-3007)
--
-- 执行方式(需要可运行的 Supabase 数据库,本地 Docker 或 CI):
--   1) supabase db reset                                  # 应用 migrations + seed
--   2) psql "$DATABASE_URL" -f supabase/tests/rls_tenant_store.sql
-- 或直接复制到 SQL Editor 以 postgres 角色执行。
--
-- 断言矩阵:
--   T1 跨租户不可读(A 用户读取 B 租户数据 = 0)
--   T2 跨租户不可写(A 用户写入 B 租户数据 = 拒绝)
--   T3 无权门店不可读(A1 员工读取 A2 门店明细 = 0)
--   T4 无权门店不可写(A1 员工写入 A2 门店 = 拒绝)
--   T5 合法门店访问成功(A1 员工读写本店 = 成功)
--   T6 管理员特殊访问有审计(system_admin 跨店读取成功,审计可写且普通角色不可读)
--
-- 任何断言失败都会 RAISE EXCEPTION,整体 rollback 不污染数据库。
-- ============================================================

begin;

-- ---------- 断言辅助(整个脚本在事务中,rollback 会撤销所有 DDL/夹具) ----------
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

-- ---------- 夹具:两租户 / 三门店 ----------
-- 租户 A:门店 A1、A2;租户 B:门店 B1
-- 用户:u_a1(T_A/A1 店长)、u_a2(T_A/A2)、u_b(T_B/B1)、u_admin(system_admin)
insert into public.tenants (id, slug, name) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'tenant-a', '租户 A'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'tenant-b', '租户 B');

insert into auth.users (id, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, aud, role, created_at, updated_at)
values
  ('aaaaaaaa-0000-0000-0000-0000000000a1', 'u-a1@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now()),
  ('aaaaaaaa-0000-0000-0000-0000000000a2', 'u-a2@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now()),
  ('bbbbbbbb-0000-0000-0000-0000000000b1', 'u-b1@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now()),
  ('cccccccc-0000-0000-0000-0000000000cc', 'u-admin@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now());

insert into public.stores (id, tenant_id, name, code, status) values
  ('aaaaaaaa-0000-0000-0000-0000000000f1', 'aaaaaaaa-0000-0000-0000-000000000001', 'A1 店', 'A1', 'active'),
  ('aaaaaaaa-0000-0000-0000-0000000000f2', 'aaaaaaaa-0000-0000-0000-000000000001', 'A2 店', 'A2', 'active'),
  ('bbbbbbbb-0000-0000-0000-0000000000f1', 'bbbbbbbb-0000-0000-0000-000000000001', 'B1 店', 'B1', 'active');

insert into public.tenant_memberships (tenant_id, user_id, status) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'active'),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a2', 'active'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-0000000000b1', 'active'),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-0000000000cc', 'active');

insert into public.employees (tenant_id, user_id, employee_no, name, status) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'EMP-A1', 'A1 员工', 'active'),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a2', 'EMP-A2', 'A2 员工', 'active'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-0000000000b1', 'EMP-B1', 'B1 员工', 'active'),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-0000000000cc', 'EMP-ADMIN', '管理员', 'active');

insert into public.employee_store_assignments (tenant_id, employee_id, store_id, is_primary) values
  ('aaaaaaaa-0000-0000-0000-000000000001', (select id from public.employees where employee_no = 'EMP-A1'), 'aaaaaaaa-0000-0000-0000-0000000000f1', true),
  ('aaaaaaaa-0000-0000-0000-000000000001', (select id from public.employees where employee_no = 'EMP-A2'), 'aaaaaaaa-0000-0000-0000-0000000000f2', true),
  ('bbbbbbbb-0000-0000-0000-000000000001', (select id from public.employees where employee_no = 'EMP-B1'), 'bbbbbbbb-0000-0000-0000-0000000000f1', true);

-- 角色:system_admin 是系统模板(tenant_id null);租户 A 建 tenant_manager 店长角色
insert into public.roles (code, name, permissions, is_system, tenant_id, scope)
select 'tenant_manager', '租户店长', array['store:view','employee.create','employee.update'], false, 'aaaaaaaa-0000-0000-0000-000000000001', 'tenant'
where not exists (select 1 from public.roles where code = 'tenant_manager');

insert into public.employee_role_assignments (tenant_id, employee_id, role_id, store_id)
values
  -- tenant_manager 是 scope='tenant' 的租户级角色,必须租户级分配(store_id IS NULL)(S30-R01/R02)
  ('aaaaaaaa-0000-0000-0000-000000000001', (select id from public.employees where employee_no = 'EMP-A1'), (select id from public.roles where code = 'tenant_manager'), null);

-- 平台管理员授权(S30-F01:平台角色独立于租户角色体系,通过 platform_user_roles 授予;
-- 供 T6 验证管理员特殊访问路径,不再通过 ERA/store_members 推导)
insert into public.platform_user_roles (user_id, role)
values ('cccccccc-0000-0000-0000-0000000000cc', 'platform_admin');

-- 审计夹具:预写一条管理员特殊访问记录(模拟 service role / writeAudit 写入)
insert into public.audit_logs (tenant_id, store_id, user_id, action, request_id)
values ('bbbbbbbb-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-0000000000f1', 'cccccccc-0000-0000-0000-0000000000cc', 'test.admin.access', 'req_test_1');

-- ============================================================
-- 各测试块自包含:set local role + set_config(request.jwt.claims)
-- ============================================================

-- ---------- T1 跨租户不可读 ----------
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  perform tests.assert_true(
    (select count(*) from public.stores where id = 'bbbbbbbb-0000-0000-0000-0000000000f1') = 0,
    'T1: A 用户不应读取到 B 租户的门店');
  perform tests.assert_true(
    (select count(*) from public.employees where tenant_id = 'bbbbbbbb-0000-0000-0000-000000000001') = 0,
    'T1: A 用户不应读取到 B 租户的员工');
end;
$$;

-- ---------- T2 跨租户不可写 ----------
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  begin
    insert into public.stores (tenant_id, name, code, status)
    values ('bbbbbbbb-0000-0000-0000-000000000001', '越权店', 'X', 'active');
    raise exception 'RLS_TEST_FAILED: T2 A 用户不应写入 B 租户门店';
  exception when insufficient_privilege then
    null;
  end;
end;
$$;

-- ---------- T3 无权门店不可读 ----------
-- 说明:stores 目录为租户级参考数据(租户成员可见全部本租户门店,用于门店选择器);
-- "无权门店不可读"作用于门店级业务数据,Phase 1 用 employee_store_assignments(门店级敏感表)验证。
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  -- 门店目录:租户内可见(非跨租户)
  perform tests.assert_true(
    (select count(*) from public.stores where tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001') = 2,
    'T3 前置: A1 员工可见本租户两个门店目录');
  -- 门店级敏感数据:无权门店 A2 的分配明细不可读
  perform tests.assert_true(
    (select count(*) from public.employee_store_assignments
      where store_id = 'aaaaaaaa-0000-0000-0000-0000000000f2' and tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001') = 0,
    'T3: A1 员工不应读取到 A2 门店的分配明细(无权门店不可读)');
end;
$$;

-- ---------- T4 无权门店不可写 ----------
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  begin
    insert into public.employee_store_assignments (tenant_id, employee_id, store_id)
    values (
      'aaaaaaaa-0000-0000-0000-000000000001',
      (select id from public.employees where employee_no = 'EMP-A1'),
      'aaaaaaaa-0000-0000-0000-0000000000f2'
    );
    raise exception 'RLS_TEST_FAILED: T4 A1 员工不应向 A2 门店写入分配';
  exception when insufficient_privilege then
    null;
  end;
end;
$$;

-- ---------- T5 合法门店访问成功 ----------
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  perform tests.assert_true(
    (select count(*) from public.stores where id = 'aaaaaaaa-0000-0000-0000-0000000000f1') = 1,
    'T5: A1 员工应能读取本门店');
  perform tests.assert_true(
    (select count(*) from public.employee_store_assignments
      where store_id = 'aaaaaaaa-0000-0000-0000-0000000000f1' and tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001') = 1,
    'T5: A1 员工应能读取本门店分配');
end;
$$;

-- ---------- T6 管理员特殊访问 + 审计 ----------
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"cccccccc-0000-0000-0000-0000000000cc","role":"authenticated"}', true);
  -- 管理员特殊路径:可读任意租户门店
  perform tests.assert_true(
    (select count(*) from public.stores where tenant_id = 'bbbbbbbb-0000-0000-0000-000000000001') = 1,
    'T6: system_admin 应能读取任意租户门店(特殊路径)');
  -- 管理员可读审计
  perform tests.assert_true(
    (select count(*) from public.audit_logs where action = 'test.admin.access') = 1,
    'T6: 管理员可读审计记录');
end;
$$;

-- 普通角色不可读审计
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  perform tests.assert_true(
    (select count(*) from public.audit_logs) = 0,
    'T6: 普通角色不可读审计日志');
end;
$$;

-- 全部断言通过(事务 rollback 撤销夹具与函数,数据库无残留)
select 'RLS_TEST_PASSED' as result;

rollback;
