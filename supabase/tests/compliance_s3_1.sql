-- ============================================================
-- 合规测试:S3.1-1 病历归档 / Amendment / 保存期 / 兽医备案 / 处方有效性 / 受控药
--
-- 验证 migration 28(compliance_base)+ 29(compliance_rpc):
--   - 归档截止触发器(门诊 24h / 住院 3 日)
--   - archive_encounter / archive_admission 归档与保存期
--   - 归档后正文不可变(DB 触发器兜底)
--   - Amendment 申请/审批/执行流(before/after 快照 + 版本保留)
--   - 执业兽医备案:无有效备案禁止开方
--   - 处方有效期:默认当日结束 / 最长 3 天 / 过期禁止发药
--   - 受控药:单独处方 / 麻醉一日量 / 保留期 5 年(普通 3 年)
--   - save/dispense 重定义:draft 兼容 + issued 防护
--
-- 本文件独立可执行(psql "$DATABASE_URL" -f supabase/tests/compliance_s3_1.sql):
--   - 自建 tests.assert_* 断言函数,不依赖其他测试文件;
--   - 单一事务 begin/rollback,无任何残留;
--   - 每个 DO 块以 execute 'reset role' 回到连接角色。
-- ============================================================

begin;

create schema if not exists tests;
grant usage on schema tests to authenticated, anon, service_role;

create or replace function tests.assert_true(cond boolean, msg text)
returns void
language plpgsql as $$
begin
  if not cond then
    raise exception 'COMPLIANCE_TEST_FAILED: %', msg;
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
    raise exception 'COMPLIANCE_TEST_FAILED: % 应抛出含 % 的错误,实际: %',
      p_name, p_expected, coalesce(v_msg, '无异常(调用成功)');
  end if;
end;
$$;

