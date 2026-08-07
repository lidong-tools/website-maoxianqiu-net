-- ============================================================
-- MXQ-S3.1-1: 合规 RPC(Stage 03 / Sprint S3.1-1)
--
-- 任务号: S3.1-1-A1~A7 病历归档/Amendment/保存期/兽医备案/处方有效性/受控药
--
-- 安全模型:
--   * 全部 Command RPC = SECURITY DEFINER + set search_path = public;
--   * revoke public/anon/authenticated + grant service_role(service-role-only);
--   * 同步登记到 api/lib/service-rpc-manifest.ts 与 api/scripts/check-rpc-manifest.ts;
--   * 权限码校验在 Hono 层(requireScopedPermission)完成,RPC 校验租户/状态/资格;
--   * 归档后正文不可变由 DB 触发器兜底,apply_record_amendment 显式放行。
-- ============================================================

-- ============================================================
-- 1. archive_encounter 门(急)诊病历归档
--    前提:已签署(signed);归档后 archive_status='archived';
--    retention_until = 归档日 + 3 年(病历保存期最低要求)
-- ============================================================
create or replace function public.archive_encounter(
  p_encounter_id uuid,
  p_operator_employee_id uuid
)
returns public.encounters
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.encounters;
  v_emp_exists boolean;
begin
  select * into v_row from public.encounters where id = p_encounter_id for update;
  if not found then
    raise exception 'ENCOUNTER_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_row.status <> 'signed' then
    raise exception 'ENCOUNTER_NOT_SIGNABLE' using errcode = 'P0003',
      message = '病历未签署,不可归档';
  end if;
  if v_row.archive_status = 'archived' then
    raise exception 'ENCOUNTER_ALREADY_ARCHIVED' using errcode = 'P0003';
  end if;

  select exists(
    select 1 from public.employees
    where id = p_operator_employee_id and tenant_id = v_row.tenant_id and status = 'active'
  ) into v_emp_exists;
  if not v_emp_exists then
    raise exception 'OPERATOR_NOT_FOUND' using errcode = 'P0002',
      message = '操作员工不存在或不属于本租户';
  end if;

  update public.encounters
  set archive_status = 'archived',
      archived_at = now(),
      archived_by_employee_id = p_operator_employee_id,
      retention_until = now() + interval '3 years',
      retention_status = 'active',
      updated_at = now()
  where id = p_encounter_id
  returning * into v_row;

  insert into public.audit_logs (tenant_id, store_id, user_id, action, entity_type, entity_id, metadata)
  values (v_row.tenant_id, v_row.store_id, null, 'medical_record.archive', 'encounter', p_encounter_id,
          jsonb_build_object('archived_by_employee_id', p_operator_employee_id,
                             'archive_due_at', v_row.archive_due_at,
                             'retention_until', v_row.retention_until));

  return v_row;
end;
$$;

-- ============================================================
-- 2. archive_admission 住院病历归档
--    前提:已出院(discharged);归档后 retention_until = 归档日 + 3 年
-- ============================================================
create or replace function public.archive_admission(
  p_admission_id uuid,
  p_operator_employee_id uuid
)
returns public.admissions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.admissions;
  v_emp_exists boolean;
begin
  select * into v_row from public.admissions where id = p_admission_id for update;
  if not found then
    raise exception 'ADMISSION_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_row.status <> 'discharged' then
    raise exception 'ADMISSION_NOT_DISCHARGED' using errcode = 'P0003',
      message = '住院病历未出院,不可归档';
  end if;
  if v_row.archive_status = 'archived' then
    raise exception 'ADMISSION_ALREADY_ARCHIVED' using errcode = 'P0003';
  end if;

  select exists(
    select 1 from public.employees
    where id = p_operator_employee_id and tenant_id = v_row.tenant_id and status = 'active'
  ) into v_emp_exists;
  if not v_emp_exists then
    raise exception 'OPERATOR_NOT_FOUND' using errcode = 'P0002',
      message = '操作员工不存在或不属于本租户';
  end if;

  update public.admissions
  set archive_status = 'archived',
      archived_at = now(),
      archived_by_employee_id = p_operator_employee_id,
      retention_until = now() + interval '3 years',
      retention_status = 'active',
      updated_at = now()
  where id = p_admission_id
  returning * into v_row;

  insert into public.audit_logs (tenant_id, store_id, user_id, action, entity_type, entity_id, metadata)
  values (v_row.tenant_id, v_row.store_id, null, 'medical_record.archive', 'admission', p_admission_id,
          jsonb_build_object('archived_by_employee_id', p_operator_employee_id,
                             'archive_due_at', v_row.archive_due_at,
                             'retention_until', v_row.retention_until));

  return v_row;
end;
$$;

-- ============================================================
-- 3. request_record_amendment 归档后修改申请
--    前提:记录已归档;同一记录存在 pending 时拒绝重复申请;
--    before_snapshot 记录申请时正文快照(原始版本永远保留)
-- ============================================================
create or replace function public.request_record_amendment(
  p_medical_record_type text,
  p_medical_record_id uuid,
  p_reason text,
  p_requested_by_employee_id uuid
)
returns public.medical_record_amendments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant uuid;
  v_store uuid;
  v_archived text;
  v_emp_exists boolean;
  v_snapshot jsonb;
  v_amendment public.medical_record_amendments;
begin
  if p_medical_record_type not in ('encounter', 'admission') then
    raise exception 'INVALID_RECORD_TYPE' using errcode = 'P0003';
  end if;
  if coalesce(p_reason, '') = '' then
    raise exception 'AMENDMENT_REASON_REQUIRED' using errcode = 'P0003';
  end if;

  if p_medical_record_type = 'encounter' then
    select tenant_id, store_id, archive_status into v_tenant, v_store, v_archived
    from public.encounters where id = p_medical_record_id;
    if not found then
      raise exception 'ENCOUNTER_NOT_FOUND' using errcode = 'P0002';
    end if;
    if v_archived <> 'archived' then
      raise exception 'RECORD_NOT_ARCHIVED' using errcode = 'P0003',
        message = '仅已归档病历可发起修订申请';
    end if;
    select jsonb_build_object(
      'chief_complaint', chief_complaint, 'history_present', history_present,
      'exam_findings', exam_findings, 'diagnosis_text', diagnosis_text,
      'treatment_plan', treatment_plan)
    into v_snapshot from public.encounters where id = p_medical_record_id;
  else
    select tenant_id, store_id, archive_status into v_tenant, v_store, v_archived
    from public.admissions where id = p_medical_record_id;
    if not found then
      raise exception 'ADMISSION_NOT_FOUND' using errcode = 'P0002';
    end if;
    if v_archived <> 'archived' then
      raise exception 'RECORD_NOT_ARCHIVED' using errcode = 'P0003',
        message = '仅已归档病历可发起修订申请';
    end if;
    select jsonb_build_object(
      'discharge_reason', discharge_reason, 'discharge_notes', discharge_notes)
    into v_snapshot from public.admissions where id = p_medical_record_id;
  end if;

  select exists(
    select 1 from public.employees
    where id = p_requested_by_employee_id and tenant_id = v_tenant and status = 'active'
  ) into v_emp_exists;
  if not v_emp_exists then
    raise exception 'OPERATOR_NOT_FOUND' using errcode = 'P0002',
      message = '申请员工不存在或不属于本租户';
  end if;

  -- 同一记录未决申请去重
  if exists (
    select 1 from public.medical_record_amendments
    where tenant_id = v_tenant and medical_record_type = p_medical_record_type
      and medical_record_id = p_medical_record_id and status = 'pending'
  ) then
    raise exception 'AMENDMENT_ALREADY_PENDING' using errcode = 'P0003';
  end if;

  insert into public.medical_record_amendments (
    tenant_id, store_id, medical_record_type, medical_record_id,
    requested_by, reason, status, before_snapshot
  )
  values (
    v_tenant, v_store, p_medical_record_type, p_medical_record_id,
    p_requested_by_employee_id, p_reason, 'pending', v_snapshot
  )
  returning * into v_amendment;

  insert into public.audit_logs (tenant_id, store_id, user_id, action, entity_type, entity_id, metadata)
  values (v_tenant, v_store, null, 'medical_record.amend.request', 'medical_record_amendment', v_amendment.id,
          jsonb_build_object('record_type', p_medical_record_type, 'record_id', p_medical_record_id,
                             'requested_by_employee_id', p_requested_by_employee_id, 'reason', p_reason));

  return v_amendment;
end;
$$;

-- ============================================================
-- 4. review_record_amendment 修订申请审批
--    approved -> 可执行 apply;rejected -> 记录拒绝原因
-- ============================================================
create or replace function public.review_record_amendment(
  p_amendment_id uuid,
  p_decision text,
  p_reviewer_employee_id uuid,
  p_reason text default null
)
returns public.medical_record_amendments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.medical_record_amendments;
  v_emp_exists boolean;
begin
  if p_decision not in ('approved', 'rejected') then
    raise exception 'INVALID_DECISION' using errcode = 'P0003';
  end if;

  select * into v_row from public.medical_record_amendments where id = p_amendment_id for update;
  if not found then
    raise exception 'AMENDMENT_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_row.status <> 'pending' then
    raise exception 'AMENDMENT_NOT_PENDING' using errcode = 'P0003';
  end if;

  select exists(
    select 1 from public.employees
    where id = p_reviewer_employee_id and tenant_id = v_row.tenant_id and status = 'active'
  ) into v_emp_exists;
  if not v_emp_exists then
    raise exception 'OPERATOR_NOT_FOUND' using errcode = 'P0002',
      message = '审批员工不存在或不属于本租户';
  end if;

  update public.medical_record_amendments
  set status = p_decision,
      reviewed_by = p_reviewer_employee_id,
      reviewed_at = now(),
      rejected_reason = case when p_decision = 'rejected' then coalesce(p_reason, '') else rejected_reason end,
      updated_at = now()
  where id = p_amendment_id
  returning * into v_row;

  insert into public.audit_logs (tenant_id, store_id, user_id, action, entity_type, entity_id, metadata)
  values (v_row.tenant_id, v_row.store_id, null,
          case when p_decision = 'approved' then 'medical_record.amend.approve' else 'medical_record.amend.reject' end,
          'medical_record_amendment', p_amendment_id,
          jsonb_build_object('reviewer_employee_id', p_reviewer_employee_id,
                             'decision', p_decision, 'reason', p_reason));

  return v_row;
