-- ============================================================
-- 20260806000016_catalog.sql
-- MXQ-6001~6010 Catalog 领域数据模型
--   - catalog_categories       类目树(租户级目录,MXQ-6001)
--   - catalog_items            统一目录(MXQ-6002/MXQ-6010)
--   - store_catalog_items      门店项目/价格覆盖(MXQ-6003)
--   - catalog_drug_extensions  药品扩展(MXQ-6004)
--   - catalog_vaccine_extensions 疫苗扩展(MXQ-6004)
--   - intake_questions         问诊问题库(MXQ-6007)
--   - diagnosis_dict           诊断字典(MXQ-6008)
--   - lab_panels / lab_analytes 检验 panel/analyte(MXQ-6009)
--   - migrate_catalog_to_store RPC 批量迁移(MXQ-6005)
--   - 权限码:catalog.view / catalog.manage / catalog.storePrice.manage /
--             catalog.drug.manage / catalog.vaccine.manage
-- 幂等,可重复应用
--
-- 设计要点:
--   - 类目是租户级目录数据,租户成员可读;写入需 catalog.manage
--   - 统一目录为租户级,租户成员可读
--   - 门店项目/价格覆盖按 can_access_store 校验
--   - 药品/疫苗扩展跟随 catalog_items 隔离(联表 RLS)
--   - 问诊/诊断/检验字典为租户级目录,租户成员可读
--   - billing_type 字段(MXQ-6010)用于收费时按目录项引用
--   - 批量迁移走 RPC,事务化幂等(on conflict do nothing)
-- ============================================================

-- ===== 1. catalog_categories 表(MXQ-6001) =====
create table if not exists public.catalog_categories (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  code text not null,                                  -- service/product/drug/vaccine/exam/consumable 或自定义子类目
  name text not null,
  parent_id uuid references public.catalog_categories(id) on delete set null,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_catalog_categories_tenant on public.catalog_categories (tenant_id);
create index if not exists idx_catalog_categories_parent on public.catalog_categories (parent_id);
create unique index if not exists idx_catalog_categories_tenant_code on public.catalog_categories (tenant_id, code);

-- ===== 2. catalog_items 表(MXQ-6002 / MXQ-6010) =====
create table if not exists public.catalog_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  category_id uuid references public.catalog_categories(id) on delete set null,
  code text not null,
  name text not null,
  description text,
  unit text,                                           -- 次/盒/支/瓶/项...
  default_price numeric(12,2) not null default 0,
  cost_price numeric(12,2) not null default 0,
  is_active boolean not null default true,
  tags text[] not null default '{}',
  billing_type text not null default 'service',        -- MXQ-6010: service/product/drug/vaccine/exam
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint catalog_items_billing_type_check check (billing_type in ('service', 'product', 'drug', 'vaccine', 'exam'))
);

create index if not exists idx_catalog_items_tenant on public.catalog_items (tenant_id);
create index if not exists idx_catalog_items_category on public.catalog_items (category_id);
create index if not exists idx_catalog_items_billing_type on public.catalog_items (billing_type);
create unique index if not exists idx_catalog_items_tenant_code on public.catalog_items (tenant_id, code);

-- ===== 3. store_catalog_items 表(MXQ-6003) =====
create table if not exists public.store_catalog_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  store_id uuid not null references public.stores(id) on delete cascade,
  catalog_item_id uuid not null references public.catalog_items(id) on delete cascade,
  custom_name text,
  custom_price numeric(12,2),
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_store_catalog_items_store on public.store_catalog_items (store_id);
create index if not exists idx_store_catalog_items_tenant_store on public.store_catalog_items (tenant_id, store_id);
create unique index if not exists idx_store_catalog_items_store_item on public.store_catalog_items (store_id, catalog_item_id);

-- ===== 4. catalog_drug_extensions 表(MXQ-6004) =====
create table if not exists public.catalog_drug_extensions (
  id uuid primary key default gen_random_uuid(),
  catalog_item_id uuid not null references public.catalog_items(id) on delete cascade,
  drug_form text not null default 'other',             -- tablet/capsule/liquid/injection/other
  strength text,
  manufacturer text,
  barcode text,
  is_controlled boolean not null default false,        -- 是否管控药品
  storage_condition text,
  shelf_life_days integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint catalog_drug_extensions_form_check check (drug_form in ('tablet', 'capsule', 'liquid', 'injection', 'other'))
);

