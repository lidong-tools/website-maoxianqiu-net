> Agent-01 HANDOFF — IAM / Context + 平台租户管理
> 环境说明:所有 Agent 共用同一工作目录与 `main` 分支,本 HANDOFF 按此记录。

# Agent-01 Handoff

## 1. 基础信息

- Base Commit: `d32e862a update`(HEAD)
- 分支:共享 `main` 工作树(未建独立分支,与其他 Agent 同一目录)
- 模块:IAM / Tenant-Store Context 收口 + 平台租户管理 + 门店详情
- 状态:开发完成;FE/api typecheck 对本 Agent 文件全部通过

## 2. 修改文件

| 文件 | 改动 |
|---|---|
| `api/lib/me-context.ts` | (本批既有)唯一事实来源 `resolveMeContext`;新增:租户分支排除已停用租户(activeTenantIds 过滤) |
| `api/routes/me.ts` | (本批既有)`GET /me/context` |
| `api/lib/permission.ts` | `resolveScopedAccess` 非平台分支新增租户停用拦截(status='suspended' → 403),停用后所有业务 Command 无法继续 |
| `api/routes/tenants.ts` | 新增平台租户管理:列表/概览/门店/人员 + `POST /:id/suspend`、`POST /:id/resume`(带原因 + 审计) |
| `api/routes/stores.ts` | 新增 `GET /:id`(门店详情概览,含租户名)、`GET /:id/employees`(门店人员+角色码) |
| `api/lib/service-rpc-manifest.ts` | 登记 `suspend_tenant` / `resume_tenant`(S30-F02) |
| `apps/maoxianqiu/src/api/modules/tenant.ts` | 新增 listPlatform / platformOverview / platformStores / platformEmployees / suspend / resume |
| `apps/maoxianqiu/src/api/modules/store.ts` | 新增 detail / employees |
| `apps/maoxianqiu/src/views/system/tenants/index.vue` | 新增平台租户列表页(搜索/状态/试用筛选;查看/停用/恢复) |
| `apps/maoxianqiu/src/views/system/tenants/detail.vue` | 新增租户详情页(概览/门店/人员 Tabs + 停用/恢复) |
| `apps/maoxianqiu/src/views/system/store/detail.vue` | 新增门店详情页(概览/人员) |
| `apps/maoxianqiu/src/views/system/store/index.vue` | 操作列新增「查看」入口跳门店详情 |
| `apps/maoxianqiu/src/router/modules/system.ts` | 新增 `/system/tenants`、`/system/tenants/:id`、`/system/store/:id` 路由 |
| `apps/maoxianqiu/src/views/system/permissions.ts` | 追加 platform.tenant.* 权限码清单 |

未动:密码找回(`/auth/reset-password` 已是 anonymous 常驻路由,只接受 PASSWORD_RECOVERY,已完成);门店切换刷新契约(`useStoreScopedPage` 已存在,本批未重复造)。

## 3. Migration(Agent-01 预留 54–55,本批用 1 个)

| Migration | 内容 |
|---|---|
| `20260810000054_platform_tenant_mgmt.sql` | ① `platform.tenant.list/read/suspend/resume` 权限码 + 授予 `system_admin`;② `suspend_tenant` / `resume_tenant` RPC(行锁状态转换);③ RLS helper(`is_tenant_member`/`can_access_store`/`has_permission`)对已停用租户返回 false |

## 4. 新增权限

```text
platform.tenant.list / platform.tenant.read
platform.tenant.suspend / platform.tenant.resume
```
映射:仅 `system_admin`(平台管理员,唯一来源 `platform_user_roles`)。普通租户角色无这些码,调用即被 `resolveScopedAccess` 拒。

## 5. 新增 API(均 Hono Command + service role)

```http
GET  /api/tenants                      # 平台租户列表(含门店/员工计数、试用信息,含已停用)
GET  /api/tenants/:id/overview         # 租户概览(详情页)
GET  /api/tenants/:id/stores           # 租户下门店
GET  /api/tenants/:id/employees        # 租户下人员(含角色码/归属门店)
POST /api/tenants/:id/suspend          # { reason } → suspend_tenant RPC + audit
POST /api/tenants/:id/resume           # { reason } → resume_tenant RPC + audit
GET  /api/stores/:id                   # 门店详情(含 tenant 名)
GET  /api/stores/:id/employees         # 门店人员(含角色码/isPrimary)
```

## 6. 跨域 Hook / 注意事项

1. **停用拦截是全局的**:`resolveScopedAccess`(permission.ts)是全部 Command 的授权咽喉。本批新增非平台分支的 `tenants.status='suspended'` 拦截 → **Agent-02~06 的业务 Command 在租户停用后自动全部拒绝**,无需各自改动。平台管理员分支提前放行,不影响停用/恢复管理动作。
2. **RLS 侧兜底**:`is_tenant_member`/`can_access_store`/`has_permission` 加了 `status='active'` 条件 → 浏览器直连路径也被拦截。注意:这些 helper 是共享 SQL 函数,若其他 Agent 后续 `create or replace` 未保留该条件,拦截会失效。
3. **`/api/me/context` 租户分支**只返回 `status='active'` 租户 → 停用后员工上下文自动消失(无法再选择该租户)。平台分支仍返回全部租户(管理页可用,切换进停用租户靠 RLS/Command 拦截)。
4. **平台列表不走 context**:管理页用 `GET /tenants`(service role)能看到已停用租户,与 context 的 active-only 不冲突。
5. `api/index.ts` 已注册 `me`/`stores`/`tenants`/`user` 路由(本批既有,Agent-07 拥有该文件,未改动)。

## 7. 验证证据

- `npx tsc --noEmit -p api/tsconfig.json` → 本 Agent 文件 0 错误(customers.ts / diagnostics.ts 报错来自 Agent-03/04 进行中代码)
- `npx vue-tsc -b` → 本 Agent 文件(tenants/detail/index、store/detail、tenant.ts、store.ts、system.ts、permissions.ts)0 错误
- `check:rpc-manifest` → `suspend_tenant`/`resume_tenant` 已登记且 revoke 存在(整体 FAIL 仅因 Agent-03 `publish_imaging_report` / Agent-05 采购 RPC 尚未登记,属并发中状态)

## 8. 未完成项 / 风险

- 平台租户列表当前为**一次性拉全量 + 前端过滤**(Pilot 规模);租户量大时需后端分页/筛选(非本次范围)。
- `platform_support` / `platform_auditor` 平台角色未纳入租户管理(仅 `platform_admin`),符合 Pilot。
- 若将来引入 `status='trial'` 租户,需评估 RLS/context 的 `active` 过滤是否会误伤(当前代码库无任何流程写入 trial,新租户默认 active)。
