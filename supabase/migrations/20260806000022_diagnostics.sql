-- ============================================================
-- 20260806000022_diagnostics.sql
-- MXQ-10001~10011 Diagnostics 疫苗与检验领域数据模型
--   - vaccine_protocols / vaccine_protocol_items  疫苗方案(MXQ-10001)
--   - vaccinations                                 疫苗接种(MXQ-10002)
--   - deworming_records                            驱虫记录(MXQ-10003)
--   - diag_reminders                               提醒(MXQ-10004)
--   - vaccine_certificates                         疫苗证明(MXQ-10005)
--   - lab_orders / lab_order_analytes              检验申请与结果(MXQ-10006/10008)
--   - lab_specimens                                标本(MXQ-10007)
--   - lab_result_reviews                           结果审核(双签,MXQ-10008)
--   - critical_value_alerts                        危急值告警(MXQ-10009)
--   - RPC:scan_diag_reminders / issue_vaccine_certificate
--         publish_lab_results / review_lab_results
--   - 权限码:vaccine.* / deworming.* / lab.* / diag_reminder.view
-- 幂等,可重复应用
--
-- 设计要点:
--   - 跨表引用 customers/pets/encounters/catalog_items 用 uuid,不加 FK 约束(避免跨 migration 依赖)
--   - administered_by/requested_by/collected_by 等 user 引用 auth.users(id) on delete set null
--   - 报告发布(publish_lab_results)与危急值通知走 RPC,事务化批量更新结果 + 自动告警 + 审计
--   - 审核流程:结果录入后由 doctor 审核发布(双签),rejected 回到待录入状态可重录
--   - RLS:can_access_store 门店级隔离 + 角色权限;vaccine_protocols 租户级
-- 状态机:
--   疫苗接种:scheduled→administered; scheduled→overdue; scheduled→skipped
--   检验申请:requested→collected→completed; requested→cancelled
--   标本:collected→in_transit→received→discarded
--   危急值告警:pending→acknowledged→resolved
--   疫苗证明:issued→revoked
-- ============================================================

-- ===== 1. vaccine_protocols 表(MXQ-10001) =====
-- 疫苗方案:租户级目录,租户成员可读
create table if not exists public.vaccine_protocols (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  code text not null,
  name text not null,
  species text not null default 'other',                 -- dog/cat/rabbit/other
  description text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint vaccine_protocols_species_check check (species in ('dog', 'cat', 'rabbit', 'other'))
);

create unique index if not exists idx_vaccine_protocols_tenant_code on public.vaccine_protocols (tenant_id, code);
create index if not exists idx_vaccine_protocols_tenant on public.vaccine_protocols (tenant_id);

-- ===== 2. vaccine_protocol_items 表(MXQ-10001) =====
-- 疫苗方案明细:每一针的年龄/间隔要求
create table if not exists public.vaccine_protocol_items (
  id uuid primary key default gen_random_uuid(),
  protocol_id uuid not null references public.vaccine_protocols(id) on delete cascade,
  vaccine_catalog_item_id uuid,                          -- 引用 catalog_items.id,不加 FK
  dose_no integer not null,                              -- 第几针
  min_age_weeks integer,                                 -- 最小年龄(周)
  max_age_weeks integer,                                 -- 最大年龄(周)
  interval_days integer,                                 -- 与上一针间隔(天)
  is_required boolean not null default true,
  remark text,
  created_at timestamptz not null default now(),

  constraint vaccine_protocol_items_dose_check check (dose_no >= 1),
  constraint vaccine_protocol_items_age_check check (
    (min_age_weeks is null or max_age_weeks is null or max_age_weeks >= min_age_weeks)
  ),
  constraint vaccine_protocol_items_interval_check check (interval_days is null or interval_days >= 0)
);

create index if not exists idx_vaccine_protocol_items_protocol on public.vaccine_protocol_items (protocol_id);
create index if not exists idx_vaccine_protocol_items_vaccine on public.vaccine_protocol_items (vaccine_catalog_item_id) where vaccine_catalog_item_id is not null;

-- ===== 3. vaccinations 表(MXQ-10002) =====
-- 疫苗接种记录:门店级,can_access_store 校验
create table if not exists public.vaccinations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  store_id uuid references public.stores(id) on delete set null,

  customer_id uuid not null,                             -- 引用 customers.id,不加 FK
  pet_id uuid not null,                                  -- 引用 pets.id,不加 FK
  encounter_id uuid,                                     -- 引用 encounters.id,不加 FK
  vaccine_catalog_item_id uuid,                          -- 引用 catalog_items.id,不加 FK
  protocol_item_id uuid,                                 -- 引用 vaccine_protocol_items.id,不加 FK
  dose_no integer not null default 1,

  scheduled_date timestamptz,
  administered_date timestamptz,
  administered_by uuid references auth.users(id) on delete set null,
  batch_no text,
  manufacturer text,
  status text not null default 'scheduled',              -- scheduled/administered/skipped/overdue
  next_due_date timestamptz,
  remark text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint vaccinations_status_check check (status in ('scheduled', 'administered', 'skipped', 'overdue')),
  constraint vaccinations_dose_check check (dose_no >= 1)
);

create index if not exists idx_vaccinations_tenant_pet_admin
  on public.vaccinations (tenant_id, pet_id, administered_date desc);
create index if not exists idx_vaccinations_tenant_store_status
  on public.vaccinations (tenant_id, store_id, status);
create index if not exists idx_vaccinations_encounter on public.vaccinations (encounter_id) where encounter_id is not null;

-- ===== 4. deworming_records 表(MXQ-10003) =====
-- 驱虫记录:门店级,can_access_store 校验
create table if not exists public.deworming_records (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  store_id uuid references public.stores(id) on delete set null,

  customer_id uuid not null,
  pet_id uuid not null,
  encounter_id uuid,
  drug_catalog_item_id uuid,                             -- 引用 catalog_items.id,不加 FK
  drug_name text not null,
  dose text,
  administered_date timestamptz not null default now(),
  administered_by uuid references auth.users(id) on delete set null,
  next_due_date timestamptz,
  parasite_type text not null default 'internal',         -- internal/external/both
  status text not null default 'done',                    -- done/scheduled
  remark text,

  created_at timestamptz not null default now(),

  constraint deworming_records_parasite_check check (parasite_type in ('internal', 'external', 'both')),
  constraint deworming_records_status_check check (status in ('done', 'scheduled'))
);

