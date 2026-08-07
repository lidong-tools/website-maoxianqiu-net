-- ============================================================
-- MXQ-S3.1-PARALLEL-01: 监管运营 Command RPC(Stage 03 / Sprint S3.1-1)
--
-- 工作包: S3.1-PARALLEL-01 监管运营基础包(与 migration 31 配套)
-- 覆盖:
--   1) save_institution_license / change_license_status  动物诊疗许可证
--   2) generate_regulatory_report / submit_regulatory_report 年度诊疗活动报告
--   3) save_epidemic_event / isolate_epidemic_event / resolve_epidemic_event 疫情事件台账
--   4) save_waste_record / handover_waste 医疗废弃物台账
--
-- 安全模型(遵循 todo.md 二、架构规则):
--   * 全部 Command RPC = SECURITY DEFINER + set search_path = public;
--   * revoke public/anon/authenticated + grant service_role(service-role-only);
--   * 同步登记到 api/lib/service-rpc-manifest.ts;
--   * 权限码校验在 Hono 层(requireScopedPermission)完成,RPC 校验租户/归属/状态机;
--   * actor(操作人)一律由服务端按登录用户推导,禁止客户端传 operatorEmployeeId;
--   * 关键状态流转在 RPC 内事务写 audit_logs(与主事务原子提交)。
-- ============================================================

-- ============================================================
-- 1. save_institution_license 动物诊疗许可证新增/编辑
--    * 同一门店同一证号唯一;编辑仅允许 draft/active/suspended 状态记录,
--      状态变更必须走 change_license_status(保证 license.status_change 审计);
--    * 每次变更向 institution_license_versions 追加版本快照(历史不覆盖);
--    * 不假设全国统一固定有效期(valid_until 可空)。
-- ============================================================
create or replace function public.save_institution_license(
  p_tenant_id uuid,
  p_store_id uuid,
  p_license_id uuid default null,
  p_license_no text default null,
  p_issuing_authority text default null,
  p_diagnosis_scope text default null,
  p_issued_at date default null,
  p_valid_from date default null,
  p_valid_until date default null,
  p_status text default 'draft',
  p_certificate_file_id uuid default null,
  p_certificate_qr text default null,
  p_operator_employee_id uuid default null
)
returns public.institution_licenses
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.institution_licenses;
  v_operator_ok boolean;
  v_store_ok boolean;
  v_version_no integer;
