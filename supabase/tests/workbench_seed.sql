-- ============================================================
-- supabase/tests/workbench_seed.sql
-- 岗位工作台批量测试数据(插入默认租户,support@maoxianqiu.app 一个账号即可看全部岗位)
--
-- 覆盖岗位(数据来源见 api/routes/patient-journey.ts GET /workbenches/:role):
--   frontdesk 前台 / triage 分诊 / doctor 医生 / manager 店长  → clinical_queue_entries(按状态过滤)
--   cashier 收银                                              → encounter_charge_items(pending/invoiced)
--   nurse / lab / imaging / pharmacy / followup               → workflow_tasks(按 owner_role 过滤)
--   所有岗位共用:patient_journey_events 时间线 + triage_assessments
--
-- 使用方式:
--   - 用 support@maoxianqiu.app 登录(该账号属于默认租户)
--   - 给其员工 E2E-ADMIN 配齐 10 个岗位角色(本脚本第 1 段)
--   - 数据全部挂在默认租户 + 系统管理门店(SYS)下
--
-- 幂等:固定 UUID + 顶部清理段(删除旧隔离租户/旧 SQL 直插账号/本脚本旧数据),可重复执行。
-- 执行:登录 Supabase Dashboard → SQL Editor 全选执行;或 supabase db query --linked --file 本文件。
-- ============================================================

begin;

-- ============ 0. 清理(幂等,可安全重复执行) ============
-- 事件表带不可变触发器(禁止 update/delete),清理前先禁用;previous_event_id 自引用需先断开。
alter table public.patient_journey_events disable trigger trg_patient_journey_events_immutable;

-- 0a. 删除旧的独立测试租户(workbench-test, ab7f0000 前缀)全部业务数据
update public.patient_journey_events set previous_event_id = null
where tenant_id = 'ab7f0000-0000-4000-8000-000000000001';
delete from public.patient_journey_events where tenant_id = 'ab7f0000-0000-4000-8000-000000000001';
delete from public.workflow_tasks where tenant_id = 'ab7f0000-0000-4000-8000-000000000001';
delete from public.encounter_charge_items where tenant_id = 'ab7f0000-0000-4000-8000-000000000001';
delete from public.medication_safety_checks where tenant_id = 'ab7f0000-0000-4000-8000-000000000001';
delete from public.lab_orders where tenant_id = 'ab7f0000-0000-4000-8000-000000000001';
delete from public.imaging_orders where tenant_id = 'ab7f0000-0000-4000-8000-000000000001';
delete from public.prescription_items
where prescription_id in (select id from public.prescriptions where tenant_id = 'ab7f0000-0000-4000-8000-000000000001');
delete from public.prescriptions where tenant_id = 'ab7f0000-0000-4000-8000-000000000001';
delete from public.triage_assessments where tenant_id = 'ab7f0000-0000-4000-8000-000000000001';
delete from public.clinical_queue_entries where tenant_id = 'ab7f0000-0000-4000-8000-000000000001';
delete from public.store_catalog_items where tenant_id = 'ab7f0000-0000-4000-8000-000000000001';
delete from public.catalog_items where tenant_id = 'ab7f0000-0000-4000-8000-000000000001';
delete from public.encounters where tenant_id = 'ab7f0000-0000-4000-8000-000000000001';
delete from public.appointments where tenant_id = 'ab7f0000-0000-4000-8000-000000000001';
delete from public.pets where tenant_id = 'ab7f0000-0000-4000-8000-000000000001';
delete from public.customers where tenant_id = 'ab7f0000-0000-4000-8000-000000000001';
delete from public.employee_role_assignments where tenant_id = 'ab7f0000-0000-4000-8000-000000000001';
delete from public.employee_store_assignments where tenant_id = 'ab7f0000-0000-4000-8000-000000000001';
delete from public.employees where tenant_id = 'ab7f0000-0000-4000-8000-000000000001';
delete from public.stores where tenant_id = 'ab7f0000-0000-4000-8000-000000000001';
delete from public.tenant_memberships where tenant_id = 'ab7f0000-0000-4000-8000-000000000001';
delete from public.tenants where id = 'ab7f0000-0000-4000-8000-000000000001';

-- 0b. 删除旧的 SQL 直插 auth 账号(GoTrue 不识别、无法登录,仅占位)
delete from auth.identities
where user_id in (select id from auth.users where email like '%@wb.test');
delete from auth.users where email like '%@wb.test';

-- 0c. 删除默认租户中本脚本上次插入的数据(固定 ID 前缀 d0e1a200 + 触发器按就诊生成的行)
update public.patient_journey_events set previous_event_id = null
where tenant_id = '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154'
  and (encounter_id in ('d0e1a200-0000-4000-8000-000000000401', 'd0e1a200-0000-4000-8000-000000000402')
       or id::text like 'd0e1a200-0000-4000-8000-%');
delete from public.patient_journey_events
where tenant_id = '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154'
  and (encounter_id in ('d0e1a200-0000-4000-8000-000000000401', 'd0e1a200-0000-4000-8000-000000000402')
       or id::text like 'd0e1a200-0000-4000-8000-%');
delete from public.workflow_tasks
where tenant_id = '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154'
  and (encounter_id in ('d0e1a200-0000-4000-8000-000000000401', 'd0e1a200-0000-4000-8000-000000000402')
       or id::text like 'd0e1a200-0000-4000-8000-%');
delete from public.encounter_charge_items
where tenant_id = '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154'
  and (encounter_id in ('d0e1a200-0000-4000-8000-000000000401', 'd0e1a200-0000-4000-8000-000000000402')
       or id::text like 'd0e1a200-0000-4000-8000-%');
delete from public.medication_safety_checks
where tenant_id = '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154'
  and encounter_id in ('d0e1a200-0000-4000-8000-000000000401', 'd0e1a200-0000-4000-8000-000000000402');
delete from public.lab_orders
where tenant_id = '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154' and id::text like 'd0e1a200-0000-4000-8000-%';
delete from public.imaging_orders
where tenant_id = '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154' and id::text like 'd0e1a200-0000-4000-8000-%';
delete from public.prescription_items
where prescription_id in (select id from public.prescriptions where id::text like 'd0e1a200-0000-4000-8000-%');
delete from public.prescriptions
where tenant_id = '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154' and id::text like 'd0e1a200-0000-4000-8000-%';
delete from public.triage_assessments
where tenant_id = '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154' and id::text like 'd0e1a200-0000-4000-8000-%';
delete from public.clinical_queue_entries
where tenant_id = '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154' and id::text like 'd0e1a200-0000-4000-8000-%';
delete from public.encounters
where tenant_id = '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154' and id::text like 'd0e1a200-0000-4000-8000-%';
delete from public.appointments
where tenant_id = '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154' and id::text like 'd0e1a200-0000-4000-8000-%';
delete from public.pets
where tenant_id = '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154' and id::text like 'd0e1a200-0000-4000-8000-%';
delete from public.customers
where tenant_id = '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154' and id::text like 'd0e1a200-0000-4000-8000-%';
delete from public.store_catalog_items
where tenant_id = '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154' and id::text like 'd0e1a200-0000-4000-8000-%';
delete from public.catalog_items
where tenant_id = '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154' and id::text like 'd0e1a200-0000-4000-8000-%';

