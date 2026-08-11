-- ============================================================
-- 20260811000072_lab_order_analytes_generation.sql
-- G-R-1(3.9.2-02 化验结果录入断链修复):
--   1. generate_lab_order_analytes RPC:
--        按 lab_orders.panel_id 解析 lab_analytes 清单,批量生成 lab_order_analytes 占位行;
--        未直接带 panel_id 时,尝试经 lab_panels.catalog_item_id(产品目录域 migration 提供,
--        本迁移不重复加列)反查 panel;关联列不存在时安全跳过,不阻断开单;
--        幂等:同一 lab_order 已有结果行则跳过,不重复生成。
--   2. CREATE OR REPLACE commit_clinical_plan:
--        原 20260810000301_clinical_plan_commit.sql 同事务只插 lab_orders,
--        本版本在其 lab_orders 插入段补充 panel_id 列值,并同事务调用
--        generate_lab_order_analytes 生成结果占位行,保证"随诊疗方案一并提交"
--        路径不再断链(不修改旧迁移文件)。
-- 幂等,可重复应用
-- ============================================================

-- ===== 1. generate_lab_order_analytes RPC(G-R-1) =====
-- 解析 lab_orders → panel → lab_analytes,批量生成 lab_order_analytes 占位行
-- 返回本次新生成的行数(幂等命中或无 panel 关联时返回 0)
create or replace function public.generate_lab_order_analytes(
  p_lab_order_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.lab_orders;
  v_panel_id uuid;
  v_has_catalog_link boolean := false;
  v_inserted integer := 0;
begin
  select * into v_order from public.lab_orders where id = p_lab_order_id;
  if not found then
    raise exception 'LAB_ORDER_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- 幂等:已有结果行则跳过(防重复生成;同一申请单只生成一次)
  if exists (select 1 from public.lab_order_analytes where lab_order_id = p_lab_order_id) then
    return 0;
  end if;

  v_panel_id := v_order.panel_id;

  -- 未直接给出 panel 时,尝试经 lab_panels.catalog_item_id 反查 panel
  -- (该关联列由产品目录域 migration 负责添加;列不存在时安全跳过,不阻断开单)
  if v_panel_id is null and v_order.catalog_item_id is not null then
    select exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'lab_panels' and column_name = 'catalog_item_id'
    ) into v_has_catalog_link;
    if v_has_catalog_link then
      select id into v_panel_id
      from public.lab_panels
      where catalog_item_id = v_order.catalog_item_id
      limit 1;
    end if;
  end if;

  if v_panel_id is null then
    return 0; -- 无 panel 关联,无结果项可生成(申请单仍可先建,采集后手动补录)
  end if;

  -- 按 panel 下 lab_analytes 批量生成占位行(排序字段:sort_order, code)
  insert into public.lab_order_analytes (lab_order_id, analyte_id, is_abnormal, is_critical)
  select p_lab_order_id, la.id, false, false
  from public.lab_analytes la
  where la.panel_id = v_panel_id
  order by la.sort_order, la.code;
  get diagnostics v_inserted = row_count;

  return v_inserted;
end;
$$;

revoke all on function public.generate_lab_order_analytes(uuid) from public;
revoke all on function public.generate_lab_order_analytes(uuid) from anon;
revoke all on function public.generate_lab_order_analytes(uuid) from authenticated;
grant execute on function public.generate_lab_order_analytes(uuid) to service_role;

