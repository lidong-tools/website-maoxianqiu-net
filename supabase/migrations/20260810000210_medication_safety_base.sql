-- ============================================================
-- 20260810000210_medication_safety_base.sql
-- Agent-04 用药安全(Stage-04 S3.2)数据底座
--
-- 目标:
--   * 提供 deterministic / explainable / versioned / auditable
--     的药物安全规则引擎数据模型;
--   * 挂在现有 prescription(save→issue→dispense)工作流之上,
--     不重建第二套 Prescription;
--   * 规则 = 医院可配置(tenant 级),系统提供默认规则种子;
--   * 检查结果(medication_safety_checks)记录当时规则版本快照,
--     历史处方可追溯(rule_version + rule_versions.condition);
--   * 阻断规则豁免(medication_safety_overrides)必须有理由,写审计。
--
-- 写边界:
--   * 本文件全部新表仅对 authenticated 开放 SELECT(RLS),
--     禁止浏览器直连 INSERT/UPDATE/DELETE;
--   * 规则/药品档案/交互禁忌/检查/豁免的写操作全部走
--     service-role-only RPC(见 migration 211)。
--
-- 安全模型:
--   * 不修改已交付 migration 01~121;
--   * 全部变更幂等可重放(if not exists / do-block 检查);
--   * 新表显式 RLS / grant / revoke / FK / 索引;
--   * 规则支持 species[] 限定(空数组 = 全物种)。
-- ============================================================

-- ============================================================
-- 1. medication_safety_rules 用药安全规则(tenant 可配置)
--    rule_type 枚举与 evaluate RPC(211)一一对应;
--    is_blocking = true 的规则未处理豁免时,禁止 issue/dispense;
--    severity 仅用于 UI 展示,阻断与否由 is_blocking 决定。
-- ============================================================
create table if not exists public.medication_safety_rules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  code text not null,
  name text not null,
  rule_type text not null,
  severity text not null default 'warning',       -- info/warning/error
  is_blocking boolean not null default false,
  species text[] not null default '{}',           -- 空 = 全物种
  active boolean not null default true,
  current_version integer not null default 1,
  created_by uuid,                                -- auth.users.id
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, code),
  constraint ms_rules_type_check check (rule_type in (
    'duplicate_ingredient', 'duplicate_drug', 'dose_range', 'duration_limit',
    'frequency_limit', 'species_contraindication', 'age_constraint',
    'weight_constraint', 'antimicrobial_notice', 'drug_interaction'
  )),
  constraint ms_rules_severity_check check (severity in ('info', 'warning', 'error')),
  constraint ms_rules_version_check check (current_version >= 1)
);

create index if not exists idx_ms_rules_tenant_active on public.medication_safety_rules (tenant_id, active);
create index if not exists idx_ms_rules_tenant_type on public.medication_safety_rules (tenant_id, rule_type);

-- ============================================================
-- 2. medication_safety_rule_versions 规则版本(append-only)
--    条件/文案随版本追溯;evaluate 取 current_version 对应版本;
--    历史检查记录(rule_version)可精确回溯当时的规则条件。
-- ============================================================
create table if not exists public.medication_safety_rule_versions (
  id uuid primary key default gen_random_uuid(),
  rule_id uuid not null references public.medication_safety_rules(id) on delete cascade,
  version integer not null,
  condition jsonb not null default '{}'::jsonb,   -- 规则类型相关参数,见 evaluate RPC 注释
  message text,                                    -- 默认提示文案(可含说明)
  recommendation text,                             -- 处置建议
  effective_from timestamptz not null default now(),
  effective_to timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (rule_id, version),
  constraint ms_rule_versions_version_check check (version >= 1)
);

create index if not exists idx_ms_rule_versions_rule on public.medication_safety_rule_versions (rule_id);

