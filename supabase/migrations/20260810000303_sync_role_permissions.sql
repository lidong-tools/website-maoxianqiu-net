-- ============================================================
-- 20260810000303_sync_role_permissions.sql
-- 幂等补齐 20260810000300 的岗位权限缺口
--
-- 背景:
--   20260810000300_clinical_patient_journey.sql 通过旧模型
--   (roles.permissions 数组)给 doctor/nurse/cashier/store_manager/tenant_owner
--   补充了岗位权限,但存在两个缺口:
--     1) 未同步新模型 role_permissions 关联表;
--     2) 对"migration 未完整应用"的存量环境(生产/预发)缺少重放保障,
--        导致已拥有 doctor 角色的用户执行叫号/接诊时返回
--        FORBIDDEN「缺少权限: queue.call」。
--
-- 权限收集逻辑 collectRolePermissions 为两个模型并集,
-- 本文件两侧补齐后,无论环境以哪个模型为主数据源均可放行。
--
-- 全部幂等,可重复应用。
-- ============================================================

-- 1) 旧模型:roles.permissions 数组幂等合并(与 20260810000300 一致)
update public.roles set permissions = array(select distinct unnest(permissions || array[
  'workbench.doctor','queue.view','queue.call','triage.view','workflow_task.view','encounter.close'
])) where code = 'doctor';
update public.roles set permissions = array(select distinct unnest(permissions || array[
  'workbench.nurse','queue.view','triage.view','workflow_task.view','workflow_task.execute'
])) where code = 'nurse';
update public.roles set permissions = array(select distinct unnest(permissions || array[
  'workbench.cashier','workflow_task.view','workflow_task.execute','charge_item.void'
])) where code = 'cashier';
update public.roles set permissions = array(select distinct unnest(permissions || array[
  'workbench.manager','queue.view','queue.manage','workflow_task.view','workflow_task.transfer',
  'clinical.payment_override','journey.audit','encounter.close'
])) where code in ('store_manager', 'tenant_owner');

-- 2) 新模型:role_permissions 关联表按"角色 × 权限码"幂等补齐
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join (values
  ('doctor',       array['workbench.doctor','queue.view','queue.call','triage.view','workflow_task.view','encounter.close']),
  ('nurse',        array['workbench.nurse','queue.view','triage.view','workflow_task.view','workflow_task.execute']),
  ('cashier',      array['workbench.cashier','workflow_task.view','workflow_task.execute','charge_item.void']),
  ('store_manager', array['workbench.manager','queue.view','queue.manage','workflow_task.view','workflow_task.transfer','clinical.payment_override','journey.audit','encounter.close']),
  ('tenant_owner', array['workbench.manager','queue.view','queue.manage','workflow_task.view','workflow_task.transfer','clinical.payment_override','journey.audit','encounter.close'])
) as v(code, codes) on v.code = r.code
cross join lateral unnest(v.codes) as u(perm_code)
join public.permissions p on p.code = u.perm_code
on conflict (role_id, permission_id) do nothing;
