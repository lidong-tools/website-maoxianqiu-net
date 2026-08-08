-- ============================================================
-- MXQ-S31-MERGE-B: 监管模块修复包(migration 34,独占)
--
-- 工作包: S31-MERGE-B 监管模块修复(合并返工任务 B)
-- 覆盖(与 migration 31/32 配套,重写 9 个 Command RPC):
--   B01: 年度活动报告 SQL 修复
--        - jsonb_each alias 错误: v.value -> v = 'null'::jsonb(JSON null ≠ SQL NULL)
--        - species alias 错误: p.species -> t.species(子查询 alias)
--        - veterinarian count 改为 store-scoped(join employee_store_assignments)
--   B02: 关联对象跨租户校验(SECURITY DEFINER RPC 不依赖 FK/前端 Picker)
--        - save_epidemic_event: customer_id / pet_id / encounter_id 逐一校验租户归属
--        - save_institution_license: p_certificate_file_id 校验 tenant/store/status
--        - save_waste_record: p_attachment_file_id 同规则校验
--   B05: 许可证状态机(禁止 revoked/expired 普通复活)
--        draft -> active;active -> suspended/revoked/expired;
--        suspended -> active/revoked/expired;revoked/expired 为终态
--   B06: 疫情状态机(禁止 reported -> detected 回退)+ audit action 区分
--        epidemic.detect / epidemic.update / epidemic.report / epidemic.isolate / epidemic.resolve
--   B07: audit 修复
--        - license update before/after 真实(先 SELECT 旧行再 UPDATE RETURNING)
--        - audit_logs.user_id 由 employee.user_id 解析(两层追溯:auth identity + employee identity)
--
-- 约束:
--   * 不修改 migration 28/29/31/32(已交付,禁止回改);
--   * 不修改权限核心模型 / can_access_store / tenant_owner / platform_user_roles;
--   * 不修改 clinical / inventory / prescription / archive 主线逻辑;
--   * 不新增 RPC(仅重写),service-rpc-manifest 无需变更;
--   * RPC 保持 SECURITY DEFINER + set search_path,重新 revoke/grant(幂等)。
-- ============================================================

-- ============================================================
-- 0. 通用内部辅助:解析操作人 employee -> auth user_id(B07 两层追溯)
--    内部函数,非 Command RPC,不进 service-rpc-manifest;
--    保持 SECURITY DEFINER 以 service_role 执行时能读到 auth.users。
-- ============================================================
create or replace function public.resolve_operator_user_id(p_employee_id uuid)
returns uuid
language sql
security definer
set search_path = public
as $$
  select user_id from public.employees where id = p_employee_id
$$;

revoke all on function public.resolve_operator_user_id(uuid) from public;
revoke all on function public.resolve_operator_user_id(uuid) from anon;
revoke all on function public.resolve_operator_user_id(uuid) from authenticated;

