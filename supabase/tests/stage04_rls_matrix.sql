-- ============================================================
-- RLS 测试:Stage-04 角色矩阵隔离(Agent-01 Stage-04 Runtime Gate)
--
-- 覆盖 DEEP 文档 §7 RLS Matrix 要求:
--   角色矩阵:platform_admin / tenant_owner / store_manager / doctor /
--           nurse / cashier / staff(普通员工) / 无权限员工
--   租户门店:Tenant A(Store A1/A2)、Tenant B(Store B1)、
--            Tenant C(suspended)、Tenant D(trial 已过期)、Tenant E(trial 未过期)
--
-- 断言矩阵(任何一条失败即 RAISE EXCEPTION,整体 rollback 不污染数据库):
--   M1  跨租户不可读/不可用(A 员工对 Tenant B 任何上下文无权限)
--   M2  A1 store 角色读 A2(未授权门店)无权限
--   M3  store 角色调 tenant-wide 上下文(store→tenant 提升)被拒绝;tenant_owner 放行
--   M4  无权限员工(无角色)在门店上下文无任何权限
--   M5  合法角色合法上下文正向:store_manager/doctor/nurse/cashier/staff 各自权限有效
--   M6  suspended tenant:即便有合法角色分配,业务可用性为 false,权限全部拦截
--   M7  trial 已过期:同上拦截
--   M8  trial 未过期:正常业务可用
--   M9  platform_admin 短路:跨租户 / suspended 租户均可管理
--   M10 RLS 直连负向:跨租户 insert 被 RLS 拒绝(0 行)
--   M11 RLS 直连:本店读可见、跨店读不可见、跨租户读不可见
--
-- 执行方式(需要可运行的 Supabase 数据库,已应用全部 migrations + seed):
--   1) supabase db reset
--   2) psql "$DATABASE_URL" -f supabase/tests/stage04_rls_matrix.sql
-- ============================================================

begin;

-- ---------- 断言辅助(整个脚本在事务中,rollback 撤销所有 DDL/夹具) ----------
create schema if not exists tests;
grant usage on schema tests to authenticated, anon, service_role;
create or replace function tests.assert_true(cond boolean, msg text)
returns void
language plpgsql as $$
begin
  if not cond then
    raise exception 'RLS_MATRIX_FAILED: %', msg;
  end if;
end;
$$;

-- ============================================================
-- 夹具:五租户 / 六门店 / 十二用户
-- ============================================================
-- 租户:A(active) B(active) C(suspended) D(trial 过期) E(trial 未过期)
insert into public.tenants (id, slug, name, status, trial_ends_at) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'mxq-matrix-a', '矩阵租户 A', 'active', null),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'mxq-matrix-b', '矩阵租户 B', 'active', null),
  ('cccccccc-0000-0000-0000-000000000001', 'mxq-matrix-c', '矩阵租户 C(停用)', 'suspended', null),
  ('dddddddd-0000-0000-0000-000000000001', 'mxq-matrix-d', '矩阵租户 D(试用过期)', 'trial', now() - interval '1 day'),
  ('eeeeeeee-0000-0000-0000-000000000001', 'mxq-matrix-e', '矩阵租户 E(试用中)', 'trial', now() + interval '10 day');

-- 门店:A1/A2 属 A,B1 属 B,C1 属 C,D1 属 D,E1 属 E
insert into public.stores (id, tenant_id, name, code, status) values
  ('aaaaaaaa-0000-0000-0000-0000000000a1', 'aaaaaaaa-0000-0000-0000-000000000001', 'A1 店', 'MATRIX-A1', 'active'),
  ('aaaaaaaa-0000-0000-0000-0000000000a2', 'aaaaaaaa-0000-0000-0000-000000000001', 'A2 店', 'MATRIX-A2', 'active'),
  ('bbbbbbbb-0000-0000-0000-0000000000b1', 'bbbbbbbb-0000-0000-0000-000000000001', 'B1 店', 'MATRIX-B1', 'active'),
  ('cccccccc-0000-0000-0000-0000000000c1', 'cccccccc-0000-0000-0000-000000000001', 'C1 店', 'MATRIX-C1', 'active'),
  ('dddddddd-0000-0000-0000-0000000000d1', 'dddddddd-0000-0000-0000-000000000001', 'D1 店', 'MATRIX-D1', 'active'),
  ('eeeeeeee-0000-0000-0000-0000000000e1', 'eeeeeeee-0000-0000-0000-000000000001', 'E1 店', 'MATRIX-E1', 'active');

