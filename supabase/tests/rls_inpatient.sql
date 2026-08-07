-- ============================================================
-- RLS 测试:inpatient 跨租户/跨门店隔离 + 并发房位锁 + 幂等(MXQ-11001~11009)
--
-- 执行方式(需要可运行的 Supabase 数据库):
--   1) supabase db reset
--   2) psql "$DATABASE_URL" -f supabase/tests/rls_inpatient.sql
--
-- 断言矩阵:
--   IP1 跨租户不可读(A 用户读取 B 租户笼位 = 0)
--   IP2 跨租户不可写(A 用户写入 B 租户房间 = 拒绝)
--   IP3 无权门店笼位不可读(A1 员工读取 A2 门店笼位 = 0)
--   IP4 合法门店笼位可读(A1 员工读取本店笼位 = 成功)
--   IP5 无 inpatient.view 权限不可读住院记录
--   IP6 并发房位锁:两入院同时抢同一笼位,只有一个成功(核心)
--       - 优先用 dblink 模拟真并发;环境不支持时降级为顺序验证
--   IP7 幂等:同 idempotency_key 调 admit_patient 两次,返回原结果,笼位不重复占用
--   IP8 出院释放笼位:discharge 后 cage.status=available,admission.status=discharged
--   IP9 换房:transfer 后旧笼位 available、新笼位 occupied,admission.cage_id 更新
--   IP10 自动计费幂等:同日重复生成不产生重复费用
--   IP11 超管可读任意租户房态
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

-- ---------- 夹具:两租户 / 三门店 / 四用户 ----------
-- 租户 A:门店 A1、A2;租户 B:门店 B1
-- 用户:u_a1(T_A/A1 店长)、u_a2(T_A/A2)、u_b(T_B/B1)、u_admin(system_admin)
insert into public.tenants (id, slug, name) values
  ('11111111-0000-0000-0000-000000000001', 'tenant-a-ip', '租户 A'),
  ('22222222-0000-0000-0000-000000000001', 'tenant-b-ip', '租户 B')
on conflict (slug) do nothing;

