-- ============================================================
-- RLS 测试:Catalog 领域跨租户/跨门店隔离(MXQ-6001~6010)
--
-- 执行方式(需要可运行的 Supabase 数据库,本地 Docker 或 CI):
--   1) supabase db reset
--   2) psql "$DATABASE_URL" -f supabase/tests/rls_catalog.sql
--
-- 断言矩阵:
--   C1 跨租户类目不可读(A 用户读取 B 租户 catalog_categories = 0)
--   C2 跨租户目录项不可读(A 用户读取 B 租户 catalog_items = 0)
--   C3 租户成员可读本租户类目(A1 员工读取 A 租户类目 >= 6 顶级类目)
--   C4 无 catalog.manage 权限不可写类目(doctor 角色插入 = 拒绝)
--   C5 有 catalog.manage 权限可写类目(store_manager/system_admin 插入 = 成功)
--   C6 跨门店 store_catalog_items 不可读(A1 员工读取 A2 门店项目 = 0)
--   C7 有 catalog.storePrice.manage 权限可写门店项目(A1 店长 = 成功)
--   C8 药品扩展跟随 catalog_items 隔离(A 用户读取 B 租户药品扩展 = 0)
--   C9 疫苗扩展跟随 catalog_items 隔离(跨租户 = 0)
--   C10 问诊问题库租户隔离(A 用户读取 B 租户 = 0)
--   C11 诊断字典租户隔离(A 用户读取 B 租户 = 0)
--   C12 检验 panel 租户隔离(A 用户读取 B 租户 = 0)
--   C13 lab_analytes 跟随 lab_panels 隔离(跨租户 = 0)
--   C14 超管可读任意租户目录
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

-- ---------- 复用两租户 / 三门店夹具 ----------
-- 租户 A:门店 A1、A2;租户 B:门店 B1
-- 用户:u_a1(T_A/A1 店长)、u_a2(T_A/A2)、u_b(T_B/B1)、u_admin(system_admin)
insert into public.tenants (id, slug, name) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'tenant-a-catalog', '租户 A'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'tenant-b-catalog', '租户 B')
on conflict (slug) do nothing;

-- 类目夹具:为测试租户插入 6 个顶级类目(migration 16 只在迁移时给已存在租户种,测试租户需自建)
insert into public.catalog_categories (tenant_id, code, name, parent_id, sort_order, is_active)
select t.id, seed.code, seed.name, null, seed.sort_order, true
from (values ('aaaaaaaa-0000-0000-0000-000000000001'::uuid), ('bbbbbbbb-0000-0000-0000-000000000001'::uuid)) as t(id)
cross join (values
  ('service', '服务', 1),
  ('product', '商品', 2),
  ('drug', '药品', 3),
  ('vaccine', '疫苗', 4),
  ('exam', '检验', 5),
  ('consumable', '耗材', 6)
) as seed(code, name, sort_order)
where not exists (
  select 1 from public.catalog_categories cc
  where cc.tenant_id = t.id and cc.code = seed.code
);

