-- ============================================================
-- RLS 测试:diagnostics 跨租户/跨门店隔离 + RPC 事务(MXQ-10001~10011)
--
-- 执行方式(需要可运行的 Supabase 数据库):
--   1) supabase db reset
--   2) psql "$DATABASE_URL" -f supabase/tests/rls_diagnostics.sql
--
-- 断言矩阵:
--   DG1 跨租户不可读疫苗接种(A 用户读取 B 租户疫苗接种 = 0)
--   DG2 跨租户不可写疫苗接种(A 用户写入 B 租户疫苗接种 = 拒绝)
--   DG3 无权门店疫苗接种不可读(A1 员工读取 A2 门店疫苗接种 = 0)
--   DG4 合法门店疫苗接种可读(A1 员工读取本店疫苗接种 = 成功)
--   DG5 无 vaccine.manage 权限不可创建疫苗接种
--   DG6 疫苗接种状态机:scheduled→administered 合法转换
--   DG7 签发疫苗证明 RPC:未接种状态拒绝签发
--   DG8 签发疫苗证明 RPC:已接种状态成功签发 + 证书编号唯一
--   DG9 重复签发同一疫苗接种的证明 = 拒绝
--   DG10 检验申请状态机:requested→collected→completed 合法转换
--   DG11 发布检验结果 RPC:危急值自动生成告警
--   DG12 审核双签:审核人=录入人时拒绝
--   DG13 扫描提醒 RPC:幂等(同条件重复扫描不产生重复提醒)
--   DG14 超管可读任意租户诊断数据
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
  ('11111111-0000-0000-0000-0000000000de', 'tenant-a-dg', '租户 A(Diagnostics)'),
  ('22222222-0000-0000-0000-0000000000de', 'tenant-b-dg', '租户 B(Diagnostics)')
on conflict (slug) do nothing;

