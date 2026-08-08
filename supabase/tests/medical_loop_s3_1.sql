-- ============================================================
-- 医疗闭环数据库层测试:S31 并发任务 C(migration 44~49 + 115)
--
-- 验证「医嘱 → 护士任务 → 检验标本 → 危急值确认 → 医嘱-检验关联 →
-- 病程记录(草稿 → 签署不可变)→ 出院结算」整条 SQL/RPC/RLS 闭环,
-- 以及 S3.1 审计 Source Gate 的两个新增约束:
--   - P0-02:signed progress note 不可 direct UPDATE / DELETE
--     (RLS 层 status='draft' + Trigger 层 SIGNED_PROGRESS_NOTE_IMMUTABLE,
--      受控流程经 set_config 显式放行)
--   - P0-01:discharge_patient Forward Fix(出院释放笼位)
--
-- 断言矩阵:
--   ML1  权限矩阵:store_manager 持有 progress/settlement/lab_sample/lab_critical 权限,
--        无角色员工全无
--   ML2  admit_patient 入院:cage → occupied,admission → admitted
--   ML3  create_medical_order:医嘱 + 自动生成护士任务(source 幂等,仅 1 条)
--   ML4  complete_nurse_task:任务完成 → 医嘱自动 completed
--   ML5  医嘱幂等:同 idempotency_key 不重复创建
--   ML6  lab sample 流转:planned→collected→received→testing→completed;
--        非法跳转拒绝;rejected 必填原因;全部完成联动 lab_order → collected
--   ML7  危急值:先通知后确认;未通知确认拒绝;pending→acknowledged→resolved 状态机
--   ML8  link_medical_lab_ref:同租户关联成功、幂等;跨租户拒绝
--   ML9  progress draft 可改;sign 后:
--        - authenticated 直连 UPDATE/DELETE 被 RLS 拦截(0 行)
--        - superuser 直连 UPDATE/DELETE 被 Trigger 拦截(SIGNED_PROGRESS_NOTE_IMMUTABLE)
--        - set_config 显式放行后受控修改/删除成功
--   ML10 出院结算:prepare→settle(超付拒绝)→finalize,笼位释放、admission discharged
--   ML11 P0-01 discharge_patient Forward Fix:出院后 cage=available、admission=discharged;
--        重复出院拒绝
--   ML12 RBAC 隔离:B 店长/无权限员工读不到 A 租户病程;A 店长可读本店病程
--
-- 执行方式(需要可运行的 Supabase 数据库):
--   1) supabase db reset
--   2) psql "$DATABASE_URL" -f supabase/tests/medical_loop_s3_1.sql
--
-- 自包含、单一事务(begin/rollback 无残留),不依赖其他测试文件。
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
    raise exception 'MEDICAL_LOOP_TEST_FAILED: %', msg;
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
    raise exception 'MEDICAL_LOOP_TEST_FAILED: % 应抛出含 % 的错误,实际: %',
      p_name, p_expected, coalesce(v_msg, '无异常(调用成功)');
  end if;
end;
$$;

-- ---------- 夹具:两租户 / 三用户 ----------
-- 租户 A:门店 A1(主测试);租户 B:门店 B1(隔离测试)
-- 用户:u_a1(A/A1 store_manager,医疗闭环全权限)、u_a2(A/A1 无角色)、u_b1(B/B1 store_manager)
insert into public.tenants (id, slug, name) values
  ('a3a3a3a3-0000-0000-0000-000000000001', 'med-loop-tenant-a', '医疗闭环租户A'),
  ('a3a3a3a3-0000-0000-0000-000000000002', 'med-loop-tenant-b', '医疗闭环租户B')
on conflict (slug) do nothing;

insert into public.stores (id, tenant_id, name, code, status) values
  ('a3a3a3a3-0000-0000-0000-000000000011', 'a3a3a3a3-0000-0000-0000-000000000001', 'A1 店', 'MLO-A1', 'active'),
  ('a3a3a3a3-0000-0000-0000-000000000012', 'a3a3a3a3-0000-0000-0000-000000000002', 'B1 店', 'MLO-B1', 'active')
on conflict (id) do nothing;