insert into auth.users (id, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, aud, role, created_at, updated_at)
values
  ('11111111-0000-0000-0000-0000000000a1', 'u-a1-ip@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now()),
  ('11111111-0000-0000-0000-0000000000a2', 'u-a2-ip@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now()),
  ('22222222-0000-0000-0000-0000000000b1', 'u-b1-ip@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now()),
  ('33333333-0000-0000-0000-0000000000cc', 'u-admin-ip@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now())
on conflict (id) do nothing;

insert into public.stores (id, tenant_id, name, code, status) values
  ('11111111-0000-0000-0000-0000000000f1', '11111111-0000-0000-0000-000000000001', 'A1 店', 'A1IP', 'active'),
  ('11111111-0000-0000-0000-0000000000f2', '11111111-0000-0000-0000-000000000001', 'A2 店', 'A2IP', 'active'),
  ('22222222-0000-0000-0000-0000000000f1', '22222222-0000-0000-0000-000000000001', 'B1 店', 'B1IP', 'active')
on conflict do nothing;

insert into public.tenant_memberships (tenant_id, user_id, status) values
  ('11111111-0000-0000-0000-000000000001', '11111111-0000-0000-0000-0000000000a1', 'active'),
  ('11111111-0000-0000-0000-000000000001', '11111111-0000-0000-0000-0000000000a2', 'active'),
  ('22222222-0000-0000-0000-000000000001', '22222222-0000-0000-0000-0000000000b1', 'active'),
  ('11111111-0000-0000-0000-000000000001', '33333333-0000-0000-0000-0000000000cc', 'active')
on conflict do nothing;

insert into public.employees (tenant_id, user_id, employee_no, name, status) values
  ('11111111-0000-0000-0000-000000000001', '11111111-0000-0000-0000-0000000000a1', 'EMP-A1IP', 'A1 员工', 'active'),
  ('11111111-0000-0000-0000-000000000001', '11111111-0000-0000-0000-0000000000a2', 'EMP-A2IP', 'A2 员工', 'active'),
  ('22222222-0000-0000-0000-000000000001', '22222222-0000-0000-0000-0000000000b1', 'EMP-B1IP', 'B1 员工', 'active'),
  ('11111111-0000-0000-0000-000000000001', '33333333-0000-0000-0000-0000000000cc', 'EMP-ADMIN-IP', '管理员', 'active')
on conflict do nothing;

insert into public.employee_store_assignments (tenant_id, employee_id, store_id, is_primary) values
  ('11111111-0000-0000-0000-000000000001', (select id from public.employees where employee_no = 'EMP-A1IP'), '11111111-0000-0000-0000-0000000000f1', true),
  ('11111111-0000-0000-0000-000000000001', (select id from public.employees where employee_no = 'EMP-A2IP'), '11111111-0000-0000-0000-0000000000f2', true),
  ('22222222-0000-0000-0000-000000000001', (select id from public.employees where employee_no = 'EMP-B1IP'), '22222222-0000-0000-0000-0000000000f1', true)
on conflict do nothing;

-- 角色:A1/A2/B1 = store_manager(含 inpatient.* / nursing.* / handover.* 权限),admin = system_admin
insert into public.employee_role_assignments (tenant_id, employee_id, role_id, store_id)
values
  ('11111111-0000-0000-0000-000000000001', (select id from public.employees where employee_no = 'EMP-A1IP'), (select id from public.roles where code = 'store_manager'), '11111111-0000-0000-0000-0000000000f1'),
  ('11111111-0000-0000-0000-000000000001', (select id from public.employees where employee_no = 'EMP-A2IP'), (select id from public.roles where code = 'store_manager'), '11111111-0000-0000-0000-0000000000f2'),
  ('22222222-0000-0000-0000-000000000001', (select id from public.employees where employee_no = 'EMP-B1IP'), (select id from public.roles where code = 'store_manager'), '22222222-0000-0000-0000-0000000000f1'),
  ('11111111-0000-0000-0000-000000000001', (select id from public.employees where employee_no = 'EMP-ADMIN-IP'), (select id from public.roles where code = 'system_admin'), null)
on conflict do nothing;

-- ---------- 房间 / 笼位夹具 ----------
-- A1 门店:room_a1 含 cage_a1_1 / cage_a1_2(供并发抢房测试)
-- A2 门店:room_a2 含 cage_a2_1
-- B1 门店:room_b1 含 cage_b1_1
insert into public.rooms (id, tenant_id, store_id, name, code, room_type, capacity, is_active) values
  ('11111111-0000-0000-0000-00000000e001', '11111111-0000-0000-0000-000000000001', '11111111-0000-0000-0000-0000000000f1', 'A1 病房', 'A1R', 'ward', 10, true),
  ('11111111-0000-0000-0000-00000000e002', '11111111-0000-0000-0000-000000000001', '11111111-0000-0000-0000-0000000000f2', 'A2 病房', 'A2R', 'ward', 8, true),
  ('22222222-0000-0000-0000-00000000e001', '22222222-0000-0000-0000-000000000001', '22222222-0000-0000-0000-0000000000f1', 'B1 病房', 'B1R', 'ward', 6, true)
on conflict do nothing;

insert into public.cages (id, tenant_id, store_id, room_id, name, code, cage_type, daily_rate, status) values
  ('11111111-0000-0000-0000-00000000c011', '11111111-0000-0000-0000-000000000001', '11111111-0000-0000-0000-0000000000f1', '11111111-0000-0000-0000-00000000e001', 'A1-1 号笼', 'A1C1', 'cage', 80.00, 'available'),
  ('11111111-0000-0000-0000-00000000c012', '11111111-0000-0000-0000-000000000001', '11111111-0000-0000-0000-0000000000f1', '11111111-0000-0000-0000-00000000e001', 'A1-2 号笼', 'A1C2', 'cage', 80.00, 'available'),
  ('11111111-0000-0000-0000-00000000c021', '11111111-0000-0000-0000-000000000001', '11111111-0000-0000-0000-0000000000f2', '11111111-0000-0000-0000-00000000e002', 'A2-1 号笼', 'A2C1', 'run', 120.00, 'available'),
  ('22222222-0000-0000-0000-00000000c011', '22222222-0000-0000-0000-000000000001', '22222222-0000-0000-0000-0000000000f1', '22222222-0000-0000-0000-00000000e001', 'B1-1 号笼', 'B1C1', 'cage', 60.00, 'available')
on conflict do nothing;

-- 固定客户/宠物 id(跨 migration 无 FK,直接用固定 UUID)
-- customer_id: 'cccccccc-0000-0000-0000-00000000c001'
-- pet_id: 'dddddddd-0000-0000-0000-00000000d001' / p002

-- ---------- IP1 跨租户不可读 ----------
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"11111111-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  perform tests.assert_true(
    (select count(*) from public.cages where tenant_id = '22222222-0000-0000-0000-000000000001') = 0,
    'IP1: A 用户不应读取到 B 租户的笼位');
end;
$$;

-- ---------- IP2 跨租户不可写 ----------
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"11111111-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  begin
    insert into public.rooms (tenant_id, store_id, name, code)
    values ('22222222-0000-0000-0000-000000000001', '22222222-0000-0000-0000-0000000000f1', 'X', 'XROOM');
    raise exception 'RLS_TEST_FAILED: IP2 A 用户不应写入 B 租户房间';
  exception when insufficient_privilege then
    null;
  end;
end;
$$;

-- ---------- IP3 无权门店笼位不可读 ----------
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"11111111-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  perform tests.assert_true(
    (select count(*) from public.cages where store_id = '11111111-0000-0000-0000-0000000000f2') = 0,
    'IP3: A1 员工不应读取到 A2 门店的笼位');
end;
$$;

-- ---------- IP4 合法门店笼位可读 ----------
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"11111111-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  perform tests.assert_true(
    (select count(*) from public.cages where store_id = '11111111-0000-0000-0000-0000000000f1') >= 2,
    'IP4: A1 员工应能读取本店笼位(至少 2 个)');
end;
$$;

-- ---------- IP5 无 inpatient.view 权限不可读住院记录 ----------
-- 用 u_a2(A2 店长,有 inpatient.view)能读 A1 住院?不能——A2 未分配 A1 门店
-- 此处验证:A2 员工(无 A1 门店分配)读取 A1 门店住院记录 = 0
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"11111111-0000-0000-0000-0000000000a2","role":"authenticated"}', true);
  perform tests.assert_true(
    (select count(*) from public.admissions where store_id = '11111111-0000-0000-0000-0000000000f1') = 0,
    'IP5: A2 员工不应读取到 A1 门店住院记录(无门店分配)');
