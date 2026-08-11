-- ============================================================
-- 20260811000074_sync_permission_grants.sql
-- 新迁移新增权限码的角色授权同步(与 seed.sql 目录/角色数组一致)
--   - inventory.write_off: 授 system_admin / store_manager(店长库存职责)
--   - lab.result.revise:   授 system_admin / store_manager / doctor(检验结果修订)
-- 同时覆盖新模型 role_permissions 关联表 与 旧模型 roles.permissions 数组
-- 幂等,可重复应用
-- ============================================================

-- 1) 权限目录补齐(双保险;迁移 35/73 已插入,此处 on conflict 跳过)
insert into public.permissions (code, name, module) values
  ('inventory.write_off', '库存报损', 'inventory'),
  ('lab.result.revise', '修订检验结果', 'diagnostics')
on conflict (code) do nothing;

-- 2) 新模型:role_permissions 关联(幂等)
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code in ('system_admin', 'store_manager')
  and p.code = 'inventory.write_off'
on conflict (role_id, permission_id) do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code in ('system_admin', 'store_manager', 'doctor')
  and p.code = 'lab.result.revise'
on conflict (role_id, permission_id) do nothing;

-- 3) 旧模型:roles.permissions 数组追加(幂等,避免重复元素)
update public.roles
set permissions = array_append(coalesce(permissions, array[]::text[]), 'inventory.write_off')
where code in ('system_admin', 'store_manager')
  and not ('inventory.write_off' = any(coalesce(permissions, array[]::text[])));

update public.roles
set permissions = array_append(coalesce(permissions, array[]::text[]), 'lab.result.revise')
where code in ('system_admin', 'store_manager', 'doctor')
  and not ('lab.result.revise' = any(coalesce(permissions, array[]::text[])));