-- ============================================================
-- 3. drug_profiles 药品安全档案(catalog_item_id 唯一,tenant 级)
--    药品规范化:active_ingredient 参与重复成分/交互检查;
--    min/max_dose_mg_kg 参与剂量范围检查(单位 mg/kg/次);
--    species_contraindications 参与物种禁忌;
--    min/max_age_months、min/max_weight_kg 参与年龄/体重约束;
--    max_duration_days 参与疗程上限;antimicrobial_class 参与抗菌提示。
-- ============================================================
create table if not exists public.drug_profiles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  catalog_item_id uuid not null references public.catalog_items(id) on delete cascade,
  active_ingredient text,
  strength text,
  strength_unit text,
  route text,                                       -- oral/injection/topical/other
  antimicrobial_class text,                         -- penicillin/cephalosporin/fluoroquinolone/macrolide/...
  min_dose_mg_kg numeric(10,4),
  max_dose_mg_kg numeric(10,4),
  min_age_months integer,
  max_age_months integer,
  min_weight_kg numeric(10,4),
  max_weight_kg numeric(10,4),
  max_duration_days integer,
  species_contraindications text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, catalog_item_id),
  constraint drug_profiles_dose_check check (
    min_dose_mg_kg is null or max_dose_mg_kg is null or min_dose_mg_kg <= max_dose_mg_kg
  ),
  constraint drug_profiles_age_check check (
    min_age_months is null or max_age_months is null or min_age_months <= max_age_months
  ),
  constraint drug_profiles_weight_check check (
    min_weight_kg is null or max_weight_kg is null or min_weight_kg <= max_weight_kg
  ),
  constraint drug_profiles_duration_check check (max_duration_days is null or max_duration_days > 0),
  constraint drug_profiles_route_check check (route is null or route in ('oral', 'injection', 'topical', 'other'))
);

create index if not exists idx_drug_profiles_tenant on public.drug_profiles (tenant_id);
create index if not exists idx_drug_profiles_ingredient on public.drug_profiles (tenant_id, active_ingredient) where active_ingredient is not null;

-- ============================================================
-- 4. medication_drug_interactions 药物相互作用禁忌(ingredient 对)
--    约定 ingredient_a <= ingredient_b 归一化存储(大小写无关);
--    severity/active 可由租户配置;命中即触发 drug_interaction 规则。
-- ============================================================
create table if not exists public.medication_drug_interactions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  ingredient_a text not null,
  ingredient_b text not null,
  severity text not null default 'warning',
  description text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, ingredient_a, ingredient_b),
  constraint mdi_severity_check check (severity in ('info', 'warning', 'error')),
  constraint mdi_order_check check (ingredient_a <= ingredient_b)
);

create index if not exists idx_mdi_tenant_pair on public.medication_drug_interactions (tenant_id, ingredient_a, ingredient_b);

-- ============================================================
-- 5. medication_safety_checks 检查结果(每次 evaluate 的产物)
--    check_stage: draft(草稿提示)/issue(开具门禁)/dispense(发药快速重检)
--    status: triggered(触发,未处理)/overridden(已豁免)/resolved(已解决/消失)
--    幂等键:(prescription_id, check_stage, rule_id, item_index)
--    item_index: 0 = 处方级;n = prescription_items 中第 n 条(按 sort_order)
--    context_snapshot: 仅存必要计算输入(体重/物种/剂量/规则条件等),不存病历全文
-- ============================================================
create table if not exists public.medication_safety_checks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  store_id uuid references public.stores(id) on delete set null,
  prescription_id uuid not null,                   -- 引用 prescriptions.id,不加 FK(跨域)
  encounter_id uuid,
  pet_id uuid not null,                            -- 引用 pets.id,不加 FK
  check_stage text not null,
  rule_id uuid,
  rule_version integer,
  rule_code text not null,
  rule_type text not null,
  severity text not null default 'warning',
  blocking boolean not null default false,
  status text not null default 'triggered',
  item_index integer not null default 0,
  message_snapshot text not null,
  recommendation_snapshot text,
  context_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (prescription_id, check_stage, rule_id, item_index),
  constraint ms_checks_stage_check check (check_stage in ('draft', 'issue', 'dispense')),
  constraint ms_checks_status_check check (status in ('triggered', 'overridden', 'resolved')),
  constraint ms_checks_severity_check check (severity in ('info', 'warning', 'error')),
  constraint ms_checks_item_index_check check (item_index >= 0)
);