end;
$$;

-- ============================================================
-- 5. apply_record_amendment 执行修订(创建新版本,保留旧版本)
--    仅 approved 可 apply;写 encounter_revisions(门诊)/更新正文(住院);
--    after_snapshot 记录应用后快照;显式放行归档不可变触发器
-- ============================================================
create or replace function public.apply_record_amendment(
  p_amendment_id uuid,
  p_apply_payload jsonb,
  p_applied_by_employee_id uuid
)
returns public.medical_record_amendments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.medical_record_amendments;
  v_emp_exists boolean;
  v_new_snapshot jsonb;
  v_revision_no integer;
begin
  select * into v_row from public.medical_record_amendments where id = p_amendment_id for update;
  if not found then
    raise exception 'AMENDMENT_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_row.status <> 'approved' then
    raise exception 'AMENDMENT_NOT_APPROVED' using errcode = 'P0003';
  end if;

  select exists(
    select 1 from public.employees
    where id = p_applied_by_employee_id and tenant_id = v_row.tenant_id and status = 'active'
  ) into v_emp_exists;
  if not v_emp_exists then
    raise exception 'OPERATOR_NOT_FOUND' using errcode = 'P0002',
      message = '执行员工不存在或不属于本租户';
  end if;

  -- 显式放行归档不可变触发器(仅当前事务有效)
  perform set_config('app.allow_archived_update', 'true', true);

  if v_row.medical_record_type = 'encounter' then
    update public.encounters
    set chief_complaint = coalesce(nullif(p_apply_payload->>'chief_complaint', ''), chief_complaint),
        history_present = coalesce(nullif(p_apply_payload->>'history_present', ''), history_present),
        exam_findings = coalesce(nullif(p_apply_payload->>'exam_findings', ''), exam_findings),
        diagnosis_text = coalesce(nullif(p_apply_payload->>'diagnosis_text', ''), diagnosis_text),
        treatment_plan = coalesce(nullif(p_apply_payload->>'treatment_plan', ''), treatment_plan),
        updated_at = now()
    where id = v_row.medical_record_id;

    -- 创建新版本(encounter_revisions 保留完整修订史)
    select coalesce(max(revision_no), 0) + 1 into v_revision_no
    from public.encounter_revisions where encounter_id = v_row.medical_record_id;
    insert into public.encounter_revisions (encounter_id, revision_no, content_diff, revised_by, revised_at, reason)
    values (v_row.medical_record_id, v_revision_no, p_apply_payload, p_applied_by_employee_id, now(),
            'amendment:' || v_row.id::text);

    select jsonb_build_object(
      'chief_complaint', chief_complaint, 'history_present', history_present,
      'exam_findings', exam_findings, 'diagnosis_text', diagnosis_text,
      'treatment_plan', treatment_plan)
    into v_new_snapshot from public.encounters where id = v_row.medical_record_id;
  else
    update public.admissions
    set discharge_reason = coalesce(nullif(p_apply_payload->>'discharge_reason', ''), discharge_reason),
        discharge_notes = coalesce(nullif(p_apply_payload->>'discharge_notes', ''), discharge_notes),
        updated_at = now()
    where id = v_row.medical_record_id;

    select jsonb_build_object(
      'discharge_reason', discharge_reason, 'discharge_notes', discharge_notes)
    into v_new_snapshot from public.admissions where id = v_row.medical_record_id;
  end if;

  update public.medical_record_amendments
  set status = 'applied',
      applied_by = p_applied_by_employee_id,
      applied_at = now(),
      after_snapshot = v_new_snapshot,
      updated_at = now()
  where id = p_amendment_id
  returning * into v_row;

  insert into public.audit_logs (tenant_id, store_id, user_id, action, entity_type, entity_id, metadata)
  values (v_row.tenant_id, v_row.store_id, null, 'medical_record.amend.apply', 'medical_record_amendment', p_amendment_id,
          jsonb_build_object('record_type', v_row.medical_record_type, 'record_id', v_row.medical_record_id,
                             'applied_by_employee_id', p_applied_by_employee_id,
                             'before', v_row.before_snapshot, 'after', v_new_snapshot));

  return v_row;
end;
$$;

-- ============================================================
-- 6. upsert_veterinarian_registration 执业兽医备案管理
--    幂等:(tenant_id, license_no) 唯一;资格变更写审计(before/after)
-- ============================================================
create or replace function public.upsert_veterinarian_registration(
  p_tenant_id uuid,
  p_employee_id uuid,
  p_license_no text,
  p_registration_no text default null,
  p_registration_authority text default null,
  p_registration_region text default null,
  p_valid_from date default null,
  p_valid_until date default null,
  p_status text default 'active',
  p_signature_specimen_file_id uuid default null,
  p_electronic_signature_provider text default null,
  p_electronic_signature_subject_id text default null,
  p_operator_employee_id uuid default null
)
returns public.veterinarian_registrations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_emp uuid;
  v_existing public.veterinarian_registrations;
  v_row public.veterinarian_registrations;
  v_operator_ok boolean;
