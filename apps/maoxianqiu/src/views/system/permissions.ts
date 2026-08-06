// 权限码与前端 views 的 meta.auth 对应;角色配置勾选基于此清单
export const PERMISSIONS = [
  { code: 'system:user:manage', label: '用户管理' },
  { code: 'system:role:manage', label: '角色管理' },
  { code: 'system:store:manage', label: '店铺管理' },
  { code: 'store:view', label: '查看店铺' },
  { code: 'pages.general:browse', label: '通用页面' },
  { code: 'pages.form:browse', label: '表单页面' },
  { code: 'pages.list:browse', label: '列表页面' },
  { code: 'pages.shop:browse', label: '商城页面' },
] as const