end;
$$;

-- ---------- IP6 并发房位锁:两入院同时抢同一笼位,只有一个成功 ----------
-- 这是 MXQ-11003 的核心并发安全测试。
-- 策略:优先用 dblink 模拟两个并发事务同时调 admit_patient 抢同一笼位;
--       环境不支持 dblink 时降级为顺序验证(第一个成功后笼位 occupied,第二个必失败)。
-- 无论哪种方式,断言不变:笼位最终被恰好一个 admission 占用。
do $_$
declare
  v_cage_id uuid := '11111111-0000-0000-0000-00000000c011';
  v_tenant_id uuid := '11111111-0000-0000-0000-000000000001';
  v_store_id uuid := '11111111-0000-0000-0000-0000000000f1';
  v_r1 jsonb;
  v_r2 jsonb;
  v_admission_count integer;
  v_cage_status text;
  v_dblink_ok boolean := false;
  v_conn_str text;
begin
  -- 尝试启用 dblink 并建立两个并发连接
  begin
    create extension if not exists dblink;
    v_conn_str := 'dbname=' || current_database();
    perform dblink_connect('ip_conn_a', v_conn_str);
    perform dblink_connect('ip_conn_b', v_conn_str);
    v_dblink_ok := true;
  exception when others then
    v_dblink_ok := false;
  end;

  if v_dblink_ok then
    -- 真并发:两个连接同时发起 admit_patient 抢同一笼位 cage_a1_1
    -- 用不同 idempotency_key 确保不是幂等命中,而是真正抢锁
    perform dblink_send_query('ip_conn_a', $$select public.admit_patient(
      '11111111-0000-0000-0000-000000000001'::uuid, '11111111-0000-0000-0000-0000000000f1'::uuid,
      'cccccccc-0000-0000-0000-00000000c001'::uuid, 'dddddddd-0000-0000-0000-00000000d001'::uuid,
      '11111111-0000-0000-0000-00000000c011'::uuid, null, '并发测试A', null, 'idem-ip6-connA')$$);
    perform dblink_send_query('ip_conn_b', $$select public.admit_patient(
      '11111111-0000-0000-0000-000000000001'::uuid, '11111111-0000-0000-0000-0000000000f1'::uuid,
      'cccccccc-0000-0000-0000-00000000c001'::uuid, 'dddddddd-0000-0000-0000-00000000d002'::uuid,
      '11111111-0000-0000-0000-00000000c011'::uuid, null, '并发测试B', null, 'idem-ip6-connB')$$);

    -- 收集结果(其中一个会抛 CAGE_NOT_AVAILABLE)
    begin
      select * into v_r1 from dblink_get_result('ip_conn_a') as t(r jsonb);
    exception when others then
      v_r1 := null;
    end;
    begin
      select * into v_r2 from dblink_get_result('ip_conn_b') as t(r jsonb);
    exception when others then
      v_r2 := null;
    end;

    -- 清理连接(忽略错误,避免清理失败中断断言)
    begin
      perform dblink_disconnect('ip_conn_a');
    exception when others then
      null;
    end;
    begin
      perform dblink_disconnect('ip_conn_b');
    exception when others then
      null;
    end;
  else
    -- 降级:顺序验证并发不变量
    -- 第一次入院抢笼位 cage_a1_1,应成功
    v_r1 := public.admit_patient(
      v_tenant_id, v_store_id,
      'cccccccc-0000-0000-0000-00000000c001'::uuid, 'dddddddd-0000-0000-0000-00000000d001'::uuid,
      v_cage_id, null, '并发测试A', null, 'idem-ip6-connA');
    perform tests.assert_true((v_r1->>'admissionId') is not null, 'IP6a: 第一次入院应成功');

    -- 第二次入院抢同一笼位,应抛 CAGE_NOT_AVAILABLE
    begin
      v_r2 := public.admit_patient(
        v_tenant_id, v_store_id,
        'cccccccc-0000-0000-0000-00000000c001'::uuid, 'dddddddd-0000-0000-0000-00000000d002'::uuid,
        v_cage_id, null, '并发测试B', null, 'idem-ip6-connB');
      -- 若未抛异常,说明并发锁失效
      perform tests.assert_true(false, 'IP6b: 第二次入院应失败(FOR UPDATE 锁应阻止重复占用)');
    exception when others then
      if position('CAGE_NOT_AVAILABLE' in sqlerrm) = 0 then
        raise exception 'RLS_TEST_FAILED: IP6b 应抛 CAGE_NOT_AVAILABLE,实际: %', sqlerrm;
      end if;
      v_r2 := null;
    end;
  end if;

  -- 断言:笼位 cage_a1_1 最终被恰好一个 admission 占用
  select count(*) into v_admission_count
  from public.admissions
  where cage_id = v_cage_id and status = 'admitted';
  perform tests.assert_true(v_admission_count = 1, 'IP6c: 同一笼位应仅有 1 条在院记录(实际 ' || v_admission_count || ')');

  -- 断言:笼位状态为 occupied
  select status into v_cage_status from public.cages where id = v_cage_id;
  perform tests.assert_true(v_cage_status = 'occupied', 'IP6d: 被抢笼位状态应为 occupied');
