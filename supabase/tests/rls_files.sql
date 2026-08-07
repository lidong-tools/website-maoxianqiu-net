-- ============================================================
-- RLS 测试:files / attachments 跨租户/跨门店隔离(MXQ-4001)
--
-- 执行方式(需要可运行的 Supabase 数据库,本地 Docker 或 CI):
--   1) supabase db reset
--   2) psql "$DATABASE_URL" -f supabase/tests/rls_files.sql
--
-- 断言矩阵:
--   F1 跨租户不可读(A 用户读取 B 租户文件 = 0)
--   F2 跨租户不可写(A 用户写入 B 租户文件 = 拒绝)
--   F3 无权门店文件不可读(A1 员工读取 A2 门店文件 = 0)
--   F4 无权门店文件不可写(A1 员工写入 A2 门店文件 = 拒绝)
--   F5 合法门店文件可读写(A1 员工读写本店文件 = 成功)
--   F6 私有医疗文件仅本店可读(跨店读取 = 0)
--   F7 attachments 跟随 files 隔离(跨店 attachment 不可读)
--   F8 归档文件仍受 RLS 保护(归档不绕过租户隔离)
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

-- ---------- 复用 rls_tenant_store.sql 的夹具(两租户 / 三门店) ----------
-- 租户 A:门店 A1、A2;租户 B:门店 B1
-- 用户:u_a1(T_A/A1 店长)、u_a2(T_A/A2)、u_b(T_B/B1)、u_admin(system_admin)
insert into public.tenants (id, slug, name) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'tenant-a-files', '租户 A'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'tenant-b-files', '租户 B')
on conflict (slug) do nothing;