create unique index if not exists idx_catalog_drug_ext_item on public.catalog_drug_extensions (catalog_item_id);

-- ===== 5. catalog_vaccine_extensions 表(MXQ-6004) =====
create table if not exists public.catalog_vaccine_extensions (
  id uuid primary key default gen_random_uuid(),
  catalog_item_id uuid not null references public.catalog_items(id) on delete cascade,
  vaccine_type text not null default 'other',          -- rabies/distemper/parvo/other
  manufacturer text,
  protocol_course integer not null default 1,          -- 针次
  interval_days integer,                               -- 间隔天数
  is_required boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint catalog_vaccine_ext_type_check check (vaccine_type in ('rabies', 'distemper', 'parvo', 'other')),
  constraint catalog_vaccine_ext_course_check check (protocol_course >= 1)
);

create unique index if not exists idx_catalog_vaccine_ext_item on public.catalog_vaccine_extensions (catalog_item_id);

-- ===== 6. intake_questions 表(MXQ-6007) =====
create table if not exists public.intake_questions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  category text not null default 'general',            -- general/history/symptom/diet/behavior...
  question text not null,
  sort_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_intake_questions_tenant on public.intake_questions (tenant_id);
create index if not exists idx_intake_questions_tenant_category on public.intake_questions (tenant_id, category);

