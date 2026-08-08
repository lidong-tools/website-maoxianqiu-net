-- ============================================================
-- S32-B: 经营报表与驾驶舱(Analytics) — 权限码与角色授权
--
-- 权限设计(见 S32-B 规格 §15):
--   * analytics.view.store  — 查看门店经营报表(当前门店/被授权门店)
--   * analytics.view.tenant — 查看全院经营报表(租户级,汇总全部门店)
--   * analytics.export      — 导出经营报表 CSV(导出必须带 Audit)
--
-- 授权策略:
--   * system_admin / tenant_owner:全部三个权限(全院 + 导出);
--   * store_manager:门店报表 + 导出(仅其被授权门店);
--   * 其他角色(如 cashier/doctor)默认不开放收入等经营数据。
--
-- 硬规则:本 migration 只增权限/授权,不改动任何交易表业务结构。
-- ============================================================

insert into public.permissions (code, name, module) values
  ('analytics.view.store', '查看门店经营报表', 'analytics'),
  ('analytics.view.tenant', '查看全院经营报表', 'analytics'),
  ('analytics.export', '导出经营报表CSV', 'analytics')
on conflict (code) do update set
  name = excluded.name,
  module = excluded.module;

-- 系统管理员 / 租户负责人:全院 + 门店 + 导出
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code in ('system_admin', 'tenant_owner')
  and p.code in ('analytics.view.store', 'analytics.view.tenant', 'analytics.export')
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );

-- 店长:门店报表 + 导出(不含全院汇总)
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
cross join public.permissions p
where r.code = 'store_manager'
  and p.code in ('analytics.view.store', 'analytics.export')
  and not exists (
    select 1 from public.role_permissions rp where rp.role_id = r.id and rp.permission_id = p.id
  );