begin
  if coalesce(p_license_no, '') = '' then
    raise exception 'LICENSE_NO_REQUIRED' using errcode = 'P0003';
  end if;
  if p_status not in ('draft', 'active', 'suspended', 'revoked', 'expired') then
    raise exception 'INVALID_LICENSE_STATUS' using errcode = 'P0003';
  end if;

  select exists(
    select 1 from public.stores
    where id = p_store_id and tenant_id = p_tenant_id
  ) into v_store_ok;
  if not v_store_ok then
    raise exception 'STORE_NOT_FOUND' using errcode = 'P0002';
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

  -- 编辑分支
  if p_license_id is not null then
    select * into v_row from public.institution_licenses
    where id = p_license_id and tenant_id = p_tenant_id and store_id = p_store_id
    for update;
    if not found then
      raise exception 'LICENSE_NOT_FOUND' using errcode = 'P0002';
    end if;
    -- 状态变更走 change_license_status,避免绕过 status_change 审计
    if v_row.status in ('revoked', 'expired') then
      raise exception 'LICENSE_NOT_EDITABLE' using errcode = 'P0003',
        message = '已注销/已过期许可证不可编辑,请新增换证记录';
    end if;
    -- 同一门店同一证号唯一性(排除自身)
    if exists (
      select 1 from public.institution_licenses
      where tenant_id = p_tenant_id and store_id = p_store_id
        and license_no = p_license_no and id <> p_license_id
    ) then
      raise exception 'LICENSE_DUPLICATE' using errcode = 'P0003';
    end if;

    update public.institution_licenses
    set license_no = p_license_no,
        issuing_authority = coalesce(p_issuing_authority, issuing_authority),
        diagnosis_scope = coalesce(p_diagnosis_scope, diagnosis_scope),
        issued_at = coalesce(p_issued_at, issued_at),
        valid_from = coalesce(p_valid_from, valid_from),
        valid_until = coalesce(p_valid_until, valid_until),
        certificate_file_id = coalesce(p_certificate_file_id, certificate_file_id),
        certificate_qr = coalesce(p_certificate_qr, certificate_qr),
        updated_at = now(),
        updated_by = p_operator_employee_id
    where id = p_license_id
    returning * into v_row;

    select coalesce(max(version_no), 0) + 1 into v_version_no
    from public.institution_license_versions where license_id = v_row.id;
    insert into public.institution_license_versions (license_id, version_no, change_type, snapshot, changed_at, changed_by)
    values (v_row.id, v_version_no, 'update', to_jsonb(v_row), now(), p_operator_employee_id);

    insert into public.audit_logs (tenant_id, store_id, user_id, action, entity_type, entity_id, metadata)
    values (p_tenant_id, p_store_id, null, 'license.update', 'institution_license', v_row.id,
            jsonb_build_object('before', to_jsonb(v_row), 'after', to_jsonb(v_row),
                               'operator_employee_id', p_operator_employee_id));
  else
    -- 新增分支
    if exists (
      select 1 from public.institution_licenses
      where tenant_id = p_tenant_id and store_id = p_store_id and license_no = p_license_no
    ) then
      raise exception 'LICENSE_DUPLICATE' using errcode = 'P0003';
    end if;

    insert into public.institution_licenses (
      tenant_id, store_id, license_no, issuing_authority, diagnosis_scope,
      issued_at, valid_from, valid_until, status,
      certificate_file_id, certificate_qr, created_by, updated_by
    )
    values (
      p_tenant_id, p_store_id, p_license_no, p_issuing_authority, p_diagnosis_scope,
      p_issued_at, p_valid_from, p_valid_until, p_status,
      p_certificate_file_id, p_certificate_qr, p_operator_employee_id, p_operator_employee_id
    )
    returning * into v_row;

    insert into public.institution_license_versions (license_id, version_no, change_type, snapshot, changed_at, changed_by)
    values (v_row.id, 1, 'create', to_jsonb(v_row), now(), p_operator_employee_id);

    insert into public.audit_logs (tenant_id, store_id, user_id, action, entity_type, entity_id, metadata)
    values (p_tenant_id, p_store_id, null, 'license.create', 'institution_license', v_row.id,
            jsonb_build_object('after', to_jsonb(v_row), 'operator_employee_id', p_operator_employee_id));
  end if;

  return v_row;
end;
$$;

-- ============================================================
-- 2. change_license_status 许可证状态变更(必须走本 RPC,保证审计与版本)
--    允许任意合法状态转移(expired 可由 valid_until 到期派生或手动维护)
-- ============================================================
create or replace function public.change_license_status(
  p_license_id uuid,
  p_new_status text,
  p_operator_employee_id uuid default null
)
returns public.institution_licenses
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.institution_licenses;
  v_old_status text;
  v_operator_ok boolean;
  v_version_no integer;
begin
  if p_new_status not in ('draft', 'active', 'suspended', 'revoked', 'expired') then
    raise exception 'INVALID_LICENSE_STATUS' using errcode = 'P0003';
  end if;

  select * into v_row from public.institution_licenses where id = p_license_id for update;
  if not found then
    raise exception 'LICENSE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_row.status = p_new_status then
    raise exception 'LICENSE_STATUS_UNCHANGED' using errcode = 'P0003';
  end if;

  select exists(
    select 1 from public.employees
    where id = p_operator_employee_id and tenant_id = v_row.tenant_id and status = 'active'
  ) into v_operator_ok;
  if not v_operator_ok then
    raise exception 'OPERATOR_NOT_FOUND' using errcode = 'P0002';
  end if;

  v_old_status := v_row.status;
  update public.institution_licenses
  set status = p_new_status, updated_at = now(), updated_by = p_operator_employee_id
  where id = p_license_id
  returning * into v_row;

  select coalesce(max(version_no), 0) + 1 into v_version_no
  from public.institution_license_versions where license_id = v_row.id;
  insert into public.institution_license_versions (license_id, version_no, change_type, snapshot, changed_at, changed_by)
  values (v_row.id, v_version_no, 'status_change', to_jsonb(v_row), now(), p_operator_employee_id);

  insert into public.audit_logs (tenant_id, store_id, user_id, action, entity_type, entity_id, metadata)
  values (v_row.tenant_id, v_row.store_id, null, 'license.status_change', 'institution_license', v_row.id,
          jsonb_build_object('before_status', v_old_status, 'after_status', p_new_status,
                             'operator_employee_id', p_operator_employee_id));

  return v_row;