create index if not exists idx_ms_checks_prescription on public.medication_safety_checks (prescription_id, check_stage);
create index if not exists idx_ms_checks_pending on public.medication_safety_checks (prescription_id, blocking, status) where status = 'triggered';
create index if not exists idx_ms_checks_tenant_created on public.medication_safety_checks (tenant_id, created_at desc);

-- ============================================================
-- 6. medication_safety_overrides 阻断规则豁免(必须有理由)
--    override_by 为 auth.users.id;override_by_employee_id 为员工档案 id;
--    同一 check 仅允许一次豁免(unique check_id)。
-- ============================================================
create table if not exists public.medication_safety_overrides (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  check_id uuid not null references public.medication_safety_checks(id) on delete cascade,
  override_by uuid,                                 -- auth.users.id
  override_by_employee_id uuid,
  reason text not null,
  created_at timestamptz not null default now(),
  unique (check_id)
);

create index if not exists idx_ms_overrides_check on public.medication_safety_overrides (check_id);

-- ============================================================
-- 7. updated_at 触发器
-- ============================================================
drop trigger if exists trg_ms_rules_updated_at on public.medication_safety_rules;
create trigger trg_ms_rules_updated_at
  before update on public.medication_safety_rules
  for each row execute procedure public.touch_updated_at();

drop trigger if exists trg_drug_profiles_updated_at on public.drug_profiles;
create trigger trg_drug_profiles_updated_at
  before update on public.drug_profiles
  for each row execute procedure public.touch_updated_at();

drop trigger if exists trg_mdi_updated_at on public.medication_drug_interactions;
create trigger trg_mdi_updated_at
  before update on public.medication_drug_interactions
  for each row execute procedure public.touch_updated_at();

drop trigger if exists trg_ms_checks_updated_at on public.medication_safety_checks;
create trigger trg_ms_checks_updated_at
  before update on public.medication_safety_checks
  for each row execute procedure public.touch_updated_at();

-- ============================================================
-- 8. RLS 策略
--    全部新表:authenticated 仅 SELECT(租户成员 + 门店范围);
--    写操作一律走 service-role-only RPC(migration 211)。
-- ============================================================
alter table public.medication_safety_rules enable row level security;
alter table public.medication_safety_rule_versions enable row level security;
alter table public.drug_profiles enable row level security;
alter table public.medication_drug_interactions enable row level security;
alter table public.medication_safety_checks enable row level security;
alter table public.medication_safety_overrides enable row level security;

-- rules:租户成员可读(规则为租户级,无 store 维度)
drop policy if exists "ms_rules_select" on public.medication_safety_rules;
create policy "ms_rules_select" on public.medication_safety_rules
  for select to authenticated
  using (public.is_tenant_member(tenant_id));

-- rule_versions:跟随规则(联表校验租户成员)
drop policy if exists "ms_rule_versions_select" on public.medication_safety_rule_versions;
create policy "ms_rule_versions_select" on public.medication_safety_rule_versions
  for select to authenticated
  using (
    exists (
      select 1 from public.medication_safety_rules r
      where r.id = medication_safety_rule_versions.rule_id
        and public.is_tenant_member(r.tenant_id)
    )
  );

-- drug_profiles:租户成员可读(档案为租户级)
drop policy if exists "drug_profiles_select" on public.drug_profiles;
create policy "drug_profiles_select" on public.drug_profiles
  for select to authenticated
  using (public.is_tenant_member(tenant_id));

-- interactions:租户成员可读
drop policy if exists "mdi_select" on public.medication_drug_interactions;
create policy "mdi_select" on public.medication_drug_interactions
  for select to authenticated
  using (public.is_tenant_member(tenant_id));