-- ===== 7. diagnosis_dict 表(MXQ-6008) =====
create table if not exists public.diagnosis_dict (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  code text not null,
  name text not null,
  category text,                                       -- 内科/外科/传染/皮肤/眼科...
  description text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_diagnosis_dict_tenant on public.diagnosis_dict (tenant_id);
create unique index if not exists idx_diagnosis_dict_tenant_code on public.diagnosis_dict (tenant_id, code);

-- ===== 8. lab_panels 表(MXQ-6009) =====
create table if not exists public.lab_panels (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  code text not null,
  name text not null,
  category text not null default 'other',              -- blood/urine/biochem/endocrine/other
  sample_type text,                                    -- 全血/血清/尿液...
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint lab_panels_category_check check (category in ('blood', 'urine', 'biochem', 'endocrine', 'other'))
);

create index if not exists idx_lab_panels_tenant on public.lab_panels (tenant_id);
create unique index if not exists idx_lab_panels_tenant_code on public.lab_panels (tenant_id, code);

-- ===== 9. lab_analytes 表(MXQ-6009) =====
create table if not exists public.lab_analytes (
  id uuid primary key default gen_random_uuid(),
  panel_id uuid not null references public.lab_panels(id) on delete cascade,
  code text not null,
  name text not null,
  unit text,
  ref_range_low numeric(12,4),
  ref_range_high numeric(12,4),
  ref_range_text text,                                 -- 文本范围(无法用数值表达时)
  is_critical boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_lab_analytes_panel on public.lab_analytes (panel_id);

-- ===== 10. updated_at 触发器(touch_updated_at 已在 000015 创建,此处挂触发器) =====
drop trigger if exists trg_catalog_categories_updated_at on public.catalog_categories;
create trigger trg_catalog_categories_updated_at
  before update on public.catalog_categories
  for each row execute procedure public.touch_updated_at();

drop trigger if exists trg_catalog_items_updated_at on public.catalog_items;
create trigger trg_catalog_items_updated_at
  before update on public.catalog_items
  for each row execute procedure public.touch_updated_at();

drop trigger if exists trg_store_catalog_items_updated_at on public.store_catalog_items;
create trigger trg_store_catalog_items_updated_at
  before update on public.store_catalog_items
  for each row execute procedure public.touch_updated_at();

drop trigger if exists trg_catalog_drug_ext_updated_at on public.catalog_drug_extensions;
create trigger trg_catalog_drug_ext_updated_at
  before update on public.catalog_drug_extensions
  for each row execute procedure public.touch_updated_at();

drop trigger if exists trg_catalog_vaccine_ext_updated_at on public.catalog_vaccine_extensions;
create trigger trg_catalog_vaccine_ext_updated_at
  before update on public.catalog_vaccine_extensions
  for each row execute procedure public.touch_updated_at();

drop trigger if exists trg_intake_questions_updated_at on public.intake_questions;
create trigger trg_intake_questions_updated_at
  before update on public.intake_questions
  for each row execute procedure public.touch_updated_at();

drop trigger if exists trg_diagnosis_dict_updated_at on public.diagnosis_dict;
create trigger trg_diagnosis_dict_updated_at
  before update on public.diagnosis_dict
  for each row execute procedure public.touch_updated_at();

drop trigger if exists trg_lab_panels_updated_at on public.lab_panels;
create trigger trg_lab_panels_updated_at
  before update on public.lab_panels
  for each row execute procedure public.touch_updated_at();

drop trigger if exists trg_lab_analytes_updated_at on public.lab_analytes;
create trigger trg_lab_analytes_updated_at
  before update on public.lab_analytes
  for each row execute procedure public.touch_updated_at();

-- ===== 11. RLS 策略 =====
alter table public.catalog_categories enable row level security;
alter table public.catalog_items enable row level security;
alter table public.store_catalog_items enable row level security;
alter table public.catalog_drug_extensions enable row level security;
alter table public.catalog_vaccine_extensions enable row level security;
alter table public.intake_questions enable row level security;
alter table public.diagnosis_dict enable row level security;
alter table public.lab_panels enable row level security;
alter table public.lab_analytes enable row level security;

-- ----- catalog_categories:租户成员可读;写入需 catalog.manage -----
drop policy if exists "catalog_categories_select" on public.catalog_categories;
create policy "catalog_categories_select" on public.catalog_categories
  for select to authenticated
  using (public.is_tenant_member(tenant_id));

drop policy if exists "catalog_categories_insert" on public.catalog_categories;
create policy "catalog_categories_insert" on public.catalog_categories
  for insert to authenticated
  with check (
    public.is_tenant_member(tenant_id)
    and public.has_permission(tenant_id, null, 'catalog.manage')
  );

drop policy if exists "catalog_categories_update" on public.catalog_categories;
create policy "catalog_categories_update" on public.catalog_categories
  for update to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and public.has_permission(tenant_id, null, 'catalog.manage')
  )
  with check (
    public.is_tenant_member(tenant_id)
    and public.has_permission(tenant_id, null, 'catalog.manage')
  );

drop policy if exists "catalog_categories_delete" on public.catalog_categories;
create policy "catalog_categories_delete" on public.catalog_categories
  for delete to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and public.has_permission(tenant_id, null, 'catalog.manage')
  );

-- ----- catalog_items:租户成员可读;写入需 catalog.manage -----
drop policy if exists "catalog_items_select" on public.catalog_items;
create policy "catalog_items_select" on public.catalog_items
  for select to authenticated
  using (public.is_tenant_member(tenant_id));

drop policy if exists "catalog_items_insert" on public.catalog_items;
create policy "catalog_items_insert" on public.catalog_items
  for insert to authenticated
  with check (
    public.is_tenant_member(tenant_id)
    and public.has_permission(tenant_id, null, 'catalog.manage')
  );

drop policy if exists "catalog_items_update" on public.catalog_items;
create policy "catalog_items_update" on public.catalog_items
  for update to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and public.has_permission(tenant_id, null, 'catalog.manage')
  )
  with check (
    public.is_tenant_member(tenant_id)
    and public.has_permission(tenant_id, null, 'catalog.manage')
  );

drop policy if exists "catalog_items_delete" on public.catalog_items;
create policy "catalog_items_delete" on public.catalog_items
  for delete to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and public.has_permission(tenant_id, null, 'catalog.manage')
  );

-- ----- store_catalog_items:can_access_store 校验 -----
drop policy if exists "store_catalog_items_select" on public.store_catalog_items;
create policy "store_catalog_items_select" on public.store_catalog_items
  for select to authenticated
  using (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and public.can_access_store(tenant_id, store_id)
    )
  );

