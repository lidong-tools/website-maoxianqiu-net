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
    'role.update'
  ], true, 'system'),
  ('store_manager', '店长', '管理本店成员与日常运营', array[
    'system:user:manage',
    'system.user.create',
    'store:view',
    'employee.create',
    'employee.update',
    'employee.assignStore',
    'employee.changeRole'
  ], true, 'store'),
  ('staff', '店员', '门店工作人员', array[
    'store:view'
  ], true, 'store'),
  ('cashier', '收银员', '负责收银', array[
    'store:view'
  ], true, 'store'),
  ('doctor', '医生', '诊疗/处方/检验报告(门店级角色)', array[
    'store:view'
  ], true, 'store')
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
  ('role.update', '编辑角色', 'role')
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