begin
  if coalesce(p_license_no, '') = '' then
    raise exception 'LICENSE_NO_REQUIRED' using errcode = 'P0003';
  end if;
  if p_status not in ('active', 'inactive', 'expired') then
    raise exception 'INVALID_REGISTRATION_STATUS' using errcode = 'P0003';
  end if;

  -- 员工必须属于该租户
  select id into v_emp from public.employees
  where id = p_employee_id and tenant_id = p_tenant_id and status = 'active';
  if not found then
    raise exception 'EMPLOYEE_NOT_FOUND' using errcode = 'P0002',
      message = '备案员工不存在或不属于该租户';
  end if;

  if p_operator_employee_id is not null then
    select exists(
      select 1 from public.employees
      where id = p_operator_employee_id and tenant_id = p_tenant_id and status = 'active'
    ) into v_operator_ok;
    if not v_operator_ok then
      raise exception 'OPERATOR_NOT_FOUND' using errcode = 'P0002';
    end if;
  end if;

  select * into v_existing from public.veterinarian_registrations
  where tenant_id = p_tenant_id and license_no = p_license_no;

  if v_existing.id is not null then
    update public.veterinarian_registrations
    set employee_id = p_employee_id,
        registration_no = coalesce(p_registration_no, registration_no),
        registration_authority = coalesce(p_registration_authority, registration_authority),
        registration_region = coalesce(p_registration_region, registration_region),
        valid_from = coalesce(p_valid_from, valid_from),
        valid_until = coalesce(p_valid_until, valid_until),
        status = p_status,
        signature_specimen_file_id = coalesce(p_signature_specimen_file_id, signature_specimen_file_id),
        electronic_signature_provider = coalesce(p_electronic_signature_provider, electronic_signature_provider),
        electronic_signature_subject_id = coalesce(p_electronic_signature_subject_id, electronic_signature_subject_id),
        updated_at = now()
    where id = v_existing.id
    returning * into v_row;

    insert into public.audit_logs (tenant_id, store_id, user_id, action, entity_type, entity_id, metadata)
    values (p_tenant_id, null, null, 'veterinarian_registration.upsert', 'veterinarian_registration', v_row.id,
            jsonb_build_object('before', to_jsonb(v_existing), 'after', to_jsonb(v_row),
                               'operator_employee_id', p_operator_employee_id));
  else
    insert into public.veterinarian_registrations (
      tenant_id, employee_id, license_no, registration_no, registration_authority, registration_region,
      valid_from, valid_until, status, signature_specimen_file_id,
      electronic_signature_provider, electronic_signature_subject_id
    )
    values (
      p_tenant_id, p_employee_id, p_license_no, p_registration_no, p_registration_authority, p_registration_region,
      coalesce(p_valid_from, current_date), p_valid_until, p_status, p_signature_specimen_file_id,
      p_electronic_signature_provider, p_electronic_signature_subject_id
    )
    returning * into v_row;

    insert into public.audit_logs (tenant_id, store_id, user_id, action, entity_type, entity_id, metadata)
    values (p_tenant_id, null, null, 'veterinarian_registration.upsert', 'veterinarian_registration', v_row.id,
            jsonb_build_object('before', '{}'::jsonb, 'after', to_jsonb(v_row),
                               'operator_employee_id', p_operator_employee_id));
  end if;

  return v_row;
end;
$$;

-- ============================================================
-- 7. issue_prescription 处方开具
--    规则(S3.1-1-A4/A5/A6/A7):
--       * 开方人必须有有效执业兽医备案(不得仅凭 role='doctor');
--       * valid_until 默认 = 开具当日结束;最长不得超过 issued_at + 3 天;
--       * 受控药:单独处方(不得混开普通药/多类受控药);
--                麻醉药品每张处方不超过一日量(duration_days <= 1);
--                保留期 5 年;普通处方保留期 3 年;
--       * 开具后状态 draft -> issued,正文不可再覆盖式修改。
-- ============================================================
create or replace function public.issue_prescription(
  p_prescription_id uuid,
  p_prescriber_employee_id uuid,
  p_prescriber_user_id uuid,
  p_valid_until timestamptz default null
)
returns public.prescriptions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.prescriptions;
  v_emp_exists boolean;
  v_reg public.veterinarian_registrations;
  v_has_controlled boolean;
  v_controlled_classes text[];
  v_non_controlled_count integer;
  v_narcotic_count integer;
  v_item record;
  v_retention_until timestamptz;