insert into auth.users (id, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, aud, role, created_at, updated_at)
values
  ('a3a3a3a3-0000-0000-0000-000000000021', 'u-mlo-a1@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now()),
  ('a3a3a3a3-0000-0000-0000-000000000022', 'u-mlo-a2@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now()),
  ('a3a3a3a3-0000-0000-0000-000000000023', 'u-mlo-b1@test.local', crypt('password', gen_salt('bf')), now(), '{"provider":"email"}'::jsonb, '{}'::jsonb, 'authenticated', 'authenticated', now(), now())
on conflict (id) do nothing;

insert into public.tenant_memberships (tenant_id, user_id, status) values
  ('a3a3a3a3-0000-0000-0000-000000000001', 'a3a3a3a3-0000-0000-0000-000000000021', 'active'),
  ('a3a3a3a3-0000-0000-0000-000000000001', 'a3a3a3a3-0000-0000-0000-000000000022', 'active'),
  ('a3a3a3a3-0000-0000-0000-000000000002', 'a3a3a3a3-0000-0000-0000-000000000023', 'active')
on conflict (tenant_id, user_id) do nothing;

insert into public.employees (id, tenant_id, user_id, employee_no, name, status) values
  ('a3a3a3a3-0000-0000-0000-000000000031', 'a3a3a3a3-0000-0000-0000-000000000001', 'a3a3a3a3-0000-0000-0000-000000000021', 'EMP-MLO-A1', 'A1 店长', 'active'),
  ('a3a3a3a3-0000-0000-0000-000000000032', 'a3a3a3a3-0000-0000-0000-000000000001', 'a3a3a3a3-0000-0000-0000-000000000022', 'EMP-MLO-A2', 'A1 无权限', 'active'),
  ('a3a3a3a3-0000-0000-0000-000000000033', 'a3a3a3a3-0000-0000-0000-000000000002', 'a3a3a3a3-0000-0000-0000-000000000023', 'EMP-MLO-B1', 'B1 店长', 'active')
on conflict (id) do nothing;

insert into public.employee_store_assignments (tenant_id, employee_id, store_id, is_primary) values
  ('a3a3a3a3-0000-0000-0000-000000000001', 'a3a3a3a3-0000-0000-0000-000000000031', 'a3a3a3a3-0000-0000-0000-000000000011', true),
  ('a3a3a3a3-0000-0000-0000-000000000001', 'a3a3a3a3-0000-0000-0000-000000000032', 'a3a3a3a3-0000-0000-0000-000000000011', true),
  ('a3a3a3a3-0000-0000-0000-000000000002', 'a3a3a3a3-0000-0000-0000-000000000033', 'a3a3a3a3-0000-0000-0000-000000000012', true)
on conflict (employee_id, store_id) do nothing;

-- 角色:u_a1 / u_b1 = store_manager(医疗闭环全权限);u_a2 无任何角色
insert into public.employee_role_assignments (tenant_id, employee_id, role_id, store_id)
values
  ('a3a3a3a3-0000-0000-0000-000000000001', 'a3a3a3a3-0000-0000-0000-000000000031',
   (select id from public.roles where code = 'store_manager'), 'a3a3a3a3-0000-0000-0000-000000000011'),
  ('a3a3a3a3-0000-0000-0000-000000000002', 'a3a3a3a3-0000-0000-0000-000000000033',
   (select id from public.roles where code = 'store_manager'), 'a3a3a3a3-0000-0000-0000-000000000012')
on conflict do nothing;

-- ---------- 病房 / 笼位夹具(A1 店两笼位供入院 + 出院测试) ----------
insert into public.rooms (id, tenant_id, store_id, name, code, room_type, capacity, is_active) values
  ('a3a3a3a3-0000-0000-0000-000000000041', 'a3a3a3a3-0000-0000-0000-000000000001', 'a3a3a3a3-0000-0000-0000-000000000011', 'A1 病房', 'MLO-R1', 'ward', 10, true)
on conflict (id) do nothing;

insert into public.cages (id, tenant_id, store_id, room_id, name, code, cage_type, daily_rate, status) values
  ('a3a3a3a3-0000-0000-0000-000000000051', 'a3a3a3a3-0000-0000-0000-000000000001', 'a3a3a3a3-0000-0000-0000-000000000011', 'a3a3a3a3-0000-0000-0000-000000000041', 'A1-1 号笼', 'MLO-C1', 'cage', 80.00, 'available'),
  ('a3a3a3a3-0000-0000-0000-000000000052', 'a3a3a3a3-0000-0000-0000-000000000001', 'a3a3a3a3-0000-0000-0000-000000000011', 'a3a3a3a3-0000-0000-0000-000000000041', 'A1-2 号笼', 'MLO-C2', 'cage', 80.00, 'available')
on conflict (id) do nothing;

-- 固定客户/宠物 id(跨 migration 无 FK,直接用固定 UUID)
-- customer_id: 'a3a3a3a3-0000-0000-0000-000000000061'
-- pet_id:      'a3a3a3a3-0000-0000-0000-000000000071'

-- ============================================================
-- ML1 权限矩阵:store_manager 全权限;无角色员工全无
-- ============================================================
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"a3a3a3a3-0000-0000-0000-000000000021","role":"authenticated"}', true);
  perform tests.assert_true(
    public.has_permission('a3a3a3a3-0000-0000-0000-000000000001', 'a3a3a3a3-0000-0000-0000-000000000011', 'progress.view'),
    'A1 店长应持有 progress.view');
  perform tests.assert_true(
    public.has_permission('a3a3a3a3-0000-0000-0000-000000000001', 'a3a3a3a3-0000-0000-0000-000000000011', 'progress.sign'),
    'A1 店长应持有 progress.sign');
  perform tests.assert_true(
    public.has_permission('a3a3a3a3-0000-0000-0000-000000000001', 'a3a3a3a3-0000-0000-0000-000000000011', 'settlement.execute'),
    'A1 店长应持有 settlement.execute');
  perform tests.assert_true(
    public.has_permission('a3a3a3a3-0000-0000-0000-000000000001', 'a3a3a3a3-0000-0000-0000-000000000011', 'lab_sample.execute'),
    'A1 店长应持有 lab_sample.execute');
  perform tests.assert_true(
    public.has_permission('a3a3a3a3-0000-0000-0000-000000000001', 'a3a3a3a3-0000-0000-0000-000000000011', 'lab_critical.execute'),
    'A1 店长应持有 lab_critical.execute');
end;
$$;

-- 无角色员工:医疗闭环权限全无
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"a3a3a3a3-0000-0000-0000-000000000022","role":"authenticated"}', true);
  perform tests.assert_true(
    not public.has_permission('a3a3a3a3-0000-0000-0000-000000000001', 'a3a3a3a3-0000-0000-0000-000000000011', 'progress.view'),
    'A1 无角色员工不应持有 progress.view');
  perform tests.assert_true(
    not public.has_permission('a3a3a3a3-0000-0000-0000-000000000001', 'a3a3a3a3-0000-0000-0000-000000000011', 'settlement.view'),
    'A1 无角色员工不应持有 settlement.view');
