-- ============================================================
-- RLS 测试:scoped permission(S30-R01 / S30-R02)
--
-- 验证 migration 26 重建后的 has_permission() 严格区分角色 scope:
--   - tenant 上下文(p_store_id IS NULL):仅 tenant/system scope 的租户级分配
--   - store 上下文(p_store_id 给定):目标门店的 store 角色分配 或 tenant/system scope 的租户级分配
--   - 禁止 store 角色 → tenant 权限提升(负向测试)
--   - validate_era_scope 触发器拒绝非法角色分配
--
-- 执行方式(需要可运行的 Supabase 数据库):
--   1) supabase db reset
--   2) psql "$DATABASE_URL" -f supabase/tests/rls_scoped_permission.sql
--
-- 断言矩阵:
--   S1  store 角色在本门店有权限(store 上下文)
--   S2  store 角色在非目标门店无权限
--   S3  store 角色在租户上下文无权限(store→tenant 提升被禁止,负向)
--   S4  tenant 角色在租户上下文有权限
--   S5  tenant 角色在门店上下文同样有效(tenant-wide 兼容)
--   S6  system_admin 任意上下文放行
--   S7  触发器:scope='store' + store_id NULL → STORE_ROLE_REQUIRES_STORE
--   S8  触发器:scope='tenant' + store_id 非空 → TENANT_ROLE_FORBIDS_STORE
--   S9  触发器:租户自定义角色分配给其他租户 → ROLE_TENANT_MISMATCH
--   S10 RLS:store 角色直连写入本门店客户成功(store 上下文授权)
--   S11 RLS:store 角色直连写入非本门店客户被拒绝
-- ============================================================

begin;

-- ---------- 断言辅助(整个脚本在事务中,rollback 撤销所有 DDL/夹具) ----------
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

-- ---------- 夹具:一租户两门店 / 三用户 ----------
-- 用户:u_sm(store_manager@S1)、u_tm(tenant_manager 租户级)、u_admin(system_admin)
insert into public.tenants (id, slug, name) values
  ('55555555-0000-0000-0000-000000000001', 'tenant-scoped', '租户 S')
on conflict (slug) do nothing;

