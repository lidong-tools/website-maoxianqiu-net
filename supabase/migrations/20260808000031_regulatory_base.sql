-- ============================================================
-- MXQ-S3.1-PARALLEL-01: 监管运营数据底座(Stage 03 / Sprint S3.1-1)
--
-- 工作包: S3.1-PARALLEL-01 监管运营基础包
-- 模块:   1) 动物诊疗许可证 institution_licenses
--         2) 年度动物诊疗活动报告 annual_regulatory_reports
--            (法规依据《动物诊疗机构管理办法》第三十条)
--         3) 疫情事件台账 epidemic_events
--         4) 医疗废弃物台账 medical_waste_records
--
-- 约束:
--   * 不修改已交付 migration 01~29(主线合规迁移 28/29 由主线员工负责);
--   * 本工作包使用独立编号区间 31~34,不与主线 30 冲突;
--   * 全部变更幂等可重放(if not exists / do-block 检查);
--   * 新表明确 RLS / grant / revoke / FK / 索引;
--   * 不信任客户端 tenantId/storeId:写操作全部走 service-role-only RPC(migration 32);
--     本 migration 仅建表 + 只读 RLS + 权限码;
--   * 普通业务 UI 不输入 UUID,使用 StorePicker / PetPicker / EncounterPicker /
--     EmployeePicker 等既有组件。
-- ============================================================

-- ============================================================
-- 1. institution_licenses 动物诊疗许可证(门店级)
--    * 一个门店可存在多张许可证(不同 license_no 的换证/增项),以版本表保留变更史;
--    * 同一门店同一证号唯一,不允许 UPDATE 覆盖历史证照而丢失旧信息(改走版本表);
--    * 不假设全国统一固定有效期(valid_until 可空),到期状态由查询派生或手动维护;
--    * 支持附件(certificate_file_id)+ 二维码(certificate_qr)+ 到期提醒查询字段。
-- ============================================================
create table if not exists public.institution_licenses (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  license_no text not null,
  issuing_authority text,
  diagnosis_scope text,
  issued_at date,
  valid_from date,
  valid_until date,
  status text not null default 'draft',
  certificate_file_id uuid references public.files(id) on delete set null,
  certificate_qr text,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint institution_licenses_status_check
    check (status in ('draft', 'active', 'suspended', 'revoked', 'expired')),
  constraint institution_licenses_tenant_store_no_unique
    unique (tenant_id, store_id, license_no)
);

comment on table public.institution_licenses is '动物诊疗许可证(门店级,含历史版本)';

-- 到期提醒查询索引(有效状态 + 快到期/已到期,供待办与列表筛选)
create index if not exists idx_institution_licenses_valid_until
  on public.institution_licenses (tenant_id, store_id, status, valid_until)
  where status = 'active';

-- ============================================================
-- 2. institution_license_versions 许可证历史版本(追加式,不可覆盖)
--    change_type: create / update / status_change
--    snapshot:变更后的完整行快照(含变更前信息见 audit_logs.metadata.before)
-- ============================================================
create table if not exists public.institution_license_versions (
  id uuid primary key default gen_random_uuid(),
  license_id uuid not null references public.institution_licenses(id) on delete cascade,
  version_no integer not null,
  change_type text not null default 'create',
  snapshot jsonb not null,
  changed_at timestamptz not null default now(),
  changed_by uuid,
  constraint institution_license_versions_type_check
    check (change_type in ('create', 'update', 'status_change')),
  constraint institution_license_versions_no_unique
    unique (license_id, version_no)
);

comment on table public.institution_license_versions is '动物诊疗许可证历史版本(追加式,关键修改必须 audit)';

create index if not exists idx_license_versions_license
  on public.institution_license_versions (license_id, version_no desc);