drop policy if exists "store_catalog_items_insert" on public.store_catalog_items;
create policy "store_catalog_items_insert" on public.store_catalog_items
  for insert to authenticated
  with check (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and public.can_access_store(tenant_id, store_id)
      and public.has_permission(tenant_id, store_id, 'catalog.storePrice.manage')
    )
  );

drop policy if exists "store_catalog_items_update" on public.store_catalog_items;
create policy "store_catalog_items_update" on public.store_catalog_items
  for update to authenticated
  using (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and public.can_access_store(tenant_id, store_id)
      and public.has_permission(tenant_id, store_id, 'catalog.storePrice.manage')
    )
  )
  with check (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and public.can_access_store(tenant_id, store_id)
      and public.has_permission(tenant_id, store_id, 'catalog.storePrice.manage')
    )
  );

drop policy if exists "store_catalog_items_delete" on public.store_catalog_items;
create policy "store_catalog_items_delete" on public.store_catalog_items
  for delete to authenticated
  using (
    public.is_system_admin()
    or (
      public.is_tenant_member(tenant_id)
      and public.can_access_store(tenant_id, store_id)
      and public.has_permission(tenant_id, store_id, 'catalog.storePrice.manage')
    )
  );

-- ----- catalog_drug_extensions:跟随 catalog_items(联表校验租户成员 + catalog.drug.manage) -----
drop policy if exists "catalog_drug_ext_select" on public.catalog_drug_extensions;
create policy "catalog_drug_ext_select" on public.catalog_drug_extensions
  for select to authenticated
  using (
    exists (
      select 1 from public.catalog_items ci
      where ci.id = catalog_drug_extensions.catalog_item_id
        and public.is_tenant_member(ci.tenant_id)
    )
  );

drop policy if exists "catalog_drug_ext_insert" on public.catalog_drug_extensions;
create policy "catalog_drug_ext_insert" on public.catalog_drug_extensions
  for insert to authenticated
  with check (
    exists (
      select 1 from public.catalog_items ci
      where ci.id = catalog_drug_extensions.catalog_item_id
        and public.is_tenant_member(ci.tenant_id)
        and public.has_permission(ci.tenant_id, null, 'catalog.drug.manage')
    )
  );

drop policy if exists "catalog_drug_ext_update" on public.catalog_drug_extensions;
create policy "catalog_drug_ext_update" on public.catalog_drug_extensions
  for update to authenticated
  using (
    exists (
      select 1 from public.catalog_items ci
      where ci.id = catalog_drug_extensions.catalog_item_id
        and public.is_tenant_member(ci.tenant_id)
        and public.has_permission(ci.tenant_id, null, 'catalog.drug.manage')
    )
  )
  with check (
    exists (
      select 1 from public.catalog_items ci
      where ci.id = catalog_drug_extensions.catalog_item_id
        and public.is_tenant_member(ci.tenant_id)
        and public.has_permission(ci.tenant_id, null, 'catalog.drug.manage')
    )
  );

drop policy if exists "catalog_drug_ext_delete" on public.catalog_drug_extensions;
create policy "catalog_drug_ext_delete" on public.catalog_drug_extensions
  for delete to authenticated
  using (
    exists (
      select 1 from public.catalog_items ci
      where ci.id = catalog_drug_extensions.catalog_item_id
        and public.is_tenant_member(ci.tenant_id)
        and public.has_permission(ci.tenant_id, null, 'catalog.drug.manage')
    )
  );

-- ----- catalog_vaccine_extensions:跟随 catalog_items(联表校验租户成员 + catalog.vaccine.manage) -----
drop policy if exists "catalog_vaccine_ext_select" on public.catalog_vaccine_extensions;
create policy "catalog_vaccine_ext_select" on public.catalog_vaccine_extensions
  for select to authenticated
  using (
    exists (
      select 1 from public.catalog_items ci
      where ci.id = catalog_vaccine_extensions.catalog_item_id
        and public.is_tenant_member(ci.tenant_id)
    )
  );

