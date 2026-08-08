-- E2E 环境重建:store_members + 前置数据(仓库/药品/笼位),全部用 where not exists 幂等
-- 账号 support@maoxianqiu.app 已由 admin API 创建

-- 平台管理员(后端绕过作用域)
insert into platform_user_roles (user_id, role)
select id, 'platform_admin' from auth.users where email = 'support@maoxianqiu.app'
on conflict (user_id, role) do nothing;

-- 系统门店
insert into public.stores (id, tenant_id, name, code, status)
select gen_random_uuid(), t.id, '系统管理门店', 'SYS', 'active'
from public.tenants t
where not exists (select 1 from public.stores where code = 'SYS')
limit 1;

-- store_members(前端 getPermissions 读取,指向 system_admin)
insert into store_members (user_id, store_id, role_id, status)
select u.id, s.id, r.id, 'active'
from auth.users u
cross join public.stores s
join roles r on r.code = 'system_admin' and r.is_system = true
where u.email = 'support@maoxianqiu.app' and s.code = 'SYS'
  and not exists (select 1 from store_members sm where sm.user_id = u.id and sm.store_id = s.id);

-- 仓库(幂等)
insert into public.warehouses (tenant_id, store_id, name, code, is_default, is_active)
select t.id, s.id, '默认仓库', 'WH-DEF', true, true
from tenants t, stores s
where s.code = 'SYS' and t.id = s.tenant_id
  and not exists (select 1 from warehouses w where w.tenant_id = t.id and w.code = 'WH-DEF');
insert into public.warehouses (tenant_id, store_id, name, code, is_default, is_active)
select t.id, s.id, '二级仓库', 'WH-SUB', false, true
from tenants t, stores s
where s.code = 'SYS' and t.id = s.tenant_id
  and not exists (select 1 from warehouses w where w.tenant_id = t.id and w.code = 'WH-SUB');

-- 类目 + drug 商品
insert into public.catalog_categories (tenant_id, code, name, parent_id, sort_order, is_active)
select t.id, seed.code, seed.name, null, seed.sort_order, true
from tenants t cross join (values
  ('service','服务',1),('product','商品',2),('drug','药品',3),
  ('vaccine','疫苗',4),('exam','检验',5),('consumable','耗材',6)
) as seed(code,name,sort_order)
where not exists (select 1 from catalog_categories cc where cc.tenant_id = t.id and cc.code = seed.code);

insert into public.catalog_items (tenant_id, category_id, code, name, unit, default_price, is_active, billing_type)
select t.id, (select id from catalog_categories where tenant_id = t.id and code = 'drug' limit 1),
       'DRUG-E2E-001', 'E2E测试药品', '片', 10, true, 'drug'
from tenants t
where not exists (select 1 from catalog_items where tenant_id = t.id and code = 'DRUG-E2E-001');

-- 病房 + 笼位
insert into public.rooms (tenant_id, store_id, name, code, floor, room_type, capacity, is_active)
select t.id, s.id, 'E2E病房', 'RM-E2E', 1, 'standard', 10, true
from tenants t, stores s
where s.code = 'SYS' and t.id = s.tenant_id
  and not exists (select 1 from rooms rm where rm.tenant_id = t.id and rm.code = 'RM-E2E');

insert into public.cages (tenant_id, store_id, room_id, name, code, cage_type, daily_rate, status)
select t.id, s.id, (select id from rooms where tenant_id = t.id and code = 'RM-E2E' limit 1),
       'E2E笼位A', 'CAGE-E2E-A', 'cage', 100, 'available'
from tenants t, stores s
where s.code = 'SYS' and t.id = s.tenant_id
  and not exists (select 1 from cages cg where cg.tenant_id = t.id and cg.code = 'CAGE-E2E-A');
insert into public.cages (tenant_id, store_id, room_id, name, code, cage_type, daily_rate, status)
select t.id, s.id, (select id from rooms where tenant_id = t.id and code = 'RM-E2E' limit 1),
       'E2E笼位B', 'CAGE-E2E-B', 'cage', 200, 'available'
from tenants t, stores s
where s.code = 'SYS' and t.id = s.tenant_id
  and not exists (select 1 from cages cg where cg.tenant_id = t.id and cg.code = 'CAGE-E2E-B');