-- ============================================================
-- 夹具:租户/门店/用户/员工/客户/宠物/目录/药品
-- 统一使用 99999999-0000-0000-0000-0000000000xx 固定 UUID 保证幂等
-- ============================================================
insert into auth.users (id, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, aud, role, created_at, updated_at)
values ('99999999-0000-0000-0000-0000000000aa', 's31-doctor@test.local', crypt('password', gen_salt('bf')), now(),
        '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now())
on conflict (id) do nothing;

insert into public.tenants (id, slug, name)
values ('99999999-0000-0000-0000-000000000001', 's31-tenant', '合规测试租户')
on conflict (slug) do nothing;
insert into public.stores (id, tenant_id, name, code, status)
values ('99999999-0000-0000-0000-000000000002', '99999999-0000-0000-0000-000000000001', '合规测试门店', 'S31', 'active')
on conflict (id) do nothing;

insert into public.employees (id, tenant_id, user_id, employee_no, name, status)
values ('99999999-0000-0000-0000-0000000000c1', '99999999-0000-0000-0000-000000000001', '99999999-0000-0000-0000-0000000000aa', 'S31-DOC', '测试兽医', 'active'),
       ('99999999-0000-0000-0000-0000000000c2', '99999999-0000-0000-0000-000000000001', null, 'S31-MGR', '测试店长', 'active')
on conflict (id) do nothing;

insert into public.customers (id, tenant_id, store_id, customer_no, name, status)
values ('99999999-0000-0000-0000-0000000000c3', '99999999-0000-0000-0000-000000000001', '99999999-0000-0000-0000-000000000002', 'S31-CUST-001', '测试客户', 'active')
on conflict (id) do nothing;
insert into public.pets (id, tenant_id, customer_id, name, species, status)
values ('99999999-0000-0000-0000-0000000000c4', '99999999-0000-0000-0000-000000000001', '99999999-0000-0000-0000-0000000000c3', '测试宠物', 'dog', 'active')
on conflict (id) do nothing;

-- 目录:普通药 / 麻醉药 / 精神药
insert into public.catalog_items (id, tenant_id, code, name, unit, default_price, cost_price, is_active, billing_type)
values ('99999999-0000-0000-0000-0000000000e1', '99999999-0000-0000-0000-000000000001', 'S31-PLAIN', '普通消炎药', '支', 10, 5, true, 'drug'),
       ('99999999-0000-0000-0000-0000000000e2', '99999999-0000-0000-0000-000000000001', 'S31-NARC', '麻醉药品甲', '支', 50, 30, true, 'drug'),
       ('99999999-0000-0000-0000-0000000000e3', '99999999-0000-0000-0000-000000000001', 'S31-PSY', '精神药品乙', '支', 40, 20, true, 'drug')
on conflict (id) do nothing;
insert into public.catalog_drug_extensions (id, catalog_item_id, drug_form, is_controlled, controlled_class)
values ('99999999-0000-0000-0000-0000000000f1', '99999999-0000-0000-0000-0000000000e1', 'tablet', false, 'none'),
       ('99999999-0000-0000-0000-0000000000f2', '99999999-0000-0000-0000-0000000000e2', 'injection', true, 'narcotic'),
       ('99999999-0000-0000-0000-0000000000f3', '99999999-0000-0000-0000-0000000000e3', 'tablet', true, 'psychotropic')
on conflict (id) do nothing;

-- 就诊病历(签署用)与处方载体 encounter
-- 注意:归档截止触发器为 before update of status,insert 不触发;
-- 以 in_progress 插入,Part 1 再 update 为 signed 触发 archive_due_at
insert into public.encounters (id, tenant_id, store_id, customer_id, pet_id, doctor_id, status, started_at, chief_complaint, exam_findings, treatment_plan)
values ('99999999-0000-0000-0000-0000000000d1', '99999999-0000-0000-0000-000000000001', '99999999-0000-0000-0000-000000000002', '99999999-0000-0000-0000-0000000000c3', '99999999-0000-0000-0000-0000000000c4', '99999999-0000-0000-0000-0000000000aa', 'in_progress', now() - interval '1 hour', '主诉', '检查所见', '治疗方案')
on conflict (id) do nothing;

-- 住院病历(出院后归档用;Part 1 再 update 为 discharged 触发归档截止)
insert into public.admissions (id, tenant_id, store_id, customer_id, pet_id, cage_id, doctor_id, status, admitted_at, discharge_reason, discharge_notes)
values ('99999999-0000-0000-0000-0000000000d2', '99999999-0000-0000-0000-000000000001', '99999999-0000-0000-0000-000000000002', '99999999-0000-0000-0000-0000000000c3', '99999999-0000-0000-0000-0000000000c4', '99999999-0000-0000-0000-000000000099', '99999999-0000-0000-0000-0000000000c1', 'admitted', now() - interval '2 days', '康复', '出院记录')
on conflict (id) do nothing;

-- 住院归档截止测试用的在院记录(未出院)
insert into public.admissions (id, tenant_id, store_id, customer_id, pet_id, cage_id, doctor_id, status, admitted_at)
values ('99999999-0000-0000-0000-0000000000d3', '99999999-0000-0000-0000-000000000001', '99999999-0000-0000-0000-000000000002', '99999999-0000-0000-0000-0000000000c3', '99999999-0000-0000-0000-0000000000c4', '99999999-0000-0000-0000-000000000099', '99999999-0000-0000-0000-0000000000c1', 'admitted', now() - interval '3 days')
on conflict (id) do nothing;

-- 已出院未归档(越租户操作员负向测试专用)
insert into public.admissions (id, tenant_id, store_id, customer_id, pet_id, cage_id, doctor_id, status, admitted_at, discharged_at)
values ('99999999-0000-0000-0000-0000000000d4', '99999999-0000-0000-0000-000000000001', '99999999-0000-0000-0000-000000000002', '99999999-0000-0000-0000-0000000000c3', '99999999-0000-0000-0000-0000000000c4', '99999999-0000-0000-0000-000000000099', '99999999-0000-0000-0000-0000000000c1', 'discharged', now() - interval '3 days', now() - interval '2 days')
on conflict (id) do nothing;

-- ============================================================
-- Part 1:归档截止触发器(门诊 24h / 住院 3 日)
-- ============================================================
do $$
declare
  v_enc_encounter_id uuid := '99999999-0000-0000-0000-0000000000d1';
  v_due timestamptz;
begin
  execute 'reset role';
  -- 签署(触发 trg_encounters_set_archive_due):就诊结束 = ended_at
  update public.encounters
  set status = 'signed', ended_at = now() - interval '1 hour', updated_at = now()
  where id = v_enc_encounter_id;

  select archive_due_at into v_due from public.encounters where id = v_enc_encounter_id;
  perform tests.assert_true(v_due is not null, '门诊病历签署后应生成归档截止时间');
  perform tests.assert_true(v_due - (now() - interval '1 hour') >= interval '23 hours'
                        and v_due - (now() - interval '1 hour') <= interval '25 hours',
                        '门诊归档截止应为就诊结束 + 24 小时');
end;
$$;

do $$
declare
  v_adm_admission_id uuid := '99999999-0000-0000-0000-0000000000d2';
  v_due timestamptz;
begin
  execute 'reset role';
  -- 出院(触发 trg_admissions_set_archive_due):出院时间 = discharged_at
  update public.admissions
  set status = 'discharged', discharged_at = now() - interval '1 day', updated_at = now()
  where id = v_adm_admission_id;

  select archive_due_at into v_due from public.admissions where id = v_adm_admission_id;
  perform tests.assert_true(v_due is not null, '住院病历出院后应生成归档截止时间');
  perform tests.assert_true(v_due - (now() - interval '1 day') >= interval '3 days' - interval '1 hour'
                        and v_due - (now() - interval '1 day') <= interval '3 days' + interval '1 hour',
                        '住院归档截止应为出院后 3 日');
end;
$$;

-- ============================================================
-- Part 2:病历归档 archive_encounter / archive_admission
-- ============================================================
do $$
declare
  v_row public.encounters;
begin
  execute 'reset role';
  select * into v_row from public.archive_encounter(
    '99999999-0000-0000-0000-0000000000d1'::uuid,
    '99999999-0000-0000-0000-0000000000c1'::uuid);
  perform tests.assert_true(v_row.archive_status = 'archived', '门诊归档后 archive_status 应为 archived');
  perform tests.assert_true(v_row.archived_at is not null, '门诊归档应记录归档时间');
  perform tests.assert_true(v_row.archived_by_employee_id = '99999999-0000-0000-0000-0000000000c1', '门诊归档应记录归档员工');
  perform tests.assert_true(v_row.retention_until is not null
                        and v_row.retention_until - v_row.archived_at >= interval '3 years' - interval '1 day',
                        '门诊病历保存期应 >= 3 年');
end;
$$;

-- 重复归档拒绝
do $$
begin
  execute 'reset role';
  perform tests.assert_raises(
    $sql$select public.archive_encounter('99999999-0000-0000-0000-0000000000d1'::uuid, '99999999-0000-0000-0000-0000000000c1'::uuid)$sql$,
    'ENCOUNTER_ALREADY_ARCHIVED', '重复归档门诊病历');
end;
$$;

-- 未签署不可归档:新建 in_progress 门诊记录
do $$
declare
  v_enc uuid := gen_random_uuid();
begin
  execute 'reset role';
  insert into public.encounters (id, tenant_id, store_id, customer_id, pet_id, doctor_id, status, started_at)
  values (v_enc, '99999999-0000-0000-0000-000000000001', '99999999-0000-0000-0000-000000000002',
          '99999999-0000-0000-0000-0000000000c3', '99999999-0000-0000-0000-0000000000c4',
          '99999999-0000-0000-0000-0000000000aa', 'in_progress', now());
  perform tests.assert_raises(
    format($sql$select public.archive_encounter('%s'::uuid, '99999999-0000-0000-0000-0000000000c1'::uuid)$sql$, v_enc),
    'ENCOUNTER_NOT_SIGNABLE', '未签署门诊病历不可归档');
end;
$$;

do $$
declare
  v_row public.admissions;
begin
  execute 'reset role';
  select * into v_row from public.archive_admission(
    '99999999-0000-0000-0000-0000000000d2'::uuid,
    '99999999-0000-0000-0000-0000000000c1'::uuid);
  perform tests.assert_true(v_row.archive_status = 'archived', '住院归档后 archive_status 应为 archived');
  perform tests.assert_true(v_row.retention_until is not null
                        and v_row.retention_until - v_row.archived_at >= interval '3 years' - interval '1 day',
                        '住院病历保存期应 >= 3 年');
end;
$$;

-- 未出院不可归档
do $$
begin
  execute 'reset role';
  perform tests.assert_raises(
    $sql$select public.archive_admission('99999999-0000-0000-0000-0000000000d3'::uuid, '99999999-0000-0000-0000-0000000000c1'::uuid)$sql$,
    'ADMISSION_NOT_DISCHARGED', '未出院住院病历不可归档');
end;
$$;

-- 越租户操作员拒绝(用 d4:已出院未归档,归档前验证操作员归属)
do $$
begin
  execute 'reset role';
  -- 外部租户员工(不存在)应报 OPERATOR_NOT_FOUND
  perform tests.assert_raises(
    $sql$select public.archive_admission('99999999-0000-0000-0000-0000000000d4'::uuid, '99999999-0000-0000-0000-000000000088'::uuid)$sql$,
    'OPERATOR_NOT_FOUND', '跨租户操作员应被拒绝');
end;
$$;

-- ============================================================
-- Part 3:归档后正文不可变(DB 触发器兜底,postgres 直连也要被拦)
-- ============================================================
do $$
begin
  execute 'reset role';
  perform tests.assert_raises(
    $sql$update public.encounters set exam_findings = '篡改' where id = '99999999-0000-0000-0000-0000000000d1'$sql$,
    'ARCHIVED_RECORD_IMMUTABLE', '归档门诊病历直接修改应被拒绝');
  perform tests.assert_raises(
    $sql$update public.admissions set discharge_notes = '篡改' where id = '99999999-0000-0000-0000-0000000000d2'$sql$,
    'ARCHIVED_RECORD_IMMUTABLE', '归档住院病历直接修改应被拒绝');
end;
$$;

-- ============================================================
-- Part 4:Amendment 申请/审批/执行流
-- ============================================================
do $$
declare
  v_row public.medical_record_amendments;
  v_approved public.medical_record_amendments;
  v_applied public.medical_record_amendments;
  v_treatment text;
  v_rev_count integer;
begin
  execute 'reset role';
  select * into v_row from public.request_record_amendment(
    'encounter', '99999999-0000-0000-0000-0000000000d1',
    '补充治疗方案细节', '99999999-0000-0000-0000-0000000000c1');
  perform tests.assert_true(v_row.status = 'pending', '修订申请初始状态应为 pending');
  perform tests.assert_true(v_row.before_snapshot is not null and jsonb_typeof(v_row.before_snapshot) = 'object'
                        and v_row.before_snapshot ? 'treatment_plan', '修订申请应记录 before_snapshot');
  -- 重复申请拒绝
  perform tests.assert_raises(
    $sql$select public.request_record_amendment('encounter', '99999999-0000-0000-0000-0000000000d1', '再次申请', '99999999-0000-0000-0000-0000000000c1'::uuid)$sql$,
    'AMENDMENT_ALREADY_PENDING', '同病历 pending 申请重复应被拒绝');

  -- 未批准前 apply 拒绝
  perform tests.assert_raises(
    format($sql$select public.apply_record_amendment('%s'::uuid, '{"treatment_plan":"新方案"}'::jsonb, '99999999-0000-0000-0000-0000000000c1'::uuid)$sql$, v_row.id),
    'AMENDMENT_NOT_APPROVED', '未批准修订不可执行');

  -- 审批通过
  select * into v_approved from public.review_record_amendment(
    v_row.id, 'approved', '99999999-0000-0000-0000-0000000000c2'::uuid);
  perform tests.assert_true(v_approved.status = 'approved', '批准后状态应为 approved');
  perform tests.assert_true(v_approved.reviewed_at is not null, '批准应记录审批时间');

  -- 执行修订:更新正文 + 创建新版本
  select * into v_applied from public.apply_record_amendment(
    v_row.id, '{"treatment_plan":"补充后的治疗方案"}'::jsonb, '99999999-0000-0000-0000-0000000000c1'::uuid);
  perform tests.assert_true(v_applied.status = 'applied', '执行后状态应为 applied');
  perform tests.assert_true(v_applied.after_snapshot->>'treatment_plan' = '补充后的治疗方案', 'after_snapshot 应记录新正文');
  select treatment_plan into v_treatment from public.encounters where id = '99999999-0000-0000-0000-0000000000d1';
  perform tests.assert_true(v_treatment = '补充后的治疗方案', '病历正文应已更新');
  select count(*) into v_rev_count from public.encounter_revisions where encounter_id = '99999999-0000-0000-0000-0000000000d1';
  perform tests.assert_true(v_rev_count = 1, '应创建 1 条修订版本');

  -- 已应用不可再次 apply
  perform tests.assert_raises(
    format($sql$select public.apply_record_amendment('%s'::uuid, '{"treatment_plan":"再次修改"}'::jsonb, '99999999-0000-0000-0000-0000000000c1'::uuid)$sql$, v_row.id),
    'AMENDMENT_NOT_APPROVED', '已应用修订不可重复执行');
end;
$$;

-- 未归档病历不可申请(admission 未出院)
do $$
begin
  execute 'reset role';
  perform tests.assert_raises(
    $sql$select public.request_record_amendment('admission', '99999999-0000-0000-0000-0000000000d3'::uuid, '非法申请', '99999999-0000-0000-0000-0000000000c1'::uuid)$sql$,
    'RECORD_NOT_ARCHIVED', '未归档住院病历不可申请修订');
end;
$$;

-- 拒绝分支:新申请 -> rejected(非法决策拒绝 / 拒绝原因记录 / 已决不可再审批)
do $$
declare
  v_id uuid;
  v_rejected public.medical_record_amendments;
begin
  execute 'reset role';
  insert into public.medical_record_amendments (
    tenant_id, store_id, medical_record_type, medical_record_id, requested_by, reason, status, before_snapshot
  ) values (
    '99999999-0000-0000-0000-000000000001', '99999999-0000-0000-0000-000000000002',
    'encounter', '99999999-0000-0000-0000-0000000000d1',
    '99999999-0000-0000-0000-0000000000c1', '待拒绝申请', 'pending', '{}'::jsonb
  ) returning id into v_id;

  -- 非法决策拒绝
  perform tests.assert_raises(
    format($sql$select public.review_record_amendment('%s'::uuid, 'unknown', '99999999-0000-0000-0000-0000000000c2'::uuid)$sql$, v_id),
    'INVALID_DECISION', '非法审批决策应被拒绝');

  -- 拒绝成功
  select * into v_rejected from public.review_record_amendment(
    v_id, 'rejected', '99999999-0000-0000-0000-0000000000c2'::uuid, '原因不符');
  perform tests.assert_true(v_rejected.status = 'rejected', '拒绝后状态应为 rejected');
  perform tests.assert_true(v_rejected.rejected_reason = '原因不符', '应记录拒绝原因');

  -- 已决不可再次审批
  perform tests.assert_raises(
    format($sql$select public.review_record_amendment('%s'::uuid, 'approved', '99999999-0000-0000-0000-0000000000c2'::uuid)$sql$, v_id),
    'AMENDMENT_NOT_PENDING', '已决申请不可重复审批');
end;
$$;

-- ============================================================
-- Part 5:执业兽医备案 + 处方开具
-- ============================================================
-- 无备案时开方拒绝
do $$
declare
  v_rx uuid := gen_random_uuid();
begin
  execute 'reset role';
  insert into public.prescriptions (id, tenant_id, store_id, encounter_id, customer_id, pet_id, doctor_id, status)
  values (v_rx, '99999999-0000-0000-0000-000000000001', '99999999-0000-0000-0000-000000000002',
          '99999999-0000-0000-0000-0000000000d1', '99999999-0000-0000-0000-0000000000c3', '99999999-0000-0000-0000-0000000000c4',
          '99999999-0000-0000-0000-0000000000aa', 'draft');
  insert into public.prescription_items (prescription_id, catalog_item_id, drug_name, dosage, frequency, duration_days, quantity, unit, sort_order)
  values (v_rx, '99999999-0000-0000-0000-0000000000e1', '普通消炎药', '1片', 'tid', 3, 9, '片', 0);

  perform tests.assert_raises(
    format($sql$select public.issue_prescription('%s'::uuid, '99999999-0000-0000-0000-0000000000c1'::uuid, '99999999-0000-0000-0000-0000000000aa'::uuid)$sql$, v_rx),
    'PRESCRIBER_NOT_REGISTERED', '无执业兽医备案禁止开方');
end;
$$;

-- 建立有效备案
do $$
declare
  v_row public.veterinarian_registrations;
begin
  execute 'reset role';
  select * into v_row from public.upsert_veterinarian_registration(
    p_tenant_id => '99999999-0000-0000-0000-000000000001'::uuid,
    p_employee_id => '99999999-0000-0000-0000-0000000000c1'::uuid,
    p_license_no => 'S31-LIC-001',
    p_registration_no => 'S31-REG-001',
    p_registration_authority => '测试主管机构',
    p_registration_region => '测试地区',
    p_valid_from => (current_date - interval '1 year')::date,
    p_valid_until => (current_date + interval '1 year')::date,
    p_status => 'active',
    p_operator_employee_id => '99999999-0000-0000-0000-0000000000c2'::uuid);
  perform tests.assert_true(v_row.id is not null, '执业兽医备案 upsert 应成功');
  perform tests.assert_true(v_row.status = 'active', '备案状态应为 active');
end;
$$;

-- 有备案后开方成功(普通药,保留期 3 年)
do $$
declare
  v_rx uuid := gen_random_uuid();
  v_row public.prescriptions;
begin
  execute 'reset role';
  insert into public.prescriptions (id, tenant_id, store_id, encounter_id, customer_id, pet_id, doctor_id, status)
  values (v_rx, '99999999-0000-0000-0000-000000000001', '99999999-0000-0000-0000-000000000002',
          '99999999-0000-0000-0000-0000000000d1', '99999999-0000-0000-0000-0000000000c3', '99999999-0000-0000-0000-0000000000c4',
          '99999999-0000-0000-0000-0000000000aa', 'draft');
  insert into public.prescription_items (prescription_id, catalog_item_id, drug_name, dosage, frequency, duration_days, quantity, unit, sort_order)
  values (v_rx, '99999999-0000-0000-0000-0000000000e1', '普通消炎药', '1片', 'tid', 3, 9, '片', 0);

  select * into v_row from public.issue_prescription(
    v_rx, '99999999-0000-0000-0000-0000000000c1'::uuid, '99999999-0000-0000-0000-0000000000aa'::uuid);
  perform tests.assert_true(v_row.status = 'issued', '开具后处方状态应为 issued');
  perform tests.assert_true(v_row.issued_at is not null, '开具应记录 issued_at');
  perform tests.assert_true(v_row.valid_until is not null
                        and v_row.valid_until >= now()
                        and v_row.valid_until <= date_trunc('day', now()) + interval '1 day',
                        '默认有效期应为开具当日结束');
  perform tests.assert_true(v_row.prescriber_veterinarian_registration_id is not null, '应记录开方备案 id');
  perform tests.assert_true(v_row.signature_method = 'manual', '签名方式应为 manual');
  perform tests.assert_true(v_row.retention_until - v_row.issued_at >= interval '3 years' - interval '1 day',
                        '普通处方保留期应 >= 3 年');
end;
$$;

-- 备案过期后开方拒绝
do $$
declare
  v_rx uuid := gen_random_uuid();
begin
  execute 'reset role';
  update public.veterinarian_registrations
  set status = 'expired', updated_at = now()
  where license_no = 'S31-LIC-001';

  insert into public.prescriptions (id, tenant_id, store_id, encounter_id, customer_id, pet_id, doctor_id, status)
  values (v_rx, '99999999-0000-0000-0000-000000000001', '99999999-0000-0000-0000-000000000002',
          '99999999-0000-0000-0000-0000000000d1', '99999999-0000-0000-0000-0000000000c3', '99999999-0000-0000-0000-0000000000c4',
          '99999999-0000-0000-0000-0000000000aa', 'draft');
  insert into public.prescription_items (prescription_id, catalog_item_id, drug_name, dosage, frequency, duration_days, quantity, unit, sort_order)
  values (v_rx, '99999999-0000-0000-0000-0000000000e1', '普通消炎药', '1片', 'tid', 3, 9, '片', 0);

  perform tests.assert_raises(
    format($sql$select public.issue_prescription('%s'::uuid, '99999999-0000-0000-0000-0000000000c1'::uuid, '99999999-0000-0000-0000-0000000000aa'::uuid)$sql$, v_rx),
    'PRESCRIBER_NOT_REGISTERED', '备案过期禁止开方');
end;
$$;

-- 恢复备案(后续受控药测试使用)
do $$
begin
  execute 'reset role';
  update public.veterinarian_registrations
  set status = 'active', valid_until = (current_date + interval '1 year')::date, updated_at = now()
  where license_no = 'S31-LIC-001';
end;
$$;

-- ============================================================
-- Part 6:处方有效期规则
-- ============================================================
-- 超过 3 天拒绝
do $$
declare
  v_rx uuid := gen_random_uuid();
begin
  execute 'reset role';
  insert into public.prescriptions (id, tenant_id, store_id, encounter_id, customer_id, pet_id, doctor_id, status)
  values (v_rx, '99999999-0000-0000-0000-000000000001', '99999999-0000-0000-0000-000000000002',
          '99999999-0000-0000-0000-0000000000d1', '99999999-0000-0000-0000-0000000000c3', '99999999-0000-0000-0000-0000000000c4',
          '99999999-0000-0000-0000-0000000000aa', 'draft');
  insert into public.prescription_items (prescription_id, catalog_item_id, drug_name, dosage, frequency, duration_days, quantity, unit, sort_order)
  values (v_rx, '99999999-0000-0000-0000-0000000000e1', '普通消炎药', '1片', 'tid', 3, 9, '片', 0);

  perform tests.assert_raises(
    format($sql$select public.issue_prescription('%s'::uuid, '99999999-0000-0000-0000-0000000000c1'::uuid, '99999999-0000-0000-0000-0000000000aa'::uuid, now() + interval '4 days')$sql$, v_rx),
    'VALIDITY_EXCEEDS_MAX', '处方有效期超过 3 天应拒绝');
end;
$$;

-- 延长有效期:正常延长成功 / 超过上限拒绝 / 缩短拒绝
do $$
declare
  v_rx uuid := gen_random_uuid();
  v_issued public.prescriptions;
  v_extended public.prescriptions;
begin
  execute 'reset role';
  insert into public.prescriptions (id, tenant_id, store_id, encounter_id, customer_id, pet_id, doctor_id, status)
  values (v_rx, '99999999-0000-0000-0000-000000000001', '99999999-0000-0000-0000-000000000002',
          '99999999-0000-0000-0000-0000000000d1', '99999999-0000-0000-0000-0000000000c3', '99999999-0000-0000-0000-0000000000c4',
          '99999999-0000-0000-0000-0000000000aa', 'draft');
  insert into public.prescription_items (prescription_id, catalog_item_id, drug_name, dosage, frequency, duration_days, quantity, unit, sort_order)
  values (v_rx, '99999999-0000-0000-0000-0000000000e1', '普通消炎药', '1片', 'tid', 3, 9, '片', 0);

  select * into v_issued from public.issue_prescription(
    v_rx, '99999999-0000-0000-0000-0000000000c1'::uuid, '99999999-0000-0000-0000-0000000000aa'::uuid);

  -- 缩短拒绝
  perform tests.assert_raises(
    format($sql$select public.extend_prescription_validity('%s'::uuid, '%s'::timestamptz, '99999999-0000-0000-0000-0000000000c2'::uuid)$sql$, v_rx, v_issued.valid_until),
    'VALIDITY_NOT_EXTENDED', '延长有效期不得缩短');

  -- 超过上限拒绝(issued_at + 4 天)
  perform tests.assert_raises(
    format($sql$select public.extend_prescription_validity('%s'::uuid, '%s'::timestamptz, '99999999-0000-0000-0000-0000000000c2'::uuid)$sql$, v_rx, v_issued.issued_at + interval '4 days'),
    'VALIDITY_EXCEEDS_MAX', '延长超过 3 天上限应拒绝');

  -- 正常延长成功(issued_at + 2 天)
  select * into v_extended from public.extend_prescription_validity(
    v_rx, v_issued.issued_at + interval '2 days', '99999999-0000-0000-0000-0000000000c2'::uuid);
  perform tests.assert_true(v_extended.valid_until = v_issued.issued_at + interval '2 days', '延长后有效期应更新');
end;
$$;

-- 过期处方禁止发药 + 正常 issued 发药成功
do $$
declare
  v_rx_exp uuid := gen_random_uuid();
  v_rx_ok uuid := gen_random_uuid();
  v_dispensed public.prescriptions;
begin
  execute 'reset role';
  -- 过期场景
  insert into public.prescriptions (id, tenant_id, store_id, encounter_id, customer_id, pet_id, doctor_id, status)
  values (v_rx_exp, '99999999-0000-0000-0000-000000000001', '99999999-0000-0000-0000-000000000002',
          '99999999-0000-0000-0000-0000000000d1', '99999999-0000-0000-0000-0000000000c3', '99999999-0000-0000-0000-0000000000c4',
          '99999999-0000-0000-0000-0000000000aa', 'draft');
  insert into public.prescription_items (prescription_id, catalog_item_id, drug_name, dosage, frequency, duration_days, quantity, unit, sort_order)
  values (v_rx_exp, '99999999-0000-0000-0000-0000000000e1', '普通消炎药', '1片', 'tid', 3, 9, '片', 0);
  perform public.issue_prescription(v_rx_exp, '99999999-0000-0000-0000-0000000000c1'::uuid, '99999999-0000-0000-0000-0000000000aa'::uuid);
  -- 有效期改为过去
  update public.prescriptions set valid_until = now() - interval '1 hour' where id = v_rx_exp;
  perform tests.assert_raises(
    format($sql$select public.dispense_prescription('%s'::uuid)$sql$, v_rx_exp),
    'PRESCRIPTION_EXPIRED', '过期处方禁止发药');

  -- 正常 issued 发药
  insert into public.prescriptions (id, tenant_id, store_id, encounter_id, customer_id, pet_id, doctor_id, status)
  values (v_rx_ok, '99999999-0000-0000-0000-000000000001', '99999999-0000-0000-0000-000000000002',
          '99999999-0000-0000-0000-0000000000d1', '99999999-0000-0000-0000-0000000000c3', '99999999-0000-0000-0000-0000000000c4',
          '99999999-0000-0000-0000-0000000000aa', 'draft');
  insert into public.prescription_items (prescription_id, catalog_item_id, drug_name, dosage, frequency, duration_days, quantity, unit, sort_order)
  values (v_rx_ok, '99999999-0000-0000-0000-0000000000e1', '普通消炎药', '1片', 'tid', 3, 9, '片', 0);
  perform public.issue_prescription(v_rx_ok, '99999999-0000-0000-0000-0000000000c1'::uuid, '99999999-0000-0000-0000-0000000000aa'::uuid);
  select * into v_dispensed from public.dispense_prescription(v_rx_ok);
  perform tests.assert_true(v_dispensed.status = 'dispensed', '有效期内 issued 处方应可发药');
  perform tests.assert_true(v_dispensed.dispensed_at is not null, '发药应记录 dispensed_at');
end;
$$;

-- ============================================================
-- Part 7:受控药品规则
-- ============================================================
-- 麻醉药一日量限制(先 duration=2 失败,后 1 成功且保留期 5 年)
do $$
declare
  v_rx uuid := gen_random_uuid();
  v_row public.prescriptions;
begin
  execute 'reset role';
  insert into public.prescriptions (id, tenant_id, store_id, encounter_id, customer_id, pet_id, doctor_id, status)
  values (v_rx, '99999999-0000-0000-0000-000000000001', '99999999-0000-0000-0000-000000000002',
          '99999999-0000-0000-0000-0000000000d1', '99999999-0000-0000-0000-0000000000c3', '99999999-0000-0000-0000-0000000000c4',
          '99999999-0000-0000-0000-0000000000aa', 'draft');
  insert into public.prescription_items (prescription_id, catalog_item_id, drug_name, dosage, frequency, duration_days, quantity, unit, sort_order)
  values (v_rx, '99999999-0000-0000-0000-0000000000e2', '麻醉药品甲', '1支', 'qd', 2, 2, '支', 0);

  -- 超过一日量拒绝
  perform tests.assert_raises(
    format($sql$select public.issue_prescription('%s'::uuid, '99999999-0000-0000-0000-0000000000c1'::uuid, '99999999-0000-0000-0000-0000000000aa'::uuid)$sql$, v_rx),
    'NARCOTIC_DAILY_LIMIT', '麻醉药品每张处方超过一日量应拒绝');

  -- 改为一量后成功,保留期 5 年
  update public.prescription_items set duration_days = 1 where prescription_id = v_rx;
  select * into v_row from public.issue_prescription(
    v_rx, '99999999-0000-0000-0000-0000000000c1'::uuid, '99999999-0000-0000-0000-0000000000aa'::uuid);
  perform tests.assert_true(v_row.status = 'issued', '麻醉药一日量处方应可开具');
  perform tests.assert_true(v_row.retention_until - v_row.issued_at >= interval '5 years' - interval '1 day',
                        '受控处方保留期应 >= 5 年');
end;
$$;

-- 受控药与非受控药混开拒绝
do $$
declare
  v_rx uuid := gen_random_uuid();
begin
  execute 'reset role';
  insert into public.prescriptions (id, tenant_id, store_id, encounter_id, customer_id, pet_id, doctor_id, status)
  values (v_rx, '99999999-0000-0000-0000-000000000001', '99999999-0000-0000-0000-000000000002',
          '99999999-0000-0000-0000-0000000000d1', '99999999-0000-0000-0000-0000000000c3', '99999999-0000-0000-0000-0000000000c4',
          '99999999-0000-0000-0000-0000000000aa', 'draft');
  insert into public.prescription_items (prescription_id, catalog_item_id, drug_name, dosage, frequency, duration_days, quantity, unit, sort_order)
  values (v_rx, '99999999-0000-0000-0000-0000000000e1', '普通消炎药', '1片', 'tid', 3, 9, '片', 0),
         (v_rx, '99999999-0000-0000-0000-0000000000e2', '麻醉药品甲', '1支', 'qd', 1, 1, '支', 1);

  perform tests.assert_raises(
    format($sql$select public.issue_prescription('%s'::uuid, '99999999-0000-0000-0000-0000000000c1'::uuid, '99999999-0000-0000-0000-0000000000aa'::uuid)$sql$, v_rx),
    'CONTROLLED_MIX_REGULAR', '受控药与非受控药混开应拒绝');
end;
$$;

-- 多受控类别混开拒绝(麻醉 + 精神)
do $$
declare
  v_rx uuid := gen_random_uuid();
begin
  execute 'reset role';
  insert into public.prescriptions (id, tenant_id, store_id, encounter_id, customer_id, pet_id, doctor_id, status)
  values (v_rx, '99999999-0000-0000-0000-000000000001', '99999999-0000-0000-0000-000000000002',
          '99999999-0000-0000-0000-0000000000d1', '99999999-0000-0000-0000-0000000000c3', '99999999-0000-0000-0000-0000000000c4',
          '99999999-0000-0000-0000-0000000000aa', 'draft');
  insert into public.prescription_items (prescription_id, catalog_item_id, drug_name, dosage, frequency, duration_days, quantity, unit, sort_order)
  values (v_rx, '99999999-0000-0000-0000-0000000000e2', '麻醉药品甲', '1支', 'qd', 1, 1, '支', 0),
         (v_rx, '99999999-0000-0000-0000-0000000000e3', '精神药品乙', '1片', 'bid', 1, 2, '片', 1);

  perform tests.assert_raises(
    format($sql$select public.issue_prescription('%s'::uuid, '99999999-0000-0000-0000-0000000000c1'::uuid, '99999999-0000-0000-0000-0000000000aa'::uuid)$sql$, v_rx),
    'CONTROLLED_MIX_CLASS', '不同受控类别混开应拒绝');
end;
$$;

-- ============================================================
-- Part 8:save/dispense 重定义防护
-- ============================================================
-- issued 处方所在就诊禁止覆盖式保存新草稿
do $$
declare
  v_enc uuid := gen_random_uuid();
  v_rx uuid;
begin
  execute 'reset role';
  insert into public.encounters (id, tenant_id, store_id, customer_id, pet_id, doctor_id, status, started_at, ended_at)
  values (v_enc, '99999999-0000-0000-0000-000000000001', '99999999-0000-0000-0000-000000000002',
          '99999999-0000-0000-0000-0000000000c3', '99999999-0000-0000-0000-0000000000c4',
          '99999999-0000-0000-0000-0000000000aa', 'signed', now() - interval '2 hours', now() - interval '1 hour');

  -- 先保存草稿再开具
  select id into v_rx from public.save_prescription(v_enc, '[{"catalog_item_id":"99999999-0000-0000-0000-0000000000e1","drug_name":"普通消炎药","dosage":"1片","frequency":"tid","duration_days":3,"quantity":9,"unit":"片"}]'::jsonb, '99999999-0000-0000-0000-0000000000aa'::uuid);
  perform tests.assert_true(v_rx is not null, 'save_prescription 应创建草稿');
  perform public.issue_prescription(v_rx, '99999999-0000-0000-0000-0000000000c1'::uuid, '99999999-0000-0000-0000-0000000000aa'::uuid);

  -- issued 后再次保存应拒绝
  perform tests.assert_raises(
    format($sql$select public.save_prescription('%s'::uuid, '[{"catalog_item_id":"99999999-0000-0000-0000-0000000000e1","drug_name":"普通消炎药","dosage":"1片","frequency":"tid","duration_days":3,"quantity":9,"unit":"片"}]'::jsonb, '99999999-0000-0000-0000-0000000000aa'::uuid)$sql$, v_enc),
    'PRESCRIPTION_ALREADY_ISSUED', '已开具处方后禁止覆盖式保存');
end;
$$;

-- draft 直发兼容(旧流程)
do $$
declare
  v_rx uuid := gen_random_uuid();
  v_row public.prescriptions;
begin
  execute 'reset role';
  insert into public.prescriptions (id, tenant_id, store_id, encounter_id, customer_id, pet_id, doctor_id, status)
  values (v_rx, '99999999-0000-0000-0000-000000000001', '99999999-0000-0000-0000-000000000002',
          '99999999-0000-0000-0000-0000000000d1', '99999999-0000-0000-0000-0000000000c3', '99999999-0000-0000-0000-0000000000c4',
          '99999999-0000-0000-0000-0000000000aa', 'draft');
  insert into public.prescription_items (prescription_id, catalog_item_id, drug_name, dosage, frequency, duration_days, quantity, unit, sort_order)
  values (v_rx, '99999999-0000-0000-0000-0000000000e1', '普通消炎药', '1片', 'tid', 3, 9, '片', 0);
  select * into v_row from public.dispense_prescription(v_rx);
  perform tests.assert_true(v_row.status = 'dispensed', 'draft 直发(旧流程)应兼容');
end;
$$;

-- ============================================================
-- 全部通过
-- ============================================================
do $$
begin
  execute 'reset role';
  raise notice 'COMPLIANCE_S3_1_PASSED';
end;
$$;

rollback;