begin
  select * into v_row from public.prescriptions where id = p_prescription_id for update;
  if not found then
    raise exception 'PRESCRIPTION_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_row.status <> 'draft' then
    raise exception 'PRESCRIPTION_NOT_DRAFT' using errcode = 'P0003',
      message = '仅草稿状态处方可开具';
  end if;

  -- 开方人必须属于该租户且为在职员工
  select exists(
    select 1 from public.employees
    where id = p_prescriber_employee_id and tenant_id = v_row.tenant_id and status = 'active'
  ) into v_emp_exists;
  if not v_emp_exists then
    raise exception 'PRESCRIBER_NOT_FOUND' using errcode = 'P0002',
      message = '开方员工不存在或不属于本租户';
  end if;

  -- 有效执业兽医备案(必须;不得仅凭 role='doctor')
  select * into v_reg from public.veterinarian_registrations
  where tenant_id = v_row.tenant_id and employee_id = p_prescriber_employee_id
    and status = 'active'
    and valid_from <= current_date
    and (valid_until is null or valid_until >= current_date)
  limit 1;
  if not found then
    raise exception 'PRESCRIBER_NOT_REGISTERED' using errcode = 'P0003',
      message = '开方人无有效执业兽医备案,禁止开具处方';
  end if;

  -- 受控药品规则:单独处方 / 麻醉一日量
  v_has_controlled := false;
  v_narcotic_count := 0;
  select
    bool_or(cde.controlled_class is not null and cde.controlled_class <> 'none') into v_has_controlled
  from public.prescription_items pi
  join public.catalog_items ci on ci.id = pi.catalog_item_id
  left join public.catalog_drug_extensions cde on cde.catalog_item_id = ci.id
  where pi.prescription_id = p_prescription_id;

  if v_has_controlled then
    -- 受控类集合
    select array_agg(distinct cde.controlled_class order by cde.controlled_class) into v_controlled_classes
    from public.prescription_items pi
    join public.catalog_items ci on ci.id = pi.catalog_item_id
    join public.catalog_drug_extensions cde on cde.catalog_item_id = ci.id
    where pi.prescription_id = p_prescription_id
      and cde.controlled_class is not null and cde.controlled_class <> 'none';

    if array_length(v_controlled_classes, 1) > 1 then
      raise exception 'CONTROLLED_MIX_CLASS' using errcode = 'P0003',
        message = '受控药品必须单独处方,不得混合开具不同受控类别';
    end if;

    -- 受控药不得与非受控药混开
    select count(*) into v_non_controlled_count
    from public.prescription_items pi
    join public.catalog_items ci on ci.id = pi.catalog_item_id
    left join public.catalog_drug_extensions cde on cde.catalog_item_id = ci.id
    where pi.prescription_id = p_prescription_id
      and (cde.controlled_class is null or cde.controlled_class = 'none');
    if v_non_controlled_count > 0 then
      raise exception 'CONTROLLED_MIX_REGULAR' using errcode = 'P0003',
        message = '受控药品必须单独处方,不得与非受控药品混开';
    end if;

    -- 麻醉药品每张处方不超过一日量(duration_days <= 1)
    if 'narcotic' = any(v_controlled_classes) then
      select count(*) into v_narcotic_count
      from public.prescription_items
      where prescription_id = p_prescription_id
        and (duration_days is null or duration_days > 1);
      if v_narcotic_count > 0 then
        raise exception 'NARCOTIC_DAILY_LIMIT' using errcode = 'P0003',
          message = '麻醉药品每张处方不得超过一日量';
      end if;
    end if;
  end if;

  -- 有效期(F03 审计修复,遵循 todo.md A5 验收规则):
  --   规则1 默认 valid_until = issued_at 当日结束(Asia/Shanghai 业务时区);
  --   规则4 valid_until > issued_at + 3 days 必须拒绝(72 小时硬上限);
  --   新增边界:valid_until 不得早于开具时刻(过去时间拒绝);
  --   时区声明:毛线球当前仅服务中国大陆,统一业务时区 Asia/Shanghai,
  --   不按 tenant/store 配置解析时区(产品决策,见交付说明)。
  if p_valid_until is not null and p_valid_until <= now() then
    raise exception 'PRESCRIPTION_VALIDITY_IN_PAST' using errcode = 'P0003',
      message = '处方有效期不得早于开具时刻';
  end if;
  if p_valid_until is not null and p_valid_until > now() + interval '3 days' then
    raise exception 'VALIDITY_EXCEEDS_MAX' using errcode = 'P0003',
      message = '处方有效期最长不得超过开具时刻 + 3 天';
  end if;

  -- 保存期:受控 5 年,普通 3 年
  v_retention_until := now() + case when v_has_controlled then interval '5 years' else interval '3 years' end;

  update public.prescriptions
  set status = 'issued',
      issued_at = now(),
      valid_until = coalesce(
        p_valid_until,
        (date_trunc('day', now() at time zone 'Asia/Shanghai') + interval '1 day' - interval '1 second')
          at time zone 'Asia/Shanghai'
      ),
      prescriber_employee_id = p_prescriber_employee_id,
      prescriber_user_id = p_prescriber_user_id,
      prescriber_veterinarian_registration_id = v_reg.id,
      signed_at = now(),
      signature_method = 'manual',
      retention_until = v_retention_until,
      retention_status = 'active',
      updated_at = now()
  where id = p_prescription_id
  returning * into v_row;

  insert into public.audit_logs (tenant_id, store_id, user_id, action, entity_type, entity_id, metadata)
  values (v_row.tenant_id, v_row.store_id, p_prescriber_user_id, 'prescription.issue', 'prescription', p_prescription_id,
          jsonb_build_object('prescriber_employee_id', p_prescriber_employee_id,
                             'veterinarian_registration_id', v_reg.id,
                             'valid_until', v_row.valid_until,
                             'controlled', v_has_controlled,
                             'retention_until', v_retention_until));

  return v_row;
