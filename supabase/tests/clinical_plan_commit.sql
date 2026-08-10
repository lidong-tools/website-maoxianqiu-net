-- 诊疗方案原子提交(commit_clinical_plan)测试:
--   1) 全成功:病历+处方+检验+影像+医嘱一次落库并推进 plan_ready
--   2) 幂等:同 idempotency_key 重试不重复生成单据/收费/任务/事件
--   3) 版本冲突:expectedVersion 不匹配返回 VERSION_CONFLICT
--   4) 整体回滚:任一项失败(如非法检验价目)时处方等已写入内容全部回滚
begin;

create schema if not exists tests;
create or replace function tests.plan_commit_assert(cond boolean, msg text)
returns void language plpgsql as $$ begin if not cond then raise exception 'PLAN_COMMIT_TEST_FAILED: %', msg; end if; end $$;

-- ===== 基础数据(租户/门店/用户/员工/角色/备案/客户/宠物/就诊/价目) =====
insert into public.tenants (id, slug, name) values
  ('c1c1c1c1-0000-0000-0000-000000000001', 'plan-commit-test', '方案提交测试租户')
on conflict (slug) do nothing;
insert into public.stores (id, tenant_id, name, code, status) values
  ('c1c1c1c1-0000-0000-0000-000000000011', 'c1c1c1c1-0000-0000-0000-000000000001', '方案提交测试门店', 'PC-01', 'active')
on conflict (id) do nothing;
insert into auth.users (id, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, aud, role, created_at, updated_at) values
  ('c1c1c1c1-0000-0000-0000-000000000021', 'plancommit-doctor@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}', '{}', 'authenticated', 'authenticated', now(), now())
on conflict (id) do nothing;
insert into public.tenant_memberships (tenant_id, user_id, status) values
  ('c1c1c1c1-0000-0000-0000-000000000001', 'c1c1c1c1-0000-0000-0000-000000000021', 'active')
on conflict (tenant_id, user_id) do nothing;
insert into public.employees (id, tenant_id, user_id, employee_no, name, status) values
  ('c1c1c1c1-0000-0000-0000-000000000031', 'c1c1c1c1-0000-0000-0000-000000000001', 'c1c1c1c1-0000-0000-0000-000000000021', 'PC-D01', '方案测试医生', 'active')
on conflict (id) do nothing;
insert into public.employee_store_assignments (tenant_id, employee_id, store_id, is_primary) values
  ('c1c1c1c1-0000-0000-0000-000000000001', 'c1c1c1c1-0000-0000-0000-000000000031', 'c1c1c1c1-0000-0000-0000-000000000011', true)
on conflict (employee_id, store_id) do nothing;
insert into public.employee_role_assignments (tenant_id, employee_id, role_id, store_id) values
  ('c1c1c1c1-0000-0000-0000-000000000001', 'c1c1c1c1-0000-0000-0000-000000000031', (select id from public.roles where code='doctor'), 'c1c1c1c1-0000-0000-0000-000000000011')
on conflict do nothing;
-- issue_prescription 要求在职医生有有效执业兽医备案
insert into public.veterinarian_registrations (
  id, tenant_id, employee_id, license_no, valid_from, valid_until, status
) values (
  'c1c1c1c1-0000-0000-0000-000000000041', 'c1c1c1c1-0000-0000-0000-000000000001',
  'c1c1c1c1-0000-0000-0000-000000000031', 'PC-LIC-001',
  (now() at time zone 'Asia/Shanghai')::date - 1, (now() at time zone 'Asia/Shanghai')::date + 365, 'active'
) on conflict (license_no) do nothing;

insert into public.customers (id, tenant_id, store_id, customer_no, name, status) values
  ('c1c1c1c1-0000-0000-0000-000000000051', 'c1c1c1c1-0000-0000-0000-000000000001', 'c1c1c1c1-0000-0000-0000-000000000011', 'PC-CUST', '方案客户', 'active');
insert into public.pets (id, tenant_id, customer_id, name, species, status) values
  ('c1c1c1c1-0000-0000-0000-000000000061', 'c1c1c1c1-0000-0000-0000-000000000001', 'c1c1c1c1-0000-0000-0000-000000000051', '方案猫', '猫', 'active');
insert into public.encounters (id, tenant_id, store_id, customer_id, pet_id, doctor_id, status, clinical_status, archive_status, version) values
  ('c1c1c1c1-0000-0000-0000-000000000071', 'c1c1c1c1-0000-0000-0000-000000000001', 'c1c1c1c1-0000-0000-0000-000000000011',
   'c1c1c1c1-0000-0000-0000-000000000051', 'c1c1c1c1-0000-0000-0000-000000000061',
   'c1c1c1c1-0000-0000-0000-000000000021', 'in_progress', 'active', 'draft', 1);
-- 回滚场景用的第二个就诊
insert into public.encounters (id, tenant_id, store_id, customer_id, pet_id, doctor_id, status, clinical_status, archive_status, version) values
  ('c1c1c1c1-0000-0000-0000-000000000072', 'c1c1c1c1-0000-0000-0000-000000000001', 'c1c1c1c1-0000-0000-0000-000000000011',
   'c1c1c1c1-0000-0000-0000-000000000051', 'c1c1c1c1-0000-0000-0000-000000000061',
   'c1c1c1c1-0000-0000-0000-000000000021', 'in_progress', 'active', 'draft', 1);