end;
$$;

-- ============================================================
-- 3. generate_regulatory_report 生成年度诊疗活动报告
--    * 法规依据《动物诊疗机构管理办法》第三十条;
--    * 生成时保存 report_snapshot,查看/导出一律读快照,历史内容固定;
--    * 各统计口径:门店信息/诊疗数量/医生数量/执业兽医数量/动物类别/处方数量/
--      疫情事件数量/医疗废弃物概要;数据不可可靠计算时明确写 null/unavailable,
--      不伪造(整体异常时快照仅含门店信息与 unavailable 标记);
--    * 已 submitted/accepted/rejected 的报告不可再生成(防覆盖已提交历史)。
-- ============================================================
create or replace function public.generate_regulatory_report(
  p_tenant_id uuid,
  p_store_id uuid,
  p_report_year integer,
  p_operator_employee_id uuid default null
)
returns public.annual_regulatory_reports
language plpgsql
security definer
set search_path = public
as $$
declare
  v_report public.annual_regulatory_reports;
  v_store_name text;
  v_store_code text;
  v_year_start timestamptz;
  v_year_end timestamptz;
  v_encounters integer;
  v_doctors integer;
  v_vets integer;
  v_species jsonb;
  v_prescriptions integer;
  v_epidemics integer;
  v_waste jsonb;
  v_snapshot jsonb;
  v_operator_ok boolean;
  v_store_ok boolean;