end;
$$;

-- ============================================================
-- 8. extend_prescription_validity 延长处方有效期
--    规则:仅 issued 状态;新有效期 > 当前有效期;不得超过 issued_at + 3 天
-- ============================================================
create or replace function public.extend_prescription_validity(
  p_prescription_id uuid,
  p_new_valid_until timestamptz,
  p_operator_employee_id uuid
)
returns public.prescriptions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.prescriptions;
  v_emp_exists boolean;
begin
  select * into v_row from public.prescriptions where id = p_prescription_id for update;
  if not found then
    raise exception 'PRESCRIPTION_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_row.status <> 'issued' then
    raise exception 'PRESCRIPTION_NOT_ISSUED' using errcode = 'P0003',
      message = '仅已开具处方可延长有效期';
  end if;
  if v_row.issued_at is null then
    raise exception 'PRESCRIPTION_NOT_ISSUED' using errcode = 'P0003';
  end if;
  if p_new_valid_until <= v_row.valid_until then
    raise exception 'VALIDITY_NOT_EXTENDED' using errcode = 'P0003',
      message = '新有效期必须晚于当前有效期';
  end if;
  -- F03 边界:上限 = issued_at + 3 天(todo.md A5 规则4,72 小时硬上限)
  if p_new_valid_until > v_row.issued_at + interval '3 days' then
    raise exception 'VALIDITY_EXCEEDS_MAX' using errcode = 'P0003',
      message = '处方有效期最长不得超过开具时刻 + 3 天';
  end if;

  select exists(
    select 1 from public.employees
    where id = p_operator_employee_id and tenant_id = v_row.tenant_id and status = 'active'
  ) into v_emp_exists;
  if not v_emp_exists then
    raise exception 'OPERATOR_NOT_FOUND' using errcode = 'P0002';
  end if;

  update public.prescriptions
  set valid_until = p_new_valid_until, updated_at = now()
  where id = p_prescription_id
  returning * into v_row;

  insert into public.audit_logs (tenant_id, store_id, user_id, action, entity_type, entity_id, metadata)
  values (v_row.tenant_id, v_row.store_id, null, 'prescription.extend_validity', 'prescription', p_prescription_id,
          jsonb_build_object('operator_employee_id', p_operator_employee_id, 'new_valid_until', p_new_valid_until));

  return v_row;
end;
$$;

-- ============================================================
-- 9. 重定义 save_prescription(保持原签名)
--    新增:已开具/已发药后禁止覆盖式保存新草稿,防止产生重复处方
-- ============================================================
create or replace function public.save_prescription(
  p_encounter_id uuid,
  p_items_json jsonb,
  p_doctor_id uuid
)
returns public.prescriptions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_encounter public.encounters;
  v_rx public.prescriptions;
  v_item record;
  v_existing_issued boolean;
begin
  select * into v_encounter from public.encounters where id = p_encounter_id for update;
  if not found then
    raise exception 'ENCOUNTER_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- 归档后禁止保存(归档不可变触发器同时兜底)
  if v_encounter.archive_status = 'archived' then
    raise exception 'ARCHIVED_RECORD_IMMUTABLE' using errcode = 'P0003',
      message = '已归档病历不可修改处方,必须走 Amendment 流程';
  end if;

  -- 已开具/已发药后禁止覆盖式保存
  select exists(
    select 1 from public.prescriptions
    where encounter_id = p_encounter_id and status in ('issued', 'dispensed')
  ) into v_existing_issued;
  if v_existing_issued then
    raise exception 'PRESCRIPTION_ALREADY_ISSUED' using errcode = 'P0003',
      message = '该就诊已开具处方,禁止覆盖式修改';
  end if;

  select * into v_rx from public.prescriptions
  where encounter_id = p_encounter_id and status = 'draft'
  for update;

  if not found then
    insert into public.prescriptions (tenant_id, store_id, encounter_id, customer_id, pet_id, doctor_id, status)
    values (v_encounter.tenant_id, v_encounter.store_id, p_encounter_id, v_encounter.customer_id, v_encounter.pet_id, p_doctor_id, 'draft')
    returning * into v_rx;
  else
    delete from public.prescription_items where prescription_id = v_rx.id;
  end if;

  for v_item in select * from jsonb_array_elements(p_items_json)
  loop
    insert into public.prescription_items (
      prescription_id, catalog_item_id, drug_name, dosage, frequency,
      duration_days, quantity, unit, instructions, sort_order
    )
    values (
      v_rx.id,
      nullif(v_item->>'catalog_item_id', '')::uuid,
      v_item->>'drug_name',
      v_item->>'dosage',
      v_item->>'frequency',
      nullif(v_item->>'duration_days', '')::integer,
      coalesce(nullif(v_item->>'quantity', '')::numeric, 1),
      v_item->>'unit',
      v_item->>'instructions',
      coalesce(nullif(v_item->>'sort_order', '')::integer, 0)
    );
  end loop;

  insert into public.audit_logs (tenant_id, store_id, user_id, action, entity_type, entity_id, metadata)
  values (v_encounter.tenant_id, v_encounter.store_id, p_doctor_id, 'prescription.save', 'prescription', v_rx.id,
          jsonb_build_object('encounter_id', p_encounter_id, 'items_count', jsonb_array_length(p_items_json)));

  return v_rx;
