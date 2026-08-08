-- E2E 闭环前置数据:仓库/药品/笼位(供 closed-loop A/B/C 使用)
-- 租户 default: 56bd1065-ed64-4206-a181-2535cc0971e7 ; 门店 SYS: dc950d79-7f0e-4366-bcab-d630519ae249

-- 1. 2 个仓库
insert into public.warehouses (tenant_id, store_id, name, code, is_default, is_active)
values
  ('56bd1065-ed64-4206-a181-2535cc0971e7', 'dc950d79-7f0e-4366-bcab-d630519ae249', '默认仓库', 'WH-DEF', true, true),
  ('56bd1065-ed64-4206-a181-2535cc0971e7', 'dc950d79-7f0e-4366-bcab-d630519ae249', '二级仓库', 'WH-SUB', false, true)
on conflict (tenant_id, store_id, code) do nothing;

-- 2. 顶级类目 + 1 个 drug 商品
insert into public.catalog_categories (tenant_id, code, name, parent_id, sort_order, is_active)
select '56bd1065-ed64-4206-a181-2535cc0971e7', seed.code, seed.name, null, seed.sort_order, true
from (values
  ('service', '服务', 1), ('product', '商品', 2), ('drug', '药品', 3),
  ('vaccine', '疫苗', 4), ('exam', '检验', 5), ('consumable', '耗材', 6)
) as seed(code, name, sort_order)
where not exists (select 1 from public.catalog_categories cc where cc.tenant_id = '56bd1065-ed64-4206-a181-2535cc0971e7' and cc.code = seed.code);

insert into public.catalog_items (tenant_id, category_id, code, name, unit, default_price, is_active, billing_type)
select '56bd1065-ed64-4206-a181-2535cc0971e7', (select id from public.catalog_categories where tenant_id = '56bd1065-ed64-4206-a181-2535cc0971e7' and code = 'drug' limit 1),
       'DRUG-E2E-001', 'E2E测试药品', '片', 10, true, 'drug'
where not exists (select 1 from public.catalog_items where tenant_id = '56bd1065-ed64-4206-a181-2535cc0971e7' and code = 'DRUG-E2E-001');

-- 3. 病房 + 2 个 available 笼位
insert into public.rooms (tenant_id, store_id, name, code, floor, room_type, capacity, is_active)
values ('56bd1065-ed64-4206-a181-2535cc0971e7', 'dc950d79-7f0e-4366-bcab-d630519ae249', 'E2E病房', 'RM-E2E', 1, 'standard', 10, true)
on conflict (tenant_id, store_id, code) do nothing;

insert into public.cages (tenant_id, store_id, room_id, name, code, cage_type, daily_rate, status)
select '56bd1065-ed64-4206-a181-2535cc0971e7', 'dc950d79-7f0e-4366-bcab-d630519ae249', (select id from public.rooms where tenant_id = '56bd1065-ed64-4206-a181-2535cc0971e7' and code = 'RM-E2E' limit 1),
       'E2E笼位A', 'CAGE-E2E-A', 'cage', 100, 'available'
where not exists (select 1 from public.cages where tenant_id = '56bd1065-ed64-4206-a181-2535cc0971e7' and code = 'CAGE-E2E-A');

insert into public.cages (tenant_id, store_id, room_id, name, code, cage_type, daily_rate, status)
select '56bd1065-ed64-4206-a181-2535cc0971e7', 'dc950d79-7f0e-4366-bcab-d630519ae249', (select id from public.rooms where tenant_id = '56bd1065-ed64-4206-a181-2535cc0971e7' and code = 'RM-E2E' limit 1),
       'E2E笼位B', 'CAGE-E2E-B', 'cage', 200, 'available'
where not exists (select 1 from public.cages where tenant_id = '56bd1065-ed64-4206-a181-2535cc0971e7' and code = 'CAGE-E2E-B');