end;
$$;

-- ============================================================
-- ML2 入院:admit_patient → admission admitted + cage occupied
-- ============================================================
do $$
declare
  v_res jsonb;
  v_admission_id uuid;
begin
  execute 'reset role';
  v_res := public.admit_patient(
    'a3a3a3a3-0000-0000-0000-000000000001',
    'a3a3a3a3-0000-0000-0000-000000000011',
    'a3a3a3a3-0000-0000-0000-000000000061',
    'a3a3a3a3-0000-0000-0000-000000000071',
    'a3a3a3a3-0000-0000-0000-000000000051',
    null, '住院观察', 'a3a3a3a3-0000-0000-0000-000000000021', null
  );
  v_admission_id := (v_res->>'admissionId')::uuid;
  perform tests.assert_true(v_res->>'status' = 'admitted', 'admit_patient 应返回 admitted');

  perform tests.assert_true(
    (select status from public.admissions where id = v_admission_id) = 'admitted',
    'admission 状态应为 admitted');
  perform tests.assert_true(
    (select status from public.cages where id = 'a3a3a3a3-0000-0000-0000-000000000051') = 'occupied',
    '笼位应被占用 occupied');
  perform tests.assert_true(
    (select current_admission_id from public.cages where id = 'a3a3a3a3-0000-0000-0000-000000000051') = v_admission_id,
    '笼位 current_admission_id 应指向本 admission');
end;
$$;

-- ============================================================
-- ML3 医嘱 → 护士任务:create_medical_order 自动生成任务(source 幂等)
-- ============================================================
do $$
declare
  v_res jsonb;
  v_order_id uuid;
  v_task_id uuid;
  v_task_cnt integer;