begin
  if p_report_year < 2000 or p_report_year > 2100 then
    raise exception 'INVALID_REPORT_YEAR' using errcode = 'P0003';
  end if;

  select exists(
    select 1 from public.stores where id = p_store_id and tenant_id = p_tenant_id
  ) into v_store_ok;
  if not v_store_ok then
    raise exception 'STORE_NOT_FOUND' using errcode = 'P0002';
  end if;

  select exists(
    select 1 from public.employees
    where id = p_operator_employee_id and tenant_id = p_tenant_id and status = 'active'
  ) into v_operator_ok;
  if not v_operator_ok then
    raise exception 'OPERATOR_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- 已提交/已验收报告不允许再生成(防覆盖已提交历史)
  select * into v_report from public.annual_regulatory_reports
  where tenant_id = p_tenant_id and store_id = p_store_id and report_year = p_report_year
  for update;
  if v_report.id is not null and v_report.status in ('submitted', 'accepted', 'rejected') then
    raise exception 'REPORT_ALREADY_SUBMITTED' using errcode = 'P0003',
      message = '该年度报告已提交,禁止重新生成';
  end if;

  v_year_start := make_timestamptz(p_report_year, 1, 1, 0, 0, 0, 'Asia/Shanghai');
  v_year_end := v_year_start + interval '1 year';

  -- 门店基本信息
  select name, code into v_store_name, v_store_code
  from public.stores where id = p_store_id and tenant_id = p_tenant_id;

  -- 各统计口径(异常时置 null/unavailable,不伪造)
  begin
    select count(*) into v_encounters
    from public.encounters
    where tenant_id = p_tenant_id and store_id = p_store_id
      and started_at >= v_year_start and started_at < v_year_end;
  exception when others then
    v_encounters := null;
  end;

  begin
    select count(distinct era.employee_id) into v_doctors
    from public.employee_role_assignments era
    join public.roles r on r.id = era.role_id
    join public.employees e on e.id = era.employee_id
    where era.tenant_id = p_tenant_id and e.status = 'active'
      and (era.store_id = p_store_id or era.store_id is null)
      and r.code = 'doctor';
  exception when others then
    v_doctors := null;
  end;

  -- 有效执业兽医数量:store-scoped + 时间有效性(FINAL-02)
  --     veterinarian_registrations(tenant/employee/status/valid_from/valid_until)
  --     + employee_store_assignments(employee -> store, starts_at/ends_at) 收敛到目标门店
  --     仅统计:租户一致 + 门店一致 + 备案 active + 备案在有效期内 + 门店分配在有效期内
  begin
    select count(distinct vr.employee_id) into v_vets
    from public.veterinarian_registrations vr
    join public.employee_store_assignments esa
      on esa.tenant_id = vr.tenant_id and esa.employee_id = vr.employee_id
    where vr.tenant_id = p_tenant_id
      and esa.store_id = p_store_id
      and vr.status = 'active'
      and vr.valid_from <= (now() at time zone 'Asia/Shanghai')::date
      and (vr.valid_until is null or vr.valid_until >= (now() at time zone 'Asia/Shanghai')::date)
      and (esa.starts_at is null or esa.starts_at <= now())
      and (esa.ends_at is null or esa.ends_at > now());
  exception when others then
    v_vets := null;
  end;

  begin
    select jsonb_object_agg(coalesce(p.species, 'unknown'), cnt) into v_species
    from (
      select p.species, count(*) as cnt
      from public.encounters e
      join public.pets p on p.id = e.pet_id
      where e.tenant_id = p_tenant_id and e.store_id = p_store_id
        and e.started_at >= v_year_start and e.started_at < v_year_end
      group by p.species
    ) t;
    v_species := coalesce(v_species, '{}'::jsonb);
  exception when others then
    v_species := null;
  end;

  begin
    select count(*) into v_prescriptions
    from public.prescriptions
    where tenant_id = p_tenant_id and store_id = p_store_id
      and created_at >= v_year_start and created_at < v_year_end;
  exception when others then
    v_prescriptions := null;
  end;

  begin
    select count(*) into v_epidemics
    from public.epidemic_events
    where tenant_id = p_tenant_id and store_id = p_store_id
      and detected_at >= v_year_start and detected_at < v_year_end;
  exception when others then
    v_epidemics := null;
  end;

  begin
    select jsonb_build_object(
      'record_count', count(*),
      'total_quantity', coalesce(sum(quantity), 0),
      'handed_over_count', count(*) filter (where status = 'handed_over')
    ) into v_waste
    from public.medical_waste_records
    where tenant_id = p_tenant_id and store_id = p_store_id
      and generated_at >= v_year_start and generated_at < v_year_end;
  exception when others then
    v_waste := null;
  end;

  v_snapshot := jsonb_build_object(
    'report_year', p_report_year,
    'generated_at', now(),
    'store', jsonb_build_object(
      'store_id', p_store_id,
      'store_name', v_store_name,
      'store_code', v_store_code
    ),
    'stats', jsonb_build_object(
      'encounter_count', v_encounters,
      'doctor_count', v_doctors,
      'registered_veterinarian_count', v_vets,
      'species_distribution', v_species,
      'prescription_count', v_prescriptions,
      'epidemic_event_count', v_epidemics,
      'medical_waste_summary', v_waste
    ),
    'computed_at', now(),
    -- 明确标记无法可靠计算的字段(值为 null 的统计口径),不伪造数据
    'unavailable_fields', (
      select coalesce(jsonb_agg(k), '[]'::jsonb)
      from jsonb_each(
        jsonb_build_object(
          'encounter_count', v_encounters,
          'doctor_count', v_doctors,
          'registered_veterinarian_count', v_vets,
          'species_distribution', v_species,
          'prescription_count', v_prescriptions,
          'epidemic_event_count', v_epidemics,
          'medical_waste_summary', v_waste
        )
      ) as t(k, v)
      where v.value is null
    )
  );

  if v_report.id is null then
    insert into public.annual_regulatory_reports (
      tenant_id, store_id, report_year, status, generated_at, generated_by, report_snapshot
    )
    values (
      p_tenant_id, p_store_id, p_report_year, 'generated', now(), p_operator_employee_id, v_snapshot
    )
    returning * into v_report;
  else
    update public.annual_regulatory_reports
    set status = 'generated',
        generated_at = now(),
        generated_by = p_operator_employee_id,
        report_snapshot = v_snapshot,
        updated_at = now()
    where id = v_report.id
    returning * into v_report;
  end if;

  insert into public.audit_logs (tenant_id, store_id, user_id, action, entity_type, entity_id, metadata)
  values (p_tenant_id, p_store_id, null, 'regulatory_report.generate', 'annual_regulatory_report', v_report.id,
          jsonb_build_object('report_year', p_report_year, 'operator_employee_id', p_operator_employee_id,
                             'snapshot', v_snapshot));

  return v_report;
end;
$$;