create index if not exists idx_deworming_tenant_pet on public.deworming_records (tenant_id, pet_id, administered_date desc);
create index if not exists idx_deworming_tenant_store on public.deworming_records (tenant_id, store_id);

-- ===== 5. diag_reminders 表(MXQ-10004) =====
-- 诊断提醒:疫苗/驱虫到期提醒
create table if not exists public.diag_reminders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  store_id uuid references public.stores(id) on delete set null,

  customer_id uuid not null,
  pet_id uuid not null,
  reminder_type text not null,                            -- vaccine/deworming
  reference_id uuid,                                      -- 引用 vaccinations.id / deworming_records.id,不加 FK
  due_date timestamptz not null,
  status text not null default 'pending',                 -- pending/sent/cancelled
  created_at timestamptz not null default now(),
  sent_at timestamptz,

  constraint diag_reminders_type_check check (reminder_type in ('vaccine', 'deworming')),
  constraint diag_reminders_status_check check (status in ('pending', 'sent', 'cancelled'))
);

create index if not exists idx_diag_reminders_tenant_store_status on public.diag_reminders (tenant_id, store_id, status);
create index if not exists idx_diag_reminders_due on public.diag_reminders (due_date) where status = 'pending';
create index if not exists idx_diag_reminders_pet on public.diag_reminders (tenant_id, pet_id);

-- ===== 6. vaccine_certificates 表(MXQ-10005) =====
-- 疫苗证明:唯一证书编号,门店级
create table if not exists public.vaccine_certificates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  store_id uuid references public.stores(id) on delete set null,

  pet_id uuid not null,
  customer_id uuid not null,
  vaccination_id uuid not null,                          -- 引用 vaccinations.id,不加 FK
  certificate_no text not null,
  issued_date timestamptz not null default now(),
  issued_by uuid references auth.users(id) on delete set null,
  certificate_data jsonb not null default '{}'::jsonb,    -- 疫苗/批次/医生等
  pdf_file_id uuid,                                       -- 引用 files.id,不加 FK
  status text not null default 'issued',                  -- issued/revoked
  created_at timestamptz not null default now(),

  constraint vaccine_certificates_status_check check (status in ('issued', 'revoked'))
);

create unique index if not exists idx_vaccine_certificates_tenant_no on public.vaccine_certificates (tenant_id, certificate_no);
create index if not exists idx_vaccine_certificates_pet on public.vaccine_certificates (tenant_id, pet_id);
create index if not exists idx_vaccine_certificates_vaccination on public.vaccine_certificates (vaccination_id);

-- ===== 7. lab_orders 表(MXQ-10006) =====
-- 检验申请:唯一申请单号,门店级
create table if not exists public.lab_orders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  store_id uuid references public.stores(id) on delete set null,

  customer_id uuid not null,
  pet_id uuid not null,
  encounter_id uuid,                                      -- 引用 encounters.id,不加 FK(MXQ-10010)
  panel_id uuid,                                          -- 引用 lab_panels.id,不加 FK
  order_no text not null,
  status text not null default 'requested',               -- requested/collected/completed/cancelled
  requested_by uuid references auth.users(id) on delete set null,
  requested_at timestamptz not null default now(),
  collected_at timestamptz,
  collected_by uuid references auth.users(id) on delete set null,
  completed_at timestamptz,
  remark text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint lab_orders_status_check check (status in ('requested', 'collected', 'completed', 'cancelled'))
);

create unique index if not exists idx_lab_orders_tenant_no on public.lab_orders (tenant_id, order_no);
create index if not exists idx_lab_orders_tenant_store on public.lab_orders (tenant_id, store_id);
create index if not exists idx_lab_orders_encounter on public.lab_orders (encounter_id) where encounter_id is not null;
create index if not exists idx_lab_orders_pet on public.lab_orders (tenant_id, pet_id);
create index if not exists idx_lab_orders_status on public.lab_orders (tenant_id, status);

-- ===== 8. lab_order_analytes 表(MXQ-10006/10008) =====
-- 检验结果项:跟随 lab_orders(联表 RLS)
create table if not exists public.lab_order_analytes (
  id uuid primary key default gen_random_uuid(),
  lab_order_id uuid not null references public.lab_orders(id) on delete cascade,
  analyte_id uuid,                                        -- 引用 lab_analytes.id,不加 FK
  result_value text,
  result_numeric numeric(12,4),
  is_abnormal boolean not null default false,
  is_critical boolean not null default false,
  flag text,                                              -- low/high/critical
  resulted_at timestamptz,
  resulted_by uuid references auth.users(id) on delete set null,
  note text,

  created_at timestamptz not null default now(),

  constraint lab_order_analytes_flag_check check (flag is null or flag in ('low', 'high', 'critical'))
);

create index if not exists idx_lab_order_analytes_order on public.lab_order_analytes (lab_order_id);
create index if not exists idx_lab_order_analytes_critical on public.lab_order_analytes (is_critical) where is_critical = true;

-- ===== 9. lab_specimens 表(MXQ-10007) =====
-- 标本:跟随 lab_orders(联表 RLS)
create table if not exists public.lab_specimens (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  lab_order_id uuid not null references public.lab_orders(id) on delete cascade,
  specimen_type text not null default 'blood',            -- blood/urine/feces/tissue/other
  collection_method text,
  collected_at timestamptz not null default now(),
  collected_by uuid references auth.users(id) on delete set null,
  container_id text,
  storage_condition text,
  status text not null default 'collected',               -- collected/in_transit/received/discarded
  received_at timestamptz,
  received_by uuid references auth.users(id) on delete set null,
  remark text,

  created_at timestamptz not null default now(),

  constraint lab_specimens_type_check check (specimen_type in ('blood', 'urine', 'feces', 'tissue', 'other')),
  constraint lab_specimens_status_check check (status in ('collected', 'in_transit', 'received', 'discarded'))
);

create index if not exists idx_lab_specimens_order on public.lab_specimens (lab_order_id);
create index if not exists idx_lab_specimens_status on public.lab_specimens (tenant_id, status);

-- ===== 10. lab_result_reviews 表(MXQ-10008) =====
-- 结果审核记录:跟随 lab_orders(联表 RLS),双签流程
create table if not exists public.lab_result_reviews (
  id uuid primary key default gen_random_uuid(),
  lab_order_id uuid not null references public.lab_orders(id) on delete cascade,
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz not null default now(),
  decision text not null,                                 -- approved/rejected
  comment text,
  created_at timestamptz not null default now(),

  constraint lab_result_reviews_decision_check check (decision in ('approved', 'rejected'))
);