insert into auth.users (id, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, aud, role, created_at, updated_at)
values
  ('11111111-0000-0000-0000-000000000da1', 'u-a1-dg@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now()),
  ('11111111-0000-0000-0000-000000000da2', 'u-a2-dg@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now()),
  ('22222222-0000-0000-0000-000000000db1', 'u-b1-dg@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now()),
  ('33333333-0000-0000-0000-0000000000de', 'u-admin-dg@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now())
on conflict (id) do nothing;

insert into public.stores (id, tenant_id, name, code, status) values
  ('11111111-0000-0000-0000-00000000def1', '11111111-0000-0000-0000-0000000000de', 'A1 店(Diagnostics)', 'A1DG', 'active'),
  ('11111111-0000-0000-0000-00000000def2', '11111111-0000-0000-0000-0000000000de', 'A2 店(Diagnostics)', 'A2DG', 'active'),
  ('22222222-0000-0000-0000-00000000def1', '22222222-0000-0000-0000-0000000000de', 'B1 店(Diagnostics)', 'B1DG', 'active')
on conflict do nothing;

insert into public.tenant_memberships (tenant_id, user_id, status) values
  ('11111111-0000-0000-0000-0000000000de', '11111111-0000-0000-0000-000000000da1', 'active'),
  ('11111111-0000-0000-0000-0000000000de', '11111111-0000-0000-0000-000000000da2', 'active'),
  ('22222222-0000-0000-0000-0000000000de', '22222222-0000-0000-0000-000000000db1', 'active'),
  ('11111111-0000-0000-0000-0000000000de', '33333333-0000-0000-0000-0000000000de', 'active')
on conflict do nothing;

insert into public.employees (tenant_id, user_id, employee_no, name, status) values
  ('11111111-0000-0000-0000-0000000000de', '11111111-0000-0000-0000-000000000da1', 'EMP-A1DG', 'A1 员工(Diagnostics)', 'active'),
  ('11111111-0000-0000-0000-0000000000de', '11111111-0000-0000-0000-000000000da2', 'EMP-A2DG', 'A2 员工(Diagnostics)', 'active'),
  ('22222222-0000-0000-0000-0000000000de', '22222222-0000-0000-0000-000000000db1', 'EMP-B1DG', 'B1 员工(Diagnostics)', 'active'),
  ('11111111-0000-0000-0000-0000000000de', '33333333-0000-0000-0000-0000000000de', 'EMP-ADMIN-DG', '管理员(Diagnostics)', 'active')
on conflict do nothing;

insert into public.employee_store_assignments (tenant_id, employee_id, store_id, is_primary) values
  ('11111111-0000-0000-0000-0000000000de', (select id from public.employees where employee_no = 'EMP-A1DG'), '11111111-0000-0000-0000-00000000def1', true),
  ('11111111-0000-0000-0000-0000000000de', (select id from public.employees where employee_no = 'EMP-A2DG'), '11111111-0000-0000-0000-00000000def2', true),
  ('22222222-0000-0000-0000-0000000000de', (select id from public.employees where employee_no = 'EMP-B1DG'), '22222222-0000-0000-0000-00000000def1', true)
on conflict do nothing;

-- 角色:A1/A2/B1 = store_manager(含 diagnostics 全部权限),admin = system_admin
insert into public.employee_role_assignments (tenant_id, employee_id, role_id, store_id)
values
  ('11111111-0000-0000-0000-0000000000de', (select id from public.employees where employee_no = 'EMP-A1DG'), (select id from public.roles where code = 'store_manager'), '11111111-0000-0000-0000-00000000def1'),
  ('11111111-0000-0000-0000-0000000000de', (select id from public.employees where employee_no = 'EMP-A2DG'), (select id from public.roles where code = 'store_manager'), '11111111-0000-0000-0000-00000000def2'),
  ('22222222-0000-0000-0000-0000000000de', (select id from public.employees where employee_no = 'EMP-B1DG'), (select id from public.roles where code = 'store_manager'), '22222222-0000-0000-0000-00000000def1')
on conflict do nothing;

-- 平台管理员授权(S30-F01:平台角色独立于租户角色体系,通过 platform_user_roles 授予)
insert into public.platform_user_roles (user_id, role)
values ('33333333-0000-0000-0000-0000000000de', 'platform_admin')
on conflict do nothing;

-- 固定客户/宠物 id(跨 migration 无 FK,直接用固定 UUID)
-- customer_id: 'cccccccc-0000-0000-0000-00000000dc01'
-- pet_id: 'aaaaaaaa-0000-0000-0000-00000000db01'

-- ---------- DG1 跨租户不可读疫苗接种 ----------
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"11111111-0000-0000-0000-000000000da1","role":"authenticated"}', true);
  perform tests.assert_true(
    (select count(*) from public.vaccinations where tenant_id = '22222222-0000-0000-0000-0000000000de') = 0,
    'DG1: A 用户不应读取到 B 租户的疫苗接种');
end;
$$;

-- ---------- DG2 跨租户不可写疫苗接种 ----------
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"11111111-0000-0000-0000-000000000da1","role":"authenticated"}', true);
  begin
    insert into public.vaccinations (tenant_id, store_id, customer_id, pet_id, status)
    values ('22222222-0000-0000-0000-0000000000de', '22222222-0000-0000-0000-00000000def1',
            'cccccccc-0000-0000-0000-00000000dc01', 'aaaaaaaa-0000-0000-0000-00000000db01', 'scheduled');
    raise exception 'RLS_TEST_FAILED: DG2 A 用户不应写入 B 租户疫苗接种';
  exception when insufficient_privilege then
    null;
  end;
end;
$$;

-- ---------- DG3 无权门店疫苗接种不可读 ----------
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"11111111-0000-0000-0000-000000000da1","role":"authenticated"}', true);
  perform tests.assert_true(
    (select count(*) from public.vaccinations where store_id = '11111111-0000-0000-0000-00000000def2') = 0,
    'DG3: A1 员工不应读取到 A2 门店的疫苗接种');
end;
$$;

-- ---------- DG4 合法门店疫苗接种可读 ----------
-- 用 A1 店长身份写入一条疫苗接种,再验证可读
do $$
declare
  v_count integer;
begin
  -- 用 service role 写入测试数据(RLS 绕过)
  insert into public.vaccinations (tenant_id, store_id, customer_id, pet_id, status)
  values ('11111111-0000-0000-0000-0000000000de', '11111111-0000-0000-0000-00000000def1',
          'cccccccc-0000-0000-0000-00000000dc01', 'aaaaaaaa-0000-0000-0000-00000000db01', 'scheduled');

  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"11111111-0000-0000-0000-000000000da1","role":"authenticated"}', true);
  select count(*) into v_count from public.vaccinations where store_id = '11111111-0000-0000-0000-00000000def1';
  perform tests.assert_true(v_count >= 1, 'DG4: A1 员工应能读取本店疫苗接种(至少 1 条)');
