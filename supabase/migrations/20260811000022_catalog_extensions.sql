-- ============================================================
-- 20260811000022_catalog_extensions.sql
-- Catalog 领域扩展字段补齐(幂等,可重复应用)
--   1. catalog_items:     barcode/manufacturer(B-R-6)、pinyin/pinyin_short(D-R-4)、
--                        billing_type check 扩展 hospitalization/boarding(E-R-2)
--   2. catalog_drug_extensions:    批准文号/通用名成分/用药单位/库存单位/换算率/是否处方药(B-R-4)
--   3. catalog_vaccine_extensions: 推荐物种/推荐年龄/接种禁忌/提醒规则(B-R-9)
--   4. lab_panels:        catalog_item_id 关联收费项(B-R-5)
--   5. lab_analytes:      report_template/is_outsourced(G-R-4)
-- ============================================================

-- ===== 1. catalog_items 通用条码/厂商 + 拼音检索字段(B-R-6 / D-R-4) =====
do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'catalog_items' and column_name = 'barcode') then
    alter table public.catalog_items add column barcode text;
    comment on column public.catalog_items.barcode is '通用条码(商品/服务均可维护,收银台可扫码检索)';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'catalog_items' and column_name = 'manufacturer') then
    alter table public.catalog_items add column manufacturer text;
    comment on column public.catalog_items.manufacturer is '通用厂商(商品/服务均可维护)';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'catalog_items' and column_name = 'pinyin') then
    alter table public.catalog_items add column pinyin text;
    comment on column public.catalog_items.pinyin is '名称全拼(拼音码检索,回填由后续迭代负责)';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'catalog_items' and column_name = 'pinyin_short') then
    alter table public.catalog_items add column pinyin_short text;
    comment on column public.catalog_items.pinyin_short is '名称拼音首字母(拼音码检索,回填由后续迭代负责)';
  end if;
end
$$;

create index if not exists idx_catalog_items_barcode on public.catalog_items (barcode);
create index if not exists idx_catalog_items_pinyin on public.catalog_items (pinyin);
create index if not exists idx_catalog_items_pinyin_short on public.catalog_items (pinyin_short);

-- ===== 2. catalog_items.billing_type check 扩展 hospitalization/boarding(E-R-2) =====
-- drop + 重建 check 约束,存量 service/product/drug/vaccine/exam 全部仍然合法
alter table public.catalog_items drop constraint if exists catalog_items_billing_type_check;
alter table public.catalog_items
  add constraint catalog_items_billing_type_check
  check (billing_type in ('service', 'product', 'drug', 'vaccine', 'exam', 'hospitalization', 'boarding'));

-- ===== 3. catalog_drug_extensions 药品扩展字段(B-R-4) =====
do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'catalog_drug_extensions' and column_name = 'approval_number') then
    alter table public.catalog_drug_extensions add column approval_number text;
    comment on column public.catalog_drug_extensions.approval_number is '批准文号(国药准字等)';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'catalog_drug_extensions' and column_name = 'generic_name') then
    alter table public.catalog_drug_extensions add column generic_name text;
    comment on column public.catalog_drug_extensions.generic_name is '通用名/成分';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'catalog_drug_extensions' and column_name = 'dosage_unit') then
    alter table public.catalog_drug_extensions add column dosage_unit text;
    comment on column public.catalog_drug_extensions.dosage_unit is '用药单位(如 mg/ml/粒)';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'catalog_drug_extensions' and column_name = 'stock_unit') then
    alter table public.catalog_drug_extensions add column stock_unit text;
    comment on column public.catalog_drug_extensions.stock_unit is '库存单位(如 盒/瓶/支)';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'catalog_drug_extensions' and column_name = 'conversion_rate') then
    alter table public.catalog_drug_extensions add column conversion_rate numeric(12,4);
    comment on column public.catalog_drug_extensions.conversion_rate is '换算率(用药单位 与 库存单位 换算,如 1 盒=10 粒)';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'catalog_drug_extensions' and column_name = 'is_rx') then
    alter table public.catalog_drug_extensions add column is_rx boolean not null default false;
    comment on column public.catalog_drug_extensions.is_rx is '是否处方药';
  end if;
end
$$;

-- ===== 4. catalog_vaccine_extensions 疫苗扩展字段(B-R-9) =====
do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'catalog_vaccine_extensions' and column_name = 'recommended_species') then
    alter table public.catalog_vaccine_extensions add column recommended_species text;
    comment on column public.catalog_vaccine_extensions.recommended_species is '推荐物种(犬/猫/其他)';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'catalog_vaccine_extensions' and column_name = 'recommended_age') then
    alter table public.catalog_vaccine_extensions add column recommended_age text;
    comment on column public.catalog_vaccine_extensions.recommended_age is '推荐年龄(如 8周龄以上)';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'catalog_vaccine_extensions' and column_name = 'contraindications') then
    alter table public.catalog_vaccine_extensions add column contraindications text;
    comment on column public.catalog_vaccine_extensions.contraindications is '接种禁忌';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'catalog_vaccine_extensions' and column_name = 'reminder_rules') then
    alter table public.catalog_vaccine_extensions add column reminder_rules text;
    comment on column public.catalog_vaccine_extensions.reminder_rules is '提醒规则(如 每年加强一针)';
  end if;
end
$$;

-- ===== 5. lab_panels 关联收费项 catalog_item_id(B-R-5) =====
-- 跨表引用用 uuid 不加 FK(与 20260806000022_diagnostics.sql 约定一致),加索引
do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'lab_panels' and column_name = 'catalog_item_id') then
    alter table public.lab_panels add column catalog_item_id uuid;
    comment on column public.lab_panels.catalog_item_id is '关联收费目录项(billing_type=exam),panel 组合的收费入口';
  end if;
end
$$;

create index if not exists idx_lab_panels_catalog_item on public.lab_panels (catalog_item_id);

-- 存量数据清洗:将 billing_type='exam' 且名称与 panel 名称一致的目录项关联到对应 panel
-- (尽力而为,名称不一致的 panel 保持 catalog_item_id 为空,后续可在 UI 手动关联)
update public.lab_panels lp
set catalog_item_id = ci.id
from public.catalog_items ci
where lp.catalog_item_id is null
  and ci.tenant_id = lp.tenant_id
  and ci.billing_type = 'exam'
  and lower(ci.name) = lower(lp.name)
  and not exists (
    select 1 from public.lab_panels lp2
    where lp2.catalog_item_id = ci.id
  );

-- ===== 6. lab_analytes 化验项目扩展字段(G-R-4) =====
do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'lab_analytes' and column_name = 'report_template') then
    alter table public.lab_analytes add column report_template text;
    comment on column public.lab_analytes.report_template is '报告模板(报告展示时的文本模板)';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'lab_analytes' and column_name = 'is_outsourced') then
    alter table public.lab_analytes add column is_outsourced boolean not null default false;
    comment on column public.lab_analytes.is_outsourced is '是否外送检测';
  end if;
end
$$;