create index if not exists idx_lab_result_reviews_order on public.lab_result_reviews (lab_order_id);

-- ===== 11. critical_value_alerts 表(MXQ-10009) =====
-- 危急值告警:门店级,由 publish_lab_results 自动创建
create table if not exists public.critical_value_alerts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  store_id uuid references public.stores(id) on delete set null,

  lab_order_id uuid not null references public.lab_orders(id) on delete cascade,
  analyte_id uuid,                                        -- 引用 lab_analytes.id,不加 FK(用 lab_order_analytes.id 更准确,但保持简单)
  pet_id uuid not null,
  alert_level text not null default 'critical',           -- critical/significant
  message text,
  status text not null default 'pending',                 -- pending/acknowledged/resolved
  acknowledged_by uuid references auth.users(id) on delete set null,
  acknowledged_at timestamptz,
  created_at timestamptz not null default now(),

  constraint critical_value_alerts_level_check check (alert_level in ('critical', 'significant')),
  constraint critical_value_alerts_status_check check (status in ('pending', 'acknowledged', 'resolved'))
);

create index if not exists idx_critical_alerts_tenant_store_status on public.critical_value_alerts (tenant_id, store_id, status);
create index if not exists idx_critical_alerts_order on public.critical_value_alerts (lab_order_id);
create index if not exists idx_critical_alerts_pet on public.critical_value_alerts (tenant_id, pet_id);

-- ===== 12. updated_at 触发器 =====
drop trigger if exists trg_vaccine_protocols_updated_at on public.vaccine_protocols;
create trigger trg_vaccine_protocols_updated_at
  before update on public.vaccine_protocols
  for each row execute procedure public.touch_updated_at();

drop trigger if exists trg_vaccinations_updated_at on public.vaccinations;
create trigger trg_vaccinations_updated_at
  before update on public.vaccinations
  for each row execute procedure public.touch_updated_at();

drop trigger if exists trg_lab_orders_updated_at on public.lab_orders;
create trigger trg_lab_orders_updated_at
  before update on public.lab_orders
  for each row execute procedure public.touch_updated_at();

-- ===== 13. RLS 策略 =====
alter table public.vaccine_protocols enable row level security;
alter table public.vaccine_protocol_items enable row level security;
alter table public.vaccinations enable row level security;
alter table public.deworming_records enable row level security;
alter table public.diag_reminders enable row level security;
alter table public.vaccine_certificates enable row level security;
alter table public.lab_orders enable row level security;
alter table public.lab_order_analytes enable row level security;
alter table public.lab_specimens enable row level security;
alter table public.lab_result_reviews enable row level security;
alter table public.critical_value_alerts enable row level security;

-- ----- vaccine_protocols:租户成员可读;写入需 vaccine.manage -----
drop policy if exists "vaccine_protocols_select" on public.vaccine_protocols;
create policy "vaccine_protocols_select" on public.vaccine_protocols
  for select to authenticated
  using (public.is_tenant_member(tenant_id));

drop policy if exists "vaccine_protocols_insert" on public.vaccine_protocols;
create policy "vaccine_protocols_insert" on public.vaccine_protocols
  for insert to authenticated
  with check (
    public.is_tenant_member(tenant_id)
    and public.has_permission(tenant_id, null, 'vaccine.manage')
  );

drop policy if exists "vaccine_protocols_update" on public.vaccine_protocols;
create policy "vaccine_protocols_update" on public.vaccine_protocols
  for update to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and public.has_permission(tenant_id, null, 'vaccine.manage')
  )
  with check (
    public.is_tenant_member(tenant_id)
    and public.has_permission(tenant_id, null, 'vaccine.manage')
  );

drop policy if exists "vaccine_protocols_delete" on public.vaccine_protocols;
create policy "vaccine_protocols_delete" on public.vaccine_protocols
  for delete to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and public.has_permission(tenant_id, null, 'vaccine.manage')
  );

-- ----- vaccine_protocol_items:跟随 vaccine_protocols(联表校验) -----
drop policy if exists "vaccine_protocol_items_select" on public.vaccine_protocol_items;
create policy "vaccine_protocol_items_select" on public.vaccine_protocol_items
  for select to authenticated
  using (
    exists (
      select 1 from public.vaccine_protocols vp
      where vp.id = vaccine_protocol_items.protocol_id
        and public.is_tenant_member(vp.tenant_id)
    )
  );

drop policy if exists "vaccine_protocol_items_insert" on public.vaccine_protocol_items;
create policy "vaccine_protocol_items_insert" on public.vaccine_protocol_items
  for insert to authenticated
  with check (
    exists (
      select 1 from public.vaccine_protocols vp
      where vp.id = vaccine_protocol_items.protocol_id
        and public.is_tenant_member(vp.tenant_id)
        and public.has_permission(vp.tenant_id, null, 'vaccine.manage')
    )
  );

drop policy if exists "vaccine_protocol_items_update" on public.vaccine_protocol_items;
create policy "vaccine_protocol_items_update" on public.vaccine_protocol_items
  for update to authenticated
  using (
    exists (
      select 1 from public.vaccine_protocols vp
      where vp.id = vaccine_protocol_items.protocol_id
        and public.is_tenant_member(vp.tenant_id)
        and public.has_permission(vp.tenant_id, null, 'vaccine.manage')
    )
  )
  with check (
    exists (
      select 1 from public.vaccine_protocols vp
      where vp.id = vaccine_protocol_items.protocol_id
        and public.is_tenant_member(vp.tenant_id)
        and public.has_permission(vp.tenant_id, null, 'vaccine.manage')
    )
  );

drop policy if exists "vaccine_protocol_items_delete" on public.vaccine_protocol_items;
create policy "vaccine_protocol_items_delete" on public.vaccine_protocol_items
  for delete to authenticated
  using (
    exists (
      select 1 from public.vaccine_protocols vp
      where vp.id = vaccine_protocol_items.protocol_id
        and public.is_tenant_member(vp.tenant_id)
        and public.has_permission(vp.tenant_id, null, 'vaccine.manage')
    )
  );