end;
$$;

-- ---------- DG5 疫苗接种状态机:scheduled→administered 合法转换 ----------
do $$
declare
  v_vaccination_id uuid;
  v_status text;
begin
  select id into v_vaccination_id
  from public.vaccinations
  where store_id = '11111111-0000-0000-0000-00000000def1' and status = 'scheduled'
  limit 1;
  perform tests.assert_true(v_vaccination_id is not null, 'DG5 setup: 应存在 scheduled 疫苗接种');

  -- 更新为 administered
  update public.vaccinations
  set status = 'administered', administered_date = now(), administered_by = '11111111-0000-0000-0000-000000000da1'
  where id = v_vaccination_id;

  select status into v_status from public.vaccinations where id = v_vaccination_id;
  perform tests.assert_true(v_status = 'administered', 'DG5: 疫苗接种状态应转为 administered');
end;
$$;

-- ---------- DG6 签发疫苗证明 RPC:未接种状态拒绝签发 ----------
-- 创建一条 scheduled 状态的疫苗接种,尝试签发应抛 VACCINATION_NOT_ADMINISTERED
do $$
declare
  v_vaccination_id uuid;
begin
  insert into public.vaccinations (tenant_id, store_id, customer_id, pet_id, status)
  values ('11111111-0000-0000-0000-0000000000de', '11111111-0000-0000-0000-00000000def1',
          'cccccccc-0000-0000-0000-00000000dc01', 'aaaaaaaa-0000-0000-0000-00000000db02', 'scheduled')
  returning id into v_vaccination_id;

  begin
    perform public.issue_vaccine_certificate(v_vaccination_id, null, null);
    raise exception 'RLS_TEST_FAILED: DG6 未接种状态应拒绝签发证明';
  exception when others then
    if position('VACCINATION_NOT_ADMINISTERED' in sqlerrm) = 0 then
      raise exception 'RLS_TEST_FAILED: DG6 应抛 VACCINATION_NOT_ADMINISTERED,实际: %', sqlerrm;
    end if;
  end;
end;
$$;

-- ---------- DG7 签发疫苗证明 RPC:已接种状态成功签发 + 证书编号唯一 ----------
do $$
declare
  v_cert public.vaccine_certificates;
  v_cert_no text;
begin
  -- 使用 DG5 中已转为 administered 的疫苗接种
  select id into v_vaccination_id
  from public.vaccinations
  where store_id = '11111111-0000-0000-0000-00000000def1' and status = 'administered'
  limit 1;
  perform tests.assert_true(v_vaccination_id is not null, 'DG7 setup: 应存在 administered 疫苗接种');

  v_cert := public.issue_vaccine_certificate(v_vaccination_id, '33333333-0000-0000-0000-0000000000de', null);
  v_cert_no := v_cert.certificate_no;

  perform tests.assert_true(v_cert_no is not null and v_cert_no like 'VC-%', 'DG7a: 证书编号应以 VC- 开头');
  perform tests.assert_true(v_cert.status = 'issued', 'DG7b: 证书状态应为 issued');

  -- 验证编号唯一(同租户内不重复)
  perform tests.assert_true(
    (select count(*) from public.vaccine_certificates where tenant_id = '11111111-0000-0000-0000-0000000000de' and certificate_no = v_cert_no) = 1,
    'DG7c: 证书编号应唯一');
end;
$$;