insert into auth.users (id, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, aud, role, created_at, updated_at)
values
  ('55555555-0000-0000-0000-0000000000a1', 'u-sm-scoped@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now()),
  ('55555555-0000-0000-0000-0000000000a2', 'u-tm-scoped@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now()),
  ('55555555-0000-0000-0000-0000000000cc', 'u-admin-scoped@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now())
on conflict (id) do nothing;

insert into public.stores (id, tenant_id, name, code, status) values
  ('55555555-0000-0000-0000-0000000000f1', '55555555-0000-0000-0000-000000000001', 'S1 店', 'S1', 'active'),
  ('55555555-0000-0000-0000-0000000000f2', '55555555-0000-0000-0000-000000000001', 'S2 店', 'S2', 'active')
on conflict do nothing;

insert into public.tenant_memberships (tenant_id, user_id, status) values
  ('55555555-0000-0000-0000-000000000001', '55555555-0000-0000-0000-0000000000a1', 'active'),
  ('55555555-0000-0000-0000-000000000001', '55555555-0000-0000-0000-0000000000a2', 'active'),
  ('55555555-0000-0000-0000-000000000001', '55555555-0000-0000-0000-0000000000cc', 'active')
on conflict do nothing;

insert into public.employees (tenant_id, user_id, employee_no, name, status) values
  ('55555555-0000-0000-0000-000000000001', '55555555-0000-0000-0000-0000000000a1', 'EMP-SM-S', '门店经理', 'active'),
  ('55555555-0000-0000-0000-000000000001', '55555555-0000-0000-0000-0000000000a2', 'EMP-TM-S', '租户经理', 'active'),
  ('55555555-0000-0000-0000-000000000001', '55555555-0000-0000-0000-0000000000cc', 'EMP-ADM-S', '管理员', 'active')
on conflict do nothing;

insert into public.employee_store_assignments (tenant_id, employee_id, store_id, is_primary) values
  ('55555555-0000-0000-0000-000000000001', (select id from public.employees where employee_no = 'EMP-SM-S'), '55555555-0000-0000-0000-0000000000f1', true),
  ('55555555-0000-0000-0000-000000000001', (select id from public.employees where employee_no = 'EMP-TM-S'), '55555555-0000-0000-0000-0000000000f1', true)
on conflict do nothing;

-- 租户级自定义角色(scope='tenant'),用于租户上下文授权
insert into public.roles (code, name, permissions, is_system, tenant_id, scope)
select 'tenant_manager_sp', '租户经理(scoped 测试)', array['membership.manage','customer.view'], false, '55555555-0000-0000-0000-000000000001', 'tenant'
where not exists (select 1 from public.roles where code = 'tenant_manager_sp');

-- 给租户级角色授予 membership.manage 权限(role_permissions 关联表)
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'tenant_manager_sp'
  and p.code in ('membership.manage', 'customer.view')
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

-- 角色分配:
--   u_sm  → store_manager(scope='store')@S1         [门店级]
--   u_tm  → tenant_manager_sp(scope='tenant')@租户级 [租户级]
--   u_adm → system_admin(scope='system')@租户级      [平台级]
insert into public.employee_role_assignments (tenant_id, employee_id, role_id, store_id)
values
  ('55555555-0000-0000-0000-000000000001', (select id from public.employees where employee_no = 'EMP-SM-S'), (select id from public.roles where code = 'store_manager'), '55555555-0000-0000-0000-0000000000f1'),
  ('55555555-0000-0000-0000-000000000001', (select id from public.employees where employee_no = 'EMP-TM-S'), (select id from public.roles where code = 'tenant_manager_sp'), null),
  ('55555555-0000-0000-0000-000000000001', (select id from public.employees where employee_no = 'EMP-ADM-S'), (select id from public.roles where code = 'system_admin'), null)
on conflict do nothing;

-- ============================================================
-- S1 store 角色在本门店有权限(store 上下文)
-- ============================================================
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"55555555-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  perform tests.assert_true(
    public.has_permission('55555555-0000-0000-0000-000000000001', '55555555-0000-0000-0000-0000000000f1', 'customer.update'),
    'S1: store_manager 应在本门店持有 customer.update');
end;
$$;

-- ============================================================
-- S2 store 角色在非目标门店无权限
-- ============================================================
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"55555555-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  perform tests.assert_true(
    not public.has_permission('55555555-0000-0000-0000-000000000001', '55555555-0000-0000-0000-0000000000f2', 'customer.update'),
    'S2: store_manager 不应在 S2 门店持有 customer.update');
end;
$$;

-- ============================================================
-- S3 store 角色在租户上下文无权限(store→tenant 提升,负向)
-- ============================================================
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"55555555-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  perform tests.assert_true(
    not public.has_permission('55555555-0000-0000-0000-000000000001', null, 'customer.update'),
    'S3: store_manager 不应在租户级持有 customer.update(store→tenant 提升禁止)');
  perform tests.assert_true(
    not public.has_permission('55555555-0000-0000-0000-000000000001', null, 'membership.manage'),
    'S3: store_manager 不应在租户级持有 membership.manage(store→tenant 提升禁止)');
end;
$$;

-- ============================================================
-- S4 tenant 角色在租户上下文有权限
-- ============================================================
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"55555555-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
  perform tests.assert_true(
    public.has_permission('55555555-0000-0000-0000-000000000001', null, 'membership.manage'),
    'S4: tenant_manager 应在租户级持有 membership.manage');
end;
$$;

-- ============================================================
-- S5 tenant 角色在门店上下文同样有效(tenant-wide 兼容)
-- ============================================================
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"55555555-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
  perform tests.assert_true(
    public.has_permission('55555555-0000-0000-0000-000000000001', '55555555-0000-0000-0000-0000000000f1', 'customer.view'),
    'S5: tenant_manager 应能在门店上下文持有 customer.view(tenant-wide 角色兼容门店)');
end;
$$;

-- ============================================================
-- S6 system_admin 任意上下文放行
-- ============================================================
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"55555555-0000-0000-0000-0000000000cc","role":"authenticated"}', true);
  perform tests.assert_true(
    public.has_permission('55555555-0000-0000-0000-000000000001', null, 'customer.update'),
    'S6: system_admin 应在租户上下文放行');
  perform tests.assert_true(
    public.has_permission('55555555-0000-0000-0000-000000000001', '55555555-0000-0000-0000-0000000000f2', 'customer.update'),
    'S6: system_admin 应在任意门店上下文放行');
