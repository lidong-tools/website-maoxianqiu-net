-- ============================================================
-- 20260809000057_search_permission.sql
-- P0-29:全局搜索权限码(服务端聚合入口)
-- 搜索范围由调用者 allowedStoreIds 收敛,仅展示有权数据。
-- 应用方式:Supabase SQL Editor 按编号顺序执行(幂等)
-- ============================================================

insert into public.permissions (code, name, module) values
  ('search.global', '全局搜索', 'system')
on conflict (code) do update set
  name = excluded.name,
  module = excluded.module;

-- 授予所有角色(搜索仅展示调用者授权门店的数据,不额外扩大数据边界)
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where p.code = 'search.global'
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );
