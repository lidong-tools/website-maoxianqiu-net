-- ============================================================
-- supabase/seed.sql(在 db reset 后自动执行;幂等,可重复运行)
-- 内置角色 + 演示数据
-- 权限码与前端 views 的 meta.auth 对应;角色可配置,可在此追加
-- ============================================================

-- 内置角色:运维管理员 / 店长 / 店员 / 收银员
insert into public.roles (code, name, description, permissions, is_system) values
  ('system_admin', '运维管理员', '平台运维方,管理所有店铺/角色/用户', array[
    'system:user:manage',
    'system:role:manage',
    'system:store:manage',
    'store:view'
  ], true),
  ('store_manager', '店长', '管理本店成员与日常运营', array[
    'system:user:manage',
    'store:view'
  ], true),
  ('staff', '店员', '门店工作人员', array[
    'store:view'
  ], true),
  ('cashier', '收银员', '负责收银', array[
    'store:view'
  ], true)
on conflict (code) do update set
  name = excluded.name,
  description = excluded.description,
  permissions = excluded.permissions,
  is_system = excluded.is_system;

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