-- ----- vaccinations:can_access_store + vaccine.view/vaccine.manage -----
drop policy if exists "vaccinations_select" on public.vaccinations;
create policy "vaccinations_select" on public.vaccinations
  for select to authenticated
  using (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
    )
  );

drop policy if exists "vaccinations_insert" on public.vaccinations;
create policy "vaccinations_insert" on public.vaccinations
  for insert to authenticated
  with check (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
      and public.has_permission(tenant_id, store_id, 'vaccine.manage')
    )
  );

drop policy if exists "vaccinations_update" on public.vaccinations;
create policy "vaccinations_update" on public.vaccinations
  for update to authenticated
  using (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
      and public.has_permission(tenant_id, store_id, 'vaccine.manage')
    )
  )
  with check (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
      and public.has_permission(tenant_id, store_id, 'vaccine.manage')
    )
  );

drop policy if exists "vaccinations_delete" on public.vaccinations;
create policy "vaccinations_delete" on public.vaccinations
  for delete to authenticated
  using (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
      and public.has_permission(tenant_id, store_id, 'vaccine.manage')
    )
  );

-- ----- deworming_records:can_access_store + deworming.view/deworming.manage -----
drop policy if exists "deworming_records_select" on public.deworming_records;
create policy "deworming_records_select" on public.deworming_records
  for select to authenticated
  using (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
    )
  );

drop policy if exists "deworming_records_insert" on public.deworming_records;
create policy "deworming_records_insert" on public.deworming_records
  for insert to authenticated
  with check (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
      and public.has_permission(tenant_id, store_id, 'deworming.manage')
    )
  );

drop policy if exists "deworming_records_update" on public.deworming_records;
create policy "deworming_records_update" on public.deworming_records
  for update to authenticated
  using (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
      and public.has_permission(tenant_id, store_id, 'deworming.manage')
    )
  )
  with check (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
      and public.has_permission(tenant_id, store_id, 'deworming.manage')
    )
  );

drop policy if exists "deworming_records_delete" on public.deworming_records;
create policy "deworming_records_delete" on public.deworming_records
  for delete to authenticated
  using (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
      and public.has_permission(tenant_id, store_id, 'deworming.manage')
    )
  );

-- ----- diag_reminders:can_access_store + diag_reminder.view -----
drop policy if exists "diag_reminders_select" on public.diag_reminders;
create policy "diag_reminders_select" on public.diag_reminders
  for select to authenticated
  using (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
    )
  );

drop policy if exists "diag_reminders_insert" on public.diag_reminders;
create policy "diag_reminders_insert" on public.diag_reminders
  for insert to authenticated
  with check (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
    )
  );

drop policy if exists "diag_reminders_update" on public.diag_reminders;
create policy "diag_reminders_update" on public.diag_reminders
  for update to authenticated
  using (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
      and public.has_permission(tenant_id, store_id, 'diag_reminder.view')
    )
  )
  with check (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
      and public.has_permission(tenant_id, store_id, 'diag_reminder.view')
    )
  );

drop policy if exists "diag_reminders_delete" on public.diag_reminders;
create policy "diag_reminders_delete" on public.diag_reminders
  for delete to authenticated
  using (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
      and public.has_permission(tenant_id, store_id, 'diag_reminder.view')
    )
  );

-- ----- vaccine_certificates:can_access_store + vaccine.view(读)/vaccine.certificate.issue(写) -----
drop policy if exists "vaccine_certificates_select" on public.vaccine_certificates;
create policy "vaccine_certificates_select" on public.vaccine_certificates
  for select to authenticated
  using (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
    )
  );

drop policy if exists "vaccine_certificates_insert" on public.vaccine_certificates;
create policy "vaccine_certificates_insert" on public.vaccine_certificates
  for insert to authenticated
  with check (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
      and public.has_permission(tenant_id, store_id, 'vaccine.certificate.issue')
    )
  );

drop policy if exists "vaccine_certificates_update" on public.vaccine_certificates;
create policy "vaccine_certificates_update" on public.vaccine_certificates
  for update to authenticated
  using (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
      and public.has_permission(tenant_id, store_id, 'vaccine.certificate.issue')
    )
  )
  with check (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
      and public.has_permission(tenant_id, store_id, 'vaccine.certificate.issue')
    )
  );

drop policy if exists "vaccine_certificates_delete" on public.vaccine_certificates;
create policy "vaccine_certificates_delete" on public.vaccine_certificates
  for delete to authenticated
  using (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
      and public.has_permission(tenant_id, store_id, 'vaccine.certificate.issue')
    )
  );

-- ----- lab_orders:can_access_store + lab.view(读)/lab.request(写) -----
drop policy if exists "lab_orders_select" on public.lab_orders;
create policy "lab_orders_select" on public.lab_orders
  for select to authenticated
  using (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
    )
  );

drop policy if exists "lab_orders_insert" on public.lab_orders;
create policy "lab_orders_insert" on public.lab_orders
  for insert to authenticated
  with check (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
      and public.has_permission(tenant_id, store_id, 'lab.request')
    )
  );

drop policy if exists "lab_orders_update" on public.lab_orders;
create policy "lab_orders_update" on public.lab_orders
  for update to authenticated
  using (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
      and (
        public.has_permission(tenant_id, store_id, 'lab.request')
        or public.has_permission(tenant_id, store_id, 'lab.collect')
        or public.has_permission(tenant_id, store_id, 'lab.result.input')
        or public.has_permission(tenant_id, store_id, 'lab.result.review')
      )
    )
  )
  with check (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
      and (
        public.has_permission(tenant_id, store_id, 'lab.request')
        or public.has_permission(tenant_id, store_id, 'lab.collect')
        or public.has_permission(tenant_id, store_id, 'lab.result.input')
        or public.has_permission(tenant_id, store_id, 'lab.result.review')
      )
    )
  );

drop policy if exists "lab_orders_delete" on public.lab_orders;
create policy "lab_orders_delete" on public.lab_orders
  for delete to authenticated
  using (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
      and public.has_permission(tenant_id, store_id, 'lab.request')
    )
  );

-- ----- lab_order_analytes:跟随 lab_orders(联表校验) -----
drop policy if exists "lab_order_analytes_select" on public.lab_order_analytes;
create policy "lab_order_analytes_select" on public.lab_order_analytes
  for select to authenticated
  using (
    exists (
      select 1 from public.lab_orders lo
      where lo.id = lab_order_analytes.lab_order_id
        and public.is_tenant_member(lo.tenant_id)
        and (lo.store_id is null or public.can_access_store(lo.tenant_id, lo.store_id))
    )
  );

