# 04 — PERMISSION REVIEW

> S3.1 权限统一审计(Agent-07)
> 最终权限事实来源:`employee_role_assignments` + `role_permissions` + `platform_user_roles`。

## 1. 新增权限码(服务端 = 前端清单一致)

| 权限 | 来源迁移 | 角色映射 | 前端清单 |
| --- | --- | --- | --- |
| `platform.tenant.list/read/suspend/resume` | 54 | 仅 system_admin | ✅ |
| `points.view` | 56 | 会员相关 | ✅(Integrator 补) |
| `imaging.view/order/perform/report/review/publish` | 60 | 见 AGENT-03 | ✅(Integrator 补) |
| `followup.view/manage/complete` | 63 | system_admin/store_manager 全量;doctor/nurse view+complete;cashier view | ✅(Integrator 补) |
| `supplier.view/manage` | 65 | system_admin/store_manager | ✅(Integrator 补) |
| `purchase.view/create/submit/approve/receive/post` | 66 | system_admin/store_manager | ✅(Integrator 补) |
| `boarding.view/manage/care/checkout` | 70 | system_admin/tenant_owner/store_manager 全量;nurse view+care;doctor view;cashier view+checkout | ✅(Integrator 补) |

## 2. 修复项

- `apps/maoxianqiu/src/views/system/permissions.ts` 静态清单缺 6 组权限码(服务端已存在、前端角色配置 UI 不显示)→ 已补齐。服务端与前端两端一致。

## 3. 服务端校验

- 所有新模块 Command 均走 `requireScopedPermission(code, tenantId, storeId?)`,按目标租户+门店解析作用域,平台管理员由 `platform_user_roles` 独立放行。
- 新 RPC 全部 service-role-only(manifest 116 个,`check:rpc-manifest` PASS)。
- 平台租户管理接口仅 `platform_admin`(system_admin 权限模板)可访问。

## 4. 遗留

- `tenant_owner`/`nurse` 角色在 `seed.sql` 的 `roles.permissions` 数组仍有缺口(依赖 role_permissions 关联表兜底;已知缺口,见 KNOWN_GAPS)。
- 多角色授权矩阵(store_manager/doctor/nurse/cashier)未逐角色 staging 实测。