end;
$_$;

-- ---------- IP7 幂等:同 idempotency_key 调 admit_patient 两次 ----------
-- 用 cage_a1_2 笼位,同一 idempotency_key 调两次,应返回相同 admissionId,笼位不重复占用
do $$
declare
  v_first jsonb;
  v_second jsonb;
  v_count integer;
begin
  v_first := public.admit_patient(
    '11111111-0000-0000-0000-000000000001'::uuid, '11111111-0000-0000-0000-0000000000f1'::uuid,
    'cccccccc-0000-0000-0000-00000000c001'::uuid, 'dddddddd-0000-0000-0000-00000000d003'::uuid,
    '11111111-0000-0000-0000-00000000c012'::uuid, null, '幂等测试', null, 'idem-ip7-admit');
  perform tests.assert_true((v_first->>'admissionId') is not null, 'IP7a: 第一次入院应成功');

  -- 第二次用同一 idempotency_key,应返回原结果
  v_second := public.admit_patient(
    '11111111-0000-0000-0000-000000000001'::uuid, '11111111-0000-0000-0000-0000000000f1'::uuid,
    'cccccccc-0000-0000-0000-00000000c001'::uuid, 'dddddddd-0000-0000-0000-00000000d003'::uuid,
    '11111111-0000-0000-0000-00000000c012'::uuid, null, '幂等测试', null, 'idem-ip7-admit');
  perform tests.assert_true(
    (v_second->>'admissionId')::text = (v_first->>'admissionId')::text,
    'IP7b: 幂等应返回相同 admissionId');

  -- 验证笼位 cage_a1_2 仅 1 条在院记录(未重复占用)
  select count(*) into v_count
  from public.admissions
  where cage_id = '11111111-0000-0000-0000-00000000c012' and status = 'admitted';
  perform tests.assert_true(v_count = 1, 'IP7c: 幂等入院后笼位应仅 1 条在院记录');
