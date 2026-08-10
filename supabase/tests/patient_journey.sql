-- 多岗位门诊旅程：处方计费、收银作废、留痕不可变、付款门禁。
begin;

create schema if not exists tests;
create or replace function tests.journey_assert(cond boolean, msg text)
returns void language plpgsql as $$ begin if not cond then raise exception 'PATIENT_JOURNEY_TEST_FAILED: %', msg; end if; end $$;

insert into public.tenants (id, slug, name) values
  ('b4b4b4b4-0000-0000-0000-000000000001', 'journey-test', '旅程测试租户')
on conflict (slug) do nothing;
insert into public.stores (id, tenant_id, name, code, status) values
  ('b4b4b4b4-0000-0000-0000-000000000011', 'b4b4b4b4-0000-0000-0000-000000000001', '旅程测试门店', 'JNY-01', 'active')
on conflict (id) do nothing;
insert into auth.users (id, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, aud, role, created_at, updated_at) values
  ('b4b4b4b4-0000-0000-0000-000000000021', 'journey-doctor@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}', '{}', 'authenticated', 'authenticated', now(), now()),
  ('b4b4b4b4-0000-0000-0000-000000000022', 'journey-cashier@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}', '{}', 'authenticated', 'authenticated', now(), now())
on conflict (id) do nothing;
insert into public.tenant_memberships (tenant_id, user_id, status) values
  ('b4b4b4b4-0000-0000-0000-000000000001', 'b4b4b4b4-0000-0000-0000-000000000021', 'active'),
  ('b4b4b4b4-0000-0000-0000-000000000001', 'b4b4b4b4-0000-0000-0000-000000000022', 'active')
on conflict (tenant_id, user_id) do nothing;
insert into public.employees (id, tenant_id, user_id, employee_no, name, status) values
  ('b4b4b4b4-0000-0000-0000-000000000031', 'b4b4b4b4-0000-0000-0000-000000000001', 'b4b4b4b4-0000-0000-0000-000000000021', 'JNY-D01', '测试医生', 'active'),
  ('b4b4b4b4-0000-0000-0000-000000000032', 'b4b4b4b4-0000-0000-0000-000000000001', 'b4b4b4b4-0000-0000-0000-000000000022', 'JNY-C01', '测试收银员', 'active')
on conflict (id) do nothing;
insert into public.employee_store_assignments (tenant_id, employee_id, store_id, is_primary) values
  ('b4b4b4b4-0000-0000-0000-000000000001', 'b4b4b4b4-0000-0000-0000-000000000031', 'b4b4b4b4-0000-0000-0000-000000000011', true),
  ('b4b4b4b4-0000-0000-0000-000000000001', 'b4b4b4b4-0000-0000-0000-000000000032', 'b4b4b4b4-0000-0000-0000-000000000011', true)
on conflict (employee_id, store_id) do nothing;
insert into public.employee_role_assignments (tenant_id, employee_id, role_id, store_id) values
  ('b4b4b4b4-0000-0000-0000-000000000001', 'b4b4b4b4-0000-0000-0000-000000000031', (select id from public.roles where code='doctor'), 'b4b4b4b4-0000-0000-0000-000000000011'),
  ('b4b4b4b4-0000-0000-0000-000000000001', 'b4b4b4b4-0000-0000-0000-000000000032', (select id from public.roles where code='cashier'), 'b4b4b4b4-0000-0000-0000-000000000011')
on conflict do nothing;

insert into public.customers (id, tenant_id, store_id, customer_no, name, status) values
  ('b4b4b4b4-0000-0000-0000-000000000041', 'b4b4b4b4-0000-0000-0000-000000000001', 'b4b4b4b4-0000-0000-0000-000000000011', 'JNY-CUST', '测试客户', 'active');
insert into public.pets (id, tenant_id, customer_id, name, species, status) values
  ('b4b4b4b4-0000-0000-0000-000000000051', 'b4b4b4b4-0000-0000-0000-000000000001', 'b4b4b4b4-0000-0000-0000-000000000041', '球球', '犬', 'active');