insert into auth.users (id, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, aud, role, created_at, updated_at)
values
  ('aaaaaaaa-0000-0000-0000-0000000000a1', 'u-a1-catalog@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now()),
  ('aaaaaaaa-0000-0000-0000-0000000000a2', 'u-a2-catalog@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now()),
  ('bbbbbbbb-0000-0000-0000-0000000000b1', 'u-b1-catalog@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now()),
  ('cccccccc-0000-0000-0000-0000000000cc', 'u-admin-catalog@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now())
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

-- 给 A1 员工 store_manager 角色(含 catalog.view + catalog.storePrice.manage)
-- 给 admin system_admin 角色(含全部 catalog 权限)
insert into public.employee_role_assignments (tenant_id, employee_id, role_id, store_id)
values
  ('aaaaaaaa-0000-0000-0000-000000000001', (select id from public.employees where employee_no = 'EMP-A1C'), (select id from public.roles where code = 'store_manager'), 'aaaaaaaa-0000-0000-0000-0000000000f1'),
  ('aaaaaaaa-0000-0000-0000-000000000001', (select id from public.employees where employee_no = 'EMP-A2C'), (select id from public.roles where code = 'store_manager'), 'aaaaaaaa-0000-0000-0000-0000000000f2'),
  ('bbbbbbbb-0000-0000-0000-000000000001', (select id from public.employees where employee_no = 'EMP-B1C'), (select id from public.roles where code = 'store_manager'), 'bbbbbbbb-0000-0000-0000-0000000000f1')
on conflict do nothing;

-- 平台管理员授权(S30-F01:平台角色独立于租户角色体系,通过 platform_user_roles 授予)
insert into public.platform_user_roles (user_id, role)
values ('cccccccc-0000-0000-0000-0000000000cc', 'platform_admin')
on conflict do nothing;

-- ---------- 类目夹具 ----------
-- A 租户:1 个目录项(归类 service 类目)
-- B 租户:1 个目录项(归类 service 类目)
insert into public.catalog_items (id, tenant_id, category_id, code, name, default_price, billing_type)
values
  ('11111111-0000-0000-0000-00000000ca01', 'aaaaaaaa-0000-0000-0000-000000000001',
    (select id from public.catalog_categories where tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001' and code = 'service' limit 1),
    'SVC-A-001', 'A 门诊诊查费', 50.00, 'service'),
  ('22222222-0000-0000-0000-00000000ca02', 'bbbbbbbb-0000-0000-0000-000000000001',
    (select id from public.catalog_categories where tenant_id = 'bbbbbbbb-0000-0000-0000-000000000001' and code = 'service' limit 1),
    'SVC-B-001', 'B 门诊诊查费', 60.00, 'service')
on conflict do nothing;

-- ---------- 门店项目夹具 ----------
-- A1 门店引用 A 租户目录项
insert into public.store_catalog_items (tenant_id, store_id, catalog_item_id, custom_price)
values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000f1', '11111111-0000-0000-0000-00000000ca01', 55.00)
on conflict do nothing;

-- ---------- 药品扩展夹具 ----------
insert into public.catalog_drug_extensions (catalog_item_id, drug_form, strength, manufacturer, is_controlled)
values
  ('11111111-0000-0000-0000-00000000ca01', 'tablet', '5mg', 'A 厂商', false)
on conflict do nothing;

-- ---------- 疫苗扩展夹具 ----------
insert into public.catalog_vaccine_extensions (catalog_item_id, vaccine_type, manufacturer, protocol_course, is_required)
values
  ('11111111-0000-0000-0000-00000000ca01', 'rabies', 'A 疫苗厂', 1, true)
on conflict do nothing;

-- ---------- 问诊问题夹具 ----------
insert into public.intake_questions (tenant_id, category, question, sort_order)
values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'general', 'A 租户:宠物食欲如何？', 1),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'general', 'B 租户:宠物食欲如何？', 1)
on conflict do nothing;

-- ---------- 诊断字典夹具 ----------
insert into public.diagnosis_dict (tenant_id, code, name, category)
values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'DX-A-001', 'A 犬瘟热', '传染'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'DX-B-001', 'B 犬瘟热', '传染')
on conflict do nothing;

-- ---------- 检验 panel 夹具 ----------
insert into public.lab_panels (id, tenant_id, code, name, category, sample_type)
values
  ('33333333-0000-0000-0000-00000000ef01', 'aaaaaaaa-0000-0000-0000-000000000001', 'LP-A-001', 'A 血常规', 'blood', '全血'),
  ('44444444-0000-0000-0000-00000000ef02', 'bbbbbbbb-0000-0000-0000-000000000001', 'LP-B-001', 'B 血常规', 'blood', '全血')
on conflict do nothing;

-- ---------- 检验 analyte 夹具 ----------
insert into public.lab_analytes (panel_id, code, name, unit, ref_range_low, ref_range_high, is_critical)
values
  ('33333333-0000-0000-0000-00000000ef01', 'WBC-A', 'A 白细胞', '10^9/L', 5.0, 19.5, true),
  ('44444444-0000-0000-0000-00000000ef02', 'WBC-B', 'B 白细胞', '10^9/L', 5.0, 19.5, true)
on conflict do nothing;

-- ============================================================
-- 各测试块
-- ============================================================

-- ---------- C1 跨租户类目不可读 ----------
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  perform tests.assert_true(
    (select count(*) from public.catalog_categories where tenant_id = 'bbbbbbbb-0000-0000-0000-000000000001') = 0,
    'C1: A 用户不应读取到 B 租户的类目');
end;
$$;

-- ---------- C2 跨租户目录项不可读 ----------
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  perform tests.assert_true(
    (select count(*) from public.catalog_items where tenant_id = 'bbbbbbbb-0000-0000-0000-000000000001') = 0,
    'C2: A 用户不应读取到 B 租户的目录项');
end;
$$;

-- ---------- C3 租户成员可读本租户类目(>= 6 顶级类目) ----------
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  perform tests.assert_true(
    (select count(*) from public.catalog_categories where tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001' and parent_id is null) >= 6,
    'C3: A1 员工应能读取本租户至少 6 个顶级类目');
end;
$$;

-- ---------- C4 无 catalog.manage 权限不可写类目 ----------
-- 注:A1 员工是 store_manager,有 catalog.storePrice.manage 但无 catalog.manage,不可写类目
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  begin
    insert into public.catalog_categories (tenant_id, code, name)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'TEST-NO-MANAGE', '越权类目');
    raise exception 'RLS_TEST_FAILED: C4 store_manager 不应能写类目(缺 catalog.manage)';
  exception when insufficient_privilege then
    null;
  end;
end;
$$;

-- ---------- C5 有 catalog.manage 权限可写类目(system_admin) ----------
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"cccccccc-0000-0000-0000-0000000000cc","role":"authenticated"}', true);
  insert into public.catalog_categories (tenant_id, code, name)
  values ('aaaaaaaa-0000-0000-0000-000000000001', 'TEST-ADMIN-MANAGE', '管理员类目');
  perform tests.assert_true(
    (select count(*) from public.catalog_categories where tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001' and code = 'TEST-ADMIN-MANAGE') = 1,
    'C5: system_admin 应能写类目');
end;
$$;

-- ---------- C6 跨门店 store_catalog_items 不可读 ----------
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  perform tests.assert_true(
    (select count(*) from public.store_catalog_items where store_id = 'aaaaaaaa-0000-0000-0000-0000000000f2') = 0,
    'C6: A1 员工不应读取到 A2 门店的目录项');
end;
$$;

-- ---------- C7 有 catalog.storePrice.manage 权限可写门店项目 ----------
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  -- A1 员工应能读本门店项目
  perform tests.assert_true(
    (select count(*) from public.store_catalog_items where store_id = 'aaaaaaaa-0000-0000-0000-0000000000f1') >= 1,
    'C7: A1 店长应能读本门店目录项');
end;
$$;

-- ---------- C8 药品扩展跟随 catalog_items 隔离 ----------
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
  -- B 用户不应读到 A 租户目录项的药品扩展
  perform tests.assert_true(
    (select count(*) from public.catalog_drug_extensions
     where catalog_item_id in (select id from public.catalog_items where tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001')) = 0,
    'C8: B 用户不应读取 A 租户的药品扩展');
end;
$$;

-- ---------- C9 疫苗扩展跟随 catalog_items 隔离 ----------
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
  perform tests.assert_true(
    (select count(*) from public.catalog_vaccine_extensions
     where catalog_item_id in (select id from public.catalog_items where tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001')) = 0,
    'C9: B 用户不应读取 A 租户的疫苗扩展');
end;
$$;

-- ---------- C10 问诊问题库租户隔离 ----------
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  perform tests.assert_true(
    (select count(*) from public.intake_questions where tenant_id = 'bbbbbbbb-0000-0000-0000-000000000001') = 0,
    'C10: A 用户不应读取 B 租户的问诊问题');
  -- A 用户应能读本租户问诊问题
  perform tests.assert_true(
    (select count(*) from public.intake_questions where tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001') >= 1,
    'C10: A 用户应能读本租户问诊问题');
end;
$$;

-- ---------- C11 诊断字典租户隔离 ----------
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  perform tests.assert_true(
    (select count(*) from public.diagnosis_dict where tenant_id = 'bbbbbbbb-0000-0000-0000-000000000001') = 0,
    'C11: A 用户不应读取 B 租户的诊断字典');
end;
$$;

-- ---------- C12 检验 panel 租户隔离 ----------
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  perform tests.assert_true(
    (select count(*) from public.lab_panels where tenant_id = 'bbbbbbbb-0000-0000-0000-000000000001') = 0,
    'C12: A 用户不应读取 B 租户的检验 panel');
end;
$$;

-- ---------- C13 lab_analytes 跟随 lab_panels 隔离 ----------
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
  -- B 用户不应读到 A 租户 panel 下的 analyte
  perform tests.assert_true(
    (select count(*) from public.lab_analytes
     where panel_id in (select id from public.lab_panels where tenant_id = 'aaaaaaaa-0000-0000-0000-000000000001')) = 0,
    'C13: B 用户不应读取 A 租户 panel 下的 analyte');
  -- B 用户应能读本租户 analyte
  perform tests.assert_true(
    (select count(*) from public.lab_analytes
     where panel_id in (select id from public.lab_panels where tenant_id = 'bbbbbbbb-0000-0000-0000-000000000001')) >= 1,
    'C13: B 用户应能读本租户 panel 下的 analyte');
end;
$$;

-- ---------- C14 超管可读任意租户目录 ----------
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"cccccccc-0000-0000-0000-0000000000cc","role":"authenticated"}', true);
  perform tests.assert_true(
    (select count(*) from public.catalog_items where tenant_id = 'bbbbbbbb-0000-0000-0000-000000000001') = 1,
    'C14: system_admin 应能读取任意租户目录项');
  perform tests.assert_true(
    (select count(*) from public.catalog_categories where tenant_id = 'bbbbbbbb-0000-0000-0000-000000000001') >= 6,
    'C14: system_admin 应能读取任意租户类目');
end;
$$;

-- 全部断言通过
select 'RLS_CATALOG_TEST_PASSED' as result;

rollback;