end;
$$;

-- ============================================================
-- S7 触发器:scope='store' + store_id NULL → STORE_ROLE_REQUIRES_STORE
-- ============================================================
do $$
begin
  begin
    insert into public.employee_role_assignments (tenant_id, employee_id, role_id, store_id)
    values (
      '55555555-0000-0000-0000-000000000001',
      (select id from public.employees where employee_no = 'EMP-SM-S'),
      (select id from public.roles where code = 'store_manager'),
      null
    );
    raise exception 'RLS_TEST_FAILED: S7 scope=store 角色禁止租户级分配';
  exception when others then
    if position('STORE_ROLE_REQUIRES_STORE' in sqlerrm) = 0 then
      raise exception 'RLS_TEST_FAILED: S7 应抛 STORE_ROLE_REQUIRES_STORE,实际: %', sqlerrm;
    end if;
  end;
end;
$$;

-- ============================================================
-- S8 触发器:scope='tenant' + store_id 非空 → TENANT_ROLE_FORBIDS_STORE
-- ============================================================
do $$
begin
  begin
    insert into public.employee_role_assignments (tenant_id, employee_id, role_id, store_id)
    values (
      '55555555-0000-0000-0000-000000000001',
      (select id from public.employees where employee_no = 'EMP-TM-S'),
      (select id from public.roles where code = 'tenant_manager_sp'),
      '55555555-0000-0000-0000-0000000000f1'
    );
    raise exception 'RLS_TEST_FAILED: S8 scope=tenant 角色禁止门店级分配';
  exception when others then
    if position('TENANT_ROLE_FORBIDS_STORE' in sqlerrm) = 0 then
      raise exception 'RLS_TEST_FAILED: S8 应抛 TENANT_ROLE_FORBIDS_STORE,实际: %', sqlerrm;
    end if;
  end;
end;
$$;

-- ============================================================
-- S9 触发器:租户自定义角色分配给其他租户 → ROLE_TENANT_MISMATCH
-- ============================================================
do $$
begin
  begin
    insert into public.employee_role_assignments (tenant_id, employee_id, role_id, store_id)
    values (
      '55555555-0000-0000-0000-000000000099',   -- 不存在的其他租户(仅验证 ROLE_TENANT_MISMATCH 优先)
      (select id from public.employees where employee_no = 'EMP-TM-S'),
      (select id from public.roles where code = 'tenant_manager_sp'),
      null
    );
    raise exception 'RLS_TEST_FAILED: S9 跨租户分配应被拒绝';
  exception when others then
    if position('ROLE_TENANT_MISMATCH' in sqlerrm) = 0 then
      raise exception 'RLS_TEST_FAILED: S9 应抛 ROLE_TENANT_MISMATCH,实际: %', sqlerrm;
    end if;
  end;
end;
$$;

-- ============================================================
-- S10 RLS:store 角色直连写入本门店客户成功(store 上下文授权)
-- ============================================================
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"55555555-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  insert into public.customers (tenant_id, store_id, customer_no, name, phone, status)
  values ('55555555-0000-0000-0000-000000000001', '55555555-0000-0000-0000-0000000000f1', 'S1C-SCOPED-001', 'S1 客户', '13700000001', 'active');
  perform tests.assert_true(
    (select count(*) from public.customers where customer_no = 'S1C-SCOPED-001') = 1,
    'S10: store_manager 应能写入本门店客户');
end;
$$;

-- ============================================================
-- S11 RLS:store 角色直连写入非本门店客户被拒绝
-- ============================================================
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"55555555-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  begin
    insert into public.customers (tenant_id, store_id, customer_no, name, phone, status)
    values ('55555555-0000-0000-0000-000000000001', '55555555-0000-0000-0000-0000000000f2', 'S2C-SCOPED-001', 'S2 客户', '13700000002', 'active');
    raise exception 'RLS_TEST_FAILED: S11 store_manager 不应写入 S2 门店客户';
  exception when insufficient_privilege then
    null;
  end;
end;
$$;

-- 全部断言通过(事务 rollback 撤销夹具与函数,数据库无残留)
select 'RLS_SCOPED_PERMISSION_PASSED' as result;

rollback;