end;
$$;

-- ---------- IP8 出院释放笼位 ----------
-- 对 IP7 创建的 admission 执行出院,断言笼位恢复 available,admission.status=discharged
do $$
declare
  v_admission_id uuid;
  v_result jsonb;
  v_cage_status text;
  v_admission_status text;
begin
  -- 直接从数据库取 IP7 创建的在院记录(笼位 cage_a1_2)
  select id into v_admission_id
  from public.admissions
  where cage_id = '11111111-0000-0000-0000-00000000c012' and status = 'admitted'
  limit 1;
  perform tests.assert_true(v_admission_id is not null, 'IP8 setup: 应存在 cage_a1_2 的在院记录');

  -- 出院
  v_result := public.discharge_patient(
    v_admission_id, '康复出院', '测试出院', '33333333-0000-0000-0000-0000000000cc'::uuid, 'idem-ip8-discharge');
  perform tests.assert_true((v_result->>'status')::text = 'discharged', 'IP8a: 出院后状态应为 discharged');

  -- 断言笼位恢复 available
  select status into v_cage_status from public.cages where id = '11111111-0000-0000-0000-00000000c012';
  perform tests.assert_true(v_cage_status = 'available', 'IP8b: 出院后笼位应恢复 available');

  -- 断言 admission.status=discharged
  select status into v_admission_status from public.admissions where id = v_admission_id;
  perform tests.assert_true(v_admission_status = 'discharged', 'IP8c: 住院记录状态应为 discharged');
end;
$$;