end;
$$;

-- ============================================================
-- 10. 重定义 dispense_prescription(保持原签名)
--     R04: 仅 issued 处方可发药(禁止 draft 直发,必须先开具);
--     R05: 改为单事务 RPC——处方状态转换 + 逐项库存扣减
--          (优先确认该处方的预留流水,否则按门店仓库即时 FEFO 扣减)
--          在同一个 plpgsql 事务内原子提交/回滚,消除 API 层
--          "先扣库存后转状态"两步编排的非原子窗口;
--     发药员工由登录用户(p_operator_id)反查推导。
-- ============================================================
create or replace function public.dispense_prescription(
  p_prescription_id uuid,
  p_operator_id uuid default null
)
returns public.prescriptions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.prescriptions;
  v_dispenser_employee_id uuid;
  v_item record;
  v_wh public.warehouses;
  v_reserve uuid;
  v_result jsonb;
  v_dispensed_items integer := 0;
  v_skipped_items integer := 0;
begin
  -- 锁定处方(整单单事务:状态 + 库存扣减原子提交/回滚)
  select * into v_row from public.prescriptions where id = p_prescription_id for update;
  if not found then
    raise exception 'PRESCRIPTION_NOT_FOUND' using errcode = 'P0002';
  end if;
  -- R04:仅 issued 处方可发药(draft 必须先开具,禁止直接发药)
  if v_row.status <> 'issued' then
    raise exception 'PRESCRIPTION_NOT_DISPENSABLE' using errcode = 'P0003',
      message = '仅已开具(issued)处方可发药,草稿处方必须先开具';
  end if;
  -- 已开具处方必须未过期
  if v_row.valid_until is null then
    raise exception 'PRESCRIPTION_EXPIRED' using errcode = 'P0003',
      message = '处方缺少有效期,禁止发药';
  end if;
  if v_row.valid_until < now() then
    raise exception 'PRESCRIPTION_EXPIRED' using errcode = 'P0003',
      message = '处方已过期,禁止发药';
  end if;

  -- 发药员工:由登录用户(p_operator_id)反查在职员工,服务端推导
  select e.id into v_dispenser_employee_id from public.employees e
  where e.user_id = p_operator_id and e.tenant_id = v_row.tenant_id and e.status = 'active'
  limit 1;

  -- 发药仓库:优先门店仓库,其次租户下任意启用仓库(与既有 API 行为一致)
  select * into v_wh from public.warehouses
  where tenant_id = v_row.tenant_id and is_active = true
    and (v_row.store_id is null or store_id = v_row.store_id)
  order by case when v_row.store_id is not null and store_id = v_row.store_id then 0 else 1 end,
           is_default desc, created_at
  limit 1;

  -- 单事务库存扣减:逐项确认预留或即时发药(带 catalog_item_id 的药品条目)
  for v_item in
    select pi.id as item_id, pi.catalog_item_id, pi.quantity, pi.drug_name
    from public.prescription_items pi
    where pi.prescription_id = p_prescription_id
    order by pi.sort_order
  loop
    -- 纯手工药名条目(无 catalog_item_id)按产品规则允许不扣库存
    if v_item.catalog_item_id is null then
      v_skipped_items := v_skipped_items + 1;
      continue;
    end if;
    -- F02:库存商品若无可用仓库必须失败,禁止"无出库但标记 dispensed"
    --     (该租户/门店未配置启用仓库 = 账实一致性 P0)
    if v_wh.id is null then
      raise exception 'DISPENSE_WAREHOUSE_NOT_FOUND' using errcode = 'P0003',
        message = '该租户/门店下无可用仓库,无法发药';
    end if;

    -- 优先确认该处方的预留流水(预留转正式扣减,FEFO 批次)
    select m.id into v_reserve
    from public.inventory_movements m
    where m.tenant_id = v_row.tenant_id
      and m.movement_type = 'reserve'
      and m.reference_type = 'prescription'
      and m.reference_id = p_prescription_id::text
      and m.catalog_item_id = v_item.catalog_item_id
    order by m.created_at
    limit 1;

    if v_reserve is not null then
      v_result := public.confirm_inventory_reservation(
        v_row.tenant_id, v_reserve, p_operator_id, null);
    else
      v_result := public.dispense_inventory(
        v_row.tenant_id, v_wh.id, v_item.catalog_item_id, v_item.quantity,
        'prescription', p_prescription_id::text, p_operator_id, null);
    end if;
    v_dispensed_items := v_dispensed_items + 1;
  end loop;

  -- 状态转换 + 发药信息(与库存扣减同事务)
  update public.prescriptions
  set status = 'dispensed',
      dispensed_by_employee_id = coalesce(v_dispenser_employee_id, dispensed_by_employee_id),
      dispensed_at = now(),
      updated_at = now()
  where id = p_prescription_id
  returning * into v_row;

  insert into public.audit_logs (tenant_id, store_id, user_id, action, entity_type, entity_id, metadata)
  values (v_row.tenant_id, v_row.store_id, p_operator_id, 'prescription.dispense', 'prescription', p_prescription_id,
          jsonb_build_object('status', 'dispensed', 'valid_until', v_row.valid_until,
                             'dispensed_by_employee_id', v_row.dispensed_by_employee_id,
                             'dispensed_items', v_dispensed_items, 'skipped_items', v_skipped_items));

  return v_row;