drop policy if exists "lab_order_analytes_insert" on public.lab_order_analytes;
create policy "lab_order_analytes_insert" on public.lab_order_analytes
  for insert to authenticated
  with check (
    exists (
      select 1 from public.lab_orders lo
      where lo.id = lab_order_analytes.lab_order_id
        and public.is_tenant_member(lo.tenant_id)
        and (lo.store_id is null or public.can_access_store(lo.tenant_id, lo.store_id))
        and public.has_permission(lo.tenant_id, lo.store_id, 'lab.result.input')
    )
  );

drop policy if exists "lab_order_analytes_update" on public.lab_order_analytes;
create policy "lab_order_analytes_update" on public.lab_order_analytes
  for update to authenticated
  using (
    exists (
      select 1 from public.lab_orders lo
      where lo.id = lab_order_analytes.lab_order_id
        and public.is_tenant_member(lo.tenant_id)
        and (lo.store_id is null or public.can_access_store(lo.tenant_id, lo.store_id))
        and public.has_permission(lo.tenant_id, lo.store_id, 'lab.result.input')
    )
  )
  with check (
    exists (
      select 1 from public.lab_orders lo
      where lo.id = lab_order_analytes.lab_order_id
        and public.is_tenant_member(lo.tenant_id)
        and (lo.store_id is null or public.can_access_store(lo.tenant_id, lo.store_id))
        and public.has_permission(lo.tenant_id, lo.store_id, 'lab.result.input')
    )
  );

drop policy if exists "lab_order_analytes_delete" on public.lab_order_analytes;
create policy "lab_order_analytes_delete" on public.lab_order_analytes
  for delete to authenticated
  using (
    exists (
      select 1 from public.lab_orders lo
      where lo.id = lab_order_analytes.lab_order_id
        and public.is_tenant_member(lo.tenant_id)
        and (lo.store_id is null or public.can_access_store(lo.tenant_id, lo.store_id))
        and public.has_permission(lo.tenant_id, lo.store_id, 'lab.result.input')
    )
  );

-- ----- lab_specimens:跟随 lab_orders(联表校验 + lab.collect) -----
drop policy if exists "lab_specimens_select" on public.lab_specimens;
create policy "lab_specimens_select" on public.lab_specimens
  for select to authenticated
  using (
    exists (
      select 1 from public.lab_orders lo
      where lo.id = lab_specimens.lab_order_id
        and public.is_tenant_member(lo.tenant_id)
        and (lo.store_id is null or public.can_access_store(lo.tenant_id, lo.store_id))
    )
  );

drop policy if exists "lab_specimens_insert" on public.lab_specimens;
create policy "lab_specimens_insert" on public.lab_specimens
  for insert to authenticated
  with check (
    exists (
      select 1 from public.lab_orders lo
      where lo.id = lab_specimens.lab_order_id
        and public.is_tenant_member(lo.tenant_id)
        and (lo.store_id is null or public.can_access_store(lo.tenant_id, lo.store_id))
        and public.has_permission(lo.tenant_id, lo.store_id, 'lab.collect')
    )
  );

drop policy if exists "lab_specimens_update" on public.lab_specimens;
create policy "lab_specimens_update" on public.lab_specimens
  for update to authenticated
  using (
    exists (
      select 1 from public.lab_orders lo
      where lo.id = lab_specimens.lab_order_id
        and public.is_tenant_member(lo.tenant_id)
        and (lo.store_id is null or public.can_access_store(lo.tenant_id, lo.store_id))
        and public.has_permission(lo.tenant_id, lo.store_id, 'lab.collect')
    )
  )
  with check (
    exists (
      select 1 from public.lab_orders lo
      where lo.id = lab_specimens.lab_order_id
        and public.is_tenant_member(lo.tenant_id)
        and (lo.store_id is null or public.can_access_store(lo.tenant_id, lo.store_id))
        and public.has_permission(lo.tenant_id, lo.store_id, 'lab.collect')
    )
  );

drop policy if exists "lab_specimens_delete" on public.lab_specimens;
create policy "lab_specimens_delete" on public.lab_specimens
  for delete to authenticated
  using (
    exists (
      select 1 from public.lab_orders lo
      where lo.id = lab_specimens.lab_order_id
        and public.is_tenant_member(lo.tenant_id)
        and (lo.store_id is null or public.can_access_store(lo.tenant_id, lo.store_id))
        and public.has_permission(lo.tenant_id, lo.store_id, 'lab.collect')
    )
  );

-- ----- lab_result_reviews:跟随 lab_orders(联表校验 + lab.result.review) -----
drop policy if exists "lab_result_reviews_select" on public.lab_result_reviews;
create policy "lab_result_reviews_select" on public.lab_result_reviews
  for select to authenticated
  using (
    exists (
      select 1 from public.lab_orders lo
      where lo.id = lab_result_reviews.lab_order_id
        and public.is_tenant_member(lo.tenant_id)
        and (lo.store_id is null or public.can_access_store(lo.tenant_id, lo.store_id))
    )
  );

drop policy if exists "lab_result_reviews_insert" on public.lab_result_reviews;
create policy "lab_result_reviews_insert" on public.lab_result_reviews
  for insert to authenticated
  with check (
    exists (
      select 1 from public.lab_orders lo
      where lo.id = lab_result_reviews.lab_order_id
        and public.is_tenant_member(lo.tenant_id)
        and (lo.store_id is null or public.can_access_store(lo.tenant_id, lo.store_id))
        and public.has_permission(lo.tenant_id, lo.store_id, 'lab.result.review')
    )
  );

drop policy if exists "lab_result_reviews_update" on public.lab_result_reviews;
create policy "lab_result_reviews_update" on public.lab_result_reviews
  for update to authenticated
  using (
    exists (
      select 1 from public.lab_orders lo
      where lo.id = lab_result_reviews.lab_order_id
        and public.is_tenant_member(lo.tenant_id)
        and (lo.store_id is null or public.can_access_store(lo.tenant_id, lo.store_id))
        and public.has_permission(lo.tenant_id, lo.store_id, 'lab.result.review')
    )
  )
  with check (
    exists (
      select 1 from public.lab_orders lo
      where lo.id = lab_result_reviews.lab_order_id
        and public.is_tenant_member(lo.tenant_id)
        and (lo.store_id is null or public.can_access_store(lo.tenant_id, lo.store_id))
        and public.has_permission(lo.tenant_id, lo.store_id, 'lab.result.review')
    )
  );