insert into public.encounters (id, tenant_id, store_id, customer_id, pet_id, doctor_id, status, clinical_status, archive_status) values
  ('b4b4b4b4-0000-0000-0000-000000000061', 'b4b4b4b4-0000-0000-0000-000000000001', 'b4b4b4b4-0000-0000-0000-000000000011', 'b4b4b4b4-0000-0000-0000-000000000041', 'b4b4b4b4-0000-0000-0000-000000000051', 'b4b4b4b4-0000-0000-0000-000000000021', 'in_progress', 'active', 'draft');
insert into public.catalog_items (id, tenant_id, code, name, default_price, billing_type) values
  ('b4b4b4b4-0000-0000-0000-000000000071', 'b4b4b4b4-0000-0000-0000-000000000001', 'JNY-DRUG', '测试药品', 28.50, 'drug');

insert into public.prescriptions (
  id, tenant_id, store_id, encounter_id, customer_id, pet_id, doctor_id, status,
  prescriber_employee_id, prescriber_user_id
) values (
  'b4b4b4b4-0000-0000-0000-000000000081', 'b4b4b4b4-0000-0000-0000-000000000001',
  'b4b4b4b4-0000-0000-0000-000000000011', 'b4b4b4b4-0000-0000-0000-000000000061',
  'b4b4b4b4-0000-0000-0000-000000000041', 'b4b4b4b4-0000-0000-0000-000000000051',
  'b4b4b4b4-0000-0000-0000-000000000021', 'draft',
  'b4b4b4b4-0000-0000-0000-000000000031', 'b4b4b4b4-0000-0000-0000-000000000021');
insert into public.prescription_items (id, prescription_id, catalog_item_id, drug_name, quantity) values
  ('b4b4b4b4-0000-0000-0000-000000000091', 'b4b4b4b4-0000-0000-0000-000000000081', 'b4b4b4b4-0000-0000-0000-000000000071', '测试药品', 2);

update public.prescriptions set status='issued', issued_at=now() where id='b4b4b4b4-0000-0000-0000-000000000081';

do $$ begin
  perform tests.journey_assert((select count(*)=1 from public.encounter_charge_items where source_type='prescription' and source_id='b4b4b4b4-0000-0000-0000-000000000081'), '处方应只生成一个待付款明细');
  perform tests.journey_assert((select amount=57.00 and status='pending' from public.encounter_charge_items where source_id='b4b4b4b4-0000-0000-0000-000000000081'), '待付款金额应按目录价和数量计算');
  perform tests.journey_assert((select count(*)=1 from public.workflow_tasks where source_type='prescription' and owner_role='pharmacist'), '应生成药房任务');
  perform tests.journey_assert((select count(*)=1 from public.patient_journey_events where event_type='prescription.issued' and actor_employee_no='JNY-D01'), '处方开具事件应记录医生快照');
end $$;

select public.void_encounter_charge_item(
  (select id from public.encounter_charge_items where source_id='b4b4b4b4-0000-0000-0000-000000000081'),
  '客户对药品条目提出异议', 'b4b4b4b4-0000-0000-0000-000000000032', 'cashier',
  'workbench.cashier', 'journey-test-request', 'journey-void-1'
);

do $$
declare v_event uuid;
begin
  perform tests.journey_assert((select status='voided' and void_reason='客户对药品条目提出异议' and voided_by_employee_id='b4b4b4b4-0000-0000-0000-000000000032' from public.encounter_charge_items where source_id='b4b4b4b4-0000-0000-0000-000000000081'), '作废应保留原因和收银员');
  select id into v_event from public.patient_journey_events where event_type='charge_item.voided';
  perform tests.journey_assert(v_event is not null, '作废必须产生旅程事件');
  begin update public.patient_journey_events set reason='篡改' where id=v_event;
    raise exception 'PATIENT_JOURNEY_TEST_FAILED: 事件不应允许修改';
  exception when check_violation then null; end;
end $$;

rollback;