end;
$$;

-- ============================================================
-- R06: 归档截止触发器增强(create or replace,覆盖 migration 28 定义)
--      签署/出院时同步 archive_status draft→signed,保证归档状态机
--      (draft→signed→archived)与状态转移同源,不依赖各 RPC 手工设置
-- ============================================================
create or replace function public.set_encounter_archive_due()
returns trigger
language plpgsql
as $$
begin
  if new.status in ('signed', 'completed')
     and new.status is distinct from old.status then
    new.archive_due_at = coalesce(new.ended_at, now()) + interval '24 hours';
    if new.archive_status <> 'archived' then
      new.archive_status = 'signed';
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.set_admission_archive_due()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'discharged'
     and new.status is distinct from old.status then
    new.archive_due_at = coalesce(new.discharged_at, now()) + interval '3 days';
    if new.archive_status <> 'archived' then
      new.archive_status = 'signed';
    end if;
  end if;
  return new;
end;
$$;

-- ============================================================
-- R06: 重定义 sign_encounter(保持原签名,覆盖 migration 19 定义)
--      签署时同步:
--        * archive_status draft→signed(归档状态机一致)
--        * signed_by_employee_id 由签署人(p_doctor_id = 登录用户 id)
--          反查在职员工档案,服务端推导,禁止前端指定
--      create or replace 保留原 revoke 权限设置,不影响 service-role-only
-- ============================================================
create or replace function public.sign_encounter(
  p_encounter_id uuid,
  p_doctor_id uuid
)
returns public.encounters
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.encounters;
  v_employee_id uuid;
begin
  select * into v_row from public.encounters where id = p_encounter_id for update;
  if not found then
    raise exception 'ENCOUNTER_NOT_FOUND' using errcode = 'P0002';
  end if;
  -- 必须是主治医生本人签署
  if v_row.doctor_id is null or v_row.doctor_id <> p_doctor_id then
    raise exception 'ENCOUNTER_NOT_OWNER' using errcode = 'P0003';
  end if;
  -- 仅 in_progress / completed 可签署
  if v_row.status not in ('in_progress', 'completed') then
    raise exception 'ENCOUNTER_NOT_SIGNABLE' using errcode = 'P0003';
  end if;
  -- 归档后不可签署
  if v_row.archive_status = 'archived' then
    raise exception 'ARCHIVED_RECORD_IMMUTABLE' using errcode = 'P0003',
      message = '已归档病历不可签署';
  end if;

  -- 签署员工:由登录用户反查在职员工档案(服务端推导)
  select e.id into v_employee_id from public.employees e
  where e.user_id = p_doctor_id and e.tenant_id = v_row.tenant_id and e.status = 'active'
  limit 1;

  update public.encounters
  set status = 'signed',
      signed_by = p_doctor_id,
      signed_by_employee_id = v_employee_id,
      signed_at = now(),
      archive_status = 'signed',
      ended_at = coalesce(ended_at, now()),
      updated_at = now()
  where id = p_encounter_id
  returning * into v_row;

  -- 事务内写入审计(原子保证)
  insert into public.audit_logs (tenant_id, store_id, user_id, action, entity_type, entity_id, metadata)
  values (v_row.tenant_id, v_row.store_id, p_doctor_id, 'encounter.sign', 'encounter', p_encounter_id,
          jsonb_build_object('status', 'signed', 'signed_by_employee_id', v_employee_id));

  return v_row;
end;
$$;

-- ============================================================
-- 11. RPC 权限收紧(S3.1-1)
--     新增 8 个 Command RPC revoke public/anon/authenticated + grant service_role;
--     重定义的 save/dispense 同步收紧(幂等)
-- ============================================================
do $$
declare
  v_fn text;
  v_sig text;
begin
  foreach v_fn in array array[
    -- S3.1-1 合规
    'archive_encounter', 'archive_admission',
    'request_record_amendment', 'review_record_amendment', 'apply_record_amendment',
    'upsert_veterinarian_registration',
    'issue_prescription', 'extend_prescription_validity',
    -- S3.1-1 重定义(保持 service-role-only)
    'save_prescription', 'dispense_prescription'
  ]
  loop
    for v_sig in
      select p.oid::regprocedure::text
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname = v_fn
        and p.prokind = 'f'
    loop
      execute format('revoke all on function %s from public', v_sig);
      execute format('revoke all on function %s from anon', v_sig);
      execute format('revoke all on function %s from authenticated', v_sig);
      execute format('grant execute on function %s to service_role', v_sig);
    end loop;
  end loop;
end;
$$;
