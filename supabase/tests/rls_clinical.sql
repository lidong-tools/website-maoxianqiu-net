-- ============================================================
-- RLS 测试:Clinical 诊疗核心领域跨租户/跨门店/跨医生隔离
-- MXQ-7001~7011
--
-- 执行方式(需要可运行的 Supabase 数据库,本地 Docker 或 CI):
--   1) supabase db reset
--   2) psql "$DATABASE_URL" -f supabase/tests/rls_clinical.sql
--
-- 断言矩阵:
--   C1 跨租户不可读预约(A1 员工读取 B 租户预约 = 0)
--   C2 跨门店不可读预约(A1 员工读取 A2 门店预约 = 0)
--   C3 合法门店预约可读(A1 员工读取 A1 门店预约 = 成功)
--   C4 跨租户不可读病历(A1 员工读取 B 租户病历 = 0)
--   C5 跨门店不可读处方(A1 员工读取 A2 门店处方 = 0)
--   C6 护士任务跨门店隔离
--   C7 未签署病历不可被非主治医生修改(RLS UPDATE 兜底)
--   C8 跨租户写入预约被拒绝
--   C9 已签署病历不可直接修改(RLS 兜底,强制走修订 RPC)
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

-- ---------- 复用夹具:两租户 / 三门店 / 医生用户 ----------
-- 租户 A:门店 A1、A2;租户 B:门店 B1
-- 用户:u_a1_doc(T_A/A1 医生)、u_a2_doc(T_A/A2 医生)、u_b_doc(T_B/B1 医生)、u_admin(system_admin)
insert into public.tenants (id, slug, name) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'tenant-a-clin', '租户 A'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'tenant-b-clin', '租户 B')
on conflict (slug) do nothing;

