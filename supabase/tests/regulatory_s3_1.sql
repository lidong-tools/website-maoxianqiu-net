-- ============================================================
-- 监管运营测试:S3.1-PARALLEL-01 / S31-MERGE-B(动物诊疗许可证 / 年度报告 / 疫情事件 / 医疗废弃物)
--
-- 验证 migration 31(regulatory_base)+ 32(regulatory_rpc)+ 34(regulatory_fix):
--   - 权限码 seed + 角色授权矩阵(system_admin 全量 / store_manager 8 项 /
--     doctor 5 项,不授 license.manage / regulatory_report.submit / waste.manage)
--   - 4 张新表 RLS 只读策略(租户成员 + 门店范围 + 权限码;无权限用户不可见)
--   - save_institution_license:新增/编辑/证号唯一/已注销禁编辑 + 版本快照 + 审计
--     B02:certificate_file_id 跨租户/门店/状态校验(FILE_SCOPE_MISMATCH)
--     B07:update 分支 before/after 真实 + audit user_id 由 employee 解析
--   - change_license_status:状态流转/重复状态拒绝 + status_change 版本 + 审计
--     B05:状态机终态(revoked/expired)不可普通复活(INVALID_LICENSE_TRANSITION)
--   - generate_regulatory_report:快照固化/重新生成 upsert/已提交禁生成 + 审计
--     B01:jsonb_each alias / species alias / 兽医数 store-scoped
--   - submit_regulatory_report:仅 generated 可提交;authenticated 无 execute 权限
--     (service-role-only,前端只能走 Hono) + 审计
--   - save_epidemic_event:创建/上报/非法状态/已隔离禁编辑 + 审计
--     B02:customer/pet/encounter 跨租户校验(CUSTOMER_SCOPE_MISMATCH /
--          PET_SCOPE_MISMATCH / ENCOUNTER_SCOPE_MISMATCH / RELATED_ENTITY_MISMATCH)
--     B06:状态机禁止 reported -> detected 回退;audit action 区分
--          epidemic.detect / epidemic.update / epidemic.report
--   - isolate_epidemic_event / resolve_epidemic_event:状态机 + 审计
--     epidemic.isolate / epidemic.resolve
--   - save_waste_record:创建/维护/负数量拒绝/已交接禁编辑 + 审计
--     B02:attachment_file_id 跨租户/门店/状态校验(FILE_SCOPE_MISMATCH)
--   - handover_waste:接收方必填/重复交接拒绝 + 审计
--   - 操作人一律服务端推导(RPC 内部按 employee 校验租户归属,不做跨租户)
--
-- 本文件独立可执行(psql "$DATABASE_URL" -f supabase/tests/regulatory_s3_1.sql):
--   - 自建 tests.assert_* 断言函数,不依赖其他测试文件;
--   - 单一事务 begin/rollback,无任何残留;
--   - 每个 DO 块以 execute 'reset role' 回到连接角色(RPC 业务断言),
--     RLS/权限断言使用 set local role authenticated + jwt claims。
--
-- B04 修复说明:
--   * UUID 仅使用合法 hex(0-9a-f):店长用户 m1->e1、店长员工 m2->e2、
--     无权限用户 o1->f1、无权限员工 o2->f2(m/o 超 hex 范围);
--   * encounters.doctor_id 引用 auth.users.id(临床 schema),测试填对应用户
--     id(医生 d1),不再填 employee.id;
--   * 新增测试:unauthorized submit FAIL / cross-tenant epidemic relation FAIL /
--     cross-tenant file relation FAIL / license 终态不可复活 / epidemic 回退拒绝 /
--     audit before/after / audit user identity / 兽医数 store-scoped。
-- ============================================================

begin;

create schema if not exists tests;
grant usage on schema tests to authenticated, anon, service_role;

create or replace function tests.assert_true(cond boolean, msg text)
returns void
language plpgsql as $$
begin
  if not cond then
    raise exception 'REGULATORY_TEST_FAILED: %', msg;
  end if;
end;
$$;

-- 期望:SQL 执行抛出包含指定文本的错误;无异常/不含文本均判失败
create or replace function tests.assert_raises(p_sql text, p_expected text, p_name text)
returns void
language plpgsql as $$
declare
  v_msg text;
begin
  begin
    execute p_sql;
  exception when others then
    v_msg := sqlerrm;
  end;
  if v_msg is null or position(p_expected in coalesce(v_msg, '')) = 0 then
    raise exception 'REGULATORY_TEST_FAILED: % 应抛出含 % 的错误,实际: %',
      p_name, p_expected, coalesce(v_msg, '无异常(调用成功)');
  end if;
end;
$$;

-- ============================================================
-- 夹具:租户/门店/用户/员工/客户/宠物/就诊/备案/文件
-- 租户 A:99999999-0000-0000-0000-000000000031(主测试租户)
-- 门店 A:99999999-0000-0000-0000-000000000032
-- 门店 A2:99999999-0000-0000-0000-000000000033(兽医数 store-scoped 断言用)
-- 租户 B:99999999-0000-0000-0000-000000000041(跨租户负向测试)
-- 门店 B:99999999-0000-0000-0000-000000000042
-- 用户/员工(全合法 hex):
--   医生 d1 / 店长 e1 / 无权限 f1 / 兽医2 d4 / 租户B用户 f4
--   员工 d2(医生)/ e2(店长)/ f2(无权限)/ d3(门店33兽医)/ f5(租户B)
-- ============================================================
insert into public.tenants (id, slug, name)
values
  ('99999999-0000-0000-0000-000000000031', 's31-reg-tenant', '监管测试租户'),
  ('99999999-0000-0000-0000-000000000041', 's31-reg-tenant-b', '监管测试租户B')
on conflict (slug) do nothing;
insert into public.stores (id, tenant_id, name, code, status)
values
  ('99999999-0000-0000-0000-000000000032', '99999999-0000-0000-0000-000000000031', '监管测试门店', 'REG32', 'active'),
  ('99999999-0000-0000-0000-000000000033', '99999999-0000-0000-0000-000000000031', '监管测试门店2', 'REG33', 'active'),
  ('99999999-0000-0000-0000-000000000042', '99999999-0000-0000-0000-000000000041', '监管测试门店B', 'REGB42', 'active')