-- ============================================================
-- 4. submit_regulatory_report 提交年度报告(标记已提交)
--    仅 generated 可提交;submit 必须 audit
-- ============================================================
create or replace function public.submit_regulatory_report(
  p_report_id uuid,
  p_operator_employee_id uuid default null
)
returns public.annual_regulatory_reports
language plpgsql
security definer
set search_path = public
as $$
declare
  v_report public.annual_regulatory_reports;
  v_operator_ok boolean;
begin
  select * into v_report from public.annual_regulatory_reports where id = p_report_id for update;
  if not found then
    raise exception 'REPORT_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_report.status <> 'generated' then
    raise exception 'REPORT_NOT_GENERATED' using errcode = 'P0003',
      message = '仅已生成(generated)状态的报告可提交';
  end if;

  select exists(
    select 1 from public.employees
    where id = p_operator_employee_id and tenant_id = v_report.tenant_id and status = 'active'
  ) into v_operator_ok;
  if not v_operator_ok then
    raise exception 'OPERATOR_NOT_FOUND' using errcode = 'P0002';
  end if;

  update public.annual_regulatory_reports
  set status = 'submitted', submitted_at = now(), submitted_by = p_operator_employee_id, updated_at = now()
  where id = p_report_id
  returning * into v_report;

  insert into public.audit_logs (tenant_id, store_id, user_id, action, entity_type, entity_id, metadata)
  values (v_report.tenant_id, v_report.store_id, null, 'regulatory_report.submit', 'annual_regulatory_report', v_report.id,
          jsonb_build_object('report_year', v_report.report_year, 'operator_employee_id', p_operator_employee_id));

  return v_report;
end;
$$;

-- ============================================================
-- 5. save_epidemic_event 疫情事件新增/维护
--    * 系统只负责记录,不替医生自动诊断;
--    * 是否隔离/是否限制治疗由授权用户明确填写;
--    * 仅 detected/reported 状态可编辑;isolated/resolved 后不可修改;
--    * 上报动作(reported)必须 audit(epidemic.report)。
-- ============================================================
create or replace function public.save_epidemic_event(
  p_tenant_id uuid,
  p_store_id uuid,
  p_event_id uuid default null,
  p_customer_id uuid default null,
  p_pet_id uuid default null,
  p_encounter_id uuid default null,
  p_suspected_disease text default null,
  p_detected_at timestamptz default null,
  p_isolation_required boolean default false,
  p_treatment_restricted boolean default false,
  p_restriction_reason text default null,
  p_culling_required boolean default null,
  p_notes text default null,
  p_status text default 'detected',
  p_operator_employee_id uuid default null
)
returns public.epidemic_events
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.epidemic_events;
  v_operator_ok boolean;
  v_store_ok boolean;
  v_old_status text;