-- checks:租户成员 + 门店范围 + medication_safety.view(医生查看需授 view 权限)
drop policy if exists "ms_checks_select" on public.medication_safety_checks;
create policy "ms_checks_select" on public.medication_safety_checks
  for select to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and (store_id is null or public.can_access_store(tenant_id, store_id))
    and public.has_permission(tenant_id, store_id, 'medication_safety.view')
  );

-- overrides:跟随 check(联表校验)
drop policy if exists "ms_overrides_select" on public.medication_safety_overrides;
create policy "ms_overrides_select" on public.medication_safety_overrides
  for select to authenticated
  using (
    exists (
      select 1 from public.medication_safety_checks c
      where c.id = medication_safety_overrides.check_id
        and public.is_tenant_member(c.tenant_id)
        and (c.store_id is null or public.can_access_store(c.tenant_id, c.store_id))
        and public.has_permission(c.tenant_id, c.store_id, 'medication_safety.view')
    )
  );

-- ============================================================
-- 9. 新增权限码 + 系统角色授权
--    view:查看规则/档案/检查记录;manage:规则与档案管理;
--    override:阻断项豁免(必须医生/负责人角色,reason 必填)。
-- ============================================================
insert into public.permissions (code, name, module) values
  ('medication_safety.view', '查看用药安全', 'medication_safety'),
  ('medication_safety.manage', '管理用药安全规则', 'medication_safety'),
  ('medication_safety.override', '豁免用药安全阻断', 'medication_safety')
on conflict (code) do update set
  name = excluded.name,
  module = excluded.module;

-- system_admin / store_manager:全部 medication_safety 权限
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code in ('system_admin', 'store_manager')
  and p.code in ('medication_safety.view', 'medication_safety.manage', 'medication_safety.override')
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

-- doctor:查看 + 豁免(临床可豁免但需理由;规则管理归店长/管理员)
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'doctor'
  and p.code in ('medication_safety.view', 'medication_safety.override')
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

-- 同步 roles.permissions 数组(兼容旧代码读取)
update public.roles
set permissions = array(
  select distinct unnest(permissions || array[
    'medication_safety.view', 'medication_safety.manage', 'medication_safety.override'
  ])
)
where code in ('system_admin', 'store_manager') and is_system = true;

update public.roles
set permissions = array(
  select distinct unnest(permissions || array[
    'medication_safety.view', 'medication_safety.override'
  ])
)
where code in ('doctor') and is_system = true;