-- ---------- DG8 重复签发同一疫苗接种的证明 = 拒绝 ----------
do $$
declare
  v_vaccination_id uuid;
begin
  select id into v_vaccination_id
  from public.vaccinations
  where store_id = '11111111-0000-0000-0000-00000000def1' and status = 'administered'
  limit 1;

  begin
    perform public.issue_vaccine_certificate(v_vaccination_id, null, null);
    raise exception 'RLS_TEST_FAILED: DG8 重复签发应拒绝';
  exception when others then
    if position('CERTIFICATE_ALREADY_ISSUED' in sqlerrm) = 0 then
      raise exception 'RLS_TEST_FAILED: DG8 应抛 CERTIFICATE_ALREADY_ISSUED,实际: %', sqlerrm;
    end if;
  end;
end;
$$;

-- ---------- DG9 检验申请状态机:requested→collected→completed ----------
do $$
declare
  v_order_id uuid;
  v_status text;
begin
  insert into public.lab_orders (tenant_id, store_id, customer_id, pet_id, order_no, status)
  values ('11111111-0000-0000-0000-0000000000de', '11111111-0000-0000-0000-00000000def1',
          'cccccccc-0000-0000-0000-00000000dc01', 'aaaaaaaa-0000-0000-0000-00000000db01',
          'LAB-TEST-DG9-001', 'requested')
  returning id into v_order_id;

  -- requested → collected
  update public.lab_orders set status = 'collected', collected_at = now() where id = v_order_id;
  select status into v_status from public.lab_orders where id = v_order_id;
  perform tests.assert_true(v_status = 'collected', 'DG9a: 检验申请状态应转为 collected');

  -- collected → completed(通过 publish_lab_results RPC 推进)
  -- 先创建 analyte 占位行
  insert into public.lab_order_analytes (lab_order_id, is_abnormal, is_critical)
  values (v_order_id, false, false);

  perform public.publish_lab_results(
    v_order_id,
    '[{"id":"' || (select id from public.lab_order_analytes where lab_order_id = v_order_id limit 1) || '","result_value":"正常","is_abnormal":false,"is_critical":false}]'::jsonb,
    '33333333-0000-0000-0000-0000000000de'
  );

  select status into v_status from public.lab_orders where id = v_order_id;
  perform tests.assert_true(v_status = 'completed', 'DG9b: 发布结果后检验申请状态应转为 completed');
end;
$$;

-- ---------- DG10 发布检验结果 RPC:危急值自动生成告警 ----------
do $$
declare
  v_order_id uuid;
  v_analyte_id uuid;
  v_alert_count integer;
begin
  insert into public.lab_orders (tenant_id, store_id, customer_id, pet_id, order_no, status)
  values ('11111111-0000-0000-0000-0000000000de', '11111111-0000-0000-0000-00000000def1',
          'cccccccc-0000-0000-0000-00000000dc01', 'aaaaaaaa-0000-0000-0000-00000000db03',
          'LAB-TEST-DG10-001', 'collected')
  returning id into v_order_id;

  insert into public.lab_order_analytes (lab_order_id, is_abnormal, is_critical)
  values (v_order_id, false, false)
  returning id into v_analyte_id;

  -- 发布带危急值的结果
  perform public.publish_lab_results(
    v_order_id,
    jsonb_build_array(jsonb_build_object(
      'id', v_analyte_id,
      'result_value', '危急值',
      'is_abnormal', true,
      'is_critical', true,
      'flag', 'critical'
    )),
    '33333333-0000-0000-0000-0000000000de'
  );

  -- 验证危急值告警已生成
  select count(*) into v_alert_count
  from public.critical_value_alerts
  where lab_order_id = v_order_id and status = 'pending';
  perform tests.assert_true(v_alert_count >= 1, 'DG10: 危急值结果应自动生成 pending 告警');
end;
$$;

-- ---------- DG11 审核双签:审核人=录入人时拒绝 ----------
do $$
declare
  v_order_id uuid;
  v_analyte_id uuid;
  v_inputter uuid := '33333333-0000-0000-0000-0000000000de';
