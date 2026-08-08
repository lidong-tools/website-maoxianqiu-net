-- ============================================================
-- MXQ-S3.1-1: 合规数据底座(Stage 03 / Sprint S3.1-1)
--
-- 任务号: S3.1-1-A1 病历归档 / A2 Amendment / A3 病历保存期
--         S3.1-1-A4 执业兽医备案 / A5 处方有效期 / A6 处方保存期
--         S3.1-1-A7 受控药最低全国规则
--
-- 约束:
--   * 不修改已交付 migration 01~27;
--   * 全部变更幂等可重放(if not exists / do-block 检查);
--   * 新表明确 RLS / grant / revoke / FK / 索引;
--   * 不信任客户端 tenantId/storeId(写操作全部走 service-role-only RPC);
--   * 归档状态机: draft -> signed -> (archive_due 由查询派生) -> archived
--   * 归档后正文不可变(DB 触发器兜底,amendment 流程显式放行)
-- ============================================================

-- ============================================================
-- 1. encounters(门急诊病历)合规字段
--    archive_due_at:就诊结束后 24 小时(由触发器在签署/完成时设定)
--    retention_until:病历保存期 >= 3 年(归档时设定,未来销毁任务另建)
-- ============================================================
alter table public.encounters
  add column if not exists signed_by_employee_id uuid,
  add column if not exists archive_status text not null default 'draft',
  add column if not exists archive_due_at timestamptz,
  add column if not exists archived_at timestamptz,
  add column if not exists archived_by_employee_id uuid,
  add column if not exists retention_until timestamptz,
  add column if not exists retention_status text not null default 'active',
  add column if not exists destroy_requested_at timestamptz,
  add column if not exists destroy_approved_at timestamptz;

-- 归档状态机约束(draft/signed/archived;archive_due 为派生态,由 UI 结合 archive_due_at 展示)
alter table public.encounters drop constraint if exists encounters_archive_status_check;
alter table public.encounters add constraint encounters_archive_status_check
  check (archive_status in ('draft', 'signed', 'archived'));

-- 保存期状态约束(active/destroy_requested/destroy_approved;S3.1 仅记录,不执行物理删除)
alter table public.encounters drop constraint if exists encounters_retention_status_check;
alter table public.encounters add constraint encounters_retention_status_check
  check (retention_status in ('active', 'destroy_requested', 'destroy_approved'));

-- 超时归档待办索引(供待办/告警查询)
create index if not exists idx_encounters_archive_due on public.encounters (tenant_id, archive_due_at)
  where archive_status <> 'archived';

-- ============================================================
-- 2. admissions(住院病历)合规字段
--    archive_due_at:出院后 3 日(由触发器在出院时设定)
-- ============================================================
alter table public.admissions
  add column if not exists archive_status text not null default 'draft',
  add column if not exists archive_due_at timestamptz,
  add column if not exists archived_at timestamptz,
  add column if not exists archived_by_employee_id uuid,
  add column if not exists retention_until timestamptz,
  add column if not exists retention_status text not null default 'active',
  add column if not exists destroy_requested_at timestamptz,
  add column if not exists destroy_approved_at timestamptz;

alter table public.admissions drop constraint if exists admissions_archive_status_check;
alter table public.admissions add constraint admissions_archive_status_check
  check (archive_status in ('draft', 'signed', 'archived'));

alter table public.admissions drop constraint if exists admissions_retention_status_check;
alter table public.admissions add constraint admissions_retention_status_check
  check (retention_status in ('active', 'destroy_requested', 'destroy_approved'));

create index if not exists idx_admissions_archive_due on public.admissions (tenant_id, archive_due_at)
  where archive_status <> 'archived';

-- ============================================================
-- 3. prescriptions(处方)合规字段
--    valid_until:默认 = 开具当日结束;最大不得超过 issued_at + 3 天
--    retention_until:普通兽医处方 3 年;麻醉/精神/毒性 5 年
-- ============================================================
alter table public.prescriptions
  add column if not exists issued_at timestamptz,
  add column if not exists valid_until timestamptz,
  add column if not exists prescriber_employee_id uuid,
  add column if not exists prescriber_user_id uuid,
  add column if not exists prescriber_veterinarian_registration_id uuid,
  add column if not exists signed_at timestamptz,
  add column if not exists signature_method text,
  add column if not exists dispensed_by_employee_id uuid,
  add column if not exists dispensed_at timestamptz,
  add column if not exists retention_until timestamptz,
  add column if not exists retention_status text not null default 'active';