-- 0d. 撤销上次给 E2E-ADMIN 添加的 10 个岗位角色(保留既有 tenant_owner)
delete from public.employee_role_assignments
where tenant_id = '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154'
  and employee_id = '0418fc5c-a089-4556-bb1d-b277beeb0709'
  and role_id in (select id from public.roles
                  where code in ('receptionist','triage_nurse','doctor','nurse','lab_technician',
                                 'imaging_technician','cashier','pharmacist','followup_service','store_manager'));

-- ============ 1. 角色分配:给 support 的 E2E-ADMIN 配齐 10 个岗位角色 ============
-- 全部为 store 作用域角色,必须带 store_id = 系统管理门店(S30-R01 双重校验)。
insert into public.employee_role_assignments (id, tenant_id, employee_id, role_id, store_id)
select ('d0e1a200-0000-4000-8000-000000000e' || lpad(n::text, 2, '0'))::uuid,
       '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154',
       '0418fc5c-a089-4556-bb1d-b277beeb0709',
       r.id,
       'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031'
from (values
  (1, 'receptionist'),
  (2, 'triage_nurse'),
  (3, 'doctor'),
  (4, 'nurse'),
  (5, 'lab_technician'),
  (6, 'imaging_technician'),
  (7, 'cashier'),
  (8, 'pharmacist'),
  (9, 'followup_service'),
  (10, 'store_manager')
) as v(n, code)
join public.roles r on r.code = v.code
on conflict (id) do nothing;