drop policy if exists "catalog_vaccine_ext_insert" on public.catalog_vaccine_extensions;
create policy "catalog_vaccine_ext_insert" on public.catalog_vaccine_extensions
  for insert to authenticated
  with check (
    exists (
      select 1 from public.catalog_items ci
      where ci.id = catalog_vaccine_extensions.catalog_item_id
        and public.is_tenant_member(ci.tenant_id)
        and public.has_permission(ci.tenant_id, null, 'catalog.vaccine.manage')
    )
  );

drop policy if exists "catalog_vaccine_ext_update" on public.catalog_vaccine_extensions;
create policy "catalog_vaccine_ext_update" on public.catalog_vaccine_extensions
  for update to authenticated
  using (
    exists (
      select 1 from public.catalog_items ci
      where ci.id = catalog_vaccine_extensions.catalog_item_id
        and public.is_tenant_member(ci.tenant_id)
        and public.has_permission(ci.tenant_id, null, 'catalog.vaccine.manage')
    )
  )
  with check (
    exists (
      select 1 from public.catalog_items ci
      where ci.id = catalog_vaccine_extensions.catalog_item_id
        and public.is_tenant_member(ci.tenant_id)
        and public.has_permission(ci.tenant_id, null, 'catalog.vaccine.manage')
    )
  );

drop policy if exists "catalog_vaccine_ext_delete" on public.catalog_vaccine_extensions;
create policy "catalog_vaccine_ext_delete" on public.catalog_vaccine_extensions
  for delete to authenticated
  using (
    exists (
      select 1 from public.catalog_items ci
      where ci.id = catalog_vaccine_extensions.catalog_item_id
        and public.is_tenant_member(ci.tenant_id)
        and public.has_permission(ci.tenant_id, null, 'catalog.vaccine.manage')
    )
  );

-- ----- intake_questions:租户成员可读;写入需 catalog.manage -----
drop policy if exists "intake_questions_select" on public.intake_questions;
create policy "intake_questions_select" on public.intake_questions
  for select to authenticated
  using (public.is_tenant_member(tenant_id));

drop policy if exists "intake_questions_insert" on public.intake_questions;
create policy "intake_questions_insert" on public.intake_questions
  for insert to authenticated
  with check (
    public.is_tenant_member(tenant_id)
    and public.has_permission(tenant_id, null, 'catalog.manage')
  );

drop policy if exists "intake_questions_update" on public.intake_questions;
create policy "intake_questions_update" on public.intake_questions
  for update to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and public.has_permission(tenant_id, null, 'catalog.manage')
  )
  with check (
    public.is_tenant_member(tenant_id)
    and public.has_permission(tenant_id, null, 'catalog.manage')
  );

drop policy if exists "intake_questions_delete" on public.intake_questions;
create policy "intake_questions_delete" on public.intake_questions
  for delete to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and public.has_permission(tenant_id, null, 'catalog.manage')
  );

-- ----- diagnosis_dict:租户成员可读;写入需 catalog.manage -----
drop policy if exists "diagnosis_dict_select" on public.diagnosis_dict;
create policy "diagnosis_dict_select" on public.diagnosis_dict
  for select to authenticated
  using (public.is_tenant_member(tenant_id));

drop policy if exists "diagnosis_dict_insert" on public.diagnosis_dict;
create policy "diagnosis_dict_insert" on public.diagnosis_dict
  for insert to authenticated
  with check (
    public.is_tenant_member(tenant_id)
    and public.has_permission(tenant_id, null, 'catalog.manage')
  );

drop policy if exists "diagnosis_dict_update" on public.diagnosis_dict;
create policy "diagnosis_dict_update" on public.diagnosis_dict
  for update to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and public.has_permission(tenant_id, null, 'catalog.manage')
  )
  with check (
    public.is_tenant_member(tenant_id)
    and public.has_permission(tenant_id, null, 'catalog.manage')
  );

drop policy if exists "diagnosis_dict_delete" on public.diagnosis_dict;
create policy "diagnosis_dict_delete" on public.diagnosis_dict
  for delete to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and public.has_permission(tenant_id, null, 'catalog.manage')
  );