-- ============================================================
-- 10. ensure_medication_safety_rules 默认规则种子(幂等)
--     默认规则覆盖全部 10 种 rule_type;
--     阻断基线(可被租户覆盖):
--       * duplicate_ingredient / species_contraindication / drug_interaction = blocking
--       * 其余为 warning/info,不默认阻断(文档 §9 原则)
--     规则版本 condition:
--       * duration_limit: {"max_duration_days": 30}(30 天全局上限,档案可收紧)
--       * frequency_limit: {"max_daily_frequency": 4}(≤ qid)
--       * 其余 {} (由 drug_profiles / interactions 数据驱动)
-- ============================================================
create or replace function public.ensure_medication_safety_rules(p_tenant_id uuid, p_operator_user_id uuid default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rules jsonb := '[
    {"code":"duplicate_drug","name":"重复药品","rule_type":"duplicate_drug","severity":"warning","is_blocking":false,"condition":{},"message":"同一处方内重复开具相同药品,请确认是否笔误","recommendation":"合并为一条明细,或确认重复给药意图"},
    {"code":"duplicate_ingredient","name":"重复成分","rule_type":"duplicate_ingredient","severity":"error","is_blocking":true,"condition":{},"message":"同一处方内存在相同活性成分的药品,可能造成叠加剂量","recommendation":"确认是否为有意联合用药并记录理由,必要时调整剂量"},
    {"code":"dose_range","name":"剂量范围","rule_type":"dose_range","severity":"warning","is_blocking":false,"condition":{},"message":"药品剂量超出参考范围","recommendation":"按体重重新计算剂量并复核"},
    {"code":"duration_limit","name":"疗程上限","rule_type":"duration_limit","severity":"warning","is_blocking":false,"condition":{"max_duration_days":30},"message":"用药疗程超过上限","recommendation":"确认长疗程必要性并记录复诊计划"},
    {"code":"frequency_limit","name":"频次上限","rule_type":"frequency_limit","severity":"warning","is_blocking":false,"condition":{"max_daily_frequency":4},"message":"用药频次超过每日上限","recommendation":"核对给药频次,确认医嘱是否正确"},
    {"code":"species_contraindication","name":"物种禁忌","rule_type":"species_contraindication","severity":"error","is_blocking":true,"condition":{},"message":"该药品对该物种存在禁忌","recommendation":"更换替代药品,或由主治兽医评估风险后豁免"},
    {"code":"age_constraint","name":"年龄约束","rule_type":"age_constraint","severity":"warning","is_blocking":false,"condition":{},"message":"该药品不适用于当前年龄的宠物","recommendation":"确认年龄数据并核对药品适应年龄"},
    {"code":"weight_constraint","name":"体重约束","rule_type":"weight_constraint","severity":"warning","is_blocking":false,"condition":{},"message":"该药品不适用于当前体重的宠物","recommendation":"核实体重并评估用药风险"},
    {"code":"antimicrobial_notice","name":"抗菌药物提示","rule_type":"antimicrobial_notice","severity":"info","is_blocking":false,"condition":{},"message":"开具抗菌药物,请在病历中记录用药指征","recommendation":"记录感染指征与抗菌选择理由"},
    {"code":"drug_interaction","name":"药物相互作用","rule_type":"drug_interaction","severity":"error","is_blocking":true,"condition":{},"message":"处方内药品之间存在已知相互作用","recommendation":"评估相互作用风险,调整方案或记录获益理由"}
  ]'::jsonb;
  v_rule jsonb;
  v_rule_id uuid;
begin
  for v_rule in select value from jsonb_array_elements(v_rules)
  loop
    insert into public.medication_safety_rules (
      tenant_id, code, name, rule_type, severity, is_blocking, active, current_version, created_by
    )
    values (
      p_tenant_id,
      v_rule->>'code',
      v_rule->>'name',
      v_rule->>'rule_type',
      v_rule->>'severity',
      (v_rule->>'is_blocking')::boolean,
      true,
      1,
      p_operator_user_id
    )
    on conflict (tenant_id, code) do nothing
    returning id into v_rule_id;

    if v_rule_id is not null then
      insert into public.medication_safety_rule_versions (
        rule_id, version, condition, message, recommendation, effective_from, created_by
      )
      values (
        v_rule_id, 1, coalesce(v_rule->'condition', '{}'::jsonb),
        v_rule->>'message', v_rule->>'recommendation', now(), p_operator_user_id
      );
    end if;
    v_rule_id := null;
  end loop;
end;
$$;

-- ============================================================
-- 11. 为现有全部租户幂等种子默认规则
--     新租户由 evaluate RPC(211)按需惰性种子(ensure 幂等),
--     保证任何租户进入处方流程即有安全基线。
-- ============================================================
do $$
declare
  v_tenant record;
begin
  for v_tenant in select id from public.tenants
  loop
    perform public.ensure_medication_safety_rules(v_tenant.id);
  end loop;
end;
$$;

-- 写权限收紧:新表浏览器不可写
revoke all on table public.medication_safety_rules from public;
revoke all on table public.medication_safety_rule_versions from public;
revoke all on table public.drug_profiles from public;
revoke all on table public.medication_drug_interactions from public;
revoke all on table public.medication_safety_checks from public;
revoke all on table public.medication_safety_overrides from public;