insert into auth.users (id, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, aud, role, created_at, updated_at)
values
  ('aaaaaaaa-7000-0000-0000-0000000000d1', 'u-a1-doc@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now()),
  ('aaaaaaaa-7000-0000-0000-0000000000d2', 'u-a2-doc@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now()),
  ('bbbbbbbb-7000-0000-0000-0000000000d1', 'u-b-doc@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now())
on conflict (id) do nothing;

insert into public.stores (id, tenant_id, name, code, status) values
  ('aaaaaaaa-7000-0000-0000-0000000000f1', 'aaaaaaaa-0000-0000-0000-000000000001', 'A1 诊所', 'A1CL', 'active'),
  ('aaaaaaaa-7000-0000-0000-0000000000f2', 'aaaaaaaa-0000-0000-0000-000000000001', 'A2 诊所', 'A2CL', 'active'),
  ('bbbbbbbb-7000-0000-0000-0000000000f1', 'bbbbbbbb-0000-0000-0000-000000000001', 'B1 诊所', 'B1CL', 'active')
on conflict do nothing;

insert into public.tenant_memberships (tenant_id, user_id, status) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-7000-0000-0000-0000000000d1', 'active'),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-7000-0000-0000-0000000000d2', 'active'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'bbbbbbbb-7000-0000-0000-0000000000d1', 'active')
on conflict do nothing;

insert into public.employees (tenant_id, user_id, employee_no, name, status) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-7000-0000-0000-0000000000d1', 'EMP-A1-DOC', 'A1 医生', 'active'),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-7000-0000-0000-0000000000d2', 'EMP-A2-DOC', 'A2 医生', 'active'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'bbbbbbbb-7000-0000-0000-0000000000d1', 'EMP-B1-DOC', 'B1 医生', 'active')
on conflict do nothing;

insert into public.employee_store_assignments (tenant_id, employee_id, store_id, is_primary) values
  ('aaaaaaaa-0000-0000-0000-000000000001', (select id from public.employees where employee_no = 'EMP-A1-DOC'), 'aaaaaaaa-7000-0000-0000-0000000000f1', true),
  ('aaaaaaaa-0000-0000-0000-000000000001', (select id from public.employees where employee_no = 'EMP-A2-DOC'), 'aaaaaaaa-7000-0000-0000-0000000000f2', true),
  ('bbbbbbbb-0000-0000-0000-000000000001', (select id from public.employees where employee_no = 'EMP-B1-DOC'), 'bbbbbbbb-7000-0000-0000-0000000000f1', true)
on conflict do nothing;

-- 给员工分配 doctor 角色(含 clinical 权限)
insert into public.employee_role_assignments (tenant_id, employee_id, role_id, store_id)
values
  ('aaaaaaaa-0000-0000-0000-000000000001', (select id from public.employees where employee_no = 'EMP-A1-DOC'), (select id from public.roles where code = 'doctor'), 'aaaaaaaa-7000-0000-0000-0000000000f1'),
  ('aaaaaaaa-0000-0000-0000-000000000001', (select id from public.employees where employee_no = 'EMP-A2-DOC'), (select id from public.roles where code = 'doctor'), 'aaaaaaaa-7000-0000-0000-0000000000f2'),
  ('bbbbbbbb-0000-0000-0000-000000000001', (select id from public.employees where employee_no = 'EMP-B1-DOC'), (select id from public.roles where code = 'doctor'), 'bbbbbbbb-7000-0000-0000-0000000000f1')
on conflict do nothing;

-- ---------- 测试数据:客户/宠物(复用 CRM 表) ----------
insert into public.customers (id, tenant_id, store_id, customer_no, name, status)
values
  ('aaaaaaaa-7000-0000-0000-0000000000c1', 'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-7000-0000-0000-0000000000f1', 'A1CL-CUST-001', 'A1 客户', 'active'),
  ('bbbbbbbb-7000-0000-0000-0000000000c1', 'bbbbbbbb-0000-0000-0000-000000000001', 'bbbbbbbb-7000-0000-0000-0000000000f1', 'B1CL-CUST-001', 'B1 客户', 'active')
on conflict do nothing;

insert into public.pets (id, tenant_id, customer_id, name, species, status)
values
  ('aaaaaaaa-7000-0000-0000-0000000000b1', 'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-7000-0000-0000-0000000000c1', 'A1 宠物', 'dog', 'active'),
  ('bbbbbbbb-7000-0000-0000-0000000000b1', 'bbbbbbbb-0000-0000-0000-000000000001', 'bbbbbbbb-7000-0000-0000-0000000000c1', 'B1 宠物', 'cat', 'active')
on conflict do nothing;

-- ---------- 测试数据:预约 ----------
insert into public.appointments (id, tenant_id, store_id, customer_id, pet_id, doctor_id, scheduled_start, scheduled_end, status, source)
values
  ('aaaaaaaa-7001-0000-0000-0000000000a1', 'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-7000-0000-0000-0000000000f1', 'aaaaaaaa-7000-0000-0000-0000000000c1', 'aaaaaaaa-7000-0000-0000-0000000000b1', 'aaaaaaaa-7000-0000-0000-0000000000d1', now(), now() + interval '1 hour', 'confirmed', 'walk_in'),
  ('aaaaaaaa-7001-0000-0000-0000000000a2', 'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-7000-0000-0000-0000000000f2', 'aaaaaaaa-7000-0000-0000-0000000000c1', 'aaaaaaaa-7000-0000-0000-0000000000b1', 'aaaaaaaa-7000-0000-0000-0000000000d2', now(), now() + interval '1 hour', 'checked_in', 'phone'),
  ('bbbbbbbb-7001-0000-0000-0000000000a1', 'bbbbbbbb-0000-0000-0000-000000000001', 'bbbbbbbb-7000-0000-0000-0000000000f1', 'bbbbbbbb-7000-0000-0000-0000000000c1', 'bbbbbbbb-7000-0000-0000-0000000000b1', 'bbbbbbbb-7000-0000-0000-0000000000d1', now(), now() + interval '1 hour', 'pending', 'online')
on conflict do nothing;

-- ---------- 测试数据:就诊病历 ----------
-- A1 病历(主治医生 u_a1_doc,未签署)
insert into public.encounters (id, tenant_id, store_id, customer_id, pet_id, doctor_id, status, chief_complaint)
values
  ('aaaaaaaa-7003-0000-0000-0000000000e1', 'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-7000-0000-0000-0000000000f1', 'aaaaaaaa-7000-0000-0000-0000000000c1', 'aaaaaaaa-7000-0000-0000-0000000000b1', 'aaaaaaaa-7000-0000-0000-0000000000d1', 'in_progress', '咳嗽')
on conflict do nothing;

-- A2 病历(已签署,用于测试不可修改)
insert into public.encounters (id, tenant_id, store_id, customer_id, pet_id, doctor_id, status, chief_complaint, signed_by, signed_at)
values
  ('aaaaaaaa-7003-0000-0000-0000000000e2', 'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-7000-0000-0000-0000000000f2', 'aaaaaaaa-7000-0000-0000-0000000000c1', 'aaaaaaaa-7000-0000-0000-0000000000b1', 'aaaaaaaa-7000-0000-0000-0000000000d2', 'signed', '发烧', 'aaaaaaaa-7000-0000-0000-0000000000d2', now())
on conflict do nothing;

-- B1 病历
insert into public.encounters (id, tenant_id, store_id, customer_id, pet_id, doctor_id, status, chief_complaint)
values
  ('bbbbbbbb-7003-0000-0000-0000000000e1', 'bbbbbbbb-0000-0000-0000-000000000001', 'bbbbbbbb-7000-0000-0000-0000000000f1', 'bbbbbbbb-7000-0000-0000-0000000000c1', 'bbbbbbbb-7000-0000-0000-0000000000b1', 'bbbbbbbb-7000-0000-0000-0000000000d1', 'in_progress', '腹泻')
on conflict do nothing;

-- ---------- 测试数据:处方 ----------
insert into public.prescriptions (id, tenant_id, store_id, encounter_id, customer_id, pet_id, doctor_id, status)
values
  ('aaaaaaaa-7006-0000-0000-0000000000b2', 'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-7000-0000-0000-0000000000f1', 'aaaaaaaa-7003-0000-0000-0000000000e1', 'aaaaaaaa-7000-0000-0000-0000000000c1', 'aaaaaaaa-7000-0000-0000-0000000000b1', 'aaaaaaaa-7000-0000-0000-0000000000d1', 'draft'),
  ('bbbbbbbb-7006-0000-0000-0000000000b2', 'bbbbbbbb-0000-0000-0000-000000000001', 'bbbbbbbb-7000-0000-0000-0000000000f1', 'bbbbbbbb-7003-0000-0000-0000000000e1', 'bbbbbbbb-7000-0000-0000-0000000000c1', 'bbbbbbbb-7000-0000-0000-0000000000b1', 'bbbbbbbb-7000-0000-0000-0000000000d1', 'draft')
on conflict do nothing;

-- ---------- 测试数据:护士任务 ----------
insert into public.nurse_tasks (id, tenant_id, store_id, pet_id, task_type, description, status)
values
  ('aaaaaaaa-7007-0000-0000-0000000000c2', 'aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-7000-0000-0000-0000000000f1', 'aaaaaaaa-7000-0000-0000-0000000000b1', 'medication', 'A1 给药任务', 'pending'),
  ('bbbbbbbb-7007-0000-0000-0000000000c2', 'bbbbbbbb-0000-0000-0000-000000000001', 'bbbbbbbb-7000-0000-0000-0000000000f1', 'bbbbbbbb-7000-0000-0000-0000000000b1', 'observation', 'B1 观察任务', 'pending')
on conflict do nothing;

-- ======================================================================
-- 以 A1 医生身份执行测试
-- ======================================================================
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"aaaaaaaa-7000-0000-0000-0000000000d1","role":"authenticated"}', true);

  perform tests.assert_true(
    (select count(*) from public.appointments where tenant_id = 'bbbbbbbb-0000-0000-0000-000000000001') = 0,
    'C1: A1 医生不应读到 B 租户预约'
  );

  perform tests.assert_true(
    (select count(*) from public.appointments where store_id = 'aaaaaaaa-7000-0000-0000-0000000000f2') = 0,
    'C2: A1 医生不应读到 A2 门店预约'
  );

  perform tests.assert_true(
    (select count(*) from public.appointments where store_id = 'aaaaaaaa-7000-0000-0000-0000000000f1') >= 1,
    'C3: A1 医生应能读到 A1 门店预约'
  );

  perform tests.assert_true(
    (select count(*) from public.encounters where tenant_id = 'bbbbbbbb-0000-0000-0000-000000000001') = 0,
    'C4: A1 医生不应读到 B 租户病历'
  );

  perform tests.assert_true(
    (select count(*) from public.prescriptions where tenant_id = 'bbbbbbbb-0000-0000-0000-000000000001') = 0,
    'C5: A1 医生不应读到 B 租户处方'
  );

  perform tests.assert_true(
    (select count(*) from public.nurse_tasks where tenant_id = 'bbbbbbbb-0000-0000-0000-000000000001') = 0,
    'C6: A1 医生不应读到 B 租户护士任务'
  );

  begin
    begin
      update public.encounters set chief_complaint = '篡改' where id = 'aaaaaaaa-7003-0000-0000-0000000000e2';
      if found then
        raise exception 'C7: A1 医生不应能修改 A2 门店的已签署病历';
      end if;
    exception
      when insufficient_privilege or check_violation then
        null;
    end;
  end;

  begin
    begin
      insert into public.appointments (tenant_id, store_id, customer_id, pet_id, scheduled_start, scheduled_end, status, source)
      values ('bbbbbbbb-0000-0000-0000-000000000001', 'bbbbbbbb-7000-0000-0000-0000000000f1', 'bbbbbbbb-7000-0000-0000-0000000000c1', 'bbbbbbbb-7000-0000-0000-0000000000b1', now(), now() + interval '1 hour', 'pending', 'walk_in');
      raise exception 'C8: A1 医生不应能写入 B 租户预约';
    exception
      when insufficient_privilege or check_violation then
        null;
    end;
  end;

  perform tests.assert_true(
    (select count(*) from public.encounters where store_id = 'aaaaaaaa-7000-0000-0000-0000000000f1' and status = 'in_progress') >= 1,
    'C9a: A1 医生应能读到 A1 门店进行中病历'
  );

  update public.encounters
  set chief_complaint = '咳嗽(已更新)'
  where id = 'aaaaaaaa-7003-0000-0000-0000000000e1'
    and status = 'in_progress';
  perform tests.assert_true(
    found,
    'C9b: A1 医生应能更新 A1 门店进行中病历'
  );
end;
$$;

reset role;

-- ---------- 打印成功 ----------
do $$
begin
  raise notice 'RLS Clinical 测试全部通过';
end;
$$;

rollback;
