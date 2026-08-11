-- ============================================================
-- 20260811000036_inventory_low_stock_threshold.sql
-- 库存域修复 R-14(库存预警/低库存阈值)
--   - catalog_items 增加 low_stock_threshold 字段(租户级默认阈值,幂等)
--   - store_catalog_items 增加 low_stock_threshold 字段(门店级覆盖,幂等,允许为 NULL 回落租户级)
--   - 分析口径:可用 ≤ 阈值 即低库存;未配置阈值回落 ≤0 缺货口径
-- 幂等,可重复应用
-- ============================================================

-- ===== 1. catalog_items 增加低库存阈值(租户级) =====
alter table public.catalog_items
  add column if not exists low_stock_threshold numeric(12,2) not null default 0;

-- ===== 2. store_catalog_items 增加低库存阈值(门店级覆盖,可空) =====
alter table public.store_catalog_items
  add column if not exists low_stock_threshold numeric(12,2);

-- ===== 3. 注释说明(便于后续维护) =====
comment on column public.catalog_items.low_stock_threshold is
  '低库存预警阈值:可用数量 ≤ 该值即视为低库存;0 表示按缺货口径(可用 ≤ 0)预警';
comment on column public.store_catalog_items.low_stock_threshold is
  '门店级低库存预警阈值覆盖;NULL 时回落 catalog_items.low_stock_threshold';