-- ============================================================
-- 3. annual_regulatory_reports 年度动物诊疗活动报告
--    《动物诊疗机构管理办法》第三十条:年度报告提交义务。
--    第一版不做政府系统 API 对接;生成时必须保存 report_snapshot,
--    查看/导出一律读取快照,不实时重算导致历史数据漂移。
--    状态机: draft -> generated -> submitted -> (accepted/rejected 平台内部模拟)
-- ============================================================
create table if not exists public.annual_regulatory_reports (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  report_year integer not null,
  status text not null default 'draft',
  generated_at timestamptz,
  generated_by uuid,
  submitted_at timestamptz,
  submitted_by uuid,
  accepted_at timestamptz,
  rejected_at timestamptz,
  rejected_reason text,
  report_snapshot jsonb,
  attachment_file_id uuid references public.files(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint annual_regulatory_reports_status_check
    check (status in ('draft', 'generated', 'submitted', 'accepted', 'rejected')),
  constraint annual_regulatory_reports_store_year_unique
    unique (tenant_id, store_id, report_year)
);

comment on table public.annual_regulatory_reports is '年度动物诊疗活动报告(快照式,生成后历史内容固定)';

create index if not exists idx_annual_reports_status
  on public.annual_regulatory_reports (tenant_id, store_id, status);

-- ============================================================
-- 4. epidemic_events 疫情事件台账(门店级)
--    * 系统只负责记录,不替医生自动做疫情诊断;
--    * 是否隔离 / 是否限制治疗等由授权用户明确填写;
--    * 状态机: detected -> reported -> isolated -> resolved;
--    * 禁止出现 customed / customed_blocked 等非规定状态。
-- ============================================================
create table if not exists public.epidemic_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  customer_id uuid references public.customers(id) on delete set null,
  pet_id uuid references public.pets(id) on delete set null,
  encounter_id uuid references public.encounters(id) on delete set null,
  suspected_disease text not null,
  detected_at timestamptz not null default now(),
  detected_by uuid,
  reported_at timestamptz,
  reported_by uuid,
  isolation_required boolean not null default false,
  isolated_at timestamptz,
  treatment_restricted boolean not null default false,
  restriction_reason text,
  culling_required boolean,
  resolved_at timestamptz,
  resolved_by uuid,
  notes text,
  status text not null default 'detected',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint epidemic_events_status_check
    check (status in ('detected', 'reported', 'isolated', 'resolved'))
);

comment on table public.epidemic_events is '疫情事件台账(系统负责记录,不替医生自动诊断)';

create index if not exists idx_epidemic_events_status
  on public.epidemic_events (tenant_id, store_id, status);

-- ============================================================
-- 5. medical_waste_records 医疗废弃物台账(门店级)
--    第一版重点:记录 / 查询 / 修改未交接记录 / 交接 / 导出 / 审计。
--    状态机: draft -> recorded -> handed_over(交接后不可修改)
-- ============================================================
create table if not exists public.medical_waste_records (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  store_id uuid not null references public.stores(id) on delete cascade,
  waste_type text not null,
  quantity numeric not null default 1 check (quantity >= 0),
  unit text,
  generated_at timestamptz not null default now(),
  handover_at timestamptz,
  handler_employee_id uuid references public.employees(id) on delete set null,
  receiver text,
  disposal_method text,
  attachment_file_id uuid references public.files(id) on delete set null,
  notes text,
  status text not null default 'draft',
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  constraint medical_waste_records_status_check
    check (status in ('draft', 'recorded', 'handed_over'))
);

comment on table public.medical_waste_records is '医疗废弃物台账(交接后不可修改)';

create index if not exists idx_medical_waste_status
  on public.medical_waste_records (tenant_id, store_id, status);

-- ============================================================
-- 6. RLS 策略
--    新表仅开放 SELECT 给授权员工(按 tenant + store 收敛);
--    写操作全部走 service-role-only RPC(migration 32),不开放任何写策略。
-- ============================================================

-- 6.1 institution_licenses + 版本表:读 = 租户成员 + 门店范围 + license.read
alter table public.institution_licenses enable row level security;
alter table public.institution_license_versions enable row level security;

drop policy if exists "institution_licenses_select" on public.institution_licenses;
create policy "institution_licenses_select" on public.institution_licenses
  for select to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and (store_id is null or public.can_access_store(tenant_id, store_id))
    and public.has_permission(tenant_id, store_id, 'license.read')
  );

-- 版本表无 tenant_id/store_id 列,策略通过关联主表许可证归属收敛(RLS 子查询)
drop policy if exists "institution_license_versions_select" on public.institution_license_versions;
create policy "institution_license_versions_select" on public.institution_license_versions
  for select to authenticated
  using (
    exists (
      select 1 from public.institution_licenses l
      where l.id = institution_license_versions.license_id
        and public.is_tenant_member(l.tenant_id)
        and (l.store_id is null or public.can_access_store(l.tenant_id, l.store_id))
        and public.has_permission(l.tenant_id, l.store_id, 'license.read')
    )
  );

-- 6.2 annual_regulatory_reports:读 = 租户成员 + 门店范围 + regulatory_report.read
alter table public.annual_regulatory_reports enable row level security;

drop policy if exists "annual_regulatory_reports_select" on public.annual_regulatory_reports;
create policy "annual_regulatory_reports_select" on public.annual_regulatory_reports
  for select to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and (store_id is null or public.can_access_store(tenant_id, store_id))
    and public.has_permission(tenant_id, store_id, 'regulatory_report.read')
  );

-- 6.3 epidemic_events:读 = 租户成员 + 门店范围 + epidemic.read
alter table public.epidemic_events enable row level security;