insert into public.catalog_items (id, tenant_id, code, name, default_price, billing_type) values
  ('c1c1c1c1-0000-0000-0000-000000000081', 'c1c1c1c1-0000-0000-0000-000000000001', 'PC-DRUG', '测试抗菌药', 30.00, 'drug'),
  ('c1c1c1c1-0000-0000-0000-000000000082', 'c1c1c1c1-0000-0000-0000-000000000001', 'PC-LAB', '血常规', 45.00, 'exam'),
  ('c1c1c1c1-0000-0000-0000-000000000083', 'c1c1c1c1-0000-0000-0000-000000000001', 'PC-IMG', '胸部X光', 120.00, 'exam');

-- ===== 场景1:全成功(病历+处方+检验+影像+医嘱一次原子落库) =====
do $$
declare v_result jsonb;
begin
  select public.commit_clinical_plan(
    'c1c1c1c1-0000-0000-0000-000000000071', 1,
    '{"chief_complaint":"咳嗽3天","diagnosis_text":"上呼吸道感染","treatment_plan":"抗菌+支持治疗"}'::jsonb,
    '[{"catalog_item_id":"c1c1c1c1-0000-0000-0000-000000000081","drug_name":"测试抗菌药","dosage":"10mg/kg","frequency":"bid","quantity":2,"unit":"片","instructions":"口服","sort_order":0}]'::jsonb,
    '[{"catalog_item_id":"c1c1c1c1-0000-0000-0000-000000000082","remark":"血常规"}]'::jsonb,
    '[{"catalog_item_id":"c1c1c1c1-0000-0000-0000-000000000083","imaging_type":"xray","clinical_question":"胸部正位"}]'::jsonb,
    '[{"order_type":"treatment","item_name":"皮下补液","quantity":1,"unit":"次"}]'::jsonb,
    true,
    'c1c1c1c1-0000-0000-0000-000000000031', 'doctor', 'workbench.doctor', 'pc-req-1', 'pc-idem-1'
  ) into v_result;

  perform tests.plan_commit_assert((select clinical_status='plan_ready' from public.encounters where id='c1c1c1c1-0000-0000-0000-000000000071'), '提交后就诊应推进到 plan_ready');
  perform tests.plan_commit_assert((select version=3 from public.encounters where id='c1c1c1c1-0000-0000-0000-000000000071'), '病历更新与状态推进应各自版本 +1');
  perform tests.plan_commit_assert((select chief_complaint='咳嗽3天' and diagnosis_text='上呼吸道感染' from public.encounters where id='c1c1c1c1-0000-0000-0000-000000000071'), '病历字段应随提交落库');
  perform tests.plan_commit_assert((v_result->>'prescriptionStatus') = 'issued', '处方应被开具为 issued');
  perform tests.plan_commit_assert((select count(*)=1 from public.prescriptions where encounter_id='c1c1c1c1-0000-0000-0000-000000000071' and status='issued'), '应只有一张已开具处方');
  perform tests.plan_commit_assert((select count(*)=1 from public.lab_orders where encounter_id='c1c1c1c1-0000-0000-0000-000000000071'), '应创建一张检验申请');
  perform tests.plan_commit_assert((select count(*)=1 from public.imaging_orders where encounter_id='c1c1c1c1-0000-0000-0000-000000000071'), '应创建一张影像申请');
  perform tests.plan_commit_assert((select count(*)=1 from public.medical_orders where encounter_id='c1c1c1c1-0000-0000-0000-000000000071'), '应创建一条医嘱');
  perform tests.plan_commit_assert((select count(*)=3 from public.encounter_charge_items where encounter_id='c1c1c1c1-0000-0000-0000-000000000071' and status='pending'), '处方/检验/影像应各生成一条待付款明细');
  perform tests.plan_commit_assert((select count(*)=1 from public.workflow_tasks where encounter_id='c1c1c1c1-0000-0000-0000-000000000071' and owner_role='pharmacist'), '应生成药房发药任务');
  perform tests.plan_commit_assert((select count(*)=1 from public.workflow_tasks where encounter_id='c1c1c1c1-0000-0000-0000-000000000071' and owner_role='lab_technician'), '应生成检验执行任务');
  perform tests.plan_commit_assert((select count(*)=1 from public.workflow_tasks where encounter_id='c1c1c1c1-0000-0000-0000-000000000071' and owner_role='imaging_technician'), '应生成影像执行任务');
  perform tests.plan_commit_assert((select count(*)=1 from public.nurse_tasks where source_type='medical_order' and encounter_id='c1c1c1c1-0000-0000-0000-000000000071'), '医嘱应生成护士任务');
  perform tests.plan_commit_assert((select count(*)=1 from public.patient_journey_events where encounter_id='c1c1c1c1-0000-0000-0000-000000000071' and event_type='encounter.plan_committed'), '应写入诊疗方案提交事件');
  perform tests.plan_commit_assert((select count(*)=1 from public.audit_logs where entity_type='encounter' and action='encounter.plan_commit' and entity_id='c1c1c1c1-0000-0000-0000-000000000071'), '应写入审计留痕');