begin
  execute 'reset role';
  v_res := public.create_medical_order(
    'a3a3a3a3-0000-0000-0000-000000000001',
    'a3a3a3a3-0000-0000-0000-000000000011',
    'a3a3a3a3-0000-0000-0000-000000000071',
    'a3a3a3a3-0000-0000-0000-000000000061',
    null, null, 'medication', '静脉输液', '250ml', 'qd', 1, '瓶',
    '每小时观察一次', now(), 'a3a3a3a3-0000-0000-0000-000000000021',
    'a3a3a3a3-0000-0000-0000-000000000021', 'mlo-order-key-001'
  );
  v_order_id := (v_res->>'orderId')::uuid;
  v_task_id := (v_res->>'taskId')::uuid;
  perform tests.assert_true(v_res->>'status' = 'active', '医嘱初始状态应为 active');
  perform tests.assert_true(v_task_id is not null, '开立医嘱应自动生成护士任务');

  -- source 幂等:同 source 仅一条任务
  select count(*) into v_task_cnt
  from public.nurse_tasks
  where source_type = 'medical_order' and source_id = v_order_id;
  perform tests.assert_true(v_task_cnt = 1, '同医嘱应仅生成 1 条护士任务(source 幂等)');

  perform tests.assert_true(
    (select status from public.nurse_tasks where id = v_task_id) = 'pending',
    '护士任务初始状态应为 pending');
  perform tests.assert_true(
    (select task_type from public.nurse_tasks where id = v_task_id) = 'medication',
    'medication 医嘱应映射为 medication 任务');
end;
$$;

-- ============================================================
-- ML4 完成任务:complete_nurse_task → 医嘱自动 completed
-- ============================================================
do $$
declare
  v_task_id uuid;
  v_order_id uuid;
begin
  execute 'reset role';
  select nt.id, nt.source_id into v_task_id, v_order_id
  from public.nurse_tasks nt
  where nt.source_type = 'medical_order'
    and nt.tenant_id = 'a3a3a3a3-0000-0000-0000-000000000001'
  limit 1;

  perform public.complete_nurse_task(v_task_id, 'a3a3a3a3-0000-0000-0000-000000000021', '已完成');

  perform tests.assert_true(
    (select status from public.nurse_tasks where id = v_task_id) = 'completed',
    '护士任务应转为 completed');
  perform tests.assert_true(
    (select status from public.medical_orders where id = v_order_id) = 'completed',
    '全部任务完成后医嘱应自动 completed');
end;
$$;

-- ============================================================
-- ML5 医嘱幂等:同 idempotency_key 不重复创建
-- ============================================================
do $$
declare
  v_res1 jsonb;
  v_res2 jsonb;
begin
  execute 'reset role';
  v_res1 := public.create_medical_order(
    'a3a3a3a3-0000-0000-0000-000000000001',
    'a3a3a3a3-0000-0000-0000-000000000011',
    'a3a3a3a3-0000-0000-0000-000000000071',
    'a3a3a3a3-0000-0000-0000-000000000061',
    null, null, 'treatment', '换药', null, 'qd', 1, null,
    null, null, null, 'a3a3a3a3-0000-0000-0000-000000000021', 'mlo-order-key-002'
  );
  v_res2 := public.create_medical_order(
    'a3a3a3a3-0000-0000-0000-000000000001',
    'a3a3a3a3-0000-0000-0000-000000000011',
    'a3a3a3a3-0000-0000-0000-000000000071',
    'a3a3a3a3-0000-0000-0000-000000000061',
    null, null, 'treatment', '换药', null, 'qd', 1, null,
    null, null, null, 'a3a3a3a3-0000-0000-0000-000000000021', 'mlo-order-key-002'
  );
  perform tests.assert_true(v_res1->>'orderId' = v_res2->>'orderId', '同 idempotency_key 应返回同一医嘱(幂等)');
end;
$$;

-- ============================================================
-- ML6 检验标本流转:create_lab_sample + transition_lab_sample
-- ============================================================
do $$
declare
  v_sample_id uuid;
  v_order_status text;