-- ============ 2. 客户 / 宠物 / 价目 ============
insert into public.customers (id, tenant_id, store_id, customer_no, name, gender, phone, member_level, status) values
  ('d0e1a200-0000-4000-8000-000000000101', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031', 'WB-CUST-01', '王芳', 'female', '13800000001', 'normal', 'active'),
  ('d0e1a200-0000-4000-8000-000000000102', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031', 'WB-CUST-02', '李明', 'male',   '13800000002', 'silver', 'active'),
  ('d0e1a200-0000-4000-8000-000000000103', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031', 'WB-CUST-03', '赵强', 'male',   '13800000003', 'normal', 'active'),
  ('d0e1a200-0000-4000-8000-000000000104', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031', 'WB-CUST-04', '孙丽', 'female', '13800000004', 'gold',   'active'),
  ('d0e1a200-0000-4000-8000-000000000105', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031', 'WB-CUST-05', '周敏', 'female', '13800000005', 'normal', 'active'),
  ('d0e1a200-0000-4000-8000-000000000106', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031', 'WB-CUST-06', '吴军', 'male',   '13800000006', 'normal', 'active'),
  ('d0e1a200-0000-4000-8000-000000000107', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031', 'WB-CUST-07', '郑芳', 'female', '13800000007', 'silver', 'active'),
  ('d0e1a200-0000-4000-8000-000000000108', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031', 'WB-CUST-08', '冯伟', 'male',   '13800000008', 'normal', 'active')
on conflict (id) do update set name = excluded.name;

insert into public.pets (id, tenant_id, customer_id, name, species, breed, gender, weight, status) values
  ('d0e1a200-0000-4000-8000-000000000201', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'd0e1a200-0000-4000-8000-000000000101', '球球',   '犬', '贵宾',   'male',   6.5,  'active'),
  ('d0e1a200-0000-4000-8000-000000000202', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'd0e1a200-0000-4000-8000-000000000102', '咪咪',   '猫', '英短',   'female', 4.2,  'active'),
  ('d0e1a200-0000-4000-8000-000000000203', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'd0e1a200-0000-4000-8000-000000000103', '旺财',   '犬', '金毛',   'male',   28.0, 'active'),
  ('d0e1a200-0000-4000-8000-000000000204', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'd0e1a200-0000-4000-8000-000000000104', '豆豆',   '犬', '柯基',   'male',   11.8, 'active'),
  ('d0e1a200-0000-4000-8000-000000000205', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'd0e1a200-0000-4000-8000-000000000105', '布丁',   '猫', '布偶',   'female', 3.9,  'active'),
  ('d0e1a200-0000-4000-8000-000000000206', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'd0e1a200-0000-4000-8000-000000000106', '雪球',   '犬', '萨摩耶', 'female', 22.5, 'active'),
  ('d0e1a200-0000-4000-8000-000000000207', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'd0e1a200-0000-4000-8000-000000000107', '巧克力', '犬', '泰迪',   'female', 5.1,  'active'),
  ('d0e1a200-0000-4000-8000-000000000208', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'd0e1a200-0000-4000-8000-000000000108', '跳跳',   '猫', '橘猫',   'male',   5.6,  'active')
on conflict (id) do update set name = excluded.name;

insert into public.catalog_items (id, tenant_id, code, name, unit, default_price, billing_type, is_active) values
  ('d0e1a200-0000-4000-8000-000000000d01', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'WB-AMOX',   '阿莫西林片',   '盒', 28.50,  'drug',    true),
  ('d0e1a200-0000-4000-8000-000000000d02', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'WB-DEWORM', '体内驱虫药',   '粒', 45.00,  'drug',    true),
  ('d0e1a200-0000-4000-8000-000000000d03', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'WB-CBC',    '血常规检查',   '项', 60.00,  'exam',    true),
  ('d0e1a200-0000-4000-8000-000000000d04', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'WB-US',     '腹部彩超',     '次', 120.00, 'exam',    true),
  ('d0e1a200-0000-4000-8000-000000000d05', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'WB-INF',    '输液观察费',   '次', 80.00,  'service', true)
on conflict (id) do update set name = excluded.name, default_price = excluded.default_price;

-- ============ 3. 预约(8 条,状态覆盖 checked_in/in_progress/completed/cancelled) ============
insert into public.appointments (id, tenant_id, store_id, customer_id, pet_id, doctor_id, scheduled_start, scheduled_end, reason, status, source) values
  ('d0e1a200-0000-4000-8000-000000000301', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031', 'd0e1a200-0000-4000-8000-000000000101', 'd0e1a200-0000-4000-8000-000000000201', 'a6169bb6-71a2-442d-a7cc-5f4652ae858e', now() - interval '50 minutes', now() - interval '20 minutes', '定期疫苗咨询', 'checked_in', 'walk_in'),
  ('d0e1a200-0000-4000-8000-000000000302', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031', 'd0e1a200-0000-4000-8000-000000000102', 'd0e1a200-0000-4000-8000-000000000202', 'a6169bb6-71a2-442d-a7cc-5f4652ae858e', now() - interval '45 minutes', now() - interval '15 minutes', '食欲不振', 'checked_in', 'phone'),
  ('d0e1a200-0000-4000-8000-000000000303', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031', 'd0e1a200-0000-4000-8000-000000000103', 'd0e1a200-0000-4000-8000-000000000203', 'a6169bb6-71a2-442d-a7cc-5f4652ae858e', now() - interval '40 minutes', now() - interval '10 minutes', '皮肤瘙痒', 'checked_in', 'walk_in'),
  ('d0e1a200-0000-4000-8000-000000000304', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031', 'd0e1a200-0000-4000-8000-000000000104', 'd0e1a200-0000-4000-8000-000000000204', 'a6169bb6-71a2-442d-a7cc-5f4652ae858e', now() - interval '35 minutes', now() - interval '5 minutes',  '驱虫', 'checked_in', 'online'),
  ('d0e1a200-0000-4000-8000-000000000305', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031', 'd0e1a200-0000-4000-8000-000000000105', 'd0e1a200-0000-4000-8000-000000000205', 'a6169bb6-71a2-442d-a7cc-5f4652ae858e', now() - interval '30 minutes', now() - interval '5 minutes',  '呕吐腹泻', 'in_progress', 'walk_in'),
  ('d0e1a200-0000-4000-8000-000000000306', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031', 'd0e1a200-0000-4000-8000-000000000106', 'd0e1a200-0000-4000-8000-000000000206', 'a6169bb6-71a2-442d-a7cc-5f4652ae858e', now() - interval '25 minutes', now() + interval '5 minutes',  '咳嗽', 'checked_in', 'phone'),
  ('d0e1a200-0000-4000-8000-000000000307', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031', 'd0e1a200-0000-4000-8000-000000000107', 'd0e1a200-0000-4000-8000-000000000207', 'a6169bb6-71a2-442d-a7cc-5f4652ae858e', now() - interval '5 hours',   now() - interval '4 hours',   '皮肤感染复查', 'completed', 'online'),
  ('d0e1a200-0000-4000-8000-000000000308', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031', 'd0e1a200-0000-4000-8000-000000000108', 'd0e1a200-0000-4000-8000-000000000208', 'a6169bb6-71a2-442d-a7cc-5f4652ae858e', now() - interval '2 hours', now() - interval '90 minutes', '日常体检', 'cancelled', 'walk_in')
on conflict (id) do update set status = excluded.status;

-- ============ 4. 就诊记录(05 布丁 in_progress/active/draft;07 巧克力 completed/closed/signed) ============
insert into public.encounters (id, tenant_id, store_id, appointment_id, customer_id, pet_id, doctor_id, status, clinical_status, archive_status, chief_complaint, diagnosis_text, started_at, ended_at, version) values
  ('d0e1a200-0000-4000-8000-000000000401', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031', 'd0e1a200-0000-4000-8000-000000000305', 'd0e1a200-0000-4000-8000-000000000105', 'd0e1a200-0000-4000-8000-000000000205', 'a6169bb6-71a2-442d-a7cc-5f4652ae858e', 'in_progress', 'active', 'draft', '呕吐腹泻3天,食欲下降', '急性胃肠炎', now() - interval '25 minutes', null, 1),
  ('d0e1a200-0000-4000-8000-000000000402', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031', 'd0e1a200-0000-4000-8000-000000000307', 'd0e1a200-0000-4000-8000-000000000107', 'd0e1a200-0000-4000-8000-000000000207', 'a6169bb6-71a2-442d-a7cc-5f4652ae858e', 'completed', 'closed', 'signed', '皮肤感染复查', '皮肤细菌感染(已愈)', now() - interval '5 hours', now() - interval '4 hours', 3)
on conflict (id) do update set status = excluded.status, clinical_status = excluded.clinical_status, archive_status = excluded.archive_status;

-- ============ 5. 候诊队列(8 态状态机全覆盖) ============
insert into public.clinical_queue_entries (
  id, tenant_id, store_id, appointment_id, encounter_id, customer_id, pet_id, assigned_doctor_id,
  queue_date, queue_no, room_name, service_type, triage_required, priority, status,
  call_sequence, call_count, checked_in_at, triaged_at, waiting_at, called_at, consultation_started_at, closed_at,
  last_operator_employee_id, version
) values
  ('d0e1a200-0000-4000-8000-000000000501', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031', 'd0e1a200-0000-4000-8000-000000000301', null, 'd0e1a200-0000-4000-8000-000000000101', 'd0e1a200-0000-4000-8000-000000000201', 'a6169bb6-71a2-442d-a7cc-5f4652ae858e', current_date, 'A001', null, 'outpatient', true, 'routine', 'checked_in', 0, 0, now() - interval '50 minutes', null, null, null, null, null, '0418fc5c-a089-4556-bb1d-b277beeb0709', 1),
  ('d0e1a200-0000-4000-8000-000000000502', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031', 'd0e1a200-0000-4000-8000-000000000302', null, 'd0e1a200-0000-4000-8000-000000000102', 'd0e1a200-0000-4000-8000-000000000202', 'a6169bb6-71a2-442d-a7cc-5f4652ae858e', current_date, 'A002', null, 'outpatient', true, 'routine', 'triage', 0, 0, now() - interval '45 minutes', null, null, null, null, null, '0418fc5c-a089-4556-bb1d-b277beeb0709', 1),
  ('d0e1a200-0000-4000-8000-000000000503', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031', 'd0e1a200-0000-4000-8000-000000000303', null, 'd0e1a200-0000-4000-8000-000000000103', 'd0e1a200-0000-4000-8000-000000000203', 'a6169bb6-71a2-442d-a7cc-5f4652ae858e', current_date, 'A003', null, 'outpatient', true, 'urgent', 'waiting', 0, 0, now() - interval '40 minutes', now() - interval '35 minutes', now() - interval '35 minutes', null, null, null, '0418fc5c-a089-4556-bb1d-b277beeb0709', 1),
  ('d0e1a200-0000-4000-8000-000000000504', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031', 'd0e1a200-0000-4000-8000-000000000304', null, 'd0e1a200-0000-4000-8000-000000000104', 'd0e1a200-0000-4000-8000-000000000204', 'a6169bb6-71a2-442d-a7cc-5f4652ae858e', current_date, 'A004', '诊室3', 'outpatient', true, 'routine', 'called', 1, 1, now() - interval '35 minutes', now() - interval '30 minutes', now() - interval '30 minutes', now() - interval '10 minutes', null, null, '0418fc5c-a089-4556-bb1d-b277beeb0709', 1),
  ('d0e1a200-0000-4000-8000-000000000505', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031', 'd0e1a200-0000-4000-8000-000000000305', 'd0e1a200-0000-4000-8000-000000000401', 'd0e1a200-0000-4000-8000-000000000105', 'd0e1a200-0000-4000-8000-000000000205', 'a6169bb6-71a2-442d-a7cc-5f4652ae858e', current_date, 'A005', '诊室2', 'outpatient', true, 'priority', 'in_consultation', 1, 1, now() - interval '30 minutes', now() - interval '25 minutes', now() - interval '25 minutes', now() - interval '12 minutes', now() - interval '10 minutes', null, '0418fc5c-a089-4556-bb1d-b277beeb0709', 1),
  ('d0e1a200-0000-4000-8000-000000000506', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031', 'd0e1a200-0000-4000-8000-000000000306', null, 'd0e1a200-0000-4000-8000-000000000106', 'd0e1a200-0000-4000-8000-000000000206', 'a6169bb6-71a2-442d-a7cc-5f4652ae858e', current_date, 'A006', null, 'outpatient', true, 'routine', 'missed', 0, 0, now() - interval '25 minutes', now() - interval '20 minutes', now() - interval '20 minutes', null, null, now() - interval '2 minutes', '0418fc5c-a089-4556-bb1d-b277beeb0709', 1),
  ('d0e1a200-0000-4000-8000-000000000507', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031', 'd0e1a200-0000-4000-8000-000000000307', 'd0e1a200-0000-4000-8000-000000000402', 'd0e1a200-0000-4000-8000-000000000107', 'd0e1a200-0000-4000-8000-000000000207', 'a6169bb6-71a2-442d-a7cc-5f4652ae858e', current_date, 'A007', null, 'outpatient', true, 'routine', 'closed', 1, 1, now() - interval '5 hours', now() - interval '290 minutes', now() - interval '290 minutes', now() - interval '280 minutes', now() - interval '270 minutes', now() - interval '4 hours', '0418fc5c-a089-4556-bb1d-b277beeb0709', 1),
  ('d0e1a200-0000-4000-8000-000000000508', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031', 'd0e1a200-0000-4000-8000-000000000308', null, 'd0e1a200-0000-4000-8000-000000000108', 'd0e1a200-0000-4000-8000-000000000208', 'a6169bb6-71a2-442d-a7cc-5f4652ae858e', current_date, 'A008', null, 'outpatient', true, 'routine', 'cancelled', 0, 0, now() - interval '2 hours', null, null, null, null, now() - interval '100 minutes', '0418fc5c-a089-4556-bb1d-b277beeb0709', 1)
on conflict (id) do update set status = excluded.status, priority = excluded.priority;

-- ============ 6. 分诊记录(03/04/05/06/07) ============
insert into public.triage_assessments (
  id, tenant_id, store_id, queue_entry_id, encounter_id, weight_kg, temperature_c, heart_rate,
  respiratory_rate, pain_score, acuity, risk_flags, chief_complaint, notes, assessed_by_employee_id, assessed_at
) values
  ('d0e1a200-0000-4000-8000-000000000601', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031', 'd0e1a200-0000-4000-8000-000000000503', null, 28.0, 38.5, 110, 30, 0, 'urgent', '{aggressive}', '皮肤瘙痒,抓挠明显', '二级急症,优先候诊', '0418fc5c-a089-4556-bb1d-b277beeb0709', now() - interval '35 minutes'),
  ('d0e1a200-0000-4000-8000-000000000602', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031', 'd0e1a200-0000-4000-8000-000000000504', null, 11.8, 38.2, 96, 24, 1, 'routine', '{}', '驱虫', null, '0418fc5c-a089-4556-bb1d-b277beeb0709', now() - interval '30 minutes'),
  ('d0e1a200-0000-4000-8000-000000000603', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031', 'd0e1a200-0000-4000-8000-000000000505', 'd0e1a200-0000-4000-8000-000000000401', 3.9, 39.1, 130, 32, 4, 'priority', '{chronic}', '呕吐腹泻', '脱水风险,需补液观察', '0418fc5c-a089-4556-bb1d-b277beeb0709', now() - interval '25 minutes'),
  ('d0e1a200-0000-4000-8000-000000000604', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031', 'd0e1a200-0000-4000-8000-000000000506', null, 22.5, 38.0, 100, 26, 0, 'routine', '{}', '咳嗽', null, '0418fc5c-a089-4556-bb1d-b277beeb0709', now() - interval '20 minutes'),
  ('d0e1a200-0000-4000-8000-000000000605', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031', 'd0e1a200-0000-4000-8000-000000000507', 'd0e1a200-0000-4000-8000-000000000402', 5.1, 38.3, 105, 25, 0, 'routine', '{}', '皮肤感染复查', null, '0418fc5c-a089-4556-bb1d-b277beeb0709', now() - interval '290 minutes')
on conflict (queue_entry_id) do update set acuity = excluded.acuity;

-- ============ 7. 处方(05 布丁:先 draft,再 issued 触发计费/药房任务/事件) ============
insert into public.prescriptions (id, tenant_id, store_id, encounter_id, customer_id, pet_id, doctor_id, status, prescriber_employee_id, prescriber_user_id) values
  ('d0e1a200-0000-4000-8000-000000000901', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031', 'd0e1a200-0000-4000-8000-000000000401', 'd0e1a200-0000-4000-8000-000000000105', 'd0e1a200-0000-4000-8000-000000000205', 'a6169bb6-71a2-442d-a7cc-5f4652ae858e', 'draft', '0418fc5c-a089-4556-bb1d-b277beeb0709', 'a6169bb6-71a2-442d-a7cc-5f4652ae858e')
on conflict (id) do update set status = excluded.status;

insert into public.prescription_items (id, prescription_id, catalog_item_id, drug_name, quantity, dosage, frequency, instructions) values
  ('d0e1a200-0000-4000-8000-000000000902', 'd0e1a200-0000-4000-8000-000000000901', 'd0e1a200-0000-4000-8000-000000000d01', '阿莫西林片', 2, '1粒/次', '每日2次', '饭后喂服'),
  ('d0e1a200-0000-4000-8000-000000000903', 'd0e1a200-0000-4000-8000-000000000901', 'd0e1a200-0000-4000-8000-000000000d02', '体内驱虫药', 1, '1粒', '一次', '空腹服用')
on conflict (id) do update set drug_name = excluded.drug_name;

update public.prescriptions set status = 'issued', issued_at = now()
where id = 'd0e1a200-0000-4000-8000-000000000901' and status = 'draft';

-- ============ 8. 检验 / 影像申请(05 布丁;插入即触发收费项+岗位任务+事件) ============
insert into public.lab_orders (id, tenant_id, store_id, customer_id, pet_id, encounter_id, order_no, status, requested_by, requested_at, catalog_item_id) values
  ('d0e1a200-0000-4000-8000-000000000a01', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031', 'd0e1a200-0000-4000-8000-000000000105', 'd0e1a200-0000-4000-8000-000000000205', 'd0e1a200-0000-4000-8000-000000000401', 'WB-LAB-001', 'requested', 'a6169bb6-71a2-442d-a7cc-5f4652ae858e', now() - interval '20 minutes', 'd0e1a200-0000-4000-8000-000000000d03')
on conflict (id) do update set status = excluded.status;

insert into public.imaging_orders (id, tenant_id, store_id, order_no, encounter_id, customer_id, pet_id, requested_by, imaging_type, catalog_item_id, status, clinical_question) values
  ('d0e1a200-0000-4000-8000-000000000b01', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031', 'WB-IMG-001', 'd0e1a200-0000-4000-8000-000000000401', 'd0e1a200-0000-4000-8000-000000000105', 'd0e1a200-0000-4000-8000-000000000205', 'a6169bb6-71a2-442d-a7cc-5f4652ae858e', 'ultrasound', 'd0e1a200-0000-4000-8000-000000000d04', 'requested', '腹部彩超排查肠梗阻可能')
on conflict (id) do update set status = excluded.status;

-- ============ 9. 手动岗位任务(护士 / 回访;药房/检验/影像任务由触发器生成) ============
insert into public.workflow_tasks (
  id, tenant_id, store_id, encounter_id, customer_id, pet_id, task_type, owner_role,
  source_type, source_id, title, description, priority, status, due_at, created_by_employee_id, version
) values
  ('d0e1a200-0000-4000-8000-000000000701', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031', 'd0e1a200-0000-4000-8000-000000000401', 'd0e1a200-0000-4000-8000-000000000105', 'd0e1a200-0000-4000-8000-000000000205', 'medical_order', 'nurse', 'medical_order', 'WB-NURSE-05-01', '执行输液观察', '遵医嘱为布丁执行输液观察并记录生命体征', 'priority', 'pending', now() + interval '30 minutes', '0418fc5c-a089-4556-bb1d-b277beeb0709', 1),
  ('d0e1a200-0000-4000-8000-000000000702', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031', 'd0e1a200-0000-4000-8000-000000000402', 'd0e1a200-0000-4000-8000-000000000107', 'd0e1a200-0000-4000-8000-000000000207', 'followup', 'followup_service', 'followup', 'WB-FU-07-01', '离院后回访', '巧克力离院后第2天电话回访康复情况', 'routine', 'pending', now() + interval '1 day', '0418fc5c-a089-4556-bb1d-b277beeb0709', 1),
  ('d0e1a200-0000-4000-8000-000000000703', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031', 'd0e1a200-0000-4000-8000-000000000402', 'd0e1a200-0000-4000-8000-000000000107', 'd0e1a200-0000-4000-8000-000000000207', 'followup', 'followup_service', 'followup', 'WB-FU-07-00', '首轮回访完成', '首次回访已完成,恢复良好', 'routine', 'completed', now() - interval '2 hours', '0418fc5c-a089-4556-bb1d-b277beeb0709', 1)
on conflict (id) do update set status = excluded.status;

-- ============ 10. 手动收费项(输液给05 pending;诊疗费给07 paid) ============
-- 处方2项(57+45)+血常规60+彩超120 由触发器生成,这里补输液观察费 80 与已结清的复查费。
insert into public.encounter_charge_items (
  id, tenant_id, store_id, encounter_id, customer_id, pet_id, source_type, source_id, source_line_id,
  catalog_item_id, item_name, quantity, unit_price, status, payment_required_before_execution, created_by_employee_id
) values
  ('d0e1a200-0000-4000-8000-000000000801', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031', 'd0e1a200-0000-4000-8000-000000000401', 'd0e1a200-0000-4000-8000-000000000105', 'd0e1a200-0000-4000-8000-000000000205', 'procedure', 'WB-PROC-05-01', '', 'd0e1a200-0000-4000-8000-000000000d05', '输液观察费', 1, 80.00, 'pending', true, '0418fc5c-a089-4556-bb1d-b277beeb0709'),
  ('d0e1a200-0000-4000-8000-000000000802', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031', 'd0e1a200-0000-4000-8000-000000000402', 'd0e1a200-0000-4000-8000-000000000107', 'd0e1a200-0000-4000-8000-000000000207', 'procedure', 'WB-PROC-07-01', '', null, '诊疗复查费', 1, 50.00, 'paid', false, '0418fc5c-a089-4556-bb1d-b277beeb0709')
on conflict (id) do update set status = excluded.status;

-- ============ 11. 患者旅程事件时间线(手动事件;处方/检验/影像触发的事件由触发器自动生成) ============
-- 全部操作人:employee E2E-ADMIN(0418fc5c)/user support(a6169bb6),事件快照写入员工号与姓名。
-- 05 布丁(就诊 401):签到→分诊→候诊→叫号→接诊→护士医嘱任务→输液观察费(7 条)
insert into public.patient_journey_events (
  id, tenant_id, store_id, customer_id, pet_id, appointment_id, queue_entry_id, encounter_id,
  entity_type, entity_id, event_type, from_status, to_status, reason, note,
  actor_type, actor_user_id, actor_employee_id, actor_employee_no, actor_name, actor_role, source_workbench, occurred_at
) values
  ('d0e1a200-0000-4000-8000-000000000e01', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031', 'd0e1a200-0000-4000-8000-000000000105', 'd0e1a200-0000-4000-8000-000000000205', 'd0e1a200-0000-4000-8000-000000000305', 'd0e1a200-0000-4000-8000-000000000505', 'd0e1a200-0000-4000-8000-000000000401', 'clinical_queue', 'd0e1a200-0000-4000-8000-000000000505', 'queue.checked_in', null, 'checked_in', '现场挂号', null, 'employee', 'a6169bb6-71a2-442d-a7cc-5f4652ae858e', '0418fc5c-a089-4556-bb1d-b277beeb0709', 'E2E-ADMIN', 'E2E管理员', 'receptionist', 'frontdesk', now() - interval '30 minutes'),
  ('d0e1a200-0000-4000-8000-000000000e02', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031', 'd0e1a200-0000-4000-8000-000000000105', 'd0e1a200-0000-4000-8000-000000000205', 'd0e1a200-0000-4000-8000-000000000305', 'd0e1a200-0000-4000-8000-000000000505', 'd0e1a200-0000-4000-8000-000000000401', 'triage_assessment', 'd0e1a200-0000-4000-8000-000000000603', 'triage.completed', null, null, null, '脱水风险,标记慢性病', 'employee', 'a6169bb6-71a2-442d-a7cc-5f4652ae858e', '0418fc5c-a089-4556-bb1d-b277beeb0709', 'E2E-ADMIN', 'E2E管理员', 'triage_nurse', 'triage', now() - interval '25 minutes'),
  ('d0e1a200-0000-4000-8000-000000000e03', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031', 'd0e1a200-0000-4000-8000-000000000105', 'd0e1a200-0000-4000-8000-000000000205', 'd0e1a200-0000-4000-8000-000000000305', 'd0e1a200-0000-4000-8000-000000000505', 'd0e1a200-0000-4000-8000-000000000401', 'clinical_queue', 'd0e1a200-0000-4000-8000-000000000505', 'queue.waiting', 'triage', 'waiting', '分诊完成进入候诊', null, 'employee', 'a6169bb6-71a2-442d-a7cc-5f4652ae858e', '0418fc5c-a089-4556-bb1d-b277beeb0709', 'E2E-ADMIN', 'E2E管理员', 'triage_nurse', 'triage', now() - interval '25 minutes'),
  ('d0e1a200-0000-4000-8000-000000000e04', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031', 'd0e1a200-0000-4000-8000-000000000105', 'd0e1a200-0000-4000-8000-000000000205', 'd0e1a200-0000-4000-8000-000000000305', 'd0e1a200-0000-4000-8000-000000000505', 'd0e1a200-0000-4000-8000-000000000401', 'clinical_queue', 'd0e1a200-0000-4000-8000-000000000505', 'queue.called', 'waiting', 'called', '叫号至诊室2', null, 'employee', 'a6169bb6-71a2-442d-a7cc-5f4652ae858e', '0418fc5c-a089-4556-bb1d-b277beeb0709', 'E2E-ADMIN', 'E2E管理员', 'receptionist', 'frontdesk', now() - interval '12 minutes'),
  ('d0e1a200-0000-4000-8000-000000000e05', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031', 'd0e1a200-0000-4000-8000-000000000105', 'd0e1a200-0000-4000-8000-000000000205', 'd0e1a200-0000-4000-8000-000000000305', 'd0e1a200-0000-4000-8000-000000000505', 'd0e1a200-0000-4000-8000-000000000401', 'clinical_queue', 'd0e1a200-0000-4000-8000-000000000505', 'queue.in_consultation', 'called', 'in_consultation', '开始接诊', '主诉:呕吐腹泻3天', 'employee', 'a6169bb6-71a2-442d-a7cc-5f4652ae858e', '0418fc5c-a089-4556-bb1d-b277beeb0709', 'E2E-ADMIN', 'E2E管理员', 'doctor', 'doctor', now() - interval '10 minutes'),
  ('d0e1a200-0000-4000-8000-000000000e06', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031', 'd0e1a200-0000-4000-8000-000000000105', 'd0e1a200-0000-4000-8000-000000000205', 'd0e1a200-0000-4000-8000-000000000305', 'd0e1a200-0000-4000-8000-000000000505', 'd0e1a200-0000-4000-8000-000000000401', 'workflow_task', 'd0e1a200-0000-4000-8000-000000000701', 'workflow_task.created', null, 'pending', '医嘱创建护士任务', '输液观察并记录生命体征', 'employee', 'a6169bb6-71a2-442d-a7cc-5f4652ae858e', '0418fc5c-a089-4556-bb1d-b277beeb0709', 'E2E-ADMIN', 'E2E管理员', 'doctor', 'doctor', now() - interval '8 minutes'),
  ('d0e1a200-0000-4000-8000-000000000e07', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031', 'd0e1a200-0000-4000-8000-000000000105', 'd0e1a200-0000-4000-8000-000000000205', 'd0e1a200-0000-4000-8000-000000000305', 'd0e1a200-0000-4000-8000-000000000505', 'd0e1a200-0000-4000-8000-000000000401', 'encounter_charge_item', 'd0e1a200-0000-4000-8000-000000000801', 'charge_item.created', null, 'pending', '录入输液观察费', null, 'employee', 'a6169bb6-71a2-442d-a7cc-5f4652ae858e', '0418fc5c-a089-4556-bb1d-b277beeb0709', 'E2E-ADMIN', 'E2E管理员', 'cashier', 'cashier', now() - interval '5 minutes')
on conflict (id) do nothing;

-- 07 巧克力(就诊 402):完整闭环 签到→分诊→候诊→叫号→接诊→完成→离院→收费→支付→回访(13 条)
insert into public.patient_journey_events (
  id, tenant_id, store_id, customer_id, pet_id, appointment_id, queue_entry_id, encounter_id,
  entity_type, entity_id, event_type, from_status, to_status, reason, note,
  actor_type, actor_user_id, actor_employee_id, actor_employee_no, actor_name, actor_role, source_workbench, occurred_at
) values
  ('d0e1a200-0000-4000-8000-000000000e08', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031', 'd0e1a200-0000-4000-8000-000000000107', 'd0e1a200-0000-4000-8000-000000000207', 'd0e1a200-0000-4000-8000-000000000307', 'd0e1a200-0000-4000-8000-000000000507', 'd0e1a200-0000-4000-8000-000000000402', 'clinical_queue', 'd0e1a200-0000-4000-8000-000000000507', 'queue.checked_in', null, 'checked_in', '线上预约到店', null, 'employee', 'a6169bb6-71a2-442d-a7cc-5f4652ae858e', '0418fc5c-a089-4556-bb1d-b277beeb0709', 'E2E-ADMIN', 'E2E管理员', 'receptionist', 'frontdesk', now() - interval '5 hours'),
  ('d0e1a200-0000-4000-8000-000000000e09', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031', 'd0e1a200-0000-4000-8000-000000000107', 'd0e1a200-0000-4000-8000-000000000207', 'd0e1a200-0000-4000-8000-000000000307', 'd0e1a200-0000-4000-8000-000000000507', 'd0e1a200-0000-4000-8000-000000000402', 'triage_assessment', 'd0e1a200-0000-4000-8000-000000000605', 'triage.completed', null, null, null, '皮肤感染复查', 'employee', 'a6169bb6-71a2-442d-a7cc-5f4652ae858e', '0418fc5c-a089-4556-bb1d-b277beeb0709', 'E2E-ADMIN', 'E2E管理员', 'triage_nurse', 'triage', now() - interval '290 minutes'),
  ('d0e1a200-0000-4000-8000-000000000e10', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031', 'd0e1a200-0000-4000-8000-000000000107', 'd0e1a200-0000-4000-8000-000000000207', 'd0e1a200-0000-4000-8000-000000000307', 'd0e1a200-0000-4000-8000-000000000507', 'd0e1a200-0000-4000-8000-000000000402', 'clinical_queue', 'd0e1a200-0000-4000-8000-000000000507', 'queue.waiting', 'triage', 'waiting', '分诊完成进入候诊', null, 'employee', 'a6169bb6-71a2-442d-a7cc-5f4652ae858e', '0418fc5c-a089-4556-bb1d-b277beeb0709', 'E2E-ADMIN', 'E2E管理员', 'triage_nurse', 'triage', now() - interval '290 minutes'),
  ('d0e1a200-0000-4000-8000-000000000e11', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031', 'd0e1a200-0000-4000-8000-000000000107', 'd0e1a200-0000-4000-8000-000000000207', 'd0e1a200-0000-4000-8000-000000000307', 'd0e1a200-0000-4000-8000-000000000507', 'd0e1a200-0000-4000-8000-000000000402', 'clinical_queue', 'd0e1a200-0000-4000-8000-000000000507', 'queue.called', 'waiting', 'called', '叫号', null, 'employee', 'a6169bb6-71a2-442d-a7cc-5f4652ae858e', '0418fc5c-a089-4556-bb1d-b277beeb0709', 'E2E-ADMIN', 'E2E管理员', 'receptionist', 'frontdesk', now() - interval '280 minutes'),
  ('d0e1a200-0000-4000-8000-000000000e12', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031', 'd0e1a200-0000-4000-8000-000000000107', 'd0e1a200-0000-4000-8000-000000000207', 'd0e1a200-0000-4000-8000-000000000307', 'd0e1a200-0000-4000-8000-000000000507', 'd0e1a200-0000-4000-8000-000000000402', 'clinical_queue', 'd0e1a200-0000-4000-8000-000000000507', 'queue.in_consultation', 'called', 'in_consultation', '开始接诊', '皮肤细菌感染复查', 'employee', 'a6169bb6-71a2-442d-a7cc-5f4652ae858e', '0418fc5c-a089-4556-bb1d-b277beeb0709', 'E2E-ADMIN', 'E2E管理员', 'doctor', 'doctor', now() - interval '270 minutes'),
  ('d0e1a200-0000-4000-8000-000000000e13', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031', 'd0e1a200-0000-4000-8000-000000000107', 'd0e1a200-0000-4000-8000-000000000207', 'd0e1a200-0000-4000-8000-000000000307', 'd0e1a200-0000-4000-8000-000000000507', 'd0e1a200-0000-4000-8000-000000000402', 'encounter', 'd0e1a200-0000-4000-8000-000000000402', 'encounter.completed', 'active', 'closed', '完成诊疗', '诊断:皮肤细菌感染(已愈)', 'employee', 'a6169bb6-71a2-442d-a7cc-5f4652ae858e', '0418fc5c-a089-4556-bb1d-b277beeb0709', 'E2E-ADMIN', 'E2E管理员', 'doctor', 'doctor', now() - interval '250 minutes'),
  ('d0e1a200-0000-4000-8000-000000000e14', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031', 'd0e1a200-0000-4000-8000-000000000107', 'd0e1a200-0000-4000-8000-000000000207', 'd0e1a200-0000-4000-8000-000000000307', 'd0e1a200-0000-4000-8000-000000000507', 'd0e1a200-0000-4000-8000-000000000402', 'clinical_queue', 'd0e1a200-0000-4000-8000-000000000507', 'queue.closed', 'in_consultation', 'closed', '离院', null, 'employee', 'a6169bb6-71a2-442d-a7cc-5f4652ae858e', '0418fc5c-a089-4556-bb1d-b277beeb0709', 'E2E-ADMIN', 'E2E管理员', 'receptionist', 'frontdesk', now() - interval '240 minutes'),
  ('d0e1a200-0000-4000-8000-000000000e15', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031', 'd0e1a200-0000-4000-8000-000000000107', 'd0e1a200-0000-4000-8000-000000000207', 'd0e1a200-0000-4000-8000-000000000307', 'd0e1a200-0000-4000-8000-000000000507', 'd0e1a200-0000-4000-8000-000000000402', 'encounter_charge_item', 'd0e1a200-0000-4000-8000-000000000802', 'charge_item.created', null, 'pending', '录入复查费', null, 'employee', 'a6169bb6-71a2-442d-a7cc-5f4652ae858e', '0418fc5c-a089-4556-bb1d-b277beeb0709', 'E2E-ADMIN', 'E2E管理员', 'cashier', 'cashier', now() - interval '240 minutes'),
  ('d0e1a200-0000-4000-8000-000000000e16', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031', 'd0e1a200-0000-4000-8000-000000000107', 'd0e1a200-0000-4000-8000-000000000207', 'd0e1a200-0000-4000-8000-000000000307', 'd0e1a200-0000-4000-8000-000000000507', 'd0e1a200-0000-4000-8000-000000000402', 'encounter_charge_item', 'd0e1a200-0000-4000-8000-000000000802', 'charge_item.paid', 'pending', 'paid', '收银结清', null, 'employee', 'a6169bb6-71a2-442d-a7cc-5f4652ae858e', '0418fc5c-a089-4556-bb1d-b277beeb0709', 'E2E-ADMIN', 'E2E管理员', 'cashier', 'cashier', now() - interval '235 minutes'),
  ('d0e1a200-0000-4000-8000-000000000e17', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031', 'd0e1a200-0000-4000-8000-000000000107', 'd0e1a200-0000-4000-8000-000000000207', 'd0e1a200-0000-4000-8000-000000000307', 'd0e1a200-0000-4000-8000-000000000507', 'd0e1a200-0000-4000-8000-000000000402', 'workflow_task', 'd0e1a200-0000-4000-8000-000000000703', 'workflow_task.created', null, 'pending', '创建首轮回访', null, 'employee', 'a6169bb6-71a2-442d-a7cc-5f4652ae858e', '0418fc5c-a089-4556-bb1d-b277beeb0709', 'E2E-ADMIN', 'E2E管理员', 'followup_service', 'followup', now() - interval '180 minutes'),
  ('d0e1a200-0000-4000-8000-000000000e18', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031', 'd0e1a200-0000-4000-8000-000000000107', 'd0e1a200-0000-4000-8000-000000000207', 'd0e1a200-0000-4000-8000-000000000307', 'd0e1a200-0000-4000-8000-000000000507', 'd0e1a200-0000-4000-8000-000000000402', 'workflow_task', 'd0e1a200-0000-4000-8000-000000000703', 'workflow_task.completed', 'pending', 'completed', '首轮回访完成', '恢复良好', 'employee', 'a6169bb6-71a2-442d-a7cc-5f4652ae858e', '0418fc5c-a089-4556-bb1d-b277beeb0709', 'E2E-ADMIN', 'E2E管理员', 'followup_service', 'followup', now() - interval '120 minutes'),
  ('d0e1a200-0000-4000-8000-000000000e19', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031', 'd0e1a200-0000-4000-8000-000000000107', 'd0e1a200-0000-4000-8000-000000000207', 'd0e1a200-0000-4000-8000-000000000307', 'd0e1a200-0000-4000-8000-000000000507', 'd0e1a200-0000-4000-8000-000000000402', 'workflow_task', 'd0e1a200-0000-4000-8000-000000000702', 'workflow_task.created', null, 'pending', '离院医嘱安排第2天回访', null, 'employee', 'a6169bb6-71a2-442d-a7cc-5f4652ae858e', '0418fc5c-a089-4556-bb1d-b277beeb0709', 'E2E-ADMIN', 'E2E管理员', 'doctor', 'doctor', now() - interval '120 minutes'),
  ('d0e1a200-0000-4000-8000-000000000e20', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031', 'd0e1a200-0000-4000-8000-000000000107', 'd0e1a200-0000-4000-8000-000000000207', 'd0e1a200-0000-4000-8000-000000000307', 'd0e1a200-0000-4000-8000-000000000507', 'd0e1a200-0000-4000-8000-000000000402', 'encounter', 'd0e1a200-0000-4000-8000-000000000402', 'encounter.followup_plan', null, null, '离院医嘱', '电话回访康复情况', 'employee', 'a6169bb6-71a2-442d-a7cc-5f4652ae858e', '0418fc5c-a089-4556-bb1d-b277beeb0709', 'E2E-ADMIN', 'E2E管理员', 'doctor', 'doctor', now() - interval '239 minutes')
on conflict (id) do nothing;

-- 其他候诊患者(01-08,除 05/07):前台签到/分诊/候诊/叫号/过号流转(11 条)
insert into public.patient_journey_events (
  id, tenant_id, store_id, customer_id, pet_id, appointment_id, queue_entry_id, encounter_id,
  entity_type, entity_id, event_type, from_status, to_status, reason, note,
  actor_type, actor_user_id, actor_employee_id, actor_employee_no, actor_name, actor_role, source_workbench, occurred_at
) values
  ('d0e1a200-0000-4000-8000-000000000e21', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031', 'd0e1a200-0000-4000-8000-000000000101', 'd0e1a200-0000-4000-8000-000000000201', 'd0e1a200-0000-4000-8000-000000000301', 'd0e1a200-0000-4000-8000-000000000501', null, 'clinical_queue', 'd0e1a200-0000-4000-8000-000000000501', 'queue.checked_in', null, 'checked_in', '现场挂号', '定期疫苗咨询', 'employee', 'a6169bb6-71a2-442d-a7cc-5f4652ae858e', '0418fc5c-a089-4556-bb1d-b277beeb0709', 'E2E-ADMIN', 'E2E管理员', 'receptionist', 'frontdesk', now() - interval '50 minutes'),
  ('d0e1a200-0000-4000-8000-000000000e22', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031', 'd0e1a200-0000-4000-8000-000000000102', 'd0e1a200-0000-4000-8000-000000000202', 'd0e1a200-0000-4000-8000-000000000302', 'd0e1a200-0000-4000-8000-000000000502', null, 'clinical_queue', 'd0e1a200-0000-4000-8000-000000000502', 'queue.checked_in', null, 'checked_in', '电话预约到店', '食欲不振', 'employee', 'a6169bb6-71a2-442d-a7cc-5f4652ae858e', '0418fc5c-a089-4556-bb1d-b277beeb0709', 'E2E-ADMIN', 'E2E管理员', 'receptionist', 'frontdesk', now() - interval '45 minutes'),
  ('d0e1a200-0000-4000-8000-000000000e23', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031', 'd0e1a200-0000-4000-8000-000000000103', 'd0e1a200-0000-4000-8000-000000000203', 'd0e1a200-0000-4000-8000-000000000303', 'd0e1a200-0000-4000-8000-000000000503', null, 'clinical_queue', 'd0e1a200-0000-4000-8000-000000000503', 'queue.checked_in', null, 'checked_in', '现场挂号', '皮肤瘙痒', 'employee', 'a6169bb6-71a2-442d-a7cc-5f4652ae858e', '0418fc5c-a089-4556-bb1d-b277beeb0709', 'E2E-ADMIN', 'E2E管理员', 'receptionist', 'frontdesk', now() - interval '40 minutes'),
  ('d0e1a200-0000-4000-8000-000000000e24', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031', 'd0e1a200-0000-4000-8000-000000000103', 'd0e1a200-0000-4000-8000-000000000203', 'd0e1a200-0000-4000-8000-000000000303', 'd0e1a200-0000-4000-8000-000000000503', null, 'triage_assessment', 'd0e1a200-0000-4000-8000-000000000601', 'triage.completed', null, null, null, '二级急症,标记攻击性', 'employee', 'a6169bb6-71a2-442d-a7cc-5f4652ae858e', '0418fc5c-a089-4556-bb1d-b277beeb0709', 'E2E-ADMIN', 'E2E管理员', 'triage_nurse', 'triage', now() - interval '35 minutes'),
  ('d0e1a200-0000-4000-8000-000000000e25', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031', 'd0e1a200-0000-4000-8000-000000000103', 'd0e1a200-0000-4000-8000-000000000203', 'd0e1a200-0000-4000-8000-000000000303', 'd0e1a200-0000-4000-8000-000000000503', null, 'clinical_queue', 'd0e1a200-0000-4000-8000-000000000503', 'queue.waiting', 'triage', 'waiting', '分诊完成进入候诊', null, 'employee', 'a6169bb6-71a2-442d-a7cc-5f4652ae858e', '0418fc5c-a089-4556-bb1d-b277beeb0709', 'E2E-ADMIN', 'E2E管理员', 'triage_nurse', 'triage', now() - interval '35 minutes'),
  ('d0e1a200-0000-4000-8000-000000000e26', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031', 'd0e1a200-0000-4000-8000-000000000104', 'd0e1a200-0000-4000-8000-000000000204', 'd0e1a200-0000-4000-8000-000000000304', 'd0e1a200-0000-4000-8000-000000000504', null, 'clinical_queue', 'd0e1a200-0000-4000-8000-000000000504', 'queue.checked_in', null, 'checked_in', '线上预约到店', '驱虫', 'employee', 'a6169bb6-71a2-442d-a7cc-5f4652ae858e', '0418fc5c-a089-4556-bb1d-b277beeb0709', 'E2E-ADMIN', 'E2E管理员', 'receptionist', 'frontdesk', now() - interval '35 minutes'),
  ('d0e1a200-0000-4000-8000-000000000e27', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031', 'd0e1a200-0000-4000-8000-000000000104', 'd0e1a200-0000-4000-8000-000000000204', 'd0e1a200-0000-4000-8000-000000000304', 'd0e1a200-0000-4000-8000-000000000504', null, 'triage_assessment', 'd0e1a200-0000-4000-8000-000000000602', 'triage.completed', null, null, null, '常规驱虫分诊', 'employee', 'a6169bb6-71a2-442d-a7cc-5f4652ae858e', '0418fc5c-a089-4556-bb1d-b277beeb0709', 'E2E-ADMIN', 'E2E管理员', 'triage_nurse', 'triage', now() - interval '30 minutes'),
  ('d0e1a200-0000-4000-8000-000000000e28', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031', 'd0e1a200-0000-4000-8000-000000000104', 'd0e1a200-0000-4000-8000-000000000204', 'd0e1a200-0000-4000-8000-000000000304', 'd0e1a200-0000-4000-8000-000000000504', null, 'clinical_queue', 'd0e1a200-0000-4000-8000-000000000504', 'queue.waiting', 'triage', 'waiting', '分诊完成进入候诊', null, 'employee', 'a6169bb6-71a2-442d-a7cc-5f4652ae858e', '0418fc5c-a089-4556-bb1d-b277beeb0709', 'E2E-ADMIN', 'E2E管理员', 'triage_nurse', 'triage', now() - interval '30 minutes'),
  ('d0e1a200-0000-4000-8000-000000000e29', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031', 'd0e1a200-0000-4000-8000-000000000104', 'd0e1a200-0000-4000-8000-000000000204', 'd0e1a200-0000-4000-8000-000000000304', 'd0e1a200-0000-4000-8000-000000000504', null, 'clinical_queue', 'd0e1a200-0000-4000-8000-000000000504', 'queue.called', 'waiting', 'called', '叫号至诊室3', null, 'employee', 'a6169bb6-71a2-442d-a7cc-5f4652ae858e', '0418fc5c-a089-4556-bb1d-b277beeb0709', 'E2E-ADMIN', 'E2E管理员', 'receptionist', 'frontdesk', now() - interval '10 minutes'),
  ('d0e1a200-0000-4000-8000-000000000e30', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031', 'd0e1a200-0000-4000-8000-000000000106', 'd0e1a200-0000-4000-8000-000000000206', 'd0e1a200-0000-4000-8000-000000000306', 'd0e1a200-0000-4000-8000-000000000506', null, 'clinical_queue', 'd0e1a200-0000-4000-8000-000000000506', 'queue.checked_in', null, 'checked_in', '电话预约到店', '咳嗽', 'employee', 'a6169bb6-71a2-442d-a7cc-5f4652ae858e', '0418fc5c-a089-4556-bb1d-b277beeb0709', 'E2E-ADMIN', 'E2E管理员', 'receptionist', 'frontdesk', now() - interval '25 minutes'),
  ('d0e1a200-0000-4000-8000-000000000e31', '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154', 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031', 'd0e1a200-0000-4000-8000-000000000106', 'd0e1a200-0000-4000-8000-000000000206', 'd0e1a200-0000-4000-8000-000000000306', 'd0e1a200-0000-4000-8000-000000000506', null, 'clinical_queue', 'd0e1a200-0000-4000-8000-000000000506', 'queue.missed', 'waiting', 'missed', '过号未到诊', null, 'employee', 'a6169bb6-71a2-442d-a7cc-5f4652ae858e', '0418fc5c-a089-4556-bb1d-b277beeb0709', 'E2E-ADMIN', 'E2E管理员', 'receptionist', 'frontdesk', now() - interval '2 minutes')
on conflict (id) do nothing;

-- ============ 12. 验证:各岗位工作台应看到的数据 ============
-- 前台/店长:候诊队列(排除已 closed/cancelled)
select 'frontdesk.manager.queue' as workbench, count(*) as rows_count
from public.clinical_queue_entries
where tenant_id = '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154'
  and store_id = 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031'
  and status in ('checked_in','triage','waiting','called','missed','in_consultation');
-- 分诊:checked_in/triage
select 'triage.queue' as workbench, count(*) as rows_count
from public.clinical_queue_entries
where tenant_id = '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154'
  and store_id = 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031'
  and status in ('checked_in','triage');
-- 医生:waiting/called/in_consultation
select 'doctor.queue' as workbench, count(*) as rows_count
from public.clinical_queue_entries
where tenant_id = '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154'
  and store_id = 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031'
  and status in ('waiting','called','in_consultation');
-- 收银:pending/invoiced 收费项(手动 1 条 + 触发器处方2/血常规/彩超 4 条 = 5 条)
select 'cashier.charges' as workbench, count(*) as rows_count
from public.encounter_charge_items
where tenant_id = '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154'
  and store_id = 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031'
  and status in ('pending','invoiced');
-- 护士/检验/影像/药房/随访:workflow_tasks(触发器生成药房/检验/影像 + 手动护士/随访)
select owner_role, count(*) as rows_count
from public.workflow_tasks
where tenant_id = '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154'
  and store_id = 'b02420f1-9ae5-4c3b-8ae0-ff4f3ebba031'
  and status in ('pending','claimed','in_progress','failed')
group by owner_role
order by owner_role;
-- 时间线:布丁/巧克力各 10 条左右(7 手动 + 3 触发器)
select encounter_id, count(*) as events
from public.patient_journey_events
where tenant_id = '74ab3c8c-0c02-48c0-b5ea-48ec3a80a154'
  and encounter_id in ('d0e1a200-0000-4000-8000-000000000401', 'd0e1a200-0000-4000-8000-000000000402')
group by encounter_id;

-- 恢复事件不可变触发器(清理段开头已禁用,确保脚本结束后事件依然防篡改)
alter table public.patient_journey_events enable trigger trg_patient_journey_events_immutable;

commit;