-- ----- lab_panels:租户成员可读;写入需 catalog.manage -----
drop policy if exists "lab_panels_select" on public.lab_panels;
create policy "lab_panels_select" on public.lab_panels
  for select to authenticated
  using (public.is_tenant_member(tenant_id));

drop policy if exists "lab_panels_insert" on public.lab_panels;
create policy "lab_panels_insert" on public.lab_panels
  for insert to authenticated
  with check (
    public.is_tenant_member(tenant_id)
    and public.has_permission(tenant_id, null, 'catalog.manage')
  );

drop policy if exists "lab_panels_update" on public.lab_panels;
create policy "lab_panels_update" on public.lab_panels
  for update to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and public.has_permission(tenant_id, null, 'catalog.manage')
  )
  with check (
    public.is_tenant_member(tenant_id)
    and public.has_permission(tenant_id, null, 'catalog.manage')
  );

drop policy if exists "lab_panels_delete" on public.lab_panels;
create policy "lab_panels_delete" on public.lab_panels
  for delete to authenticated
  using (
    public.is_tenant_member(tenant_id)
    and public.has_permission(tenant_id, null, 'catalog.manage')
  );

-- ----- lab_analytes:跟随 lab_panels(联表校验租户成员 + catalog.manage) -----
drop policy if exists "lab_analytes_select" on public.lab_analytes;
create policy "lab_analytes_select" on public.lab_analytes
  for select to authenticated
  using (
    exists (
      select 1 from public.lab_panels lp
      where lp.id = lab_analytes.panel_id
        and public.is_tenant_member(lp.tenant_id)
    )
  );

drop policy if exists "lab_analytes_insert" on public.lab_analytes;
create policy "lab_analytes_insert" on public.lab_analytes
  for insert to authenticated
  with check (
    exists (
      select 1 from public.lab_panels lp
      where lp.id = lab_analytes.panel_id
        and public.is_tenant_member(lp.tenant_id)
        and public.has_permission(lp.tenant_id, null, 'catalog.manage')
    )
  );

drop policy if exists "lab_analytes_update" on public.lab_analytes;
create policy "lab_analytes_update" on public.lab_analytes
  for update to authenticated
  using (
    exists (
      select 1 from public.lab_panels lp
      where lp.id = lab_analytes.panel_id
        and public.is_tenant_member(lp.tenant_id)
        and public.has_permission(lp.tenant_id, null, 'catalog.manage')
    )
  )
  with check (
    exists (
      select 1 from public.lab_panels lp
      where lp.id = lab_analytes.panel_id
        and public.is_tenant_member(lp.tenant_id)
        and public.has_permission(lp.tenant_id, null, 'catalog.manage')
    )
  );

drop policy if exists "lab_analytes_delete" on public.lab_analytes;
create policy "lab_analytes_delete" on public.lab_analytes
  for delete to authenticated
  using (
    exists (
      select 1 from public.lab_panels lp
      where lp.id = lab_analytes.panel_id
        and public.is_tenant_member(lp.tenant_id)
        and public.has_permission(lp.tenant_id, null, 'catalog.manage')
    )
  );

-- ===== 12. 新增权限码(MXQ-6001~6010) =====
insert into public.permissions (code, name, module) values
  ('catalog.view', '查看目录', 'catalog'),
  ('catalog.manage', '管理目录', 'catalog'),
  ('catalog.storePrice.manage', '管理门店价格', 'catalog'),
  ('catalog.drug.manage', '管理药品扩展', 'catalog'),
  ('catalog.vaccine.manage', '管理疫苗扩展', 'catalog')
on conflict (code) do update set
  name = excluded.name,
  module = excluded.module;

-- 系统角色补 catalog.* 权限(幂等)
-- system_admin:全部 catalog 权限
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'system_admin'
  and p.code in (
    'catalog.view', 'catalog.manage', 'catalog.storePrice.manage',
    'catalog.drug.manage', 'catalog.vaccine.manage'
  )
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

-- store_manager:目录查看 + 门店价格管理(不含药品/疫苗扩展)
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'store_manager'
  and p.code in (
    'catalog.view', 'catalog.storePrice.manage'
  )
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