end $$;

-- ===== 场景2:幂等重试(同 idempotency_key 直接返回,不重复生成任何单据) =====
do $$
declare v_result jsonb;
begin
  select public.commit_clinical_plan(
    'c1c1c1c1-0000-0000-0000-000000000071', 3,
    '{"chief_complaint":"重复提交"}'::jsonb,
    '[{"catalog_item_id":"c1c1c1c1-0000-0000-0000-000000000081","drug_name":"测试抗菌药","quantity":2}]'::jsonb,
    '[{"catalog_item_id":"c1c1c1c1-0000-0000-0000-000000000082"}]'::jsonb,
    '[]'::jsonb,
    '[]'::jsonb,
    true,
    'c1c1c1c1-0000-0000-0000-000000000031', 'doctor', 'workbench.doctor', 'pc-req-2', 'pc-idem-1'
  ) into v_result;

  perform tests.plan_commit_assert(v_result->>'prescriptionId' is not null, '幂等重试应返回上次结果');
  perform tests.plan_commit_assert((select count(*)=1 from public.prescriptions where encounter_id='c1c1c1c1-0000-0000-0000-000000000071' and status='issued'), '幂等重试不应重复开具处方');
  perform tests.plan_commit_assert((select count(*)=1 from public.lab_orders where encounter_id='c1c1c1c1-0000-0000-0000-000000000071'), '幂等重试不应重复创建检验');
  perform tests.plan_commit_assert((select count(*)=3 from public.encounter_charge_items where encounter_id='c1c1c1c1-0000-0000-0000-000000000071' and status='pending'), '幂等重试不应重复生成收费项');
  perform tests.plan_commit_assert((select count(*)=1 from public.patient_journey_events where encounter_id='c1c1c1c1-0000-0000-0000-000000000071' and event_type='encounter.plan_committed'), '幂等重试不应重复写入提交事件');
end $$;

-- ===== 场景3:版本冲突(expectedVersion 不匹配必须拒绝) =====
do $$
declare v_msg text;
begin
  begin
    perform public.commit_clinical_plan(
      'c1c1c1c1-0000-0000-0000-000000000071', 999,
      '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, true,
      'c1c1c1c1-0000-0000-0000-000000000031', 'doctor', 'workbench.doctor', 'pc-req-3', 'pc-idem-3'
    );
    raise exception 'PLAN_COMMIT_TEST_FAILED: 版本冲突应被拒绝';
  exception when others then
    v_msg := sqlerrm;
    perform tests.plan_commit_assert(v_msg like '%VERSION_CONFLICT%', '版本冲突应返回 VERSION_CONFLICT,实际: ' || v_msg);
  end;
end $$;

-- ===== 场景4:整体回滚(处方已写成功后检验价目非法 → 全部回滚) =====
do $$
declare v_msg text;
begin
  begin
    perform public.commit_clinical_plan(
      'c1c1c1c1-0000-0000-0000-000000000072', 1,
      '{"chief_complaint":"回滚测试"}'::jsonb,
      '[{"catalog_item_id":"c1c1c1c1-0000-0000-0000-000000000081","drug_name":"测试抗菌药","quantity":1}]'::jsonb,
      -- 非法检验价目:外键不存在 → insert 失败
      '[{"catalog_item_id":"c1c1c1c1-0000-0000-0000-00000000ffff"}]'::jsonb,
      '[]'::jsonb, '[]'::jsonb, true,
      'c1c1c1c1-0000-0000-0000-000000000031', 'doctor', 'workbench.doctor', 'pc-req-4', 'pc-idem-4'
    );
    raise exception 'PLAN_COMMIT_TEST_FAILED: 非法检验价目应导致提交失败';
  exception when others then
    null; -- 期望失败
  end;
  -- 断言:处方/收费/任务/事件全部回滚,就诊仍为 active
  perform tests.plan_commit_assert((select clinical_status='active' and version=1 from public.encounters where id='c1c1c1c1-0000-0000-0000-000000000072'), '失败时就诊状态与版本应回滚');
  perform tests.plan_commit_assert((select count(*)=0 from public.prescriptions where encounter_id='c1c1c1c1-0000-0000-0000-000000000072'), '失败时处方应整体回滚');
  perform tests.plan_commit_assert((select count(*)=0 from public.encounter_charge_items where encounter_id='c1c1c1c1-0000-0000-0000-000000000072'), '失败时收费项应整体回滚');
  perform tests.plan_commit_assert((select count(*)=0 from public.workflow_tasks where encounter_id='c1c1c1c1-0000-0000-0000-000000000072'), '失败时任务应整体回滚');
  perform tests.plan_commit_assert((select count(*)=0 from public.patient_journey_events where encounter_id='c1c1c1c1-0000-0000-0000-000000000072'), '失败时事件应整体回滚');
end $$;

rollback;