-- 用户:13 个(auth.users 必须真实存在,helper 依赖 auth.uid())
insert into auth.users (id, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, aud, role, created_at, updated_at)
values
  ('aaaaaaaa-0000-0000-0000-0000000000p0', 'mxq-p0@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now()),
  ('aaaaaaaa-0000-0000-0000-0000000000o1', 'mxq-owner@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now()),
  ('aaaaaaaa-0000-0000-0000-0000000000s1', 'mxq-sm@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now()),
  ('aaaaaaaa-0000-0000-0000-0000000000d1', 'mxq-doc@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now()),
  ('aaaaaaaa-0000-0000-0000-0000000000n1', 'mxq-nurse@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now()),
  ('aaaaaaaa-0000-0000-0000-0000000000c1', 'mxq-cashier@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now()),
  ('aaaaaaaa-0000-0000-0000-0000000000f1', 'mxq-staff@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now()),
  ('aaaaaaaa-0000-0000-0000-0000000000i1', 'mxq-inv@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now()),
  ('aaaaaaaa-0000-0000-0000-0000000000n9', 'mxq-noperm@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now()),
  ('bbbbbbbb-0000-0000-0000-0000000000s1', 'mxq-bsm@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now()),
  ('cccccccc-0000-0000-0000-0000000000s1', 'mxq-csm@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now()),
  ('dddddddd-0000-0000-0000-0000000000s1', 'mxq-dsm@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now()),
  ('eeeeeeee-0000-0000-0000-0000000000s1', 'mxq-esm@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now());

-- 平台管理员(独立模型,不走租户角色体系)
insert into public.platform_user_roles (user_id, role)
values ('aaaaaaaa-0000-0000-0000-0000000000p0', 'platform_admin');

-- 租户成员关系
insert into public.tenant_memberships (tenant_id, user_id, status) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000o1', 'active'),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000s1', 'active'),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000d1', 'active'),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000n1', 'active'),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000c1', 'active'),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000f1', 'active'),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000n9', 'active'),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000p0', 'active'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-0000000000s1', 'active'),
  ('cccccccc-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-0000000000s1', 'active'),
  ('dddddddd-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-0000000000s1', 'active'),
  ('eeeeeeee-0000-0000-0000-000000000001', 'eeeeeeee-0000-0000-0000-0000000000s1', 'active');

-- 员工档案
insert into public.employees (tenant_id, user_id, employee_no, name, status) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000o1', 'MX-OWNER', '租户所有者', 'active'),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000s1', 'MX-SM', '店长A1', 'active'),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000d1', 'MX-DOC', '医生A1', 'active'),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000n1', 'MX-NURSE', '护士A1', 'active'),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000c1', 'MX-CASH', '收银A2', 'active'),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000f1', 'MX-STAFF', '店员A1', 'active'),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000n9', 'MX-NOPERM', '无权限员工', 'active'),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000p0', 'MX-PLAT', '平台管理员', 'active'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-0000000000s1', 'MX-BSM', 'B1店长', 'active'),
  ('cccccccc-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-0000000000s1', 'MX-CSM', 'C1店长', 'active'),
  ('dddddddd-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-0000000000s1', 'MX-DSM', 'D1店长', 'active'),
  ('eeeeeeee-0000-0000-0000-000000000001', 'eeeeeeee-0000-0000-0000-0000000000s1', 'MX-ESM', 'E1店长', 'active');

-- 门店分配(主门店)
insert into public.employee_store_assignments (tenant_id, employee_id, store_id, is_primary) values
  ('aaaaaaaa-0000-0000-0000-000000000001', (select id from public.employees where employee_no = 'MX-OWNER'), 'aaaaaaaa-0000-0000-0000-0000000000a1', true),
  ('aaaaaaaa-0000-0000-0000-000000000001', (select id from public.employees where employee_no = 'MX-SM'), 'aaaaaaaa-0000-0000-0000-0000000000a1', true),
  ('aaaaaaaa-0000-0000-0000-000000000001', (select id from public.employees where employee_no = 'MX-DOC'), 'aaaaaaaa-0000-0000-0000-0000000000a1', true),
  ('aaaaaaaa-0000-0000-0000-000000000001', (select id from public.employees where employee_no = 'MX-NURSE'), 'aaaaaaaa-0000-0000-0000-0000000000a1', true),
  ('aaaaaaaa-0000-0000-0000-000000000001', (select id from public.employees where employee_no = 'MX-CASH'), 'aaaaaaaa-0000-0000-0000-0000000000a2', true),
  ('aaaaaaaa-0000-0000-0000-000000000001', (select id from public.employees where employee_no = 'MX-STAFF'), 'aaaaaaaa-0000-0000-0000-0000000000a1', true),
  ('aaaaaaaa-0000-0000-0000-000000000001', (select id from public.employees where employee_no = 'MX-INV'), 'aaaaaaaa-0000-0000-0000-0000000000a1', true),
  ('aaaaaaaa-0000-0000-0000-000000000001', (select id from public.employees where employee_no = 'MX-NOPERM'), 'aaaaaaaa-0000-0000-0000-0000000000a1', true),
  ('aaaaaaaa-0000-0000-0000-000000000001', (select id from public.employees where employee_no = 'MX-PLAT'), 'aaaaaaaa-0000-0000-0000-0000000000a1', true),
  ('bbbbbbbb-0000-0000-0000-000000000001', (select id from public.employees where employee_no = 'MX-BSM'), 'bbbbbbbb-0000-0000-0000-0000000000b1', true),
  ('cccccccc-0000-0000-0000-000000000001', (select id from public.employees where employee_no = 'MX-CSM'), 'cccccccc-0000-0000-0000-0000000000c1', true),
  ('dddddddd-0000-0000-0000-000000000001', (select id from public.employees where employee_no = 'MX-DSM'), 'dddddddd-0000-0000-0000-0000000000d1', true),
  ('eeeeeeee-0000-0000-0000-000000000001', (select id from public.employees where employee_no = 'MX-ESM'), 'eeeeeeee-0000-0000-0000-0000000000e1', true);

-- 角色分配(employee_role_assignments 无四列唯一约束,用 WHERE NOT EXISTS 防重复)
insert into public.employee_role_assignments (tenant_id, employee_id, role_id, store_id)
select e.tenant_id, e.id, r.id, null
from public.employees e
join public.roles r on r.code = 'tenant_owner' and r.is_system = true
where e.employee_no = 'MX-OWNER'
  and not exists (select 1 from public.employee_role_assignments x where x.tenant_id = e.tenant_id and x.employee_id = e.id and x.role_id = r.id and x.store_id is null);

-- 门店级角色按员工主门店绑定(A1/B1/C1/D1/E1 的 store_manager)
insert into public.employee_role_assignments (tenant_id, employee_id, role_id, store_id)
select e.tenant_id, e.id, r.id,
       case e.employee_no
         when 'MX-SM' then 'aaaaaaaa-0000-0000-0000-0000000000a1'
         when 'MX-BSM' then 'bbbbbbbb-0000-0000-0000-0000000000b1'
         when 'MX-CSM' then 'cccccccc-0000-0000-0000-0000000000c1'
         when 'MX-DSM' then 'dddddddd-0000-0000-0000-0000000000d1'
         when 'MX-ESM' then 'eeeeeeee-0000-0000-0000-0000000000e1'
       end
from public.employees e
join public.roles r on r.code = 'store_manager' and r.is_system = true
where e.employee_no in ('MX-SM', 'MX-BSM', 'MX-CSM', 'MX-DSM', 'MX-ESM')
  and not exists (select 1 from public.employee_role_assignments x where x.tenant_id = e.tenant_id and x.employee_id = e.id and x.role_id = r.id);

insert into public.employee_role_assignments (tenant_id, employee_id, role_id, store_id)
select e.tenant_id, e.id, r.id, 'aaaaaaaa-0000-0000-0000-0000000000a1'
from public.employees e
join public.roles r on r.code = 'doctor' and r.is_system = true
where e.employee_no = 'MX-DOC'
  and not exists (select 1 from public.employee_role_assignments x where x.tenant_id = e.tenant_id and x.employee_id = e.id and x.role_id = r.id);

insert into public.employee_role_assignments (tenant_id, employee_id, role_id, store_id)
select e.tenant_id, e.id, r.id, 'aaaaaaaa-0000-0000-0000-0000000000a1'
from public.employees e
join public.roles r on r.code = 'nurse' and r.is_system = true
where e.employee_no = 'MX-NURSE'
  and not exists (select 1 from public.employee_role_assignments x where x.tenant_id = e.tenant_id and x.employee_id = e.id and x.role_id = r.id);

insert into public.employee_role_assignments (tenant_id, employee_id, role_id, store_id)
select e.tenant_id, e.id, r.id, 'aaaaaaaa-0000-0000-0000-0000000000a2'
from public.employees e
join public.roles r on r.code = 'cashier' and r.is_system = true
where e.employee_no = 'MX-CASH'
  and not exists (select 1 from public.employee_role_assignments x where x.tenant_id = e.tenant_id and x.employee_id = e.id and x.role_id = r.id);

insert into public.employee_role_assignments (tenant_id, employee_id, role_id, store_id)
select e.tenant_id, e.id, r.id, 'aaaaaaaa-0000-0000-0000-0000000000a1'
from public.employees e
join public.roles r on r.code = 'staff' and r.is_system = true
where e.employee_no = 'MX-STAFF'
  and not exists (select 1 from public.employee_role_assignments x where x.tenant_id = e.tenant_id and x.employee_id = e.id and x.role_id = r.id);

-- 业务数据:客户(供 RLS 直连读写断言)
-- A1 客户 / A2 客户 / B1 客户 / C1 客户(停用租户)
insert into public.customers (tenant_id, store_id, customer_no, name) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'MATRIX-A1-C-1', 'A1 客户'),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a2', 'MATRIX-A2-C-1', 'A2 客户'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-0000000000b1', 'MATRIX-B1-C-1', 'B1 客户'),
  ('cccccccc-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-0000000000c1', 'MATRIX-C1-C-1', 'C1 客户');

-- ============================================================
-- 各测试块自包含:set local role + set_config(request.jwt.claims)
-- ============================================================

-- ---------- M1 跨租户不可读/不可用(A 员工对 Tenant B 无权限) ----------
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-0000000000s1","role":"authenticated"}', true);
  perform tests.assert_true(
    not public.has_permission('bbbbbbbb-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-0000000000b1', 'customer.view'),
    'M1: A1 store_manager 不应在 B1 门店上下文拥有 customer.view');
  perform tests.assert_true(
    not public.has_permission('bbbbbbbb-0000-0000-0000-000000000001', null, 'customer.view'),
    'M1: A1 store_manager 不应在 B 租户上下文拥有 customer.view');
  perform tests.assert_true(
    not public.can_access_store('bbbbbbbb-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-0000000000b1'),
    'M1: A1 store_manager 不应可访问 B1 门店');
end $$;

-- ---------- M2 A1 store 角色读 A2(未授权门店)无权限 ----------
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-0000000000s1","role":"authenticated"}', true);
  perform tests.assert_true(
    not public.has_permission('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a2', 'customer.view'),
    'M2: A1 store_manager 不应在 A2 门店上下文拥有权限(store 角色仅限授权门店)');
  perform tests.assert_true(
    not public.can_access_store('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a2'),
    'M2: A1 store_manager 不应可访问 A2 门店');
end $$;

-- ---------- M3 store 角色调 tenant-wide 上下文被拒绝;tenant_owner 放行 ----------
do $$
begin
  set local role authenticated;
  -- A1 store_manager:store 角色不得在租户级上下文拿到权限(禁止 store→tenant 提升)
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-0000000000s1","role":"authenticated"}', true);
  perform tests.assert_true(
    not public.has_permission('aaaaaaaa-0000-0000-0000-000000000001', null, 'customer.view'),
    'M3: A1 store_manager 在 tenant 上下文(store_id=null)不应拥有 customer.view(禁止提升)');
  -- tenant_owner:租户级角色在 tenant 上下文放行(tenant_owner 持 license.read 等租户管理权限)
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-0000000000o1","role":"authenticated"}', true);
  perform tests.assert_true(
    public.has_permission('aaaaaaaa-0000-0000-0000-000000000001', null, 'license.read'),
    'M3: tenant_owner 在 tenant 上下文应拥有 license.read');
end $$;

-- ---------- M4 无权限员工在门店上下文无任何权限 ----------
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-0000000000n9","role":"authenticated"}', true);
  perform tests.assert_true(
    not public.has_permission('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'customer.view'),
    'M4: 无角色员工不应拥有 customer.view');
  perform tests.assert_true(
    not public.has_permission('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'inventory.view'),
    'M4: 无角色员工不应拥有 inventory.view');
end $$;

-- ---------- M5 合法角色合法上下文正向 ----------
do $$
begin
  set local role authenticated;
  -- store_manager @ A1
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-0000000000s1","role":"authenticated"}', true);
  perform tests.assert_true(
    public.has_permission('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'customer.view'),
    'M5: store_manager 在本店 A1 应拥有 customer.view');
  perform tests.assert_true(
    public.has_permission('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'employee.create'),
    'M5: store_manager 在本店 A1 应拥有 employee.create');
  -- doctor @ A1
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-0000000000d1","role":"authenticated"}', true);
  perform tests.assert_true(
    public.has_permission('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'prescription.create'),
    'M5: doctor 在本店 A1 应拥有 prescription.create');
  perform tests.assert_true(
    not public.has_permission('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'payment.process'),
    'M5: doctor 不应拥有 payment.process');
  -- nurse @ A1
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-0000000000n1","role":"authenticated"}', true);
  perform tests.assert_true(
    public.has_permission('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'nurse_task.manage'),
    'M5: nurse 在本店 A1 应拥有 nurse_task.manage');
  -- cashier @ A2
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-0000000000c1","role":"authenticated"}', true);
  perform tests.assert_true(
    public.has_permission('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a2', 'payment.process'),
    'M5: cashier 在本店 A2 应拥有 payment.process');
  perform tests.assert_true(
    not public.has_permission('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'payment.process'),
    'M5: cashier 在未授权门店 A1 不应拥有 payment.process');
  -- staff @ A1(系统 staff 角色仅持 store:view,不放大为库存/客户权限)
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-0000000000f1","role":"authenticated"}', true);
  perform tests.assert_true(
    public.has_permission('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'store:view'),
    'M5: staff 在本店 A1 应拥有 store:view');
  perform tests.assert_true(
    not public.has_permission('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'inventory.view'),
    'M5: staff 不应拥有 inventory.view(权限不放大)');
  -- inventory_role @ A1(自定义门店级库存角色,DEEP §7 inventory role)
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-0000000000i1","role":"authenticated"}', true);
  perform tests.assert_true(
    public.has_permission('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'inventory.view')
    and public.has_permission('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'inventory.count'),
    'M5: inventory_role 在本店 A1 应拥有库存域权限');
  perform tests.assert_true(
    not public.has_permission('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a2', 'inventory.view'),
    'M5: inventory_role 在未授权门店 A2 不应拥有库存权限');
  -- tenant_owner:tenant-wide 角色可访问本租户全部门店
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-0000000000o1","role":"authenticated"}', true);
  perform tests.assert_true(
    public.can_access_store('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a1')
    and public.can_access_store('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a2'),
    'M5: tenant_owner(tenant-wide)应可访问本租户全部门店 A1/A2');
end $$;

-- ---------- M6 suspended tenant:业务可用性为 false,权限全部拦截 ----------
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"cccccccc-0000-0000-0000-0000000000s1","role":"authenticated"}', true);
  perform tests.assert_true(
    not public.is_tenant_business_active('cccccccc-0000-0000-0000-000000000001'),
    'M6: suspended 租户业务可用性应为 false');
  perform tests.assert_true(
    not public.has_permission('cccccccc-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-0000000000c1', 'customer.view'),
    'M6: suspended 租户即便有合法 store_manager 角色也不应拥有权限');
  perform tests.assert_true(
    not public.can_access_store('cccccccc-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-0000000000c1'),
    'M6: suspended 租户员工不应可访问本门店');
  perform tests.assert_true(
    not public.is_tenant_member('cccccccc-0000-0000-0000-000000000001'),
    'M6: suspended 租户成员关系应视为不可用');
end $$;

-- ---------- M7 trial 已过期:同上拦截 ----------
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"dddddddd-0000-0000-0000-0000000000s1","role":"authenticated"}', true);
  perform tests.assert_true(
    not public.is_tenant_business_active('dddddddd-0000-0000-0000-000000000001'),
    'M7: trial 已过期租户业务可用性应为 false');
  perform tests.assert_true(
    not public.has_permission('dddddddd-0000-0000-0000-000000000001', 'dddddddd-0000-0000-0000-0000000000d1', 'customer.view'),
    'M7: trial 已过期租户员工不应拥有权限');
end $$;

-- ---------- M8 trial 未过期:正常业务可用 ----------
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"eeeeeeee-0000-0000-0000-0000000000s1","role":"authenticated"}', true);
  perform tests.assert_true(
    public.is_tenant_business_active('eeeeeeee-0000-0000-0000-000000000001'),
    'M8: trial 未过期租户业务可用性应为 true');
  perform tests.assert_true(
    public.has_permission('eeeeeeee-0000-0000-0000-000000000001', 'eeeeeeee-0000-0000-0000-0000000000e1', 'customer.view'),
    'M8: trial 未过期租户 store_manager 应正常拥有 customer.view');
end $$;

-- ---------- M9 platform_admin 短路:跨租户 / suspended 租户均可管理 ----------
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-0000000000p0","role":"authenticated"}', true);
  perform tests.assert_true(
    public.is_system_admin(),
    'M9: platform_admin 应 is_system_admin() = true');
  perform tests.assert_true(
    public.has_permission('bbbbbbbb-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-0000000000b1', 'customer.view'),
    'M9: platform_admin 应可跨租户访问(短路)');
  perform tests.assert_true(
    public.has_permission('cccccccc-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-0000000000c1', 'customer.view'),
    'M9: platform_admin 对 suspended 租户也应可管理(用于恢复等管理动作)');
  perform tests.assert_true(
    public.can_access_store('bbbbbbbb-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-0000000000b1'),
    'M9: platform_admin 应可访问任意门店');
end $$;

-- ---------- M10 RLS 直连负向:跨租户 insert 被拒绝(0 行) ----------
do $$
declare
  v_rows int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-0000000000s1","role":"authenticated"}', true);
  -- A1 store_manager 尝试向 B 租户插入客户:is_tenant_member(B)=false → RLS 拒绝,0 行
  insert into public.customers (tenant_id, store_id, customer_no, name)
  values ('bbbbbbbb-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-0000000000b1', 'MATRIX-X-1', '越权客户');
  get diagnostics v_rows = row_count;
  perform tests.assert_true(v_rows = 0, 'M10: 跨租户 insert 应被 RLS 拒绝(0 行)');
end $$;

-- ---------- M11 RLS 直连:本店读可见、跨店不可见、跨租户不可见 ----------
do $$
begin
  set local role authenticated;
  -- A1 store_manager:只看到 A1 客户
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-0000000000s1","role":"authenticated"}', true);
  perform tests.assert_true(
    (select count(*) from public.customers where customer_no = 'MATRIX-A1-C-1') = 1,
    'M11: A1 store_manager 应能读取本店客户');
  perform tests.assert_true(
    (select count(*) from public.customers where customer_no = 'MATRIX-A2-C-1') = 0,
    'M11: A1 store_manager 不应读到 A2 客户');
  perform tests.assert_true(
    (select count(*) from public.customers where customer_no = 'MATRIX-B1-C-1') = 0,
    'M11: A1 store_manager 不应读到 B 租户客户');
  -- A2 cashier:只看到 A2 客户
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-0000000000c1","role":"authenticated"}', true);
  perform tests.assert_true(
    (select count(*) from public.customers where customer_no = 'MATRIX-A2-C-1') = 1,
    'M11: A2 cashier 应能读取本店客户');
  perform tests.assert_true(
    (select count(*) from public.customers where customer_no = 'MATRIX-A1-C-1') = 0,
    'M11: A2 cashier 不应读到 A1 客户');
  -- suspended 租户 C1 店长:连本租户数据也读不到(业务不可用)
  perform set_config('request.jwt.claims', '{"sub":"cccccccc-0000-0000-0000-0000000000s1","role":"authenticated"}', true);
  perform tests.assert_true(
    (select count(*) from public.customers where customer_no = 'MATRIX-C1-C-1') = 0,
    'M11: suspended 租户员工不应读到任何客户数据');
  -- platform_admin:全量可见(短路)
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-0000000000p0","role":"authenticated"}', true);
  perform tests.assert_true(
    (select count(*) from public.customers where customer_no = 'MATRIX-B1-C-1') = 1,
    'M11: platform_admin 应可读取任意租户客户(短路)');
end $$;

-- 全部通过:整体 rollback(测试不残留任何夹具)
rollback;