drop policy if exists "lab_result_reviews_delete" on public.lab_result_reviews;
create policy "lab_result_reviews_delete" on public.lab_result_reviews
  for delete to authenticated
  using (
    exists (
      select 1 from public.lab_orders lo
      where lo.id = lab_result_reviews.lab_order_id
        and public.is_tenant_member(lo.tenant_id)
        and (lo.store_id is null or public.can_access_store(lo.tenant_id, lo.store_id))
        and public.has_permission(lo.tenant_id, lo.store_id, 'lab.result.review')
    )
  );

-- ----- critical_value_alerts:can_access_store + lab.view(读)/lab.critical.acknowledge(写) -----
drop policy if exists "critical_value_alerts_select" on public.critical_value_alerts;
create policy "critical_value_alerts_select" on public.critical_value_alerts
  for select to authenticated
  using (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
    )
  );

drop policy if exists "critical_value_alerts_insert" on public.critical_value_alerts;
create policy "critical_value_alerts_insert" on public.critical_value_alerts
  for insert to authenticated
  with check (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
    )
  );

drop policy if exists "critical_value_alerts_update" on public.critical_value_alerts;
create policy "critical_value_alerts_update" on public.critical_value_alerts
  for update to authenticated
  using (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
      and public.has_permission(tenant_id, store_id, 'lab.critical.acknowledge')
    )
  )
  with check (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
      and public.has_permission(tenant_id, store_id, 'lab.critical.acknowledge')
    )
  );

drop policy if exists "critical_value_alerts_delete" on public.critical_value_alerts;
create policy "critical_value_alerts_delete" on public.critical_value_alerts
  for delete to authenticated
  using (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and (store_id is null or public.can_access_store(tenant_id, store_id))
      and public.has_permission(tenant_id, store_id, 'lab.critical.acknowledge')
    )
  );

-- ===== 14. 新增权限码(MXQ-10001~10011) =====
insert into public.permissions (code, name, module) values
  ('vaccine.view', '查看疫苗', 'vaccine'),
  ('vaccine.manage', '管理疫苗', 'vaccine'),
  ('vaccine.certificate.issue', '签发疫苗证明', 'vaccine'),
  ('deworming.view', '查看驱虫', 'deworming'),
  ('deworming.manage', '管理驱虫', 'deworming'),
  ('lab.view', '查看检验', 'lab'),
  ('lab.request', '申请检验', 'lab'),
  ('lab.collect', '采集标本', 'lab'),
  ('lab.result.input', '录入结果', 'lab'),
  ('lab.result.review', '审核结果', 'lab'),
  ('lab.critical.acknowledge', '确认危急值', 'lab'),
  ('diag_reminder.view', '查看提醒', 'diag_reminder')
on conflict (code) do update set
  name = excluded.name,
  module = excluded.module;

-- 系统角色补 Diagnostics 权限(幂等)
-- system_admin:全部 diagnostics 权限
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'system_admin'
  and p.code in (
    'vaccine.view', 'vaccine.manage', 'vaccine.certificate.issue',
    'deworming.view', 'deworming.manage',
    'lab.view', 'lab.request', 'lab.collect', 'lab.result.input', 'lab.result.review', 'lab.critical.acknowledge',
    'diag_reminder.view'
  )
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

-- store_manager:全部 diagnostics 权限(店长全权管理)
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'store_manager'
  and p.code in (
    'vaccine.view', 'vaccine.manage', 'vaccine.certificate.issue',
    'deworming.view', 'deworming.manage',
    'lab.view', 'lab.request', 'lab.collect', 'lab.result.input', 'lab.result.review', 'lab.critical.acknowledge',
    'diag_reminder.view'
  )
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

-- doctor:疫苗/驱虫/检验申请/结果录入/结果审核/危急值查看(全诊疗流)
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'doctor'
  and p.code in (
    'vaccine.view', 'vaccine.manage', 'vaccine.certificate.issue',
    'deworming.view', 'deworming.manage',
    'lab.view', 'lab.request', 'lab.collect', 'lab.result.input', 'lab.result.review',
    'diag_reminder.view'
  )
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

-- nurse:疫苗/驱虫查看与执行、标本采集、结果录入(辅助)
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'nurse'
  and p.code in (
    'vaccine.view', 'vaccine.manage',
    'deworming.view', 'deworming.manage',
    'lab.view', 'lab.collect', 'lab.result.input',
    'diag_reminder.view'
  )
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

-- 同步 roles.permissions 数组(兼容旧代码读取)
update public.roles
set permissions = array(
  select distinct unnest(permissions || array[
    'vaccine.view', 'vaccine.manage', 'vaccine.certificate.issue',
    'deworming.view', 'deworming.manage',
    'lab.view', 'lab.request', 'lab.collect', 'lab.result.input', 'lab.result.review', 'lab.critical.acknowledge',
    'diag_reminder.view'
  ])
)
where code in ('system_admin', 'store_manager') and is_system = true;

update public.roles
set permissions = array(
  select distinct unnest(permissions || array[
    'vaccine.view', 'vaccine.manage', 'vaccine.certificate.issue',
    'deworming.view', 'deworming.manage',
    'lab.view', 'lab.request', 'lab.collect', 'lab.result.input', 'lab.result.review',
    'diag_reminder.view'
  ])
)
where code in ('doctor') and is_system = true;

update public.roles
set permissions = array(
  select distinct unnest(permissions || array[
    'vaccine.view', 'vaccine.manage',
    'deworming.view', 'deworming.manage',
    'lab.view', 'lab.collect', 'lab.result.input',
    'diag_reminder.view'
  ])
)
where code in ('nurse') and is_system = true;

