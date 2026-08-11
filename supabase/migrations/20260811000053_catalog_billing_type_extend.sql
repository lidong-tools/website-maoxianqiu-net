-- ============================================================
-- 20260811000053_catalog_billing_type_extend.sql
-- E-R-2(3.6.2-01) catalog_items.billing_type 扩展 hospitalization/boarding(修复任务清单 R-2, P1)
--
-- 现状:catolog_items.billing_type check 仅 ('service','product','drug','vaccine','exam')
--      (migration 20260806000016_catalog.sql L57-61),PRD §14.1 规划的
--      hospitalization(住院床位费)/boarding(寄养服务费) 专用类型未落地。
-- 修复:drop 旧 check 并重建为含 hospitalization/boarding 的新 check
--      (参照 migration 20260810000070 L12-15 同类 drop+重建写法)。
-- 存量数据不受影响:默认 'service' 仍在新 check 取值内。
-- 幂等,可重复应用。
-- ============================================================

-- 重建 billing_type 校验:在既有五类基础上增加 hospitalization(住院)/boarding(寄养)
alter table public.catalog_items drop constraint if exists catalog_items_billing_type_check;
alter table public.catalog_items
  add constraint catalog_items_billing_type_check
  check (billing_type in ('service', 'product', 'drug', 'vaccine', 'exam', 'hospitalization', 'boarding'));

-- ============================================================
-- 结束
-- ============================================================