-- 状态机扩展: draft -> issued -> dispensed / cancelled
alter table public.prescriptions drop constraint if exists prescriptions_status_check;
alter table public.prescriptions add constraint prescriptions_status_check
  check (status in ('draft', 'issued', 'dispensed', 'cancelled'));

alter table public.prescriptions drop constraint if exists prescriptions_retention_status_check;
alter table public.prescriptions add constraint prescriptions_retention_status_check
  check (retention_status in ('active', 'destroy_requested', 'destroy_approved'));

-- 签名方式约束(manual=普通签名图片,electronic=可靠电子签名;未接入可靠 Provider 前不得宣称电子签名)
alter table public.prescriptions drop constraint if exists prescriptions_signature_method_check;
alter table public.prescriptions add constraint prescriptions_signature_method_check
  check (signature_method in ('manual', 'electronic'));

-- 待发药/超期处方查询索引
create index if not exists idx_prescriptions_valid_until on public.prescriptions (tenant_id, valid_until)
  where status in ('issued', 'draft');

-- ============================================================
-- 4. catalog_drug_extensions 受控药品类型
--    controlled_class: none/narcotic(麻醉)/psychotropic(精神)/toxic(毒性)/other_controlled
-- ============================================================
alter table public.catalog_drug_extensions
  add column if not exists controlled_class text not null default 'none';

alter table public.catalog_drug_extensions drop constraint if exists catalog_drug_extensions_controlled_class_check;
alter table public.catalog_drug_extensions add constraint catalog_drug_extensions_controlled_class_check
  check (controlled_class in ('none', 'narcotic', 'psychotropic', 'toxic', 'other_controlled'));

-- ============================================================
-- 5. medical_record_amendments 归档后修改(Amendment)审批流
--    request -> approved/rejected -> applied
--    原始版本永远保留;before/after 快照可追溯;操作写 audit_logs
-- ============================================================
create table if not exists public.medical_record_amendments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  store_id uuid references public.stores(id) on delete set null,
  medical_record_type text not null check (medical_record_type in ('encounter', 'admission')),
  medical_record_id uuid not null,
  requested_by uuid not null,                          -- 员工 id(employees.id)
  requested_at timestamptz not null default now(),
  reason text not null,
  status text not null default 'pending',
  reviewed_by uuid,                                   -- 负责人员工 id(employees.id)
  reviewed_at timestamptz,
  rejected_reason text,
  applied_by uuid,                                    -- 执行人员工 id(employees.id)
  applied_at timestamptz,
  before_snapshot jsonb not null default '{}'::jsonb, -- 申请时正文快照(可追溯)
  after_snapshot jsonb not null default '{}'::jsonb,  -- 应用后正文快照(可追溯)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint medical_record_amendments_status_check check (status in ('pending', 'approved', 'rejected', 'applied'))
);

create index if not exists idx_amendments_record on public.medical_record_amendments (tenant_id, medical_record_type, medical_record_id);
create index if not exists idx_amendments_status on public.medical_record_amendments (tenant_id, status);

-- ============================================================
-- 6. veterinarian_registrations 执业兽医备案
--    只有有效备案的执业兽医可以开具处方/签署要求执业兽医完成的医疗记录
--    不得仅通过 role='doctor' 判断执业资格
-- ============================================================
create table if not exists public.veterinarian_registrations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  employee_id uuid not null references public.employees(id) on delete cascade,
  license_no text not null,
  registration_no text,
  registration_authority text,
  registration_region text,
  valid_from date not null,
  valid_until date,
  status text not null default 'active',
  signature_specimen_file_id uuid,
  electronic_signature_provider text,
  electronic_signature_subject_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint veterinarian_registrations_status_check check (status in ('active', 'inactive', 'expired')),
  constraint veterinarian_registrations_license_unique unique (tenant_id, license_no),
  constraint veterinarian_registrations_valid_range_check check (valid_until is null or valid_from <= valid_until)
);

create index if not exists idx_vet_reg_employee on public.veterinarian_registrations (tenant_id, employee_id);
create index if not exists idx_vet_reg_status on public.veterinarian_registrations (tenant_id, status);