-- ---------- IP9 换房:旧笼位 available、新笼位 occupied,admission.cage_id 更新 ----------
-- 重新入院到 cage_a1_1(IP6 已占用),再换到 cage_a1_2(IP8 出院后已释放)
do $$
declare
  v_admission_id uuid;
  v_result jsonb;
  v_old_cage_status text;
  v_new_cage_status text;
  v_admission_cage_id uuid;
begin
  -- 取 IP6 创建的在院记录(笼位 cage_a1_1)
  select id into v_admission_id
  from public.admissions
  where cage_id = '11111111-0000-0000-0000-00000000c011' and status = 'admitted'
  limit 1;
  perform tests.assert_true(v_admission_id is not null, 'IP9 setup: 应存在 cage_a1_1 的在院记录');

  -- 换房:cage_a1_1 → cage_a1_2
  v_result := public.transfer_cage(
    v_admission_id, '11111111-0000-0000-0000-00000000c012'::uuid,
    '更换大笼位', '33333333-0000-0000-0000-0000000000cc'::uuid, 'idem-ip9-transfer');
  perform tests.assert_true((v_result->>'transferId') is not null, 'IP9a: 换房应成功返回 transferId');

  -- 断言旧笼位 cage_a1_1 恢复 available
  select status into v_old_cage_status from public.cages where id = '11111111-0000-0000-0000-00000000c011';
  perform tests.assert_true(v_old_cage_status = 'available', 'IP9b: 换房后旧笼位应恢复 available');

  -- 断言新笼位 cage_a1_2 变为 occupied
  select status into v_new_cage_status from public.cages where id = '11111111-0000-0000-0000-00000000c012';
  perform tests.assert_true(v_new_cage_status = 'occupied', 'IP9c: 换房后新笼位应为 occupied');

  -- 断言 admission.cage_id 已更新为新笼位
  select cage_id into v_admission_cage_id from public.admissions where id = v_admission_id;
  perform tests.assert_true(
    v_admission_cage_id = '11111111-0000-0000-0000-00000000c012',
    'IP9d: 换房后 admission.cage_id 应更新为新笼位');
end;
$$;

-- ---------- IP10 自动计费幂等:同日重复生成不产生重复费用 ----------
-- 对当前在院记录(cage_a1_2)生成当日笼位费,调两次,费用仅 1 条
do $$
declare
  v_first jsonb;
  v_second jsonb;
  v_charge_count integer;
  v_admission_id uuid;
begin
  select id into v_admission_id
  from public.admissions
  where cage_id = '11111111-0000-0000-0000-00000000c012' and status = 'admitted'
  limit 1;
  perform tests.assert_true(v_admission_id is not null, 'IP10 setup: 应存在 cage_a1_2 的在院记录');

  -- 第一次生成当日计费
  v_first := public.generate_daily_charges(current_date);
  perform tests.assert_true((v_first->>'generatedCount')::int >= 1, 'IP10a: 首次计费应至少生成 1 条');

  -- 第二次用同一日期生成(幂等)
  v_second := public.generate_daily_charges(current_date);
  perform tests.assert_true(
    (v_second->>'generatedCount')::int = 0,
    'IP10b: 重复计费应幂等,generatedCount=0');

  -- 断言该 admission 当日笼位费仅 1 条
  select count(*) into v_charge_count
  from public.inpatient_charges
  where admission_id = v_admission_id and charge_date = current_date;
  perform tests.assert_true(v_charge_count = 1, 'IP10c: 当日笼位费应仅 1 条(幂等)');
end;
$$;

-- ---------- IP11 超管可读任意租户房态 ----------
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"33333333-0000-0000-0000-0000000000cc","role":"authenticated"}', true);
  -- 超管可读 B 租户笼位(虽未分配 B 店,但 is_system_admin 放行)
  perform tests.assert_true(
    (select count(*) from public.cages where tenant_id = '22222222-0000-0000-0000-000000000001') >= 1,
    'IP11: system_admin 应能读取任意租户笼位');
end;
$$;

-- 全部断言通过
select 'RLS_INPATIENT_TEST_PASSED' as result;

rollback;