drop policy if exists "epidemic_events_select" on public.epidemic_events;
create policy "epidemic_events_select" on public.epidemic_events
  for select to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and (store_id is null or public.can_access_store(tenant_id, store_id))
    and public.has_permission(tenant_id, store_id, 'epidemic.read')
  );

-- 6.4 medical_waste_records:读 = 租户成员 + 门店范围 + waste.read
alter table public.medical_waste_records enable row level security;

drop policy if exists "medical_waste_records_select" on public.medical_waste_records;
create policy "medical_waste_records_select" on public.medical_waste_records
  for select to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and (store_id is null or public.can_access_store(tenant_id, store_id))
    and public.has_permission(tenant_id, store_id, 'waste.read')
  );

-- ============================================================
-- 7. 新增权限码(S3.1-PARALLEL-01 监管运营域)+ 系统角色授权
--
-- 默认授权矩阵(遵循 todo.md 十、权限):
--   system_admin : 全部 11 个
--   store_manager: license.read/manage、regulatory_report.read、
--                  epidemic.read/report/resolve、waste.read/manage
--   doctor       : license.read、regulatory_report.read、epidemic.read/report、waste.read
--                  不授予 license.manage / regulatory_report.submit / waste.manage
--   tenant_owner : 最终模型由主线员工负责;本 migration 只登记权限码,
--                  待主线合并后由权限 seed/reconciliation 统一授权(不在此重复创建)。
-- ============================================================
insert into public.permissions (code, name, module) values
  ('license.read', '查看动物诊疗许可证', 'regulatory'),
  ('license.manage', '管理动物诊疗许可证', 'regulatory'),
  ('regulatory_report.read', '查看年度诊疗活动报告', 'regulatory'),
  ('regulatory_report.generate', '生成年度诊疗活动报告', 'regulatory'),
  ('regulatory_report.submit', '提交年度诊疗活动报告', 'regulatory'),
  ('epidemic.read', '查看疫情事件台账', 'regulatory'),
  ('epidemic.report', '上报/维护疫情事件', 'regulatory'),
  ('epidemic.resolve', '解除疫情事件', 'regulatory'),
  ('waste.read', '查看医疗废弃物台账', 'regulatory'),
  ('waste.manage', '管理医疗废弃物台账', 'regulatory')
on conflict (code) do update set
  name = excluded.name,
  module = excluded.module;

-- system_admin:全部监管运营权限
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'system_admin'
  and p.code in (
    'license.read', 'license.manage',
    'regulatory_report.read', 'regulatory_report.generate', 'regulatory_report.submit',
    'epidemic.read', 'epidemic.report', 'epidemic.resolve',
    'waste.read', 'waste.manage'
  )
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

-- store_manager(店长):许可证/废弃物全权,报告读+疫情全流程;不授 generate/submit
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'store_manager'
  and p.code in (
    'license.read', 'license.manage',
    'regulatory_report.read',
    'epidemic.read', 'epidemic.report', 'epidemic.resolve',
    'waste.read', 'waste.manage'
  )
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

-- doctor(医生):只读 + 疫情上报;不授 license.manage / regulatory_report.submit / waste.manage
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'doctor'
  and p.code in (
    'license.read',
    'regulatory_report.read',
    'epidemic.read', 'epidemic.report',
    'waste.read'
  )
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

-- 同步 roles.permissions 数组(兼容旧代码读取)
update public.roles
set permissions = array(
  select distinct unnest(permissions || array[
    'license.read', 'license.manage',
    'regulatory_report.read', 'regulatory_report.generate', 'regulatory_report.submit',
    'epidemic.read', 'epidemic.report', 'epidemic.resolve',
    'waste.read', 'waste.manage'
  ])
)
where code in ('system_admin') and is_system = true;

update public.roles
set permissions = array(
  select distinct unnest(permissions || array[
    'license.read', 'license.manage',
    'regulatory_report.read',
    'epidemic.read', 'epidemic.report', 'epidemic.resolve',
    'waste.read', 'waste.manage'
  ])
)
where code in ('store_manager') and is_system = true;

update public.roles
set permissions = array(
  select distinct unnest(permissions || array[
    'license.read',
    'regulatory_report.read',
    'epidemic.read', 'epidemic.report',
    'waste.read'
  ])
)
where code in ('doctor') and is_system = true;

-- ============================================================
-- 8. 表权限收紧
--     新表写入仅 service_role(通过 security definer RPC 执行);
--     新 RPC 的 revoke/grant 在 migration 32 统一处理(service-role-only manifest)
-- ============================================================
revoke all on table public.institution_licenses from public;
revoke all on table public.institution_license_versions from public;
revoke all on table public.annual_regulatory_reports from public;
revoke all on table public.epidemic_events from public;
revoke all on table public.medical_waste_records from public;