on conflict (id) do nothing;

-- 用户(encounters.doctor_id / employees.user_id / audit user_id 均指向 auth.users.id)
insert into auth.users (id, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, aud, role, created_at, updated_at)
values
  ('99999999-0000-0000-0000-0000000000d1', 's31-reg-doctor@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now()),
  ('99999999-0000-0000-0000-0000000000e1', 's31-reg-manager@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now()),
  ('99999999-0000-0000-0000-0000000000f1', 's31-reg-outsider@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now()),
  ('99999999-0000-0000-0000-0000000000d4', 's31-reg-vet2@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now()),
  ('99999999-0000-0000-0000-0000000000f4', 's31-reg-tenantb@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now())
on conflict (id) do nothing;

-- 员工(user_id 与 auth.users 对应;唯一约束 tenant_id + employee_no)
insert into public.employees (id, tenant_id, user_id, employee_no, name, status)
values
  ('99999999-0000-0000-0000-0000000000d2', '99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-0000000000d1', 'REG-DOC', '监管测试兽医', 'active'),
  ('99999999-0000-0000-0000-0000000000e2', '99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-0000000000e1', 'REG-MGR', '监管测试店长', 'active'),
  ('99999999-0000-0000-0000-0000000000f2', '99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-0000000000f1', 'REG-OUT', '监管测试无权限', 'active'),
  ('99999999-0000-0000-0000-0000000000d3', '99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-0000000000d4', 'REG-DOC2', '监管测试兽医2', 'active'),
  ('99999999-0000-0000-0000-0000000000f5', '99999999-0000-0000-0000-000000000041', '99999999-0000-0000-0000-0000000000f4', 'REGB-MGR', '监管测试店长B', 'active')
on conflict (id) do nothing;

-- 租户成员关系(RLS is_tenant_member 依赖)
insert into public.tenant_memberships (tenant_id, user_id, status)
values
  ('99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-0000000000d1', 'active'),
  ('99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-0000000000e1', 'active'),
  ('99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-0000000000f1', 'active'),
  ('99999999-0000-0000-0000-000000000041', '99999999-0000-0000-0000-0000000000f4', 'active')
on conflict (tenant_id, user_id) do nothing;

-- 员工门店分配(RLS can_access_store 依赖;d3 只属门店33,用于 store-scoped 断言)
insert into public.employee_store_assignments (tenant_id, employee_id, store_id, is_primary)
values
  ('99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-0000000000d2', '99999999-0000-0000-0000-000000000032', true),
  ('99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-0000000000e2', '99999999-0000-0000-0000-000000000032', true),
  ('99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-0000000000f2', '99999999-0000-0000-0000-000000000032', true),
  ('99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-0000000000d3', '99999999-0000-0000-0000-000000000033', true)
on conflict (employee_id, store_id) do nothing;

-- 角色分配:医生/店长(has_permission 依赖 roles.permissions 数组,migration 31 已更新)
insert into public.employee_role_assignments (tenant_id, employee_id, role_id, store_id)
values
  ('99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-0000000000d2',
   (select id from public.roles where code = 'doctor'), '99999999-0000-0000-0000-000000000032'),
  ('99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-0000000000e2',
   (select id from public.roles where code = 'store_manager'), '99999999-0000-0000-0000-000000000032')
on conflict do nothing;

-- 执业兽医备案(B01 兽医数 store-scoped 依赖;license_no 按租户唯一)
insert into public.veterinarian_registrations (tenant_id, employee_id, license_no, registration_no, valid_from, valid_until, status)
values
  ('99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-0000000000d2', 'REG-VET-001', 'REG-REG-001', date '2024-01-01', null, 'active'),
  ('99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-0000000000d3', 'REG-VET-002', 'REG-REG-002', date '2024-01-01', null, 'active')
on conflict (tenant_id, license_no) do nothing;

-- 客户/宠物/就诊(A 租户:年度报告与疫情事件统计载体;doctor_id 填 auth user id d1)
insert into public.customers (id, tenant_id, store_id, customer_no, name, status)
values
  ('99999999-0000-0000-0000-0000000000c1', '99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-000000000032', 'REG-CUST-001', '监管测试客户', 'active'),
  ('99999999-0000-0000-0000-0000000000e8', '99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-000000000032', 'REG-CUST-002', '监管测试客户2', 'active'),
  ('99999999-0000-0000-0000-0000000000f6', '99999999-0000-0000-0000-000000000041', '99999999-0000-0000-0000-000000000042', 'REGB-CUST-001', '监管测试客户B', 'active')
on conflict (id) do nothing;
insert into public.pets (id, tenant_id, customer_id, name, species, status)
values
  ('99999999-0000-0000-0000-0000000000c2', '99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-0000000000c1', '监管测试宠物', 'dog', 'active'),
  ('99999999-0000-0000-0000-0000000000e9', '99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-0000000000e8', '监管测试宠物2', 'cat', 'active'),
  ('99999999-0000-0000-0000-0000000000f7', '99999999-0000-0000-0000-000000000041', '99999999-0000-0000-0000-0000000000f6', '监管测试宠物B', 'rabbit', 'active')
on conflict (id) do nothing;
insert into public.encounters (id, tenant_id, store_id, customer_id, pet_id, doctor_id, status, started_at, chief_complaint)
values
  ('99999999-0000-0000-0000-0000000000c3', '99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-000000000032',
   '99999999-0000-0000-0000-0000000000c1', '99999999-0000-0000-0000-0000000000c2',
   '99999999-0000-0000-0000-0000000000d1', 'in_progress', now() - interval '1 hour', '监管测试主诉'),
  ('99999999-0000-0000-0000-0000000000f8', '99999999-0000-0000-0000-000000000041', '99999999-0000-0000-0000-000000000042',
   '99999999-0000-0000-0000-0000000000f6', '99999999-0000-0000-0000-0000000000f7',
   '99999999-0000-0000-0000-0000000000f4', 'in_progress', now() - interval '2 hours', '监管测试主诉B')
on conflict (id) do nothing;

-- 文件(license/waste 附件跨租户校验载体;status='uploaded' 才可用)
insert into public.files (id, tenant_id, store_id, bucket, object_key, original_name, mime_type, size_bytes, status)
values
  ('99999999-0000-0000-0000-0000000000fa', '99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-000000000032', 'private', 's31-reg/license-a.png', 'license-a.png', 'image/png', 1024, 'uploaded'),
  ('99999999-0000-0000-0000-0000000000f9', '99999999-0000-0000-0000-000000000041', '99999999-0000-0000-0000-000000000042', 'private', 's31-reg/attachment-b.png', 'attachment-b.png', 'image/png', 1024, 'uploaded')
on conflict (id) do nothing;

-- ============================================================
-- Part 1:权限码 seed + 角色授权矩阵
-- ============================================================
do $$
declare
  v_cnt integer;
begin
  execute 'reset role';
  select count(*) into v_cnt from public.permissions
  where code in (
    'license.read', 'license.manage',
    'regulatory_report.read', 'regulatory_report.generate', 'regulatory_report.submit',
    'epidemic.read', 'epidemic.report', 'epidemic.resolve',
    'waste.read', 'waste.manage'
  );
  perform tests.assert_true(v_cnt = 10, 'migration 31 应注册 10 个监管权限码');
end;
$$;

-- 权限矩阵(has_permission 依赖 roles.permissions 数组)
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"99999999-0000-0000-0000-0000000000d1","role":"authenticated"}', true);
  -- 医生:只读 + 疫情上报;不授 license.manage / regulatory_report.submit / waste.manage
  perform tests.assert_true(public.has_permission('99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-000000000032', 'license.read'), '医生应持有 license.read');
  perform tests.assert_true(not public.has_permission('99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-000000000032', 'license.manage'), '医生不应持有 license.manage');
  perform tests.assert_true(not public.has_permission('99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-000000000032', 'regulatory_report.submit'), '医生不应持有 regulatory_report.submit');
  perform tests.assert_true(not public.has_permission('99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-000000000032', 'waste.manage'), '医生不应持有 waste.manage');
  perform tests.assert_true(public.has_permission('99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-000000000032', 'epidemic.report'), '医生应持有 epidemic.report');
  perform tests.assert_true(not public.has_permission('99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-000000000032', 'epidemic.resolve'), '医生不应持有 epidemic.resolve');
end;
$$;

do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"99999999-0000-0000-0000-0000000000e1","role":"authenticated"}', true);
  -- 店长:许可证/废弃物全权、疫情全流程;不授报告 generate/submit
  perform tests.assert_true(public.has_permission('99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-000000000032', 'license.manage'), '店长应持有 license.manage');
  perform tests.assert_true(public.has_permission('99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-000000000032', 'waste.manage'), '店长应持有 waste.manage');
  perform tests.assert_true(public.has_permission('99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-000000000032', 'epidemic.resolve'), '店长应持有 epidemic.resolve');
  perform tests.assert_true(not public.has_permission('99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-000000000032', 'regulatory_report.generate'), '店长不应持有 regulatory_report.generate');
  perform tests.assert_true(not public.has_permission('99999999-0000-0000-0000-000000000031', '99999999-0000-0000-0000-000000000032', 'regulatory_report.submit'), '店长不应持有 regulatory_report.submit');
end;
$$;

-- ============================================================
-- Part 2:动物诊疗许可证 save_institution_license / change_license_status
--   B02: FILE_SCOPE_MISMATCH(跨租户文件)
--   B05: 终态(revoked)不可普通复活
--   B07: before/after 真实 + audit user_id 两层追溯
-- ============================================================
do $$
declare
  v_lic public.institution_licenses;
  v_ver_cnt integer;
  v_audit_cnt integer;
  v_audit_user uuid;
  v_before_scope text;
  v_after_scope text;
begin
  execute 'reset role';
  -- 新增(带本租户合法证照附件):创建版本 1 + license.create 审计 + user_id 两层追溯
  select * into v_lic from public.save_institution_license(
    p_tenant_id => '99999999-0000-0000-0000-000000000031'::uuid,
    p_store_id => '99999999-0000-0000-0000-000000000032'::uuid,
    p_license_no => 'REG-LIC-001',
    p_issuing_authority => '测试发证机关',
    p_diagnosis_scope => '犬猫内科',
    p_issued_at => current_date,
    p_valid_from => current_date,
    p_valid_until => (current_date + interval '3 years')::date,
    p_status => 'active',
    p_certificate_file_id => '99999999-0000-0000-0000-0000000000fa'::uuid,
    p_operator_employee_id => '99999999-0000-0000-0000-0000000000e2'::uuid);
  perform tests.assert_true(v_lic.id is not null, '许可证新增应成功');
  perform tests.assert_true(v_lic.status = 'active', '许可证初始状态应为 active');

  select count(*) into v_ver_cnt from public.institution_license_versions where license_id = v_lic.id;
  perform tests.assert_true(v_ver_cnt = 1, '新增许可证应创建 1 条版本记录');
  select count(*) into v_audit_cnt from public.audit_logs
  where action = 'license.create' and entity_type = 'institution_license' and entity_id = v_lic.id::text;
  perform tests.assert_true(v_audit_cnt = 1, '新增许可证应写 license.create 审计');
  -- B07:audit user_id 由 operator employee(e2) 解析到 auth user(e1),两层追溯
  select user_id into v_audit_user from public.audit_logs
  where action = 'license.create' and entity_type = 'institution_license' and entity_id = v_lic.id::text;
  perform tests.assert_true(v_audit_user = '99999999-0000-0000-0000-0000000000e1'::uuid,
    '审计应记录操作人 auth user_id(employee e2 -> user e1)');

  -- B02:跨租户文件拒绝(Tenant A 许可证 + Tenant B 文件 -> FILE_SCOPE_MISMATCH)
  perform tests.assert_raises(
    $sql$select public.save_institution_license('99999999-0000-0000-0000-000000000031'::uuid, '99999999-0000-0000-0000-000000000032'::uuid, null, 'REG-LIC-B01', null, null, null, null, null, 'draft', '99999999-0000-0000-0000-0000000000f9'::uuid, null, '99999999-0000-0000-0000-0000000000e2'::uuid)$sql$,
    'FILE_SCOPE_MISMATCH', '跨租户证照附件应被拒绝');

  -- 证号唯一:同一门店同一证号拒绝
  perform tests.assert_raises(
    $sql$select public.save_institution_license('99999999-0000-0000-0000-000000000031'::uuid, '99999999-0000-0000-0000-000000000032'::uuid, null, 'REG-LIC-001', null, null, null, null, null, 'draft', null, null, '99999999-0000-0000-0000-0000000000e2'::uuid)$sql$,
    'LICENSE_DUPLICATE', '同一门店同一证号重复应拒绝');

  -- 编辑:追加版本 2 + license.update 审计;before/after 真实
  select * into v_lic from public.save_institution_license(
    p_tenant_id => '99999999-0000-0000-0000-000000000031'::uuid,
    p_store_id => '99999999-0000-0000-0000-000000000032'::uuid,
    p_license_id => v_lic.id,
    p_license_no => 'REG-LIC-001',
    p_diagnosis_scope => '犬猫内科/外科',
    p_status => 'active',
    p_operator_employee_id => '99999999-0000-0000-0000-0000000000e2'::uuid);
  select count(*) into v_ver_cnt from public.institution_license_versions where license_id = v_lic.id;
  perform tests.assert_true(v_ver_cnt = 2, '编辑许可证应追加第 2 条版本记录');
  select count(*) into v_audit_cnt from public.audit_logs
  where action = 'license.update' and entity_type = 'institution_license' and entity_id = v_lic.id::text;
  perform tests.assert_true(v_audit_cnt = 1, '编辑许可证应写 license.update 审计');
  -- B07:before 为旧行、after 为新行,两者不同
  select metadata->'before'->>'diagnosis_scope' into v_before_scope from public.audit_logs
  where action = 'license.update' and entity_type = 'institution_license' and entity_id = v_lic.id::text;
  select metadata->'after'->>'diagnosis_scope' into v_after_scope from public.audit_logs
  where action = 'license.update' and entity_type = 'institution_license' and entity_id = v_lic.id::text;
  perform tests.assert_true(v_before_scope = '犬猫内科' and v_after_scope = '犬猫内科/外科',
    'license.update 审计 before/after 应真实(旧值≠新值)');

  -- 空证号拒绝
  perform tests.assert_raises(
    $sql$select public.save_institution_license('99999999-0000-0000-0000-000000000031'::uuid, '99999999-0000-0000-0000-000000000032'::uuid, null, '', null, null, null, null, null, 'draft', null, null, '99999999-0000-0000-0000-0000000000e2'::uuid)$sql$,
    'LICENSE_NO_REQUIRED', '空证号应拒绝');

  -- 非法状态拒绝
  perform tests.assert_raises(
    $sql$select public.save_institution_license('99999999-0000-0000-0000-000000000031'::uuid, '99999999-0000-0000-0000-000000000032'::uuid, null, 'REG-LIC-002', null, null, null, null, null, 'bogus', null, null, '99999999-0000-0000-0000-0000000000e2'::uuid)$sql$,
    'INVALID_LICENSE_STATUS', '非法许可证状态应拒绝');
end;
$$;

do $$
declare
  v_lic public.institution_licenses;
  v_ver_cnt integer;
  v_audit_cnt integer;
begin
  execute 'reset role';
  select * into v_lic from public.institution_licenses where license_no = 'REG-LIC-001';

  -- 状态流转:active → suspended,追加 status_change 版本 + 审计
  select * into v_lic from public.change_license_status(
    v_lic.id, 'suspended', '99999999-0000-0000-0000-0000000000e2'::uuid);
  perform tests.assert_true(v_lic.status = 'suspended', '状态变更后应为 suspended');
  select count(*) into v_ver_cnt from public.institution_license_versions where license_id = v_lic.id;
  perform tests.assert_true(v_ver_cnt = 3, '状态变更应追加第 3 条版本记录');
  select count(*) into v_audit_cnt from public.audit_logs
  where action = 'license.status_change' and entity_type = 'institution_license' and entity_id = v_lic.id::text;
  perform tests.assert_true(v_audit_cnt = 1, '状态变更应写 license.status_change 审计');

  -- 重复状态拒绝
  perform tests.assert_raises(
    format($sql$select public.change_license_status('%s'::uuid, 'suspended', '99999999-0000-0000-0000-0000000000e2'::uuid)$sql$, v_lic.id),
    'LICENSE_STATUS_UNCHANGED', '相同状态变更应拒绝');

  -- 非法状态拒绝
  perform tests.assert_raises(
    format($sql$select public.change_license_status('%s'::uuid, 'bogus', '99999999-0000-0000-0000-0000000000e2'::uuid)$sql$, v_lic.id),
    'INVALID_LICENSE_STATUS', '非法目标状态应拒绝');

  -- 跨租户操作员拒绝
  perform tests.assert_raises(
    format($sql$select public.change_license_status('%s'::uuid, 'active', '99999999-0000-0000-0000-0000000000a1'::uuid)$sql$, v_lic.id),
    'OPERATOR_NOT_FOUND', '跨租户操作员应被拒绝');

  -- 注销(suspended → revoked 合法,进入终态)
  perform public.change_license_status(v_lic.id, 'revoked', '99999999-0000-0000-0000-0000000000e2'::uuid);
  -- B05:终态(revoked)禁止普通复活(revoked → active)
  perform tests.assert_raises(
    format($sql$select public.change_license_status('%s'::uuid, 'active', '99999999-0000-0000-0000-0000000000e2'::uuid)$sql$, v_lic.id),
    'INVALID_LICENSE_TRANSITION', '终态(revoked)禁止普通复活');

  -- 注销后禁止编辑
  perform tests.assert_raises(
    format($sql$select public.save_institution_license('99999999-0000-0000-0000-000000000031'::uuid, '99999999-0000-0000-0000-000000000032'::uuid, '%s'::uuid, 'REG-LIC-001', null, null, null, null, null, 'active', null, null, '99999999-0000-0000-0000-0000000000e2'::uuid)$sql$, v_lic.id),
    'LICENSE_NOT_EDITABLE', '已注销许可证禁止编辑');
end;
$$;

-- ============================================================
-- Part 3:年度动物诊疗活动报告 generate / submit
--   B01: 兽医数 store-scoped(门店32 报告不含门店33 备案兽医)
--   B04: unauthorized submit FAIL(authenticated 无 execute 权限)
-- ============================================================
do $$
declare
  v_rep public.annual_regulatory_reports;
  v_snap jsonb;
  v_stats jsonb;
begin
  execute 'reset role';
  select * into v_rep from public.generate_regulatory_report(
    p_tenant_id => '99999999-0000-0000-0000-000000000031'::uuid,
    p_store_id => '99999999-0000-0000-0000-000000000032'::uuid,
    p_report_year => 2026,
    p_operator_employee_id => '99999999-0000-0000-0000-0000000000e2'::uuid);
  perform tests.assert_true(v_rep.id is not null, '年度报告生成应成功');
  perform tests.assert_true(v_rep.status = 'generated', '生成后状态应为 generated');
  perform tests.assert_true(v_rep.report_snapshot is not null, '生成应固化 report_snapshot');

  v_snap := v_rep.report_snapshot;
  perform tests.assert_true(jsonb_typeof(v_snap->'stats') = 'object', '快照应包含 stats 统计对象');
  v_stats := v_snap->'stats';
  perform tests.assert_true(v_stats ? 'encounter_count' and v_stats ? 'doctor_count'
                        and v_stats ? 'registered_veterinarian_count' and v_stats ? 'species_distribution'
                        and v_stats ? 'prescription_count' and v_stats ? 'epidemic_event_count'
                        and v_stats ? 'medical_waste_summary', '快照 stats 应包含全部 7 个统计口径');
  perform tests.assert_true(jsonb_typeof(v_snap->'unavailable_fields') = 'array',
                        '快照应标记 unavailable_fields(数组,值可空)');
  perform tests.assert_true((v_snap->'store'->>'store_id') = '99999999-0000-0000-0000-000000000032',
                        '快照应记录门店归属');

  -- B01:注册兽医数只统计目标门店(门店33 的 d3 备案不计入门店32)
  perform tests.assert_true((v_stats->>'registered_veterinarian_count')::int = 1,
    '注册兽医数应只统计目标门店(store-scoped,不含门店33 备案)');
  -- B01:物种分布引用子查询 alias(encounter 仅 c3/dog)
  perform tests.assert_true((v_stats->'species_distribution'->>'dog')::int = 1,
    '物种分布应正确统计 dog=1');

  -- 重新生成 upsert:同一年度仍为 generated,不产生重复行
  perform public.generate_regulatory_report(
    p_tenant_id => '99999999-0000-0000-0000-000000000031'::uuid,
    p_store_id => '99999999-0000-0000-0000-000000000032'::uuid,
    p_report_year => 2026,
    p_operator_employee_id => '99999999-0000-0000-0000-0000000000e2'::uuid);
  perform tests.assert_true(
    (select count(*) from public.annual_regulatory_reports
     where tenant_id = '99999999-0000-0000-0000-000000000031'
       and store_id = '99999999-0000-0000-0000-000000000032'
       and report_year = 2026) = 1,
    '同年度重复生成应 upsert 而非新增行');

  -- 非法年份拒绝
  perform tests.assert_raises(
    $sql$select public.generate_regulatory_report('99999999-0000-0000-0000-000000000031'::uuid, '99999999-0000-0000-0000-000000000032'::uuid, 1999, '99999999-0000-0000-0000-0000000000e2'::uuid)$sql$,
    'INVALID_REPORT_YEAR', '非法报告年份应拒绝');
end;
$$;

do $$
declare
  v_rep public.annual_regulatory_reports;
  v_audit_cnt integer;
  v_rep_id uuid;
begin
  execute 'reset role';
  select * into v_rep from public.annual_regulatory_reports
  where tenant_id = '99999999-0000-0000-0000-000000000031'
    and store_id = '99999999-0000-0000-0000-000000000032'
    and report_year = 2026;

  -- 提交:generated → submitted + 审计
  select * into v_rep from public.submit_regulatory_report(
    v_rep.id, '99999999-0000-0000-0000-0000000000e2'::uuid);
  perform tests.assert_true(v_rep.status = 'submitted', '提交后状态应为 submitted');
  perform tests.assert_true(v_rep.submitted_at is not null, '提交应记录 submitted_at');
  select count(*) into v_audit_cnt from public.audit_logs
  where action = 'regulatory_report.submit' and entity_type = 'annual_regulatory_report' and entity_id = v_rep.id::text;
  perform tests.assert_true(v_audit_cnt = 1, '提交应写 regulatory_report.submit 审计');

  -- 已提交后再次生成拒绝(防覆盖已提交历史)
  perform tests.assert_raises(
    format($sql$select public.generate_regulatory_report('99999999-0000-0000-0000-000000000031'::uuid, '99999999-0000-0000-0000-000000000032'::uuid, 2026, '99999999-0000-0000-0000-0000000000e2'::uuid)$sql$, v_rep.id),
    'REPORT_ALREADY_SUBMITTED', '已提交年度报告禁止重新生成');

  -- 已提交状态不可再次提交
  perform tests.assert_raises(
    format($sql$select public.submit_regulatory_report('%s'::uuid, '99999999-0000-0000-0000-0000000000e2'::uuid)$sql$, v_rep.id),
    'REPORT_NOT_GENERATED', '非 generated 状态报告禁止提交');

  -- B04:unauthorized submit FAIL(authenticated 角色对 submit RPC 无 execute 权限,
  --     前端只能经 Hono service-role 通道调用,SQL 层 service-role-only 兜底)
  v_rep_id := v_rep.id;
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"99999999-0000-0000-0000-0000000000d1","role":"authenticated"}', true);
  perform tests.assert_raises(
    format($sql$select public.submit_regulatory_report('%s'::uuid, '99999999-0000-0000-0000-0000000000d2'::uuid)$sql$, v_rep_id),
    'permission denied', '无权限用户直接调用 submit RPC 应被拒绝');
end;
$$;

-- ============================================================
-- Part 4:疫情事件台账 save / isolate / resolve
--   B02: customer/pet/encounter 跨租户拒绝
--   B06: 禁止 reported -> detected 回退;audit action 区分 detect/update/report
-- ============================================================
do $$
declare
  v_ev public.epidemic_events;
  v_audit_cnt integer;
begin
  execute 'reset role';
  -- 创建 detected:epidemic.detect 审计(创建即上报才是 epidemic.report)
  select * into v_ev from public.save_epidemic_event(
    p_tenant_id => '99999999-0000-0000-0000-000000000031'::uuid,
    p_store_id => '99999999-0000-0000-0000-000000000032'::uuid,
    p_customer_id => '99999999-0000-0000-0000-0000000000c1'::uuid,
    p_pet_id => '99999999-0000-0000-0000-0000000000c2'::uuid,
    p_encounter_id => '99999999-0000-0000-0000-0000000000c3'::uuid,
    p_suspected_disease => '犬瘟热(疑似)',
    p_detected_at => now() - interval '1 hour',
    p_isolation_required => true,
    p_treatment_restricted => true,
    p_restriction_reason => '防止院内传播',
    p_status => 'detected',
    p_operator_employee_id => '99999999-0000-0000-0000-0000000000d2'::uuid);
  perform tests.assert_true(v_ev.id is not null, '疫情事件上报应成功');
  perform tests.assert_true(v_ev.status = 'detected', '创建后状态应为 detected');
  select count(*) into v_audit_cnt from public.audit_logs
  where action = 'epidemic.detect' and entity_type = 'epidemic_event' and entity_id = v_ev.id::text;
  perform tests.assert_true(v_audit_cnt = 1, '创建 detected 应写 epidemic.detect 审计(B06 区分 action)');

  -- 空疑似疫病拒绝
  perform tests.assert_raises(
    $sql$select public.save_epidemic_event('99999999-0000-0000-0000-000000000031'::uuid, '99999999-0000-0000-0000-000000000032'::uuid, null, null, null, null, '', null, false, false, null, null, null, 'detected', '99999999-0000-0000-0000-0000000000d2'::uuid)$sql$,
    'SUSPECTED_DISEASE_REQUIRED', '空疑似疫病应拒绝');

  -- 非法状态拒绝(save 仅支持 detected/reported)
  perform tests.assert_raises(
    $sql$select public.save_epidemic_event('99999999-0000-0000-0000-000000000031'::uuid, '99999999-0000-0000-0000-000000000032'::uuid, null, null, null, null, '犬瘟热', null, false, false, null, null, null, 'isolated', '99999999-0000-0000-0000-0000000000d2'::uuid)$sql$,
    'INVALID_EPIDEMIC_STATUS', 'save 传 isolated 状态应拒绝');

  -- B02:跨租户 customer(Tenant A 事件 + Tenant B 客户 -> CUSTOMER_SCOPE_MISMATCH)
  perform tests.assert_raises(
    $sql$select public.save_epidemic_event('99999999-0000-0000-0000-000000000031'::uuid, '99999999-0000-0000-0000-000000000032'::uuid, null, '99999999-0000-0000-0000-0000000000f6'::uuid, null, null, '犬瘟热', null, false, false, null, null, null, 'detected', '99999999-0000-0000-0000-0000000000d2'::uuid)$sql$,
    'CUSTOMER_SCOPE_MISMATCH', '跨租户 customer 应被拒绝');
  -- B02:跨租户 pet(Tenant A 事件 + Tenant B 宠物 -> PET_SCOPE_MISMATCH)
  perform tests.assert_raises(
    $sql$select public.save_epidemic_event('99999999-0000-0000-0000-000000000031'::uuid, '99999999-0000-0000-0000-000000000032'::uuid, null, null, '99999999-0000-0000-0000-0000000000f7'::uuid, null, '犬瘟热', null, false, false, null, null, null, 'detected', '99999999-0000-0000-0000-0000000000d2'::uuid)$sql$,
    'PET_SCOPE_MISMATCH', '跨租户 pet 应被拒绝');
  -- B02:跨租户 encounter(Tenant A 事件 + Tenant B 就诊 -> ENCOUNTER_SCOPE_MISMATCH)
  perform tests.assert_raises(
    $sql$select public.save_epidemic_event('99999999-0000-0000-0000-000000000031'::uuid, '99999999-0000-0000-0000-000000000032'::uuid, null, null, null, '99999999-0000-0000-0000-0000000000f8'::uuid, '犬瘟热', null, false, false, null, null, null, 'detected', '99999999-0000-0000-0000-0000000000d2'::uuid)$sql$,
    'ENCOUNTER_SCOPE_MISMATCH', '跨租户 encounter 应被拒绝');
  -- B02:同租户但关联不一致(customer c1 + pet e9 属 c5 -> RELATED_ENTITY_MISMATCH)
  perform tests.assert_raises(
    $sql$select public.save_epidemic_event('99999999-0000-0000-0000-000000000031'::uuid, '99999999-0000-0000-0000-000000000032'::uuid, null, '99999999-0000-0000-0000-0000000000c1'::uuid, '99999999-0000-0000-0000-0000000000e9'::uuid, null, '犬瘟热', null, false, false, null, null, null, 'detected', '99999999-0000-0000-0000-0000000000d2'::uuid)$sql$,
    'RELATED_ENTITY_MISMATCH', '宠物与客户关联不一致应被拒绝');

  -- 维护为 reported:reported_at/by 落库 + epidemic.report 审计
  select * into v_ev from public.save_epidemic_event(
    p_tenant_id => '99999999-0000-0000-0000-000000000031'::uuid,
    p_store_id => '99999999-0000-0000-0000-000000000032'::uuid,
    p_event_id => v_ev.id,
    p_customer_id => '99999999-0000-0000-0000-0000000000c1'::uuid,
    p_pet_id => '99999999-0000-0000-0000-0000000000c2'::uuid,
    p_suspected_disease => '犬瘟热(疑似)',
    p_status => 'reported',
    p_operator_employee_id => '99999999-0000-0000-0000-0000000000d2'::uuid);
  perform tests.assert_true(v_ev.status = 'reported', '维护后状态应为 reported');
  perform tests.assert_true(v_ev.reported_at is not null, '上报应记录 reported_at');
  select count(*) into v_audit_cnt from public.audit_logs
  where action = 'epidemic.report' and entity_type = 'epidemic_event' and entity_id = v_ev.id::text;
  perform tests.assert_true(v_audit_cnt = 1, '转为 reported 应写 epidemic.report 审计');

  -- B06:禁止 reported -> detected 回退
  perform tests.assert_raises(
    format($sql$select public.save_epidemic_event('99999999-0000-0000-0000-000000000031'::uuid, '99999999-0000-0000-0000-000000000032'::uuid, '%s'::uuid, null, null, null, '犬瘟热(疑似)', null, true, true, null, null, null, 'detected', '99999999-0000-0000-0000-0000000000d2'::uuid)$sql$, v_ev.id),
    'INVALID_EPIDEMIC_TRANSITION', 'reported 回退 detected 应被拒绝');
end;
$$;

do $$
declare
  v_ev public.epidemic_events;
  v_audit_cnt integer;
begin
  execute 'reset role';
  select * into v_ev from public.epidemic_events
  where suspected_disease = '犬瘟热(疑似)';

  -- 隔离:detected/reported → isolated + epidemic.isolate 审计
  select * into v_ev from public.isolate_epidemic_event(
    v_ev.id, '99999999-0000-0000-0000-0000000000d2'::uuid);
  perform tests.assert_true(v_ev.status = 'isolated', '隔离后状态应为 isolated');
  perform tests.assert_true(v_ev.isolation_required, '隔离应自动置 isolation_required=true');
  perform tests.assert_true(v_ev.isolated_at is not null, '隔离应记录 isolated_at');
  select count(*) into v_audit_cnt from public.audit_logs
  where action = 'epidemic.isolate' and entity_type = 'epidemic_event' and entity_id = v_ev.id::text;
  perform tests.assert_true(v_audit_cnt = 1, '隔离应写 epidemic.isolate 审计');

  -- 已隔离不可再次隔离
  perform tests.assert_raises(
    format($sql$select public.isolate_epidemic_event('%s'::uuid, '99999999-0000-0000-0000-0000000000d2'::uuid)$sql$, v_ev.id),
    'EPIDEMIC_NOT_ISOLATABLE', '已隔离事件不可重复隔离');

  -- 已隔离事件禁止维护
  perform tests.assert_raises(
    format($sql$select public.save_epidemic_event('99999999-0000-0000-0000-000000000031'::uuid, '99999999-0000-0000-0000-000000000032'::uuid, '%s'::uuid, null, null, null, '犬瘟热(疑似)', null, true, true, null, null, null, 'detected', '99999999-0000-0000-0000-0000000000d2'::uuid)$sql$, v_ev.id),
    'EPIDEMIC_NOT_EDITABLE', '已隔离事件禁止维护');

  -- 解除:isolated → resolved + epidemic.resolve 审计
  select * into v_ev from public.resolve_epidemic_event(
    v_ev.id, '99999999-0000-0000-0000-0000000000d2'::uuid);
  perform tests.assert_true(v_ev.status = 'resolved', '解除后状态应为 resolved');
  perform tests.assert_true(v_ev.resolved_at is not null, '解除应记录 resolved_at');
  select count(*) into v_audit_cnt from public.audit_logs
  where action = 'epidemic.resolve' and entity_type = 'epidemic_event' and entity_id = v_ev.id::text;
  perform tests.assert_true(v_audit_cnt = 1, '解除应写 epidemic.resolve 审计');

  -- 已解除不可重复解除
  perform tests.assert_raises(
    format($sql$select public.resolve_epidemic_event('%s'::uuid, '99999999-0000-0000-0000-0000000000d2'::uuid)$sql$, v_ev.id),
    'EPIDEMIC_NOT_RESOLVABLE', '已解除事件不可重复解除');
end;
$$;

-- ============================================================
-- Part 5:医疗废弃物台账 save / handover
--   B02: attachment_file_id 跨租户拒绝(FILE_SCOPE_MISMATCH)
-- ============================================================
do $$
declare
  v_w public.medical_waste_records;
  v_audit_cnt integer;
begin
  execute 'reset role';
  -- 创建 draft:waste.create 审计
  select * into v_w from public.save_waste_record(
    p_tenant_id => '99999999-0000-0000-0000-000000000031'::uuid,
    p_store_id => '99999999-0000-0000-0000-000000000032'::uuid,
    p_waste_type => '感染性废物',
    p_quantity => 5,
    p_unit => 'kg',
    p_generated_at => now() - interval '2 hours',
    p_handler_employee_id => '99999999-0000-0000-0000-0000000000d2'::uuid,
    p_status => 'draft',
    p_operator_employee_id => '99999999-0000-0000-0000-0000000000d2'::uuid);
  perform tests.assert_true(v_w.id is not null, '废弃物记录创建应成功');
  select count(*) into v_audit_cnt from public.audit_logs
  where action = 'waste.create' and entity_type = 'medical_waste_record' and entity_id = v_w.id::text;
  perform tests.assert_true(v_audit_cnt = 1, '创建废弃物应写 waste.create 审计');

  -- B02:跨租户附件(Tenant A 废弃物 + Tenant B 文件 -> FILE_SCOPE_MISMATCH)
  perform tests.assert_raises(
    $sql$select public.save_waste_record('99999999-0000-0000-0000-000000000031'::uuid, '99999999-0000-0000-0000-000000000032'::uuid, null, '损伤性废物', 1, null, null, null, null, '99999999-0000-0000-0000-0000000000f9'::uuid, 'draft', '99999999-0000-0000-0000-0000000000d2'::uuid)$sql$,
    'FILE_SCOPE_MISMATCH', '跨租户废弃物附件应被拒绝');

  -- 空类型拒绝
  perform tests.assert_raises(
    $sql$select public.save_waste_record('99999999-0000-0000-0000-000000000031'::uuid, '99999999-0000-0000-0000-000000000032'::uuid, null, '', 1, null, null, null, null, null, 'draft', '99999999-0000-0000-0000-0000000000d2'::uuid)$sql$,
    'WASTE_TYPE_REQUIRED', '空废弃物类型应拒绝');

  -- 负数量拒绝
  perform tests.assert_raises(
    $sql$select public.save_waste_record('99999999-0000-0000-0000-000000000031'::uuid, '99999999-0000-0000-0000-000000000032'::uuid, null, '感染性废物', -1, null, null, null, null, null, 'draft', '99999999-0000-0000-0000-0000000000d2'::uuid)$sql$,
    'INVALID_WASTE_QUANTITY', '负数量应拒绝');

  -- 非法状态拒绝(save 仅支持 draft/recorded)
  perform tests.assert_raises(
    $sql$select public.save_waste_record('99999999-0000-0000-0000-000000000031'::uuid, '99999999-0000-0000-0000-000000000032'::uuid, null, '感染性废物', 1, null, null, null, null, null, 'handed_over', '99999999-0000-0000-0000-0000000000d2'::uuid)$sql$,
    'INVALID_WASTE_STATUS', 'save 传 handed_over 状态应拒绝');

  -- 维护为 recorded:waste.update 审计
  select * into v_w from public.save_waste_record(
    p_tenant_id => '99999999-0000-0000-0000-000000000031'::uuid,
    p_store_id => '99999999-0000-0000-0000-000000000032'::uuid,
    p_record_id => v_w.id,
    p_waste_type => '感染性废物',
    p_quantity => 6,
    p_unit => 'kg',
    p_status => 'recorded',
    p_operator_employee_id => '99999999-0000-0000-0000-0000000000d2'::uuid);
  perform tests.assert_true(v_w.quantity = 6, '维护后数量应更新为 6');
  perform tests.assert_true(v_w.status = 'recorded', '维护后状态应为 recorded');
  select count(*) into v_audit_cnt from public.audit_logs
  where action = 'waste.update' and entity_type = 'medical_waste_record' and entity_id = v_w.id::text;
  perform tests.assert_true(v_audit_cnt = 1, '维护废弃物应写 waste.update 审计');
end;
$$;

do $$
declare
  v_w public.medical_waste_records;
  v_audit_cnt integer;
begin
  execute 'reset role';
  select * into v_w from public.medical_waste_records where waste_type = '感染性废物';

  -- 接收方必填
  perform tests.assert_raises(
    format($sql$select public.handover_waste('%s'::uuid, '99999999-0000-0000-0000-0000000000d2'::uuid, null, null, null, '99999999-0000-0000-0000-0000000000d2'::uuid)$sql$, v_w.id),
    'WASTE_RECEIVER_REQUIRED', '交接缺少接收方应拒绝');

  -- 交接成功:handed_over + waste.handover 审计
  select * into v_w from public.handover_waste(
    p_record_id => v_w.id,
    p_handler_employee_id => '99999999-0000-0000-0000-0000000000d2'::uuid,
    p_receiver => '测试处置公司',
    p_disposal_method => '集中焚烧',
    p_handover_at => now(),
    p_operator_employee_id => '99999999-0000-0000-0000-0000000000d2'::uuid);
  perform tests.assert_true(v_w.status = 'handed_over', '交接后状态应为 handed_over');
  perform tests.assert_true(v_w.handover_at is not null, '交接应记录 handover_at');
  perform tests.assert_true(v_w.receiver = '测试处置公司', '交接应记录接收方');
  select count(*) into v_audit_cnt from public.audit_logs
  where action = 'waste.handover' and entity_type = 'medical_waste_record' and entity_id = v_w.id::text;
  perform tests.assert_true(v_audit_cnt = 1, '交接应写 waste.handover 审计');

  -- 重复交接拒绝
  perform tests.assert_raises(
    format($sql$select public.handover_waste('%s'::uuid, '99999999-0000-0000-0000-0000000000d2'::uuid, '测试处置公司', null, null, '99999999-0000-0000-0000-0000000000d2'::uuid)$sql$, v_w.id),
    'WASTE_ALREADY_HANDED_OVER', '已交接记录禁止重复交接');

  -- 已交接禁止维护
  perform tests.assert_raises(
    format($sql$select public.save_waste_record('99999999-0000-0000-0000-000000000031'::uuid, '99999999-0000-0000-0000-000000000032'::uuid, '%s'::uuid, '感染性废物', 10, null, null, null, null, null, 'draft', '99999999-0000-0000-0000-0000000000d2'::uuid)$sql$, v_w.id),
    'WASTE_NOT_EDITABLE', '已交接记录禁止维护');
end;
$$;

-- ============================================================
-- Part 6:RLS 只读策略(租户成员 + 门店范围 + 权限码)
-- 已授权医生可读;无权限用户不可见
-- ============================================================
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"99999999-0000-0000-0000-0000000000d1","role":"authenticated"}', true);
  perform tests.assert_true(
    (select count(*) from public.institution_licenses
     where tenant_id = '99999999-0000-0000-0000-000000000031') >= 1,
    'RLS:医生应可读本租户许可证');
  perform tests.assert_true(
    (select count(*) from public.institution_license_versions) >= 1,
    'RLS:医生应可读许可证历史版本(子查询关联策略)');
  perform tests.assert_true(
    (select count(*) from public.annual_regulatory_reports
     where tenant_id = '99999999-0000-0000-0000-000000000031') >= 1,
    'RLS:医生应可读本租户年度报告');
  perform tests.assert_true(
    (select count(*) from public.epidemic_events
     where tenant_id = '99999999-0000-0000-0000-000000000031') >= 1,
    'RLS:医生应可读本租户疫情事件');
  perform tests.assert_true(
    (select count(*) from public.medical_waste_records
     where tenant_id = '99999999-0000-0000-0000-000000000031') >= 1,
    'RLS:医生应可读本租户医疗废弃物');
end;
$$;

do $$
begin
  set local role authenticated;
  -- 无权限用户(无角色分配):即使有租户成员关系,也因权限码缺失不可见
  perform set_config('request.jwt.claims', '{"sub":"99999999-0000-0000-0000-0000000000f1","role":"authenticated"}', true);
  perform tests.assert_true(
    (select count(*) from public.institution_licenses
     where tenant_id = '99999999-0000-0000-0000-000000000031') = 0,
    'RLS:无权限用户不可见许可证');
  perform tests.assert_true(
    (select count(*) from public.epidemic_events
     where tenant_id = '99999999-0000-0000-0000-000000000031') = 0,
    'RLS:无权限用户不可见疫情事件');
end;
$$;

-- ============================================================
-- 全部通过
-- ============================================================
do $$
begin
  execute 'reset role';
  raise notice 'REGULATORY_S3_1_PASSED';
end;
$$;

rollback;
