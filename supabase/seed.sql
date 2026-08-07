-- ============================================================
-- supabase/seed.sql(在 db reset 后自动执行;幂等,可重复运行)
-- 内置角色 + 演示数据
-- 权限码与前端 views 的 meta.auth 对应;角色可配置,可在此追加
-- ============================================================

-- 内置角色:运维管理员 / 店长 / 店员 / 收银员 / 医生
-- scope 语义(S30-R01):system=平台级;tenant=租户级(须租户级分配 store_id IS NULL);
-- store=门店级(须带 store_id 分配,禁止提升为租户级权限)
insert into public.roles (code, name, description, permissions, is_system, scope) values
  ('system_admin', '运维管理员', '平台运维方,管理所有店铺/角色/用户', array[
    'system:user:manage',
    'system:role:manage',
    'system:store:manage',
    'system.user.create',
    'system.user.resetPassword',
    'store:view',
    'store.create',
    'store.update',
    'tenant.membership.create',
    'tenant.membership.update',
    'employee.create',
    'employee.update',
    'employee.assignStore',
    'employee.changeRole',
    'role.create',
    'role.update',
    -- S31-PARALLEL-B:日结与对账权限(与 migration 39/41 保持一致)
    'daily_closing.read',
    'daily_closing.close',
    'daily_closing.adjust',
    'reconciliation.read',
    'reconciliation.edit',
    'reconciliation.confirm'
  ], true, 'system'),
  ('store_manager', '店长', '管理本店成员与日常运营', array[
    'system:user:manage',
    'system.user.create',
    'store:view',
    'employee.create',
    'employee.update',
    'employee.assignStore',
    'employee.changeRole',
    -- S31-PARALLEL-B:日结(读+关账,不含调整)/对账全量(与 migration 39/41 保持一致)
    'daily_closing.read',
    'daily_closing.close',
    'reconciliation.read',
    'reconciliation.edit',
    'reconciliation.confirm'
  ], true, 'store'),
  ('staff', '店员', '门店工作人员', array[
    'store:view'
  ], true, 'store'),
  ('cashier', '收银员', '负责收银', array[
    'store:view',
    -- S31-PARALLEL-B:日结/对账只读(与 migration 39/41 保持一致)
    'daily_closing.read',
    'reconciliation.read'
  ], true, 'store'),
  ('doctor', '医生', '诊疗/处方/检验报告(门店级角色)', array[
    'store:view'
  ], true, 'store'),
  -- FINAL-01(第三轮审计):租户级默认角色 tenant_owner(scope=tenant,store_id IS NULL 分配)
  -- 真实医院租户自管执业兽医备案等 tenant-level 数据;与 migration 28 幂等一致。
  -- S31-MERGE-A(A01):补齐监管运营权限,与 migration 33 保持一致(db reset 后 seed 最后执行,数组需同步)。
  ('tenant_owner', '租户所有者', '租户级管理角色,可维护本租户执业兽医备案及监管运营数据', array[
    'veterinarian_registration.read',
    'veterinarian_registration.manage',
    'license.read',
    'license.manage',
    'regulatory_report.read',
    'regulatory_report.generate',
    'regulatory_report.submit',
    'epidemic.read',
    'epidemic.report',
    'epidemic.resolve',
    'waste.read',
    'waste.manage',
    -- S31-PARALLEL-B:日结与对账全量(与 migration 39/41 保持一致)
    'daily_closing.read',
    'daily_closing.close',
    'daily_closing.adjust',
    'reconciliation.read',
    'reconciliation.edit',
    'reconciliation.confirm'
  ], true, 'tenant')
on conflict (code) do update set
  name = excluded.name,
  description = excluded.description,
  permissions = excluded.permissions,
  is_system = excluded.is_system,
  scope = excluded.scope;

-- 权限目录种子(MXQ-3004;code 唯一,幂等)
insert into public.permissions (code, name, module) values
  ('system:user:manage', '用户管理', 'system'),
  ('system:role:manage', '角色管理', 'system'),
  ('system:store:manage', '店铺管理', 'system'),
  ('system.user.create', '创建用户', 'system'),
  ('system.user.resetPassword', '重置用户密码', 'system'),
  ('store:view', '查看门店', 'store'),
  ('store.create', '创建门店', 'store'),
  ('store.update', '编辑门店', 'store'),
  ('tenant.membership.create', '添加租户成员', 'tenant'),
  ('tenant.membership.update', '更新租户成员', 'tenant'),
  ('employee.create', '创建员工', 'employee'),
  ('employee.update', '编辑员工', 'employee'),
  ('employee.assignStore', '分配门店', 'employee'),
  ('employee.changeRole', '变更角色', 'employee'),
  ('role.create', '创建角色', 'role'),
  ('role.update', '编辑角色', 'role'),
  -- S3.1-A:租户初始化权限
  ('tenant.initialize', '初始化租户', 'tenant'),
  ('tenant.initialization.read', '查看租户初始化状态', 'tenant'),
  ('payment_context.read', '查看支付上下文', 'billing'),
  ('print.setting.read', '查看打印设置', 'operations'),
  -- S31-PARALLEL-B:日结与对账权限码(与 migration 39/41 保持一致)
  ('daily_closing.read', '查看日结', 'closing'),
  ('daily_closing.close', '执行日结', 'closing'),
  ('daily_closing.adjust', '调整日结', 'closing'),
  ('reconciliation.read', '查看对账', 'closing'),
  ('reconciliation.edit', '录入对账实际金额', 'closing'),
  ('reconciliation.confirm', '确认对账差异', 'closing')
on conflict (code) do update set
  name = excluded.name,
  module = excluded.module;

-- 演示数据(可选):给指定账号设置演示权限(把邮箱换成你的登录账号)
update public.profiles
set permissions = array[
  'pages.general:browse',
  'pages.form:browse',
  'pages.list:browse',
  'pages.shop:browse'
]
where account = 'admin@example.com';

-- standard_module 示例数据(幂等)
insert into public.standard_module (title)
select v.title
from (values
  ('示例标题一'),
  ('示例标题二'),
  ('示例标题三')
) as v(title)
where not exists (
  select 1 from public.standard_module
  where title = v.title
);