-- ===== 15. scan_diag_reminders RPC(MXQ-10004) =====
-- 扫描到期疫苗/驱虫记录,生成提醒(幂等:同 reference_id+due_date 已存在则跳过)
-- 扫描条件:vaccinations where status in ('scheduled','overdue') and scheduled_date < now()+7days
--          deworming_records where status='scheduled' and next_due_date < now()+7days
create or replace function public.scan_diag_reminders(
  p_tenant_id uuid,
  p_store_id uuid default null,
  p_lookahead_days integer default 7
)
returns table(scanned_count bigint, inserted_count bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_threshold timestamptz := now() + (p_lookahead_days || ' days')::interval;
begin
  -- 疫苗到期提醒(含已逾期)
  insert into public.diag_reminders (tenant_id, store_id, customer_id, pet_id, reminder_type, reference_id, due_date, status)
  select v.tenant_id, v.store_id, v.customer_id, v.pet_id, 'vaccine', v.id, coalesce(v.scheduled_date, v.next_due_date), 'pending'
  from public.vaccinations v
  where v.tenant_id = p_tenant_id
    and (p_store_id is null or v.store_id = p_store_id)
    and v.status in ('scheduled', 'overdue')
    and coalesce(v.scheduled_date, v.next_due_date) is not null
    and coalesce(v.scheduled_date, v.next_due_date) < v_threshold
    and not exists (
      select 1 from public.diag_reminders dr
      where dr.reference_id = v.id
        and dr.reminder_type = 'vaccine'
        and dr.status = 'pending'
    );

  -- 驱虫到期提醒(看 next_due_date)
  insert into public.diag_reminders (tenant_id, store_id, customer_id, pet_id, reminder_type, reference_id, due_date, status)
  select d.tenant_id, d.store_id, d.customer_id, d.pet_id, 'deworming', d.id, d.next_due_date, 'pending'
  from public.deworming_records d
  where d.tenant_id = p_tenant_id
    and (p_store_id is null or d.store_id = p_store_id)
    and d.status = 'scheduled'
    and d.next_due_date is not null
    and d.next_due_date < v_threshold
    and not exists (
      select 1 from public.diag_reminders dr
      where dr.reference_id = d.id
        and dr.reminder_type = 'deworming'
        and dr.status = 'pending'
    );

  return query
  select
    (select count(*) from public.vaccinations
     where tenant_id = p_tenant_id
       and (p_store_id is null or store_id = p_store_id)
       and status in ('scheduled', 'overdue')
       and coalesce(scheduled_date, next_due_date) is not null
       and coalesce(scheduled_date, next_due_date) < v_threshold) as scanned_count,
    (select count(*) from public.diag_reminders
     where tenant_id = p_tenant_id
       and (p_store_id is null or store_id = p_store_id)
       and status = 'pending') as inserted_count;
end;
$$;

revoke all on function public.scan_diag_reminders(uuid, uuid, integer) from public;
grant execute on function public.scan_diag_reminders(uuid, uuid, integer) to authenticated;

-- ===== 16. issue_vaccine_certificate RPC(MXQ-10005) =====
-- 事务化生成证书编号(VC-yyyymmdd-序号)+ 落库 + 写审计
-- 校验:vaccination 必须为 administered 状态,同 vaccination 不可重复签发
create or replace function public.issue_vaccine_certificate(
  p_vaccination_id uuid,
  p_operator_id uuid default null,
  p_pdf_file_id uuid default null
)
returns public.vaccine_certificates
language plpgsql
security definer
set search_path = public
as $$
declare
  v_vaccination public.vaccinations;
  v_existing public.vaccine_certificates;
  v_cert_no text;
  v_today text := to_char(now(), 'YYYYMMDD');
  v_seq integer;
  v_cert public.vaccine_certificates;
begin
  select * into v_vaccination from public.vaccinations where id = p_vaccination_id for update;
  if not found then
    raise exception 'VACCINATION_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_vaccination.status <> 'administered' then
    raise exception 'VACCINATION_NOT_ADMINISTERED' using errcode = 'P0003';
  end if;

  -- 同 vaccination 不可重复签发(只看 issued 状态)
  select * into v_existing
  from public.vaccine_certificates
  where vaccination_id = p_vaccination_id and status = 'issued'
  limit 1;
  if found then
    raise exception 'CERTIFICATE_ALREADY_ISSUED' using errcode = 'P0003';
  end if;

  -- 生成证书编号:VC-{yyyymmdd}-{6 位序列},序列从同日已存在证书计数 +1
  select count(*) + 1 into v_seq
  from public.vaccine_certificates
  where tenant_id = v_vaccination.tenant_id
    and to_char(issued_date, 'YYYYMMDD') = v_today;
  v_cert_no := 'VC-' || v_today || '-' || lpad(v_seq::text, 6, '0');

  insert into public.vaccine_certificates (
    tenant_id, store_id, pet_id, customer_id, vaccination_id,
    certificate_no, issued_by, certificate_data, pdf_file_id, status
  )
  values (
    v_vaccination.tenant_id,
    v_vaccination.store_id,
    v_vaccination.pet_id,
    v_vaccination.customer_id,
    p_vaccination_id,
    v_cert_no,
    p_operator_id,
    jsonb_build_object(
      'vaccine_catalog_item_id', v_vaccination.vaccine_catalog_item_id,
      'dose_no', v_vaccination.dose_no,
      'batch_no', v_vaccination.batch_no,
      'manufacturer', v_vaccination.manufacturer,
      'administered_date', v_vaccination.administered_date,
      'administered_by', v_vaccination.administered_by
    ),
    p_pdf_file_id,
    'issued'
  )
  returning * into v_cert;

  -- 事务内审计
  insert into public.audit_logs (tenant_id, store_id, user_id, action, entity_type, entity_id, metadata)
  values (v_vaccination.tenant_id, v_vaccination.store_id, p_operator_id, 'vaccine.certificate.issue', 'vaccine_certificate', v_cert.id,
          jsonb_build_object('certificate_no', v_cert_no, 'vaccination_id', p_vaccination_id));

  return v_cert;
end;
$$;

revoke all on function public.issue_vaccine_certificate(uuid, uuid, uuid) from public;
grant execute on function public.issue_vaccine_certificate(uuid, uuid, uuid) to authenticated;

-- ===== 17. publish_lab_results RPC(MXQ-10008) =====
-- 事务化批量更新 lab_order_analytes + 校验危急值 + 更新 lab_orders.status=completed + 写审计
-- p_results_json:[{ id, result_value, result_numeric, is_abnormal, is_critical, flag, note }]
-- 校验:lab_order 必须为 collected 状态(已采集);rejected 后重新录入也允许
-- 自动:is_critical=true 时,在 critical_value_alerts 插入告警
create or replace function public.publish_lab_results(
  p_lab_order_id uuid,
  p_results_json jsonb,
  p_operator_id uuid default null
)
returns public.lab_orders
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.lab_orders;
  v_item jsonb;
  v_analyte_id uuid;
  v_critical_count integer := 0;
  v_alert public.critical_value_alerts;
begin
  select * into v_order from public.lab_orders where id = p_lab_order_id for update;
  if not found then
    raise exception 'LAB_ORDER_NOT_FOUND' using errcode = 'P0002';
  end if;
  -- 仅 collected 或 completed 状态可发布结果(rejected 后重录也走这里,但状态保留为 collected/completed)
  if v_order.status not in ('collected', 'completed') then
    raise exception 'LAB_ORDER_NOT_PUBLISHABLE' using errcode = 'P0003';
  end if;

  -- 逐项更新
  for v_item in select * from jsonb_array_elements(p_results_json)
  loop
    v_analyte_id := nullif(v_item->>'id', '')::uuid;
    if v_analyte_id is null then
      raise exception 'INVALID_RESULT_ITEM' using errcode = 'P0003', detail = 'id 缺失';
    end if;

    update public.lab_order_analytes
    set result_value = nullif(v_item->>'result_value', ''),
        result_numeric = case when v_item ? 'result_numeric' and nullif(v_item->>'result_numeric', '') is not null
                              then (v_item->>'result_numeric')::numeric else null end,
        is_abnormal = coalesce((v_item->>'is_abnormal')::boolean, false),
        is_critical = coalesce((v_item->>'is_critical')::boolean, false),
        flag = nullif(v_item->>'flag', ''),
        note = nullif(v_item->>'note', ''),
        resulted_at = now(),
        resulted_by = p_operator_id
    where id = v_analyte_id
      and lab_order_id = p_lab_order_id;

    -- 危急值自动告警(去重:同一 analyte 已存在 pending 告警则不重复创建)
    if coalesce((v_item->>'is_critical')::boolean, false) then
      v_critical_count := v_critical_count + 1;
      insert into public.critical_value_alerts (
        tenant_id, store_id, lab_order_id, analyte_id, pet_id, alert_level, message, status
      )
      select v_order.tenant_id, v_order.store_id, p_lab_order_id, v_analyte_id, v_order.pet_id,
             'critical',
             '检验危急值:' || coalesce(v_item->>'result_value', v_item->>'result_numeric', '未知'),
             'pending'
      where not exists (
        select 1 from public.critical_value_alerts cva
        where cva.lab_order_id = p_lab_order_id
          and cva.analyte_id = v_analyte_id
          and cva.status in ('pending', 'acknowledged')
      )
      returning * into v_alert;
    end if;
  end loop;

  -- 推进状态:collected→completed(若已是 completed 则保持)
  if v_order.status = 'collected' then
    update public.lab_orders
    set status = 'completed', completed_at = now(), updated_at = now()
    where id = p_lab_order_id
    returning * into v_order;
  end if;

  -- 事务内审计
  insert into public.audit_logs (tenant_id, store_id, user_id, action, entity_type, entity_id, metadata)
  values (v_order.tenant_id, v_order.store_id, p_operator_id, 'lab.publish_results', 'lab_order', p_lab_order_id,
          jsonb_build_object('results_count', jsonb_array_length(p_results_json), 'critical_count', v_critical_count));

  return v_order;
end;
$$;

revoke all on function public.publish_lab_results(uuid, jsonb, uuid) from public;
grant execute on function public.publish_lab_results(uuid, jsonb, uuid) to authenticated;

-- ===== 18. review_lab_results RPC(MXQ-10008) =====
-- 审核发布:approved→lab_orders.status=completed(若未完成)+ 写 lab_result_reviews
--          rejected→lab_orders.status 保持(回到待录入),允许重新录入
-- 校验:必须已 publish_results(存在至少一条 resulted_at 不为 null 的 analyte)
-- 双签:审核人不能是结果录入人(若 p_reviewer_id 与 lab_order_analytes.resulted_by 相同则拒绝)
create or replace function public.review_lab_results(
  p_lab_order_id uuid,
  p_decision text,
  p_comment text default null,
  p_reviewer_id uuid default null
)
returns public.lab_result_reviews
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.lab_orders;
  v_review public.lab_result_reviews;
  v_resulted_by uuid;
  v_resulted_count integer;
begin
  if p_decision not in ('approved', 'rejected') then
    raise exception 'INVALID_REVIEW_DECISION' using errcode = 'P0003';
  end if;

  select * into v_order from public.lab_orders where id = p_lab_order_id for update;
  if not found then
    raise exception 'LAB_ORDER_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- 必须已录入结果
  select count(*) into v_resulted_count
  from public.lab_order_analytes
  where lab_order_id = p_lab_order_id and resulted_at is not null;
  if v_resulted_count = 0 then
    raise exception 'NO_RESULTS_TO_REVIEW' using errcode = 'P0003';
  end if;

  -- 双签:审核人不能是结果录入人(查任意一条结果,resulted_by = p_reviewer_id 即视为同人)
  select resulted_by into v_resulted_by
  from public.lab_order_analytes
  where lab_order_id = p_lab_order_id and resulted_at is not null
    and resulted_by = p_reviewer_id
  limit 1;
  if found then
    raise exception 'REVIEWER_IS_RESULT_INPUTTER' using errcode = 'P0003';
  end if;

  -- 写审核记录
  insert into public.lab_result_reviews (lab_order_id, reviewed_by, decision, comment)
  values (p_lab_order_id, p_reviewer_id, p_decision, p_comment)
  returning * into v_review;

  -- approved → 确保 status=completed(若 publish_lab_results 已完成则保持)
  -- rejected → 保留状态(completed/collected),允许重新录入覆盖结果
  if p_decision = 'approved' then
    update public.lab_orders
    set status = 'completed', completed_at = coalesce(completed_at, now()), updated_at = now()
    where id = p_lab_order_id;
  end if;

  -- 事务内审计
  insert into public.audit_logs (tenant_id, store_id, user_id, action, entity_type, entity_id, metadata)
  values (v_order.tenant_id, v_order.store_id, p_reviewer_id, 'lab.review_results', 'lab_order', p_lab_order_id,
          jsonb_build_object('decision', p_decision, 'comment', p_comment));

  return v_review;
end;
$$;

revoke all on function public.review_lab_results(uuid, text, text, uuid) from public;
grant execute on function public.review_lab_results(uuid, text, text, uuid) to authenticated;