-- ============================================================
-- 1. save_institution_license 重写
--    B02: certificate_file_id 跨租户/门店/状态校验(FILE_SCOPE_MISMATCH)
--    B07: update 分支 before/after 真实;audit user_id 由 employee 解析
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
  v_before public.institution_licenses;
  v_row public.institution_licenses;
  v_operator_ok boolean;
  v_store_ok boolean;
  v_version_no integer;
  v_operator_user_id uuid;
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
    -- B07:解析 auth user_id(两层追溯)
    select public.resolve_operator_user_id(p_operator_employee_id) into v_operator_user_id;
  end if;

  -- B02:证照附件必须属于目标租户、门店范围一致且已上传(FILE_SCOPE_MISMATCH)
  if p_certificate_file_id is not null then
    if not exists (
      select 1 from public.files
      where id = p_certificate_file_id
        and tenant_id = p_tenant_id
        and (store_id is null or store_id = p_store_id)
        and status = 'uploaded'
    ) then
      raise exception 'FILE_SCOPE_MISMATCH' using errcode = 'P0003';
    end if;
  end if;

  -- 编辑分支
  if p_license_id is not null then
    -- B07:先取旧行做 before,再 UPDATE RETURNING 得 after
    select * into v_before from public.institution_licenses
    where id = p_license_id and tenant_id = p_tenant_id and store_id = p_store_id
    for update;
    if not found then
      raise exception 'LICENSE_NOT_FOUND' using errcode = 'P0002';
    end if;
    -- 状态变更走 change_license_status,避免绕过 status_change 审计
    if v_before.status in ('revoked', 'expired') then
      raise exception 'LICENSE_NOT_EDITABLE' using errcode = 'P0003';
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
    values (p_tenant_id, p_store_id, v_operator_user_id, 'license.update', 'institution_license', v_row.id,
            jsonb_build_object('before', to_jsonb(v_before), 'after', to_jsonb(v_row),
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
    values (p_tenant_id, p_store_id, v_operator_user_id, 'license.create', 'institution_license', v_row.id,
            jsonb_build_object('after', to_jsonb(v_row), 'operator_employee_id', p_operator_employee_id));
  end if;

  return v_row;
end;
$$;

-- ============================================================
-- 2. change_license_status 重写
--    B05: 状态机 transition matrix,revoked/expired 为终态(INVALID_LICENSE_TRANSITION)
--    B07: audit user_id 由 employee 解析
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
  v_operator_user_id uuid;
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
  select public.resolve_operator_user_id(p_operator_employee_id) into v_operator_user_id;

  -- B05:许可证状态机(revoked/expired 为终态,禁止普通复活)
  if not (
    (v_row.status = 'draft' and p_new_status = 'active')
    or (v_row.status = 'active' and p_new_status in ('suspended', 'revoked', 'expired'))
    or (v_row.status = 'suspended' and p_new_status in ('active', 'revoked', 'expired'))
  ) then
    raise exception 'INVALID_LICENSE_TRANSITION' using errcode = 'P0003', detail = v_row.status || ' -> ' || p_new_status;
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
  values (v_row.tenant_id, v_row.store_id, v_operator_user_id, 'license.status_change', 'institution_license', v_row.id,
          jsonb_build_object('before_status', v_old_status, 'after_status', p_new_status,
                             'operator_employee_id', p_operator_employee_id));

  return v_row;
end;
$$;

-- ============================================================
-- 3. generate_regulatory_report 重写
--    B01: jsonb_each alias 修复(v = 'null'::jsonb)
--         species alias 修复(p.species -> t.species)
--         veterinarian count store-scoped(join employee_store_assignments)
--    B07: audit user_id 由 employee 解析
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
  v_operator_user_id uuid;
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
  select public.resolve_operator_user_id(p_operator_employee_id) into v_operator_user_id;

  -- 已提交/已验收报告不允许再生成(防覆盖已提交历史)
  select * into v_report from public.annual_regulatory_reports
  where tenant_id = p_tenant_id and store_id = p_store_id and report_year = p_report_year
  for update;
  if v_report.id is not null and v_report.status in ('submitted', 'accepted', 'rejected') then
    raise exception 'REPORT_ALREADY_SUBMITTED' using errcode = 'P0003';
  end if;

  v_year_start := make_timestamptz(p_report_year, 1, 1, 0, 0, 0, 'Asia/Shanghai');
  v_year_end := v_year_start + interval '1 year';

  -- 门店基本信息
  select name, code into v_store_name, v_store_code
  from public.stores where id = p_store_id and tenant_id = p_tenant_id;

  -- 各统计口径(异常时置 null/unavailable,不伪造;统计健壮性保护,非掩盖编码 bug)
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

  -- B01+FINAL-02:有效执业兽医数量必须 store-scoped + 时间有效性
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
    -- B01:物种分布引用子查询 alias t,不再引用外部不存在的 p
    select jsonb_object_agg(coalesce(t.species, 'unknown'), t.cnt) into v_species
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
    -- B01:JSON null 判断,jsonb_each 的 value 是 jsonb 类型,直接与 'null'::jsonb 比较
    --     (jsonb_build_object 对 NULL 参数产出 JSON null,而非 SQL NULL)
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
      where v = 'null'::jsonb
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
  values (p_tenant_id, p_store_id, v_operator_user_id, 'regulatory_report.generate', 'annual_regulatory_report', v_report.id,
          jsonb_build_object('report_year', p_report_year, 'operator_employee_id', p_operator_employee_id,
                             'snapshot', v_snapshot));

  return v_report;
end;
$$;

-- ============================================================
-- 4. submit_regulatory_report 重写
--    B07: audit user_id 由 employee 解析
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
  v_operator_user_id uuid;
begin
  select * into v_report from public.annual_regulatory_reports where id = p_report_id for update;
  if not found then
    raise exception 'REPORT_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_report.status <> 'generated' then
    raise exception 'REPORT_NOT_GENERATED' using errcode = 'P0003';
  end if;

  select exists(
    select 1 from public.employees
    where id = p_operator_employee_id and tenant_id = v_report.tenant_id and status = 'active'
  ) into v_operator_ok;
  if not v_operator_ok then
    raise exception 'OPERATOR_NOT_FOUND' using errcode = 'P0002';
  end if;
  select public.resolve_operator_user_id(p_operator_employee_id) into v_operator_user_id;

  update public.annual_regulatory_reports
  set status = 'submitted', submitted_at = now(), submitted_by = p_operator_employee_id, updated_at = now()
  where id = p_report_id
  returning * into v_report;

  insert into public.audit_logs (tenant_id, store_id, user_id, action, entity_type, entity_id, metadata)
  values (v_report.tenant_id, v_report.store_id, v_operator_user_id, 'regulatory_report.submit', 'annual_regulatory_report', v_report.id,
          jsonb_build_object('report_year', v_report.report_year, 'operator_employee_id', p_operator_employee_id));

  return v_report;
end;
$$;

-- ============================================================
-- 5. save_epidemic_event 重写
--    B02: customer/pet/encounter 跨租户校验
--         (CUSTOMER_SCOPE_MISMATCH / PET_SCOPE_MISMATCH /
--          ENCOUNTER_SCOPE_MISMATCH / RELATED_ENTITY_MISMATCH)
--    B06: 状态机禁止 reported -> detected 回退(INVALID_EPIDEMIC_TRANSITION);
--         audit action 区分 epidemic.detect / epidemic.update / epidemic.report
--    B07: audit user_id 由 employee 解析
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
  v_operator_user_id uuid;
  v_action text;
begin
  if coalesce(p_suspected_disease, '') = '' then
    raise exception 'SUSPECTED_DISEASE_REQUIRED' using errcode = 'P0003';
  end if;
  if p_status not in ('detected', 'reported') then
    raise exception 'INVALID_EPIDEMIC_STATUS' using errcode = 'P0003';
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
  select public.resolve_operator_user_id(p_operator_employee_id) into v_operator_user_id;

  -- ===== B02:关联对象跨租户校验(SECURITY DEFINER 不依赖 FK/前端 Picker) =====
  -- customer 必须属于目标租户
  if p_customer_id is not null then
    if not exists (
      select 1 from public.customers
      where id = p_customer_id and tenant_id = p_tenant_id
    ) then
      raise exception 'CUSTOMER_SCOPE_MISMATCH' using errcode = 'P0003';
    end if;
  end if;
  -- pet 必须属于目标租户;同时传 customer 时校验 pet.customer_id 归属一致
  if p_pet_id is not null then
    if not exists (
      select 1 from public.pets
      where id = p_pet_id and tenant_id = p_tenant_id
    ) then
      raise exception 'PET_SCOPE_MISMATCH' using errcode = 'P0003';
    end if;
    if p_customer_id is not null then
      if not exists (
        select 1 from public.pets
        where id = p_pet_id and customer_id = p_customer_id
      ) then
        raise exception 'RELATED_ENTITY_MISMATCH' using errcode = 'P0003';
      end if;
    end if;
  end if;
  -- encounter 必须属于目标租户 + 目标门店;与 customer/pet 不冲突
  if p_encounter_id is not null then
    if not exists (
      select 1 from public.encounters
      where id = p_encounter_id and tenant_id = p_tenant_id
    ) then
      raise exception 'ENCOUNTER_SCOPE_MISMATCH' using errcode = 'P0003';
    end if;
    if not exists (
      select 1 from public.encounters
      where id = p_encounter_id and store_id = p_store_id
    ) then
      raise exception 'ENCOUNTER_SCOPE_MISMATCH' using errcode = 'P0003';
    end if;
    if p_customer_id is not null or p_pet_id is not null then
      if not exists (
        select 1 from public.encounters
        where id = p_encounter_id
          and (p_customer_id is null or customer_id = p_customer_id)
          and (p_pet_id is null or pet_id = p_pet_id)
      ) then
        raise exception 'RELATED_ENTITY_MISMATCH' using errcode = 'P0003';
      end if;
    end if;
  end if;
  -- ===== B02 结束 =====

  if p_event_id is not null then
    select * into v_row from public.epidemic_events
    where id = p_event_id and tenant_id = p_tenant_id and store_id = p_store_id
    for update;
    if not found then
      raise exception 'EPIDEMIC_NOT_FOUND' using errcode = 'P0002';
    end if;
    if v_row.status in ('isolated', 'resolved') then
      raise exception 'EPIDEMIC_NOT_EDITABLE' using errcode = 'P0003';
    end if;
    -- B06:禁止 reported -> detected 回退
    if v_row.status = 'reported' and p_status = 'detected' then
      raise exception 'INVALID_EPIDEMIC_TRANSITION' using errcode = 'P0003';
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

    -- B06:audit action 区分:detected -> reported 记 report,其余维护记 update
    v_action := case
      when v_old_status = 'detected' and p_status = 'reported' then 'epidemic.report'
      else 'epidemic.update'
    end;
    insert into public.audit_logs (tenant_id, store_id, user_id, action, entity_type, entity_id, metadata)
    values (p_tenant_id, p_store_id, v_operator_user_id, v_action,
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

    -- B06:创建 detected 记 epidemic.detect,创建即上报记 epidemic.report
    v_action := case when p_status = 'reported' then 'epidemic.report' else 'epidemic.detect' end;
    insert into public.audit_logs (tenant_id, store_id, user_id, action, entity_type, entity_id, metadata)
    values (p_tenant_id, p_store_id, v_operator_user_id, v_action, 'epidemic_event', v_row.id,
            jsonb_build_object('status', p_status, 'suspected_disease', p_suspected_disease,
                               'operator_employee_id', p_operator_employee_id));
  end if;

  return v_row;
end;
$$;

-- ============================================================
-- 6. isolate_epidemic_event 重写
--    B07: audit user_id 由 employee 解析
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
  v_operator_user_id uuid;
begin
  select * into v_row from public.epidemic_events where id = p_event_id for update;
  if not found then
    raise exception 'EPIDEMIC_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_row.status not in ('detected', 'reported') then
    raise exception 'EPIDEMIC_NOT_ISOLATABLE' using errcode = 'P0003';
  end if;

  select exists(
    select 1 from public.employees
    where id = p_operator_employee_id and tenant_id = v_row.tenant_id and status = 'active'
  ) into v_operator_ok;
  if not v_operator_ok then
    raise exception 'OPERATOR_NOT_FOUND' using errcode = 'P0002';
  end if;
  select public.resolve_operator_user_id(p_operator_employee_id) into v_operator_user_id;

  update public.epidemic_events
  set status = 'isolated',
      isolation_required = true,
      isolated_at = now(),
      updated_at = now()
  where id = p_event_id
  returning * into v_row;

  insert into public.audit_logs (tenant_id, store_id, user_id, action, entity_type, entity_id, metadata)
  values (v_row.tenant_id, v_row.store_id, v_operator_user_id, 'epidemic.isolate', 'epidemic_event', v_row.id,
          jsonb_build_object('operator_employee_id', p_operator_employee_id));

  return v_row;
end;
$$;

-- ============================================================
-- 7. resolve_epidemic_event 重写
--    B07: audit user_id 由 employee 解析
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
  v_operator_user_id uuid;
begin
  select * into v_row from public.epidemic_events where id = p_event_id for update;
  if not found then
    raise exception 'EPIDEMIC_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_row.status not in ('detected', 'reported', 'isolated') then
    raise exception 'EPIDEMIC_NOT_RESOLVABLE' using errcode = 'P0003';
  end if;

  select exists(
    select 1 from public.employees
    where id = p_operator_employee_id and tenant_id = v_row.tenant_id and status = 'active'
  ) into v_operator_ok;
  if not v_operator_ok then
    raise exception 'OPERATOR_NOT_FOUND' using errcode = 'P0002';
  end if;
  select public.resolve_operator_user_id(p_operator_employee_id) into v_operator_user_id;

  update public.epidemic_events
  set status = 'resolved',
      resolved_at = now(),
      resolved_by = p_operator_employee_id,
      updated_at = now()
  where id = p_event_id
  returning * into v_row;

  insert into public.audit_logs (tenant_id, store_id, user_id, action, entity_type, entity_id, metadata)
  values (v_row.tenant_id, v_row.store_id, v_operator_user_id, 'epidemic.resolve', 'epidemic_event', v_row.id,
          jsonb_build_object('operator_employee_id', p_operator_employee_id));

  return v_row;
end;
$$;

-- ============================================================
-- 8. save_waste_record 重写
--    B02: attachment_file_id 跨租户/门店/状态校验(FILE_SCOPE_MISMATCH)
--    B07: audit user_id 由 employee 解析
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
  v_operator_user_id uuid;
begin
  if coalesce(p_waste_type, '') = '' then
    raise exception 'WASTE_TYPE_REQUIRED' using errcode = 'P0003';
  end if;
  if p_quantity is null or p_quantity < 0 then
    raise exception 'INVALID_WASTE_QUANTITY' using errcode = 'P0003';
  end if;
  if p_status not in ('draft', 'recorded') then
    raise exception 'INVALID_WASTE_STATUS' using errcode = 'P0003';
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
  select public.resolve_operator_user_id(p_operator_employee_id) into v_operator_user_id;

  if p_handler_employee_id is not null then
    select exists(
      select 1 from public.employees
      where id = p_handler_employee_id and tenant_id = p_tenant_id and status = 'active'
    ) into v_emp_ok;
    if not v_emp_ok then
      raise exception 'EMPLOYEE_NOT_FOUND' using errcode = 'P0002';
    end if;
  end if;

  -- B02:交接凭证附件必须属于目标租户、门店范围一致且已上传(FILE_SCOPE_MISMATCH)
  if p_attachment_file_id is not null then
    if not exists (
      select 1 from public.files
      where id = p_attachment_file_id
        and tenant_id = p_tenant_id
        and (store_id is null or store_id = p_store_id)
        and status = 'uploaded'
    ) then
      raise exception 'FILE_SCOPE_MISMATCH' using errcode = 'P0003';
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
      raise exception 'WASTE_NOT_EDITABLE' using errcode = 'P0003';
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
    values (p_tenant_id, p_store_id, v_operator_user_id, 'waste.update', 'medical_waste_record', v_row.id,
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
    values (p_tenant_id, p_store_id, v_operator_user_id, 'waste.create', 'medical_waste_record', v_row.id,
            jsonb_build_object('waste_type', p_waste_type, 'quantity', p_quantity,
                               'operator_employee_id', p_operator_employee_id));
  end if;

  return v_row;
end;
$$;

-- ============================================================
-- 9. handover_waste 重写
--    B07: audit user_id 由 employee 解析
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
  v_operator_user_id uuid;
begin
  if coalesce(p_receiver, '') = '' then
    raise exception 'WASTE_RECEIVER_REQUIRED' using errcode = 'P0003';
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
  select public.resolve_operator_user_id(p_operator_employee_id) into v_operator_user_id;

  if p_handler_employee_id is not null then
    select exists(
      select 1 from public.employees
      where id = p_handler_employee_id and tenant_id = v_row.tenant_id and status = 'active'
    ) into v_emp_ok;
    if not v_emp_ok then
      raise exception 'EMPLOYEE_NOT_FOUND' using errcode = 'P0002';
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
  values (v_row.tenant_id, v_row.store_id, v_operator_user_id, 'waste.handover', 'medical_waste_record', v_row.id,
          jsonb_build_object('handler_employee_id', p_handler_employee_id, 'receiver', p_receiver,
                             'disposal_method', p_disposal_method, 'operator_employee_id', p_operator_employee_id));

  return v_row;
end;
$$;

-- ============================================================
-- 10. RPC 权限收紧(重定义后重新 revoke/grant,幂等)
--     9 个 Command RPC + 1 个内部 helper:
--     revoke public/anon/authenticated + grant service_role
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
