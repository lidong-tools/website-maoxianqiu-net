#!/usr/bin/env bash
# E2E 环境重建脚本:重置 staging 库 → 重建 E2E 账号 → 补前置数据(仓库/药品/笼位)
# 用法: bash scripts/e2e-setup.sh
set -e
cd "$(dirname "$0")/.."

echo "=== 1. 重置 staging 库(migration + seed) ==="
supabase db reset --linked --yes

echo "=== 2. 重建 E2E 账号 support@maoxianqiu.app ==="
SR=$(grep -oE "SUPABASE_SERVICE_ROLE_KEY=.*" api/.env.local | cut -d= -f2- | tr -d ' "')
PROJ_URL=$(grep -oE "SUPABASE_URL=.*" api/.env.local | cut -d= -f2- | tr -d ' "')
AUTH_URL="${PROJ_URL%/}/auth/v1"

# 2a. admin API 创建(GoTrue 兼容哈希 + 确认邮箱)
curl -s -X POST "$AUTH_URL/admin/users" \
  -H "apikey: $SR" -H "Authorization: Bearer $SR" -H "Content-Type: application/json" \
  -d '{"email":"support@maoxianqiu.app","password":"Support@20001223","email_confirm":true}' \
  | python -c "import sys,json; d=json.load(sys.stdin); print('user id:', d.get('id','(exists)'))" || true

# 2b. 用 admin API 列表确认存在
USER_ID=$(curl -s "$AUTH_URL/admin/users?email=support@maoxianqiu.app" -H "apikey: $SR" -H "Authorization: Bearer $SR" \
  | python -c "import sys,json; d=json.load(sys.stdin); u=d.get('users',[]); print(u[0]['id'] if u else '')")
echo "user id: $USER_ID"

# 3. 补 SQL 数据(store_members 供前端权限 + 仓库/药品/笼位)
cat > /tmp/e2e-setup.sql <<SQL
-- 平台管理员(后端绕过作用域)
insert into platform_user_roles (user_id, role)
select id, 'platform_admin' from auth.users where email = 'support@maoxianqiu.app'
on conflict (user_id, role) do nothing;

-- 系统门店(store_members 需要 store_id)
insert into public.stores (id, tenant_id, name, code, status)
select gen_random_uuid(), t.id, '系统管理门店', 'SYS', 'active'
from public.tenants t limit 1
on conflict (code) do nothing;

-- store_members(前端 getPermissions 读取,指向 system_admin)
insert into store_members (user_id, store_id, role_id, status)
select u.id, s.id, r.id, 'active'
from auth.users u
cross join public.stores s
join roles r on r.code = 'system_admin' and r.is_system = true
where u.email = 'support@maoxianqiu.app' and s.code = 'SYS'
on conflict (user_id, store_id) do update set role_id = excluded.role_id, status = 'active';

-- 租户员工权限(新模型 me-context/RLS 的唯一事实来源,db reset 后必须重建,否则 E2E 账号退化为纯平台模式)
-- 1. tenant_memberships:账号归属租户
insert into tenant_memberships (tenant_id, user_id, status)
select t.id, u.id, 'active'
from auth.users u, tenants t
where u.email = 'support@maoxianqiu.app' and t.id = (select id from tenants limit 1)
on conflict (tenant_id, user_id) do update set status = 'active';

-- 2. employees:员工档案(employee_no 租户内唯一)
insert into employees (tenant_id, user_id, employee_no, name, status)
select t.id, u.id, 'E2E-ADMIN', 'E2E管理员', 'active'
from auth.users u, tenants t
where u.email = 'support@maoxianqiu.app' and t.id = (select id from tenants limit 1)
on conflict (tenant_id, user_id) do nothing;

-- 3. employee_role_assignments:租户级角色(tenant_owner,store_id 为空 → tenant-wide)
insert into employee_role_assignments (tenant_id, employee_id, role_id, store_id)
select e.tenant_id, e.id, r.id, null
from employees e
join roles r on r.code = 'tenant_owner' and r.is_system = true
where e.employee_no = 'E2E-ADMIN'
on conflict (tenant_id, employee_id, role_id, store_id) do nothing;

-- 4. employee_store_assignments:主门店(指向系统门店 SYS)
insert into employee_store_assignments (tenant_id, employee_id, store_id, is_primary)
select e.tenant_id, e.id, s.id, true
from employees e
cross join stores s
where e.employee_no = 'E2E-ADMIN' and s.code = 'SYS'
on conflict (tenant_id, employee_id, store_id) do update set is_primary = true;

-- 仓库/药品/笼位(closed-loop B/C 前置)
insert into public.warehouses (tenant_id, store_id, name, code, is_default, is_active)
select t.id, s.id, '默认仓库', 'WH-DEF', true, true
from tenants t, stores s where s.code = 'SYS' and t.id = s.tenant_id
on conflict (tenant_id, store_id, code) do nothing;
insert into public.warehouses (tenant_id, store_id, name, code, is_default, is_active)
select t.id, s.id, '二级仓库', 'WH-SUB', false, true
from tenants t, stores s where s.code = 'SYS' and t.id = s.tenant_id
on conflict (tenant_id, store_id, code) do nothing;

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

insert into public.rooms (tenant_id, store_id, name, code, floor, room_type, capacity, is_active)
select t.id, s.id, 'E2E病房', 'RM-E2E', 1, 'standard', 10, true
from tenants t, stores s where s.code = 'SYS' and t.id = s.tenant_id
on conflict (tenant_id, store_id, code) do nothing;

insert into public.cages (tenant_id, store_id, room_id, name, code, cage_type, daily_rate, status)
select t.id, s.id, (select id from rooms where tenant_id = t.id and code = 'RM-E2E' limit 1),
       'E2E笼位A', 'CAGE-E2E-A', 'cage', 100, 'available'
from tenants t, stores s where s.code = 'SYS' and t.id = s.tenant_id
where not exists (select 1 from cages where tenant_id = t.id and code = 'CAGE-E2E-A');
insert into public.cages (tenant_id, store_id, room_id, name, code, cage_type, daily_rate, status)
select t.id, s.id, (select id from rooms where tenant_id = t.id and code = 'RM-E2E' limit 1),
       'E2E笼位B', 'CAGE-E2E-B', 'cage', 200, 'available'
from tenants t, stores s where s.code = 'SYS' and t.id = s.tenant_id
where not exists (select 1 from cages where tenant_id = t.id and code = 'CAGE-E2E-B');
SQL

PGPASSWORD=maoxianqiu-app psql "postgresql://postgres@db.bxhvtbhwuktrpxxygikj.supabase.co:5432/postgres" -f /tmp/e2e-setup.sql 2>&1 | tail -5 || {
  echo "psql 不可用,尝试 node 执行..."
  NODE_PATH=$(node -e "console.log(require('child_process').execSync('npm root -g').toString().trim())") node -e "
    const { Client } = require('pg')
    const fs = require('fs')
    ;(async () => {
      const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
      await c.connect()
      await c.query(fs.readFileSync('/tmp/e2e-setup.sql', 'utf-8'))
      console.log('setup SQL applied')
      await c.end()
    })()"
}

echo "=== E2E 环境重建完成 ==="
