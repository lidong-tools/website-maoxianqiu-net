# 实施状态（IMPLEMENTATION_STATUS）

> 版本：v0.4
> 基线 commit：`eb44aa97`
> 本文档跟踪第一阶段（MXQ-0001~0004、1001~1009、2001~2009、3001~3007）实施进度。

## 图例

- ✅ 完成并验证
- 🔶 已完成（依赖本地 Docker 的执行步骤被阻塞，见说明）
- ⏳ 未开始 / 待评审

## 00 基线

| ID | 任务 | 状态 | 说明 |
|---|---|---|---|
| MXQ-0001 | 仓库基线 | ✅ | commit `eb44aa97` 记录；`pnpm install`、`pnpm lint`、`pnpm build` 全通过；路由/API/migration 清单见 `BASELINE_AUDIT.md` |
| MXQ-0002 | 演示与真实功能矩阵 | ✅ | example/真实/fake 分类见 `BASELINE_AUDIT.md` §6 |
| MXQ-0003 | 数据库与 RLS 审计 | ✅ | 表/函数/策略/索引/远程数据见 `BASELINE_AUDIT.md` §5 |
| MXQ-0004 | R2 审计 | ✅ | key/公开性/大小/MIME/删除授权见 `BASELINE_AUDIT.md` §7 |

## 10 UI Foundation

| ID | 任务 | 状态 | 说明 |
|---|---|---|---|
| MXQ-1001 | 移除生产 example 路由 | ✅ | `router/routes.ts` 仅保留系统管理组；`VITE_BUILD_FAKE=false`；example 源码保留参考；同时修复 `system.ts` 缺 view 子路由的渲染 bug |
| MXQ-1002 | 品牌替换 | ✅ | settings 版权/首页标题、Logo/favicon、`VITE_APP_TITLE=毛线球`、移除两个促销插槽、重做首页 |
| MXQ-1003 | StoreSelector | ✅ | `src/components/business/StoreSelector` |
| MXQ-1004 | PermissionButton | ✅ | hide/disable 两种模式 + disabledReason tooltip |
| MXQ-1005 | EntityStatusTag | ✅ | 语义色 CSS 变量 + 状态映射（`src/utils/status.ts`） |
| MXQ-1006 | 标准列表壳 | ✅ | `EntityListShell`（FaPageHeader+状态+分页） |
| MXQ-1007 | 标准详情壳 | ✅ | `EntityDetailShell` |
| MXQ-1008 | Empty/Error/Conflict | ✅ | `EmptyState`/`ErrorState`/`ConflictState` |
| MXQ-1009 | Money/Date formatter | ✅ | `MoneyText`/`DateTimeText`/`src/utils/format.ts` |
| 组件演示页 | 演示/Story | ✅ | 隐藏路由 `/system/component-demo` → `views/dev/component-demo.vue` |

## 20 API Foundation

| ID | 任务 | 状态 | 说明 |
|---|---|---|---|
| MXQ-2001 | Result/Error | ✅ | `api/lib/result.ts`（ok/fail/failError）+ `api/lib/errors.ts`（ApiError + 400/401/403/404/409/422/500 构造器） |
| MXQ-2002 | Request ID | ✅ | `api/middlewares/request-id.ts`，全局中间件，响应头回写 |
| MXQ-2003 | Authorization Bearer | ✅ | `api/middlewares/auth.ts` 统一 Bearer；前端 Axios 发送 `Authorization: Bearer` |
| MXQ-2004 | Zod validation | ✅ | `api/lib/validation.ts`（parseJsonBody + validateJson 中间件），已用于 user/files/upload 路由 |
| MXQ-2005 | tenant/store context | ✅ | `api/lib/request-context.ts` + `AppEnv` 类型化（user/token/roles/memberships/requestId/context/validated） |
| MXQ-2006 | permission helper | ✅ | `api/lib/permission.ts`（loadPermissions + requirePermission） |
| MXQ-2007 | audit helper | ✅ | `api/lib/audit.ts`（writeAudit → audit_logs） |
| MXQ-2008 | idempotency helper | ✅ | `api/lib/idempotency.ts`（findIdempotency/storeIdempotency） |
| MXQ-2009 | Axios 兼容迁移 | ✅ | `apps/maoxianqiu/src/api/index.ts` 兼容新旧格式 + 状态码处理 + requestId 展示 |
| 现有路由迁移 | user/files/upload | ✅ | 迁移到新 Result/Error + Zod；`user/create` 增加补偿删除 |

## 30 Tenant 与 IAM

| ID | 任务 | 状态 | 说明 |
|---|---|---|---|
| MXQ-3001 | tenants migration | ✅ | `20260806000008_tenants.sql`（tenants + stores.tenant_id + 归档字段 + 回填） |
| MXQ-3002 | stores.tenant_id | ✅ | 同上，唯一 `(tenant_id, code)`，回填后 NOT NULL |
| MXQ-3003 | memberships/employees | ✅ | `20260806000009_membership_employee.sql`（tenant_memberships/employees/employee_store_assignments/roles 租户化/权限目录/角色分配/audit_logs/idempotency_records） |
| MXQ-3004 | roles/permissions | ✅ | roles 增加 tenant_id/scope；permissions + role_permissions 目录；seed 补充权限种子 |
| MXQ-3005 | 现有数据迁移 | ✅ | `20260806000011_migrate_store_members.sql`（store_members → 新模型，幂等） |
| MXQ-3006 | RLS helper | ✅ | `20260806000010_rls_helpers.sql`（current_employee_id/is_tenant_member/can_access_store/has_permission + auth_role_codes 兼容新旧）+ `20260806000012_tenant_rls_policies.sql` |
| MXQ-3007 | 跨租户/跨店测试 | 🔶 | `supabase/tests/rls_tenant_store.sql`（两租户三门店 fixture + T1~T6 断言）已编写；**本地 Docker 不可用，未执行**；执行说明见 `supabase/tests/README.md` |

## 验证结果

- `pnpm lint`（tsc + eslint + stylelint）✅ 通过
- `pnpm --filter @fantastic-admin/maoxianqiu build` ✅ 通过
- `npx tsc --noEmit -p api/tsconfig.json` ✅ 通过

## 阻塞项与待决策

1. **本地 Docker 不可用**：`MXQ-3007` RLS 测试无法在本机执行。已产出测试脚本，可在远程库或 CI 执行（远程库为共享环境，需负责人确认）。
2. **迁移未推送到远程库**：migrations 08~12 仅本地编写，尚未 `supabase db push`。远程库 `maoxianqiu-app` 为共享环境，推送 schema 属共享状态变更，需负责人确认后执行。
3. **Node 版本 WARN**：v24.11.1 不满足引擎 `^22.22.2 || ^24.15.0 || >=26.0.0`（仅 WARN，不阻塞）。
