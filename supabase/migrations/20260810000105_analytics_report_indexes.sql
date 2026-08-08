-- ============================================================
-- S32-B: 经营报表与驾驶舱(Analytics) — 只读聚合所需索引
--
-- 原则(S32-B 规格 §12):
--   * 第一版优先 SQL 聚合 + 合适 Index,不引入 OLAP 引擎;
--   * 仅当 Explain/运行时明确慢才加 Materialized View;
--   * 本 migration 只新增只读查询索引,不改动任何交易表业务结构。
--
-- 说明: 每张业务表原有的 (tenant_id, store_id) 索引已存在,
--        这里只补充"时间切片"维度,支撑按日/月聚合的经营报表查询。
-- ============================================================

-- 就诊(接诊数/完成病历):按门店 + 开始时间切片
create index if not exists idx_analytics_encounters_store_started
  on public.encounters (tenant_id, store_id, started_at);

-- 客户(新增客户):按门店 + 建档时间切片
create index if not exists idx_analytics_customers_store_created
  on public.customers (tenant_id, store_id, created_at);

-- 检验单量:按门店 + 申请时间切片
create index if not exists idx_analytics_lab_orders_store_requested
  on public.lab_orders (tenant_id, store_id, requested_at);

-- 影像单量:按门店 + 创建时间切片
create index if not exists idx_analytics_imaging_store_created
  on public.imaging_orders (tenant_id, store_id, created_at);

-- 住院量:按门店 + 入住时间切片
create index if not exists idx_analytics_boarding_store_checkin
  on public.boarding_stays (tenant_id, store_id, check_in_at);

-- 采购金额:按门店 + 创建时间切片
create index if not exists idx_analytics_po_store_created
  on public.purchase_orders (tenant_id, store_id, created_at);

-- 库存异动/报损:按仓库 + 时间切片(inventory_movements 无 tenant_id,经 warehouses 收敛门店)
create index if not exists idx_analytics_movements_warehouse_created
  on public.inventory_movements (warehouse_id, created_at);