-- ===== 2. CREATE OR REPLACE commit_clinical_plan(G-R-1) =====
-- 与原 20260810000301_clinical_plan_commit.sql 保持完全一致的函数签名,
-- 仅在 lab_orders 插入段补充 panel_id 列值 + 同事务生成结果占位行。
create or replace function public.commit_clinical_plan(
  p_encounter_id uuid,
  p_expected_version integer,
  p_actor_employee_id uuid,
  p_actor_role text,
  p_source_workbench text,
  p_request_id text,
  p_idempotency_key text,
  p_encounter_updates jsonb default '{}'::jsonb,
  p_prescription_items jsonb default '[]'::jsonb,
  p_labs jsonb default '[]'::jsonb,
  p_imaging jsonb default '[]'::jsonb,
  p_medical_orders jsonb default '[]'::jsonb,
  p_finish_consultation boolean default true
)
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_encounter public.encounters;
  v_employee public.employees;
  v_existing public.patient_journey_events;
  v_rx public.prescriptions;
  v_issued public.prescriptions;
  v_med jsonb;
  v_item jsonb;
  v_order_no text;
  v_blocking integer;
  v_has_updates boolean;
  v_lab_id uuid;
  v_img_id uuid;
  v_lab_ids uuid[] := '{}';
  v_img_ids uuid[] := '{}';
  v_med_ids uuid[] := '{}';
  v_med_nos text[] := '{}';
  v_lab_count integer := 0;
  v_img_count integer := 0;
  v_med_count integer := 0;
  v_billing_count integer := 0;
  v_task_count integer := 0;
  v_no_price integer := 0;
  v_result jsonb;