-- doctor:仅目录查看
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'doctor'
  and p.code in ('catalog.view')
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

-- 同步 roles.permissions 数组(兼容旧代码读取)
update public.roles
set permissions = array(
  select distinct unnest(permissions || array[
    'catalog.view', 'catalog.manage', 'catalog.storePrice.manage',
    'catalog.drug.manage', 'catalog.vaccine.manage'
  ])
)
where code in ('system_admin') and is_system = true;

update public.roles
set permissions = array(
  select distinct unnest(permissions || array[
    'catalog.view', 'catalog.storePrice.manage'
  ])
)
where code in ('store_manager') and is_system = true;

update public.roles
set permissions = array(
  select distinct unnest(permissions || array['catalog.view'])
)
where code in ('doctor') and is_system = true;

-- ===== 13. 顶级类目种子(为每个已存在租户插入6个顶级类目,幂等) =====
-- service(服务) / product(商品) / drug(药品) / vaccine(疫苗) / exam(检验) / consumable(耗材)
insert into public.catalog_categories (tenant_id, code, name, parent_id, sort_order, is_active)
select t.id, seed.code, seed.name, null, seed.sort_order, true
from public.tenants t
cross join (values
  ('service', '服务', 1),
  ('product', '商品', 2),
  ('drug', '药品', 3),
  ('vaccine', '疫苗', 4),
  ('exam', '检验', 5),
  ('consumable', '耗材', 6)
) as seed(code, name, sort_order)
where not exists (
  select 1 from public.catalog_categories cc
  where cc.tenant_id = t.id and cc.code = seed.code
);

-- ===== 14. migrate_catalog_to_store RPC(MXQ-6005) =====
-- 把租户级 catalog_items 批量创建 store_catalog_items(幂等,on conflict do nothing)
-- 按 p_category_code 过滤;为 null 时迁移全部 active 目录项
-- 返回新建条数(已存在的计为 0,通过 on conflict do nothing)
create or replace function public.migrate_catalog_to_store(
  p_tenant_id uuid,
  p_store_id uuid,
  p_category_code text default null,
  p_operator_id uuid default null
)
returns table(inserted_count bigint, skipped_count bigint, total_count bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_store_exists integer;
begin
  -- 校验门店存在且归属同租户
  select count(*) into v_store_exists
  from public.stores
  where id = p_store_id and tenant_id = p_tenant_id and archived_at is null;

  if v_store_exists = 0 then
    raise exception 'STORE_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- 事务化批量插入(on conflict do nothing 保证幂等)
  insert into public.store_catalog_items (tenant_id, store_id, catalog_item_id, is_active, sort_order)
  select p_tenant_id, p_store_id, ci.id, ci.is_active, 0
  from public.catalog_items ci
  where ci.tenant_id = p_tenant_id
    and ci.is_active = true
    and (
      p_category_code is null
      or exists (
        select 1 from public.catalog_categories cc
        where cc.id = ci.category_id and cc.code = p_category_code
      )
    )
    and not exists (
      select 1 from public.store_catalog_items sci
      where sci.store_id = p_store_id and sci.catalog_item_id = ci.id
    );

  -- 返回统计:inserted(本次新建)、skipped(已存在跳过)、total(门店总项目数)
  return query
  select
    (select count(*) from public.store_catalog_items sci
     where sci.store_id = p_store_id
       and sci.catalog_item_id in (
         select ci.id from public.catalog_items ci
         where ci.tenant_id = p_tenant_id
           and ci.is_active = true
           and (
             p_category_code is null
             or exists (
               select 1 from public.catalog_categories cc
               where cc.id = ci.category_id and cc.code = p_category_code
             )
           )
       )
    ) as inserted_count,
    (select count(*) from public.store_catalog_items sci
     where sci.store_id = p_store_id
    ) as skipped_count,
    (select count(*) from public.store_catalog_items sci
     where sci.store_id = p_store_id
    ) as total_count;
end;
$$;

revoke all on function public.migrate_catalog_to_store(uuid, uuid, text, uuid) from public;
grant execute on function public.migrate_catalog_to_store(uuid, uuid, text, uuid) to authenticated;