insert into auth.users (id, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, aud, role, created_at, updated_at)
values
  ('aaaaaaaa-0000-0000-0000-0000000000a1', 'u-a1-files@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now()),
  ('aaaaaaaa-0000-0000-0000-0000000000a2', 'u-a2-files@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now()),
  ('bbbbbbbb-0000-0000-0000-0000000000b1', 'u-b1-files@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now()),
  ('cccccccc-0000-0000-0000-0000000000cc', 'u-admin-files@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now())
on conflict (id) do nothing;

insert into public.stores (id, tenant_id, name, code, status) values
  ('aaaaaaaa-0000-0000-0000-0000000000f1', 'aaaaaaaa-0000-0000-0000-000000000001', 'A1 店', 'A1F', 'active'),
  ('aaaaaaaa-0000-0000-0000-0000000000f2', 'aaaaaaaa-0000-0000-0000-000000000001', 'A2 店', 'A2F', 'active'),
  ('bbbbbbbb-0000-0000-0000-0000000000f1', 'bbbbbbbb-0000-0000-0000-000000000001', 'B1 店', 'B1F', 'active')
on conflict do nothing;

insert into public.tenant_memberships (tenant_id, user_id, status) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'active'),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a2', 'active'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-0000000000b1', 'active'),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-0000000000cc', 'active')
on conflict do nothing;

insert into public.employees (tenant_id, user_id, employee_no, name, status) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a1', 'EMP-A1F', 'A1 员工', 'active'),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000a2', 'EMP-A2F', 'A2 员工', 'active'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-0000000000b1', 'EMP-B1F', 'B1 员工', 'active'),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'cccccccc-0000-0000-0000-0000000000cc', 'EMP-ADMIN-F', '管理员', 'active')
on conflict do nothing;

insert into public.employee_store_assignments (tenant_id, employee_id, store_id, is_primary) values
  ('aaaaaaaa-0000-0000-0000-000000000001', (select id from public.employees where employee_no = 'EMP-A1F'), 'aaaaaaaa-0000-0000-0000-0000000000f1', true),
  ('aaaaaaaa-0000-0000-0000-000000000001', (select id from public.employees where employee_no = 'EMP-A2F'), 'aaaaaaaa-0000-0000-0000-0000000000f2', true),
  ('bbbbbbbb-0000-0000-0000-000000000001', (select id from public.employees where employee_no = 'EMP-B1F'), 'bbbbbbbb-0000-0000-0000-0000000000f1', true)
on conflict do nothing;

-- 给 A1 员工 store_manager 角色(含 file.upload/download/archive 权限)
insert into public.employee_role_assignments (tenant_id, employee_id, role_id, store_id)
values
  ('aaaaaaaa-0000-0000-0000-000000000001', (select id from public.employees where employee_no = 'EMP-A1F'), (select id from public.roles where code = 'store_manager'), 'aaaaaaaa-0000-0000-0000-0000000000f1'),
  ('aaaaaaaa-0000-0000-0000-000000000001', (select id from public.employees where employee_no = 'EMP-A2F'), (select id from public.roles where code = 'store_manager'), 'aaaaaaaa-0000-0000-0000-0000000000f2'),
  ('bbbbbbbb-0000-0000-0000-000000000001', (select id from public.employees where employee_no = 'EMP-B1F'), (select id from public.roles where code = 'store_manager'), 'bbbbbbbb-0000-0000-0000-0000000000f1')
on conflict do nothing;

-- 平台管理员授权(S30-F01:平台角色独立于租户角色体系,通过 platform_user_roles 授予)
insert into public.platform_user_roles (user_id, role)
values ('cccccccc-0000-0000-0000-0000000000cc', 'platform_admin')
on conflict do nothing;

-- ---------- 文件夹具 ----------
-- A1 门店的私有医疗文件
insert into public.files (id, tenant_id, store_id, bucket, object_key, original_name, mime_type, size_bytes, category, status, uploaded_by)
values
  ('11111111-0000-0000-0000-0000000000f1', 'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000f1', 'private', 'prod/tenant/a/store/a1/medical-record/2026/08/f1.pdf', '病历1.pdf', 'application/pdf', 1024, 'medical-record', 'uploaded', 'aaaaaaaa-0000-0000-0000-0000000000a1');

-- A2 门店的私有医疗文件(不应被 A1 读取)
insert into public.files (id, tenant_id, store_id, bucket, object_key, original_name, mime_type, size_bytes, category, status, uploaded_by)
values
  ('22222222-0000-0000-0000-0000000000f2', 'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000f2', 'private', 'prod/tenant/a/store/a2/medical-record/2026/08/f2.pdf', '病历2.pdf', 'application/pdf', 2048, 'medical-record', 'uploaded', 'aaaaaaaa-0000-0000-0000-0000000000a2');

-- B1 门店的私有医疗文件(不应被 A 读取)
insert into public.files (id, tenant_id, store_id, bucket, object_key, original_name, mime_type, size_bytes, category, status, uploaded_by)
values
  ('33333333-0000-0000-0000-0000000000f3', 'bbbbbbbb-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-0000000000f1', 'private', 'prod/tenant/b/store/b1/medical-record/2026/08/f3.pdf', '病历3.pdf', 'application/pdf', 4096, 'medical-record', 'uploaded', 'bbbbbbbb-0000-0000-0000-0000000000b1');

-- 归档文件
insert into public.files (id, tenant_id, store_id, bucket, object_key, original_name, mime_type, size_bytes, category, status, uploaded_by, archived_at)
values
  ('44444444-0000-0000-0000-0000000000f4', 'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000f1', 'private', 'prod/tenant/a/store/a1/medical-record/2026/08/f4.pdf', '归档病历.pdf', 'application/pdf', 8192, 'medical-record', 'archived', 'aaaaaaaa-0000-0000-0000-0000000000a1', now());

-- ---------- 附件夹具 ----------
insert into public.attachments (id, tenant_id, file_id, entity_type, entity_id, purpose) values
  ('aaaa1111-0000-0000-0000-0000000000e1', 'aaaaaaaa-0000-0000-0000-000000000001', '11111111-0000-0000-0000-0000000000f1', 'customer', 'aaaa1111-0000-0000-0000-0000000000c1', 'attachment'),
  ('aaaa2222-0000-0000-0000-0000000000e2', 'aaaaaaaa-0000-0000-0000-000000000001', '22222222-0000-0000-0000-0000000000f2', 'customer', 'aaaa2222-0000-0000-0000-0000000000c2', 'attachment');

-- ============================================================
-- 各测试块
-- ============================================================

-- ---------- F1 跨租户不可读 ----------
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  perform tests.assert_true(
    (select count(*) from public.files where tenant_id = 'bbbbbbbb-0000-0000-0000-000000000001') = 0,
    'F1: A 用户不应读取到 B 租户的文件');
end;
$$;

-- ---------- F2 跨租户不可写 ----------
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  begin
    insert into public.files (tenant_id, store_id, bucket, object_key, original_name, mime_type, size_bytes, category, status)
    values ('bbbbbbbb-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-0000000000f1', 'private', 'test/cross-tenant.pdf', '越权.pdf', 'application/pdf', 100, 'general', 'pending');
    raise exception 'RLS_TEST_FAILED: F2 A 用户不应写入 B 租户文件';
  exception when insufficient_privilege then
    null;
  end;
end;
$$;

-- ---------- F3 无权门店文件不可读 ----------
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  perform tests.assert_true(
    (select count(*) from public.files where store_id = 'aaaaaaaa-0000-0000-0000-0000000000f2') = 0,
    'F3: A1 员工不应读取到 A2 门店的文件');
end;
$$;

-- ---------- F4 无权门店文件不可写 ----------
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  begin
    insert into public.files (tenant_id, store_id, bucket, object_key, original_name, mime_type, size_bytes, category, status)
    values ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000f2', 'private', 'test/cross-store.pdf', '越权店.pdf', 'application/pdf', 100, 'general', 'pending');
    raise exception 'RLS_TEST_FAILED: F4 A1 员工不应写入 A2 门店文件';
  exception when insufficient_privilege then
    null;
  end;
end;
$$;

-- ---------- F5 合法门店文件可读 ----------
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  perform tests.assert_true(
    (select count(*) from public.files where store_id = 'aaaaaaaa-0000-0000-0000-0000000000f1' and status = 'uploaded') >= 1,
    'F5: A1 员工应能读取本门店文件');
end;
$$;

-- ---------- F6 私有医疗文件仅本店可读(跨店 = 0) ----------
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  perform tests.assert_true(
    (select count(*) from public.files where category = 'medical-record' and store_id = 'aaaaaaaa-0000-0000-0000-0000000000f2') = 0,
    'F6: A1 员工不应读取 A2 门店的私有医疗文件');
end;
$$;

-- ---------- F7 attachments 跟随 files 隔离 ----------
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  -- A1 可读本店 attachment
  perform tests.assert_true(
    (select count(*) from public.attachments where file_id = '11111111-0000-0000-0000-0000000000f1') = 1,
    'F7: A1 员工应能读取本店文件的 attachment');
  -- A1 不可读 A2 attachment(因关联文件在 A2 门店)
  perform tests.assert_true(
    (select count(*) from public.attachments where file_id = '22222222-0000-0000-0000-0000000000f2') = 0,
    'F7: A1 员工不应读取 A2 门店文件的 attachment');
end;
$$;

-- ---------- F8 归档文件仍受 RLS 保护 ----------
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
  perform tests.assert_true(
    (select count(*) from public.files where id = '44444444-0000-0000-0000-0000000000f4') = 0,
    'F8: 归档文件仍受 RLS 保护,A2 员工不可读取 A1 的归档文件');
end;
$$;

-- ---------- F9 超管可读任意租户文件 ----------
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"cccccccc-0000-0000-0000-0000000000cc","role":"authenticated"}', true);
  perform tests.assert_true(
    (select count(*) from public.files where tenant_id = 'bbbbbbbb-0000-0000-0000-000000000001') = 1,
    'F9: system_admin 应能读取任意租户文件');
end;
$$;

-- 全部断言通过
select 'RLS_FILES_TEST_PASSED' as result;

rollback;