-- ============================================================
-- 7. 归档不可变兜底(DB 层,不依赖 RPC/前端)
--    archived 后禁止直接 UPDATE 正文;amendment apply 通过
--    set_config('app.allow_archived_update','true',true) 显式放行
-- ============================================================
create or replace function public.prevent_archived_record_update()
returns trigger
language plpgsql
as $$
begin
  if old.archive_status = 'archived'
     and coalesce(current_setting('app.allow_archived_update', true), '') <> 'true' then
    raise exception 'ARCHIVED_RECORD_IMMUTABLE'
      using errcode = 'P0003';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_encounters_archive_immutable on public.encounters;
create trigger trg_encounters_archive_immutable
  before update on public.encounters
  for each row execute function public.prevent_archived_record_update();

drop trigger if exists trg_admissions_archive_immutable on public.admissions;
create trigger trg_admissions_archive_immutable
  before update on public.admissions
  for each row execute function public.prevent_archived_record_update();

-- ============================================================
-- 8. 归档截止时间触发器
--    门(急)诊病历:就诊结束(signed/completed)后 24 小时内归档
--    住院病历:出院(discharged)后 3 日内归档
-- ============================================================
create or replace function public.set_encounter_archive_due()
returns trigger
language plpgsql
as $$
begin
  if new.status in ('signed', 'completed')
     and new.status is distinct from old.status then
    new.archive_due_at = coalesce(new.ended_at, now()) + interval '24 hours';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_encounters_set_archive_due on public.encounters;
create trigger trg_encounters_set_archive_due
  before update of status on public.encounters
  for each row execute function public.set_encounter_archive_due();

create or replace function public.set_admission_archive_due()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'discharged'
     and new.status is distinct from old.status then
    new.archive_due_at = coalesce(new.discharged_at, now()) + interval '3 days';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_admissions_set_archive_due on public.admissions;
create trigger trg_admissions_set_archive_due
  before update of status on public.admissions
  for each row execute function public.set_admission_archive_due();

-- ============================================================
-- 9. RLS 策略
--    新表仅开放 SELECT 给授权员工;写操作全部走 service-role-only RPC
-- ============================================================

-- 9.1 medical_record_amendments:读=租户成员+门店范围+amend 权限;写=不开放
alter table public.medical_record_amendments enable row level security;

drop policy if exists "medical_record_amendments_select" on public.medical_record_amendments;
create policy "medical_record_amendments_select" on public.medical_record_amendments
  for select to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and (store_id is null or public.can_access_store(tenant_id, store_id))
    and (
      public.has_permission(tenant_id, store_id, 'medical_record.amend.request')
      or public.has_permission(tenant_id, store_id, 'medical_record.amend.approve')
    )
  );

-- 9.2 veterinarian_registrations:读=租户成员+备案读权限;写=不开放
--    R01 修复:本表为租户级数据(无 store_id 列),RLS 不得引用 store_id;
--    门店维度由 can_access_store 不适用,按 tenant 上下文校验备案读权限
alter table public.veterinarian_registrations enable row level security;

drop policy if exists "veterinarian_registrations_select" on public.veterinarian_registrations;
create policy "veterinarian_registrations_select" on public.veterinarian_registrations
  for select to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and public.has_permission(tenant_id, null, 'veterinarian_registration.read')
  );

-- ============================================================
-- 10. 新增权限码(S3.1 合规域)+ 系统角色授权
-- ============================================================
insert into public.permissions (code, name, module) values
  ('medical_record.archive', '病历归档', 'compliance'),
  ('medical_record.amend.request', '病历修订申请', 'compliance'),
  ('medical_record.amend.approve', '病历修订审批', 'compliance'),
  ('veterinarian_registration.read', '查看执业兽医备案', 'compliance'),
  ('veterinarian_registration.manage', '管理执业兽医备案', 'compliance'),
  ('prescription.issue', '开具处方', 'prescription'),
  ('prescription.extend_validity', '延长处方有效期', 'prescription'),
  ('prescription.controlled_issue', '开具受控药品处方', 'prescription')
on conflict (code) do update set
  name = excluded.name,
  module = excluded.module;

-- system_admin:全部合规权限
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'system_admin'
  and p.code in (
    'medical_record.archive', 'medical_record.amend.request', 'medical_record.amend.approve',
    'veterinarian_registration.read', 'veterinarian_registration.manage',
    'prescription.issue', 'prescription.extend_validity', 'prescription.controlled_issue'
  )
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