begin
  -- 1) 锁定 encounter(整单事务:版本 + 各实体写入原子提交/回滚)
  select * into v_encounter from public.encounters where id = p_encounter_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'ENCOUNTER_NOT_FOUND'; end if;

  -- 2) 幂等:同一 idempotency_key 重复提交直接返回上次结果
  if p_idempotency_key is not null then
    select * into v_existing from public.patient_journey_events
    where tenant_id = v_encounter.tenant_id and event_type = 'encounter.plan_committed'
      and idempotency_key = p_idempotency_key;
    if found then return v_existing.after_data->'result'; end if;
  end if;

  -- 3) 乐观锁版本校验(不匹配返回 409,由 API 层映射为 VERSION_CONFLICT)
  if v_encounter.version <> p_expected_version then
    raise exception using errcode = 'P0004', message = 'VERSION_CONFLICT: 病历已被其他窗口修改,请刷新后重试';
  end if;
  if v_encounter.clinical_status not in ('active', 'plan_ready') then
    raise exception using errcode = '23514', message = 'ENCOUNTER_NOT_ACTIVE';
  end if;

  -- 4) 医生作用域:在职员工;角色分配由 append_patient_journey_event 再强校验
  select * into v_employee from public.employees
  where id = p_actor_employee_id and tenant_id = v_encounter.tenant_id and status = 'active';
  if not found then raise exception using errcode = '42501', message = 'ACTIVE_EMPLOYEE_REQUIRED'; end if;

  -- 5) 更新病历草稿(仅当携带字段时;其余字段保持原值)
  v_has_updates := jsonb_typeof(p_encounter_updates) = 'object'
    and (p_encounter_updates ? 'chief_complaint' or p_encounter_updates ? 'history_present'
      or p_encounter_updates ? 'exam_findings' or p_encounter_updates ? 'diagnosis_text'
      or p_encounter_updates ? 'treatment_plan' or p_encounter_updates ? 'follow_up_date');
  if v_has_updates then
    update public.encounters set
      chief_complaint = case when p_encounter_updates->>'chief_complaint' is not null
        then p_encounter_updates->>'chief_complaint' else chief_complaint end,
      history_present = case when p_encounter_updates->>'history_present' is not null
        then p_encounter_updates->>'history_present' else history_present end,
      exam_findings = case when p_encounter_updates->>'exam_findings' is not null
        then p_encounter_updates->>'exam_findings' else exam_findings end,
      diagnosis_text = case when p_encounter_updates->>'diagnosis_text' is not null
        then p_encounter_updates->>'diagnosis_text' else diagnosis_text end,
      treatment_plan = case when p_encounter_updates->>'treatment_plan' is not null
        then p_encounter_updates->>'treatment_plan' else treatment_plan end,
      follow_up_date = case when p_encounter_updates->>'follow_up_date' is not null
        then (p_encounter_updates->>'follow_up_date')::date else follow_up_date end,
      version = version + 1,
      updated_at = now()
    where id = p_encounter_id returning * into v_encounter;
  end if;

  -- 6) 处方:保存草稿 + 开具(受控药/有效期/用药安全门禁由 issue 内部执行,
  --    触发器同步生成逐项待收费与药房发药任务,全部在同一事务内)
  if jsonb_array_length(p_prescription_items) > 0 then
    select * into v_rx from public.save_prescription(p_encounter_id, p_prescription_items, v_employee.user_id);
    select * into v_issued from public.issue_prescription(v_rx.id, p_actor_employee_id, v_employee.user_id);
  end if;

  -- 7) 检验申请(触发器同步收费、检验岗位任务与旅程事件)
  for v_item in select value from jsonb_array_elements(p_labs)
  loop
    v_order_no := 'LAB-' || to_char(now() at time zone 'Asia/Shanghai', 'YYYYMMDD')
      || '-' || upper(substr(md5(random()::text), 1, 6));
    insert into public.lab_orders (
      tenant_id, store_id, customer_id, pet_id, encounter_id, order_no, status,
      requested_by, remark, clinical_question, panel_id, catalog_item_id, idempotency_key
    ) values (
      v_encounter.tenant_id, v_encounter.store_id, v_encounter.customer_id, v_encounter.pet_id,
      v_encounter.id, v_order_no, 'requested', v_employee.user_id,
      nullif(v_item.value->>'remark', ''), nullif(v_item.value->>'clinical_question', ''),
      nullif(v_item.value->>'panel_id', '')::uuid,
      nullif(v_item.value->>'catalog_item_id', '')::uuid,
      p_idempotency_key || ':lab:' || v_lab_count
    ) returning id into v_lab_id;
    -- G-R-1:同事务生成 lab_order_analytes 占位行(panel→analyte 解析,失败整体回滚)
    perform public.generate_lab_order_analytes(v_lab_id);
    v_lab_ids := array_append(v_lab_ids, v_lab_id);
    v_lab_count := v_lab_count + 1;
  end loop;

  -- 8) 影像申请(触发器同步收费、影像岗位任务与旅程事件)
  for v_item in select value from jsonb_array_elements(p_imaging)
  loop
    v_order_no := 'IMG-' || to_char(now() at time zone 'Asia/Shanghai', 'YYYYMMDD')
      || '-' || upper(substr(md5(random()::text), 1, 6));
    insert into public.imaging_orders (
      tenant_id, store_id, customer_id, pet_id, encounter_id, order_no, status,
      requested_by, imaging_type, catalog_item_id, clinical_question, notes, idempotency_key
    ) values (
      v_encounter.tenant_id, v_encounter.store_id, v_encounter.customer_id, v_encounter.pet_id,
      v_encounter.id, v_order_no, 'requested', v_employee.user_id,
      nullif(v_item.value->>'imaging_type', ''), nullif(v_item.value->>'catalog_item_id', '')::uuid,
      nullif(v_item.value->>'clinical_question', ''), nullif(v_item.value->>'remark', ''),
      p_idempotency_key || ':img:' || v_img_count
    ) returning id into v_img_id;
    v_img_ids := array_append(v_img_ids, v_img_id);
    v_img_count := v_img_count + 1;
  end loop;

  -- 9) 医嘱(复用 create_medical_order:自动生成护士任务与审计,幂等子键防重)
  for v_item in select value from jsonb_array_elements(p_medical_orders)
  loop
    v_med := public.create_medical_order(
      v_encounter.tenant_id, v_encounter.store_id, v_encounter.pet_id, v_encounter.customer_id,
      v_encounter.id, null,
      coalesce(nullif(v_item.value->>'order_type', ''), 'treatment'),
      nullif(v_item.value->>'item_name', ''), nullif(v_item.value->>'dosage', ''),
      nullif(v_item.value->>'frequency', ''), coalesce((v_item.value->>'quantity')::numeric, 1),
      nullif(v_item.value->>'unit', ''), nullif(v_item.value->>'instructions', ''),
      null, null, v_employee.user_id,
      p_idempotency_key || ':med:' || v_med_count
    );
    v_med_ids := array_append(v_med_ids, (v_med->>'orderId')::uuid);
    v_med_nos := array_append(v_med_nos, v_med->>'orderNo');
    v_med_count := v_med_count + 1;
  end loop;

  -- 10) 结束问诊前:存在未处理的用药安全阻断则禁止提交(与服务端门禁一致)
  if p_finish_consultation then
    -- 10.1) 无有效价格的待收费项目禁止提交(与前端提交摘要 noPriceCount 双重阻断)
    select count(*) into v_no_price from public.encounter_charge_items
    where encounter_id = p_encounter_id and status in ('pending', 'invoiced')
      and coalesce(unit_price, 0) <= 0;
    if v_no_price > 0 then
      raise exception using errcode = '23514', message = 'PLAN_HAS_NO_PRICE: 存在无有效价格的收费项目,请先维护价格后重试';
    end if;
    select count(*) into v_blocking from public.medication_safety_checks
    where encounter_id = p_encounter_id and status = 'triggered' and blocking;
    if v_blocking > 0 then
      raise exception using errcode = '23514', message = 'PLAN_HAS_BLOCKING: 存在未处理的用药安全阻断,请先处理豁免';
    end if;
    -- 推进 encounter → plan_ready(下游岗位待办保留)
    if v_encounter.clinical_status = 'active' then
      update public.encounters set
        clinical_status = 'plan_ready',
        version = version + 1,
        updated_at = now()
      where id = p_encounter_id returning * into v_encounter;
    end if;
  end if;

  -- 11) 汇总:提交后待收费与开放任务数量(前端摘要刷新用)
  select count(*) into v_billing_count from public.encounter_charge_items
  where encounter_id = p_encounter_id and status in ('pending', 'invoiced');
  select count(*) into v_task_count from public.workflow_tasks
  where encounter_id = p_encounter_id and status in ('pending', 'claimed', 'in_progress');

  v_result := jsonb_build_object(
    'encounterId', v_encounter.id,
    'encounterVersion', v_encounter.version,
    'clinicalStatus', v_encounter.clinical_status,
    'prescriptionId', case when v_issued.id is null then null else v_issued.id end,
    'prescriptionStatus', case when v_issued.id is null then null else v_issued.status end,
    'prescriptionItemsCount', case when v_issued.id is null then 0
      else (select count(*)::int from public.prescription_items where prescription_id = v_issued.id) end,
    'labOrderIds', v_lab_ids,
    'imagingOrderIds', v_img_ids,
    'medicalOrderIds', v_med_ids,
    'medicalOrderNos', v_med_nos,
    'finishConsultation', p_finish_consultation,
    'billingPendingCount', v_billing_count,
    'taskCount', v_task_count
  );

  -- 12) 不可变旅程事件(幂等键承载于事件行,重复请求直接复用)
  perform public.append_patient_journey_event(
    v_encounter.tenant_id, v_encounter.store_id, p_actor_employee_id, p_actor_role,
    'encounter.plan_committed', 'encounter', v_encounter.id::text,
    v_encounter.customer_id, v_encounter.pet_id, v_encounter.appointment_id, null,
    v_encounter.id, null, null, null,
    '诊疗方案原子提交:病历/处方/检验/影像/医嘱批量落库',
    '{}'::jsonb, jsonb_build_object('result', v_result),
    p_source_workbench, p_request_id, p_request_id, p_idempotency_key
  );

  -- 13) 审计留痕(带操作员工与岗位快照)
  insert into public.audit_logs (tenant_id, store_id, user_id, action, entity_type, entity_id,
    metadata, employee_id, actor_role)
  values (v_encounter.tenant_id, v_encounter.store_id, v_employee.user_id,
    'encounter.plan_commit', 'encounter', v_encounter.id::text, v_result,
    p_actor_employee_id, p_actor_role);

  return v_result;
end;
$$;

-- 权限:仅 service_role 可执行(Hono Command + PostgreSQL RPC 边界,与原迁移一致)
revoke all on function public.commit_clinical_plan(uuid, integer, uuid, text, text, text, text, jsonb, jsonb, jsonb, jsonb, jsonb, boolean) from public;
revoke all on function public.commit_clinical_plan(uuid, integer, uuid, text, text, text, text, jsonb, jsonb, jsonb, jsonb, jsonb, boolean) from anon;
revoke all on function public.commit_clinical_plan(uuid, integer, uuid, text, text, text, text, jsonb, jsonb, jsonb, jsonb, jsonb, boolean) from authenticated;
grant execute on function public.commit_clinical_plan(uuid, integer, uuid, text, text, text, text, jsonb, jsonb, jsonb, jsonb, jsonb, boolean) to service_role;