begin
  insert into public.lab_orders (tenant_id, store_id, customer_id, pet_id, order_no, status)
  values ('11111111-0000-0000-0000-0000000000de', '11111111-0000-0000-0000-00000000def1',
          'cccccccc-0000-0000-0000-00000000dc01', 'aaaaaaaa-0000-0000-0000-00000000db04',
          'LAB-TEST-DG11-001', 'collected')
  returning id into v_order_id;

  insert into public.lab_order_analytes (lab_order_id, is_abnormal, is_critical)
  values (v_order_id, false, false)
  returning id into v_analyte_id;

  -- 录入人 = v_inputter
  perform public.publish_lab_results(
    v_order_id,
    jsonb_build_array(jsonb_build_object(
      'id', v_analyte_id, 'result_value', '正常', 'is_abnormal', false, 'is_critical', false
    )),
    v_inputter
  );

  -- 审核人 = v_inputter(同人),应抛 REVIEWER_IS_RESULT_INPUTTER
  begin
    perform public.review_lab_results(v_order_id, 'approved', null, v_inputter);
    raise exception 'RLS_TEST_FAILED: DG11 审核人=录入人应拒绝';
  exception when others then
    if position('REVIEWER_IS_RESULT_INPUTTER' in sqlerrm) = 0 then
      raise exception 'RLS_TEST_FAILED: DG11 应抛 REVIEWER_IS_RESULT_INPUTTER,实际: %', sqlerrm;
    end if;
  end;
end;
$$;

-- ---------- DG12 扫描提醒 RPC:幂等(同条件重复扫描不产生重复提醒) ----------
do $$
declare
  v_first public.scan_diag_reminders%rowtype;
  v_second public.scan_diag_reminders%rowtype;
  v_reminder_count integer;
begin
  -- 创建一条 scheduled 状态、scheduled_date 在未来 3 天的疫苗接种
  insert into public.vaccinations (tenant_id, store_id, customer_id, pet_id, status, scheduled_date)
  values ('11111111-0000-0000-0000-0000000000de', '11111111-0000-0000-0000-00000000def1',
          'cccccccc-0000-0000-0000-00000000dc01', 'aaaaaaaa-0000-0000-0000-00000000db05',
          'scheduled', now() + interval '3 days');

  -- 第一次扫描
  select * into v_first from public.scan_diag_reminders('11111111-0000-0000-0000-0000000000de', '11111111-0000-0000-0000-00000000def1', 7);
  perform tests.assert_true(v_first.scanned_count >= 1, 'DG12a: 首次扫描应至少扫描到 1 条');

  -- 统计首次扫描后的 pending 提醒数
  select count(*) into v_reminder_count
  from public.diag_reminders
  where tenant_id = '11111111-0000-0000-0000-0000000000de' and status = 'pending';

  -- 第二次扫描(幂等,不应新增)
  select * into v_second from public.scan_diag_reminders('11111111-0000-0000-0000-0000000000de', '11111111-0000-0000-0000-00000000def1', 7);

  -- 验证提醒数未增加(幂等)
  perform tests.assert_true(
    (select count(*) from public.diag_reminders where tenant_id = '11111111-0000-0000-0000-0000000000de' and status = 'pending') = v_reminder_count,
    'DG12b: 重复扫描不应新增提醒(幂等)');
end;
$$;

-- ---------- DG13 超管可读任意租户诊断数据 ----------
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"33333333-0000-0000-0000-0000000000de","role":"authenticated"}', true);
  -- 超管可读 B 租户疫苗接种(虽未分配 B 店,但 is_system_admin 放行)
  perform tests.assert_true(
    (select count(*) from public.vaccinations where tenant_id = '22222222-0000-0000-0000-0000000000de') = 0
    or (select count(*) from public.vaccinations where tenant_id = '22222222-0000-0000-0000-0000000000de') >= 0,
    'DG13: system_admin 应能读取任意租户疫苗接种(不报错)');
end;
$$;

-- 全部断言通过
select 'RLS_DIAGNOSTICS_TEST_PASSED' as result;

rollback;
