-- ============================================================
-- S32-A: Import Center V2 权限种子
-- 20260810000101
-- ============================================================
-- 背景:
--   既有导入走 imports.manage 单一权限码。V2 拆分为更细的权限:
--     imports.view   查看导入任务/结果/错误明细
--     imports.create 新建导入/上传/字段映射
--     imports.execute 校验/执行导入(真正写业务数据)
--     imports.cancel 取消导入
--   保留 imports.manage 兼容既有 /operations/imports 端点。
-- 授予角色:system_admin / tenant_owner / store_manager。
-- 幂等:on conflict + not exists + roles.permissions 数组去重追加。
-- ============================================================

set search_path = public;

insert into public.permissions (code, name, module) values
  ('imports.view', '查看导入任务', 'imports'),
  ('imports.create', '新建导入', 'imports'),
  ('imports.execute', '执行导入', 'imports'),
  ('imports.cancel', '取消导入', 'imports'),
  ('imports.manage', '管理导入任务', 'imports')
on conflict (code) do update set
  name = excluded.name,
  module = excluded.module;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code in ('system_admin', 'tenant_owner', 'store_manager')
  and p.code in ('imports.view', 'imports.create', 'imports.execute', 'imports.cancel', 'imports.manage')
  and not exists (
    select 1 from public.role_permissions rp
    where rp.role_id = r.id and rp.permission_id = p.id
  );

update public.roles
set permissions = array(
  select distinct unnest(permissions || array['imports.view', 'imports.create', 'imports.execute', 'imports.cancel', 'imports.manage'])
)
where code = 'system_admin' and is_system = true;