begin
  if coalesce(p_suspected_disease, '') = '' then
    raise exception 'SUSPECTED_DISEASE_REQUIRED' using errcode = 'P0003';
  end if;
  if p_status not in ('detected', 'reported') then
    raise exception 'INVALID_EPIDEMIC_STATUS' using errcode = 'P0003',
      message = '事件创建/维护仅支持 detected/reported 状态,隔离与解除请走专属动作';
  end if;

  select exists(
    select 1 from public.stores where id = p_store_id and tenant_id = p_tenant_id
  ) into v_store_ok;
  if not v_store_ok then
    raise exception 'STORE_NOT_FOUND' using errcode = 'P0002';
  end if;

  select exists(
    select 1 from public.employees
    where id = p_operator_employee_id and tenant_id = p_tenant_id and status = 'active'
  ) into v_operator_ok;
  if not v_operator_ok then
    raise exception 'OPERATOR_NOT_FOUND' using errcode = 'P0002';
  end if;

  if p_event_id is not null then
    select * into v_row from public.epidemic_events
    where id = p_event_id and tenant_id = p_tenant_id and store_id = p_store_id
    for update;
    if not found then
      raise exception 'EPIDEMIC_NOT_FOUND' using errcode = 'P0002';
    end if;
    if v_row.status in ('isolated', 'resolved') then
      raise exception 'EPIDEMIC_NOT_EDITABLE' using errcode = 'P0003',
        message = '已隔离/已解除事件不可修改';
    end if;
    v_old_status := v_row.status;

    update public.epidemic_events
    set customer_id = p_customer_id,
        pet_id = p_pet_id,
        encounter_id = p_encounter_id,
        suspected_disease = p_suspected_disease,
        detected_at = coalesce(p_detected_at, detected_at),
        isolation_required = coalesce(p_isolation_required, isolation_required),
        treatment_restricted = coalesce(p_treatment_restricted, treatment_restricted),
        restriction_reason = coalesce(p_restriction_reason, restriction_reason),
        culling_required = coalesce(p_culling_required, culling_required),
        notes = coalesce(p_notes, notes),
        status = p_status,
        reported_at = case when p_status = 'reported' then coalesce(reported_at, now()) else reported_at end,
        reported_by = case when p_status = 'reported' then coalesce(reported_by, p_operator_employee_id) else reported_by end,
        updated_at = now()
    where id = p_event_id
    returning * into v_row;

    insert into public.audit_logs (tenant_id, store_id, user_id, action, entity_type, entity_id, metadata)
    values (p_tenant_id, p_store_id, null,
            case when p_status = 'reported' then 'epidemic.report' else 'epidemic.update' end,
            'epidemic_event', v_row.id,
            jsonb_build_object('before_status', v_old_status, 'after_status', p_status,
                               'operator_employee_id', p_operator_employee_id));
  else
    insert into public.epidemic_events (
      tenant_id, store_id, customer_id, pet_id, encounter_id,
      suspected_disease, detected_at, detected_by, status,
      isolation_required, treatment_restricted, restriction_reason,
      culling_required, notes,
      reported_at, reported_by
    )
    values (
      p_tenant_id, p_store_id, p_customer_id, p_pet_id, p_encounter_id,
      p_suspected_disease, coalesce(p_detected_at, now()), p_operator_employee_id, p_status,
      coalesce(p_isolation_required, false), coalesce(p_treatment_restricted, false), p_restriction_reason,
      p_culling_required, p_notes,
      case when p_status = 'reported' then now() else null end,
      case when p_status = 'reported' then p_operator_employee_id else null end
    )
    returning * into v_row;

    insert into public.audit_logs (tenant_id, store_id, user_id, action, entity_type, entity_id, metadata)
    values (p_tenant_id, p_store_id, null, 'epidemic.report', 'epidemic_event', v_row.id,
            jsonb_build_object('status', p_status, 'suspected_disease', p_suspected_disease,
                               'operator_employee_id', p_operator_employee_id));
  end if;

  return v_row;
end;
$$;

-- ============================================================
-- 6. isolate_epidemic_event 疫情事件隔离(必须 audit)
--    仅 detected/reported 可隔离;隔离时自动置 isolation_required=true
-- ============================================================
create or replace function public.isolate_epidemic_event(
  p_event_id uuid,
  p_operator_employee_id uuid default null
)
returns public.epidemic_events
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.epidemic_events;
  v_operator_ok boolean;
begin
  select * into v_row from public.epidemic_events where id = p_event_id for update;
  if not found then
    raise exception 'EPIDEMIC_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_row.status not in ('detected', 'reported') then
    raise exception 'EPIDEMIC_NOT_ISOLATABLE' using errcode = 'P0003',
      message = '仅 detected/reported 状态事件可执行隔离';
  end if;

  select exists(
    select 1 from public.employees
    where id = p_operator_employee_id and tenant_id = v_row.tenant_id and status = 'active'
  ) into v_operator_ok;
  if not v_operator_ok then
    raise exception 'OPERATOR_NOT_FOUND' using errcode = 'P0002';
  end if;

  update public.epidemic_events
  set status = 'isolated',
      isolation_required = true,
      isolated_at = now(),
      updated_at = now()
  where id = p_event_id
  returning * into v_row;

  insert into public.audit_logs (tenant_id, store_id, user_id, action, entity_type, entity_id, metadata)
  values (v_row.tenant_id, v_row.store_id, null, 'epidemic.isolate', 'epidemic_event', v_row.id,
          jsonb_build_object('operator_employee_id', p_operator_employee_id));

  return v_row;
end;
$$;

-- ============================================================
-- 7. resolve_epidemic_event 疫情事件解除(必须 audit)
--    仅 detected/reported/isolated 可解除
-- ============================================================
create or replace function public.resolve_epidemic_event(
  p_event_id uuid,
  p_operator_employee_id uuid default null
)
returns public.epidemic_events
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.epidemic_events;
  v_operator_ok boolean;
begin
  select * into v_row from public.epidemic_events where id = p_event_id for update;
  if not found then
    raise exception 'EPIDEMIC_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_row.status not in ('detected', 'reported', 'isolated') then
    raise exception 'EPIDEMIC_NOT_RESOLVABLE' using errcode = 'P0003',
      message = '事件已解除,不可重复解除';
  end if;

  select exists(
    select 1 from public.employees
    where id = p_operator_employee_id and tenant_id = v_row.tenant_id and status = 'active'
  ) into v_operator_ok;
  if not v_operator_ok then
    raise exception 'OPERATOR_NOT_FOUND' using errcode = 'P0002';
  end if;

  update public.epidemic_events
  set status = 'resolved',
      resolved_at = now(),
      resolved_by = p_operator_employee_id,
      updated_at = now()
  where id = p_event_id
  returning * into v_row;

  insert into public.audit_logs (tenant_id, store_id, user_id, action, entity_type, entity_id, metadata)
  values (v_row.tenant_id, v_row.store_id, null, 'epidemic.resolve', 'epidemic_event', v_row.id,
          jsonb_build_object('operator_employee_id', p_operator_employee_id));

  return v_row;
end;
$$;

-- ============================================================
-- 8. save_waste_record 医疗废弃物新增/维护
--    * 仅 draft/recorded 可编辑;handed_over 后不可修改;
--    * create / update 必须 audit。
-- ============================================================
create or replace function public.save_waste_record(
  p_tenant_id uuid,
  p_store_id uuid,
  p_record_id uuid default null,
  p_waste_type text default null,
  p_quantity numeric default 1,
  p_unit text default null,
  p_generated_at timestamptz default null,
  p_handler_employee_id uuid default null,
  p_notes text default null,
  p_attachment_file_id uuid default null,
  p_status text default 'draft',
  p_operator_employee_id uuid default null
)
returns public.medical_waste_records
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.medical_waste_records;
  v_operator_ok boolean;
  v_store_ok boolean;
  v_emp_ok boolean;
begin
  if coalesce(p_waste_type, '') = '' then
    raise exception 'WASTE_TYPE_REQUIRED' using errcode = 'P0003';
  end if;
  if p_quantity is null or p_quantity < 0 then
    raise exception 'INVALID_WASTE_QUANTITY' using errcode = 'P0003';
  end if;
  if p_status not in ('draft', 'recorded') then
    raise exception 'INVALID_WASTE_STATUS' using errcode = 'P0003',
      message = '记录创建/维护仅支持 draft/recorded 状态,交接请走专属动作';
  end if;

  select exists(
    select 1 from public.stores where id = p_store_id and tenant_id = p_tenant_id
  ) into v_store_ok;
  if not v_store_ok then
    raise exception 'STORE_NOT_FOUND' using errcode = 'P0002';
  end if;

  select exists(
    select 1 from public.employees
    where id = p_operator_employee_id and tenant_id = p_tenant_id and status = 'active'
  ) into v_operator_ok;
  if not v_operator_ok then
    raise exception 'OPERATOR_NOT_FOUND' using errcode = 'P0002';
  end if;

  if p_handler_employee_id is not null then
    select exists(
      select 1 from public.employees
      where id = p_handler_employee_id and tenant_id = p_tenant_id and status = 'active'
    ) into v_emp_ok;
    if not v_emp_ok then
      raise exception 'EMPLOYEE_NOT_FOUND' using errcode = 'P0002',
        message = '交接员工不存在或不属于该租户';
    end if;
  end if;

  if p_record_id is not null then
    select * into v_row from public.medical_waste_records
    where id = p_record_id and tenant_id = p_tenant_id and store_id = p_store_id
    for update;
    if not found then
      raise exception 'WASTE_NOT_FOUND' using errcode = 'P0002';
    end if;
    if v_row.status = 'handed_over' then
      raise exception 'WASTE_NOT_EDITABLE' using errcode = 'P0003',
        message = '已交接记录不可修改';
    end if;

    update public.medical_waste_records
    set waste_type = p_waste_type,
        quantity = p_quantity,
        unit = coalesce(p_unit, unit),
        generated_at = coalesce(p_generated_at, generated_at),
        handler_employee_id = coalesce(p_handler_employee_id, handler_employee_id),
        notes = coalesce(p_notes, notes),
        attachment_file_id = coalesce(p_attachment_file_id, attachment_file_id),
        status = p_status,
        updated_at = now()
    where id = p_record_id
    returning * into v_row;

    insert into public.audit_logs (tenant_id, store_id, user_id, action, entity_type, entity_id, metadata)
    values (p_tenant_id, p_store_id, null, 'waste.update', 'medical_waste_record', v_row.id,
            jsonb_build_object('operator_employee_id', p_operator_employee_id, 'status', p_status));
  else
    insert into public.medical_waste_records (
      tenant_id, store_id, waste_type, quantity, unit, generated_at,
      handler_employee_id, notes, attachment_file_id, status, created_by, updated_at
    )
    values (
      p_tenant_id, p_store_id, p_waste_type, p_quantity, p_unit, coalesce(p_generated_at, now()),
      p_handler_employee_id, p_notes, p_attachment_file_id, p_status, p_operator_employee_id, now()
    )
    returning * into v_row;

    insert into public.audit_logs (tenant_id, store_id, user_id, action, entity_type, entity_id, metadata)
    values (p_tenant_id, p_store_id, null, 'waste.create', 'medical_waste_record', v_row.id,
            jsonb_build_object('waste_type', p_waste_type, 'quantity', p_quantity,
                               'operator_employee_id', p_operator_employee_id));
  end if;

  return v_row;