begin
  execute 'reset role';
  -- 直接插入检验申请(service 层直连,RLS 由 service role 绕过)
  insert into public.lab_orders (id, tenant_id, store_id, customer_id, pet_id, order_no, status, requested_by, remark)
  values (
    'a3a3a3a3-0000-0000-0000-000000000081',
    'a3a3a3a3-0000-0000-0000-000000000001',
    'a3a3a3a3-0000-0000-0000-000000000011',
    'a3a3a3a3-0000-0000-0000-000000000061',
    'a3a3a3a3-0000-0000-0000-000000000071',
    'MLO-LAB-001', 'requested', 'a3a3a3a3-0000-0000-0000-000000000021', '血常规'
  )
  on conflict (id) do nothing;

  -- 创建标本
  v_sample_id := (public.create_lab_sample(
    'a3a3a3a3-0000-0000-0000-000000000081',
    'blood', 'a3a3a3a3-0000-0000-0000-000000000021',
    'EDTA 抗凝管', '2-8℃', '住院常规'
  )).id;
  perform tests.assert_true(
    (select status from public.lab_samples where id = v_sample_id) = 'planned',
    '标本初始状态应为 planned');

  -- 非法跳转:testing → collected 拒绝
  perform public.transition_lab_sample(v_sample_id, 'testing', 'a3a3a3a3-0000-0000-0000-000000000021', null);
  perform tests.assert_raises(
    'select public.transition_lab_sample(''' || v_sample_id || ''', ''collected'', null, null)',
    'INVALID_SAMPLE_TRANSITION',
    'testing → collected 跳转应被拒绝'
  );
  -- 拒收必填原因
  perform tests.assert_raises(
    'select public.transition_lab_sample(''' || v_sample_id || ''', ''rejected'', null, null)',
    'REJECT_REASON_REQUIRED',
    'rejected 必须填写原因'
  );
  -- 合法流转:testing → completed
  perform public.transition_lab_sample(v_sample_id, 'completed', 'a3a3a3a3-0000-0000-0000-000000000021', null);
  perform tests.assert_true(
    (select status from public.lab_samples where id = v_sample_id) = 'completed',
    '标本应转为 completed'
  );

  -- 联动:全部标本 completed → lab_order → collected
  select status into v_order_status from public.lab_orders where id = 'a3a3a3a3-0000-0000-0000-000000000081';
  perform tests.assert_true(v_order_status = 'collected', '全部标本完成后 lab_order 应联动为 collected');
end;
$$;

-- ============================================================
-- ML7 危急值:notify → ack(未通知确认拒绝;跳级拒绝)
-- ============================================================
do $$
declare
  v_alert_id uuid := 'a3a3a3a3-0000-0000-0000-000000000091';
  v_res public.critical_value_alerts;
begin
  execute 'reset role';
  insert into public.critical_value_alerts (id, tenant_id, store_id, lab_order_id, pet_id, alert_level, message, status)
  values (
    v_alert_id,
    'a3a3a3a3-0000-0000-0000-000000000001',
    'a3a3a3a3-0000-0000-0000-000000000011',
    'a3a3a3a3-0000-0000-0000-000000000081',
    'a3a3a3a3-0000-0000-0000-000000000071',
    'critical', '血糖危急值 GLU-H 22.5 mmol/L', 'pending'
  )
  on conflict (id) do nothing;

  -- 未通知直接确认 → 拒绝(闭环强制 critical → notify → acknowledge)
  perform tests.assert_raises(
    'select public.ack_critical_value(''' || v_alert_id || ''', ''acknowledged'', null, null)',
    'CRITICAL_NOT_NOTIFIED',
    '未通知的危急值不可直接确认'
  );
  -- 跳级:pending → resolved 拒绝
  perform tests.assert_raises(
    'select public.ack_critical_value(''' || v_alert_id || ''', ''resolved'', null, null)',
    'INVALID_CRITICAL_TRANSITION',
    '危急值禁止 pending → resolved 跳级'
  );

  -- 通知
  perform public.notify_critical_value(v_alert_id, 'a3a3a3a3-0000-0000-0000-000000000021', 'phone');
  perform tests.assert_true(
    (select notified_at is not null from public.critical_value_alerts where id = v_alert_id),
    'notify 后应记录 notified_at'
  );

  -- 确认
  v_res := public.ack_critical_value(v_alert_id, 'acknowledged', 'a3a3a3a3-0000-0000-0000-000000000021', '已电话通知医生');
  perform tests.assert_true(v_res.status = 'acknowledged', '危急值应转为 acknowledged');

  -- 解除
  v_res := public.ack_critical_value(v_alert_id, 'resolved', 'a3a3a3a3-0000-0000-0000-000000000021', null);
  perform tests.assert_true(v_res.status = 'resolved', '危急值应转为 resolved');
end;
$$;

-- ============================================================
-- ML8 医嘱-检验关联:link_medical_lab_ref(同租户成功/幂等,跨租户拒绝)
-- ============================================================
do $$
declare
  v_order_a uuid;
  v_order_b uuid;
  v_ref_id uuid;
  v_ref2_id uuid;
begin
  execute 'reset role';
  -- A 租户医嘱(ML3 已完成的医嘱)
  select id into v_order_a from public.medical_orders
  where tenant_id = 'a3a3a3a3-0000-0000-0000-000000000001'
  limit 1;

  -- 关联:同租户成功
  v_ref_id := (public.link_medical_lab_ref(v_order_a, 'a3a3a3a3-0000-0000-0000-000000000081', 'order_request', 'a3a3a3a3-0000-0000-0000-000000000021')).id;
  perform tests.assert_true(v_ref_id is not null, '同租户医嘱-检验关联应成功');

  -- 幂等:重复关联返回原记录
  v_ref2_id := (public.link_medical_lab_ref(v_order_a, 'a3a3a3a3-0000-0000-0000-000000000081', 'order_request', 'a3a3a3a3-0000-0000-0000-000000000021')).id;
  perform tests.assert_true(v_ref2_id = v_ref_id, '重复关联应幂等返回原记录');

  -- 跨租户拒绝:B 租户医嘱 + A 租户检验
  v_order_b := (public.create_medical_order(
    'a3a3a3a3-0000-0000-0000-000000000002',
    'a3a3a3a3-0000-0000-0000-000000000012',
    'a3a3a3a3-0000-0000-0000-000000000071',
    null, null, null, 'treatment', 'B 店治疗', null, 'qd', 1, null,
    null, null, null, 'a3a3a3a3-0000-0000-0000-000000000023', 'mlo-order-b-001'
  )->>'orderId')::uuid;

  -- B 租户检验申请
  insert into public.lab_orders (id, tenant_id, store_id, customer_id, pet_id, order_no, status, requested_by)
  values (
    'a3a3a3a3-0000-0000-0000-000000000082',
    'a3a3a3a3-0000-0000-0000-000000000002',
    'a3a3a3a3-0000-0000-0000-000000000012',
    'a3a3a3a3-0000-0000-0000-000000000061',
    'a3a3a3a3-0000-0000-0000-000000000071',
    'MLO-LAB-B-001', 'requested', 'a3a3a3a3-0000-0000-0000-000000000023'
  )
  on conflict (id) do nothing;

  -- B 医嘱 + A 检验 → 跨租户拒绝
  perform tests.assert_raises(
    'select public.link_medical_lab_ref(''' || v_order_b || ''', ''a3a3a3a3-0000-0000-0000-000000000081'', ''order_request'', null)',
    'CROSS_TENANT_REF',
    '跨租户医嘱-检验关联应被拒绝'
  );
end;
$$;

-- ============================================================
-- ML9 病程记录:草稿可改 → 签署后不可变(RLS + Trigger 双层)
-- ============================================================
do $$
declare
  v_admission_id uuid;
  v_note_id uuid;
  v_updated uuid;
  v_deleted uuid;
  v_note_del_id uuid;
begin
  execute 'reset role';
  select id into v_admission_id from public.admissions
  where tenant_id = 'a3a3a3a3-0000-0000-0000-000000000001'
  limit 1;

  -- 创建病程(草稿)
  v_note_id := (public.create_progress_note(
    v_admission_id, '住院第 1 天,精神尚可,食欲正常', 'daily',
    now(), 'a3a3a3a3-0000-0000-0000-000000000021'
  )).id;
  perform tests.assert_true(
    (select status from public.inpatient_progress_notes where id = v_note_id) = 'draft',
    '病程初始状态应为 draft'
  );

  -- 草稿可直接修改(无 Trigger 拦截)
  update public.inpatient_progress_notes
  set content = '住院第 1 天,精神尚可,食欲正常(复查)'
  where id = v_note_id;
  perform tests.assert_true(
    (select content from public.inpatient_progress_notes where id = v_note_id) like '%复查%',
    '草稿病程应可直接修改'
  );

  -- 签署
  perform public.sign_progress_note(v_note_id, 'a3a3a3a3-0000-0000-0000-000000000021');
  perform tests.assert_true(
    (select status from public.inpatient_progress_notes where id = v_note_id) = 'signed',
    '签署后病程应为 signed'
  );

  -- 层 1:authenticated 直连 UPDATE 被 RLS 拦截(0 行)
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"a3a3a3a3-0000-0000-0000-000000000021","role":"authenticated"}', true);
  v_updated := null;
  update public.inpatient_progress_notes set content = 'RLS 篡改尝试'
  where id = v_note_id
  returning id into v_updated;
  perform tests.assert_true(v_updated is null, 'signed 病程被 authenticated 直连 UPDATE 应被 RLS 拦截(0 行)');

  -- 层 1:authenticated 直连 DELETE 被 RLS 拦截(0 行)
  v_deleted := null;
  delete from public.inpatient_progress_notes where id = v_note_id
  returning id into v_deleted;
  perform tests.assert_true(v_deleted is null, 'signed 病程被 authenticated 直连 DELETE 应被 RLS 拦截(0 行)');

  -- 层 2:superuser(绕过 RLS)直连 UPDATE 被 Trigger 拦截
  execute 'reset role';
  perform tests.assert_raises(
    'update public.inpatient_progress_notes set content = ''service 篡改'' where id = ''' || v_note_id || '''',
    'SIGNED_PROGRESS_NOTE_IMMUTABLE',
    'signed 病程被直连 UPDATE 应被 Trigger 拦截'
  );

  -- 层 2:superuser 直连 DELETE 被 Trigger 拦截
  perform tests.assert_raises(
    'delete from public.inpatient_progress_notes where id = ''' || v_note_id || '''',
    'SIGNED_PROGRESS_NOTE_IMMUTABLE',
    'signed 病程被直连 DELETE 应被 Trigger 拦截'
  );

  -- 受控放行:set_config('app.allow_signed_note_update') → 修改成功(Amendment 等受控流程)
  perform set_config('app.allow_signed_note_update', 'true', true);
  update public.inpatient_progress_notes set content = '经受控流程修正'
  where id = v_note_id;
  perform set_config('app.allow_signed_note_update', 'false', true);
  perform tests.assert_true(
    (select content from public.inpatient_progress_notes where id = v_note_id) = '经受控流程修正',
    'set_config 显式放行后受控 UPDATE 应成功'
  );

  -- 受控放行删除:另建一张病程并签署后删除
  v_note_del_id := (public.create_progress_note(
    v_admission_id, '待删除的已签署病程', 'daily',
    now(), 'a3a3a3a3-0000-0000-0000-000000000021'
  )).id;
  perform public.sign_progress_note(v_note_del_id, 'a3a3a3a3-0000-0000-0000-000000000021');
  perform set_config('app.allow_signed_note_delete', 'true', true);
  delete from public.inpatient_progress_notes where id = v_note_del_id;
  perform set_config('app.allow_signed_note_delete', 'false', true);
  perform tests.assert_true(
    (select count(*) from public.inpatient_progress_notes where id = v_note_del_id) = 0,
    'set_config 显式放行后受控 DELETE 应成功'
  );
end;
$$;

-- ============================================================
-- ML10 出院结算:prepare → settle(超付拒绝)→ finalize
-- ============================================================
do $$
declare
  v_admission_id uuid;
  v_res jsonb;
  v_receivable numeric;
begin
  execute 'reset role';
  select id into v_admission_id from public.admissions
  where tenant_id = 'a3a3a3a3-0000-0000-0000-000000000001'
  limit 1;

  -- 手工插入住院费用(确定金额,避免依赖全库扫描)
  insert into public.inpatient_charges (tenant_id, store_id, admission_id, charge_date, description, quantity, unit_price, amount, is_auto)
  values (
    'a3a3a3a3-0000-0000-0000-000000000001',
    'a3a3a3a3-0000-0000-0000-000000000011',
    v_admission_id, current_date, '住院诊疗费', 1, 150, 150, false
  );

  -- 准备结算
  v_res := public.prepare_settlement(v_admission_id, 'a3a3a3a3-0000-0000-0000-000000000021');
  v_receivable := (v_res->>'receivableAmount')::numeric;
  perform tests.assert_true(v_res->>'settlementStatus' = 'prepared', 'prepare_settlement 应返回 prepared');
  perform tests.assert_true(v_receivable = 150, '应收应为住院费用汇总 150');

  -- 重复 prepare 幂等
  v_res := public.prepare_settlement(v_admission_id, 'a3a3a3a3-0000-0000-0000-000000000021');
  perform tests.assert_true(v_res->>'settlementStatus' = 'prepared', '重复 prepare 应幂等返回 prepared');

  -- 超付拒绝
  perform tests.assert_raises(
    'select public.settle_admission(''' || v_admission_id || ''', 999, ''cash'', null)',
    'PAID_EXCEEDS_PAYABLE',
    '实收超过应付应被拒绝'
  );

  -- 正常收款
  v_res := public.settle_admission(v_admission_id, 150, 'cash', 'a3a3a3a3-0000-0000-0000-000000000021');
  perform tests.assert_true(v_res->>'settlementStatus' = 'settled', 'settle_admission 应返回 settled');

  -- 完成结算并出院
  v_res := public.finalize_settlement(v_admission_id, 'a3a3a3a3-0000-0000-0000-000000000021');
  perform tests.assert_true(v_res->>'settlementStatus' = 'finalized', 'finalize_settlement 应返回 finalized');
  perform tests.assert_true(v_res->>'status' = 'discharged', '结算完成后 admission 应为 discharged');
  perform tests.assert_true(
    (select status from public.cages where id = 'a3a3a3a3-0000-0000-0000-000000000051') = 'available',
    '结算完成后笼位应释放为 available');
end;
$$;

-- ============================================================
-- ML11 P0-01 discharge_patient Forward Fix(直接出院释放笼位)
-- ============================================================
do $$
declare
  v_res jsonb;
  v_admission_id uuid;
begin
  execute 'reset role';
  -- 第二笼位再次入院
  v_res := public.admit_patient(
    'a3a3a3a3-0000-0000-0000-000000000001',
    'a3a3a3a3-0000-0000-0000-000000000011',
    'a3a3a3a3-0000-0000-0000-000000000061',
    'a3a3a3a3-0000-0000-0000-000000000071',
    'a3a3a3a3-0000-0000-0000-000000000052',
    null, '门诊转住院', 'a3a3a3a3-0000-0000-0000-000000000021', 'mlo-admit-key-002'
  );
  v_admission_id := (v_res->>'admissionId')::uuid;

  -- Forward Fix 出院
  v_res := public.discharge_patient(v_admission_id, '治愈出院', '恢复良好', 'a3a3a3a3-0000-0000-0000-000000000021', 'mlo-discharge-key-001');
  perform tests.assert_true(v_res->>'status' = 'discharged', 'discharge_patient 应返回 discharged');

  perform tests.assert_true(
    (select status from public.cages where id = 'a3a3a3a3-0000-0000-0000-000000000052') = 'available',
    '出院后笼位应释放为 available(P0-01 Forward Fix)');
  perform tests.assert_true(
    (select current_admission_id from public.cages where id = 'a3a3a3a3-0000-0000-0000-000000000052') is null,
    '出院后笼位 current_admission_id 应清空(P0-01 Forward Fix)');

  -- 重复出院拒绝
  perform tests.assert_raises(
    'select public.discharge_patient(''' || v_admission_id || ''', null, null, null, null)',
    'ADMISSION_NOT_ADMITTED',
    '已出院记录重复出院应被拒绝'
  );
end;
$$;

-- ============================================================
-- ML12 RBAC 隔离:跨租户 / 无权限员工读不到 A 租户病程
-- ============================================================
do $$
declare
  v_admission_id uuid;
  v_cnt integer;
begin
  -- 选择存在病程记录的那条 admission(ML9 在 ML2 入院上创建了病程)
  select a.id into v_admission_id
  from public.admissions a
  where a.tenant_id = 'a3a3a3a3-0000-0000-0000-000000000001'
    and exists (select 1 from public.inpatient_progress_notes n where n.admission_id = a.id)
  limit 1;

  -- B 店长:跨租户不可读
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"a3a3a3a3-0000-0000-0000-000000000023","role":"authenticated"}', true);
  select count(*) into v_cnt from public.inpatient_progress_notes where admission_id = v_admission_id;
  perform tests.assert_true(v_cnt = 0, 'B 店长跨租户应读不到 A 租户病程');

  -- A1 无角色员工:无 progress.view 权限不可读
  perform set_config('request.jwt.claims', '{"sub":"a3a3a3a3-0000-0000-0000-000000000022","role":"authenticated"}', true);
  select count(*) into v_cnt from public.inpatient_progress_notes where admission_id = v_admission_id;
  perform tests.assert_true(v_cnt = 0, '无 progress.view 权限员工应读不到病程');

  -- A1 店长:可读本店病程
  perform set_config('request.jwt.claims', '{"sub":"a3a3a3a3-0000-0000-0000-000000000021","role":"authenticated"}', true);
  select count(*) into v_cnt from public.inpatient_progress_notes where admission_id = v_admission_id;
  perform tests.assert_true(v_cnt >= 1, 'A1 店长应可读本店病程');
end;
$$;

-- ---------- 收尾:回滚,无任何残留 ----------
rollback;