-- store_manager(店长):归档/修订/开方全权;备案为 tenant-level 权限(F05),
-- 店长 role.scope=store 无法满足 tenant 上下文 has_permission(..., NULL, ...),
-- 故不再声明 veterinarian_registration.read/manage,避免"声明了但实际被拒"
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'store_manager'
  and p.code in (
    'medical_record.archive', 'medical_record.amend.request', 'medical_record.amend.approve',
    'prescription.issue', 'prescription.extend_validity', 'prescription.controlled_issue'
  )
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

-- 存量数据幂等回退:若旧 seed 已给 store_manager 写入备案权限,删除之(F05)
delete from public.role_permissions rp
using public.roles r, public.permissions p
where rp.role_id = r.id and rp.permission_id = p.id
  and r.code = 'store_manager'
  and p.code in ('veterinarian_registration.read', 'veterinarian_registration.manage');

-- doctor(医生):归档/修订申请/开方/受控开方;不授审批与备案权限
-- F05:备案为 tenant-level,doctor(scope=store)不声明 read/manage,与 store_manager 一致
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'doctor'
  and p.code in (
    'medical_record.archive', 'medical_record.amend.request',
    'prescription.issue', 'prescription.controlled_issue'
  )
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

-- F05:存量幂等回退(若旧 seed 已把备案权限写入 doctor role_permissions)
delete from public.role_permissions rp
using public.roles r, public.permissions p
where rp.role_id = r.id and rp.permission_id = p.id
  and r.code = 'doctor'
  and p.code in ('veterinarian_registration.read', 'veterinarian_registration.manage');

-- 同步 roles.permissions 数组(兼容旧代码读取);F05:store_manager 数组不含备案权限
update public.roles
set permissions = array(
  select distinct unnest(permissions || array[
    'medical_record.archive', 'medical_record.amend.request', 'medical_record.amend.approve',
    'prescription.issue', 'prescription.extend_validity', 'prescription.controlled_issue'
  ])
)
where code in ('system_admin', 'store_manager') and is_system = true;

-- F05:存量数组幂等回退(doctor 数组也不含备案权限)
update public.roles
set permissions = array(
  select perm from unnest(permissions) as perm
  where perm not in ('veterinarian_registration.read', 'veterinarian_registration.manage')
)
where code in ('store_manager', 'doctor') and is_system = true
  and permissions && array['veterinarian_registration.read', 'veterinarian_registration.manage'];

update public.roles
set permissions = array(
  select distinct unnest(permissions || array[
    'medical_record.archive', 'medical_record.amend.request',
    'prescription.issue', 'prescription.controlled_issue'
  ])
)
where code in ('doctor') and is_system = true;

-- FINAL-01(第三轮审计):新增租户级默认角色 tenant_owner(scope = tenant)
-- 背景:store_manager/doctor 均为 scope=store,不能冒充 tenant-wide role,
--      此前备案 read/manage 只给了平台 system_admin,导致真实医院租户
--      无法自行维护执业兽医备案(开方前置条件死锁)。
-- 修复:建立真正的 tenant-level 默认角色 tenant_owner:
--      * role.scope = 'tenant'(migration 26/27 触发器强制 store_id IS NULL 分配);
--      * 授予 veterinarian_registration.read / .manage;
--      * 不把 tenant-level 备案权限塞回 store scope 角色(维持 F05 基线);
--      * 租户初始化(给首位 owner 自动分配)由 S3.1-2 负责,本 Sprint 只建角色+权限模型。
insert into public.roles (code, name, description, permissions, is_system, scope)
values ('tenant_owner', '租户所有者', '租户级管理角色,可维护本租户执业兽医备案等租户级数据',
        array['veterinarian_registration.read', 'veterinarian_registration.manage'],
        true, 'tenant')
on conflict (code) do update set
  name = excluded.name,
  description = excluded.description,
  permissions = excluded.permissions,
  is_system = excluded.is_system,
  scope = excluded.scope;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'tenant_owner'
  and p.code in ('veterinarian_registration.read', 'veterinarian_registration.manage')
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

-- ============================================================
-- 11. 默认权限收紧
--     新表写入仅 service_role(通过 security definer RPC 执行);
--     新 RPC 的 revoke/grant 在 migration 29 统一处理(service-role-only manifest)
-- ============================================================
revoke all on table public.medical_record_amendments from public;
revoke all on table public.veterinarian_registrations from public;