end;
$$;

-- ============================================================
-- 9. handover_waste 医疗废弃物交接(必须 audit)
--    仅 draft/recorded 可交接;交接后状态 handed_over,不可再修改
-- ============================================================
create or replace function public.handover_waste(
  p_record_id uuid,
  p_handler_employee_id uuid default null,
  p_receiver text default null,
  p_disposal_method text default null,
  p_handover_at timestamptz default null,
  p_operator_employee_id uuid default null
)
returns public.medical_waste_records
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.medical_waste_records;
  v_operator_ok boolean;
  v_emp_ok boolean;
begin
  if coalesce(p_receiver, '') = '' then
    raise exception 'WASTE_RECEIVER_REQUIRED' using errcode = 'P0003',
      message = '交接必须填写接收方';
  end if;

  select * into v_row from public.medical_waste_records where id = p_record_id for update;
  if not found then
    raise exception 'WASTE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_row.status = 'handed_over' then
    raise exception 'WASTE_ALREADY_HANDED_OVER' using errcode = 'P0003';
  end if;

  select exists(
    select 1 from public.employees
    where id = p_operator_employee_id and tenant_id = v_row.tenant_id and status = 'active'
  ) into v_operator_ok;
  if not v_operator_ok then
    raise exception 'OPERATOR_NOT_FOUND' using errcode = 'P0002';
  end if;

  if p_handler_employee_id is not null then
    select exists(
      select 1 from public.employees
      where id = p_handler_employee_id and tenant_id = v_row.tenant_id and status = 'active'
    ) into v_emp_ok;
    if not v_emp_ok then
      raise exception 'EMPLOYEE_NOT_FOUND' using errcode = 'P0002',
        message = '交接员工不存在或不属于该租户';
    end if;
  end if;

  update public.medical_waste_records
  set status = 'handed_over',
      handover_at = coalesce(p_handover_at, now()),
      handler_employee_id = coalesce(p_handler_employee_id, handler_employee_id),
      receiver = p_receiver,
      disposal_method = coalesce(p_disposal_method, disposal_method),
      updated_at = now()
  where id = p_record_id
  returning * into v_row;

  insert into public.audit_logs (tenant_id, store_id, user_id, action, entity_type, entity_id, metadata)
  values (v_row.tenant_id, v_row.store_id, null, 'waste.handover', 'medical_waste_record', v_row.id,
          jsonb_build_object('handler_employee_id', p_handler_employee_id, 'receiver', p_receiver,
                             'disposal_method', p_disposal_method, 'operator_employee_id', p_operator_employee_id));

  return v_row;
end;
$$;

-- ============================================================
-- 10. RPC 权限收紧
--     9 个 Command RPC revoke public/anon/authenticated + grant service_role
-- ============================================================
do $$
declare
  v_fn text;
  v_sig text;
begin
  foreach v_fn in array array[
    'save_institution_license', 'change_license_status',
    'generate_regulatory_report', 'submit_regulatory_report',
    'save_epidemic_event', 'isolate_epidemic_event', 'resolve_epidemic_event',
    'save_waste_record', 'handover_waste'
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
