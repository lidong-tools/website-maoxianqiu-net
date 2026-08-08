# S32-B 经营报表与驾驶舱 — Handoff(给 S32-E Integrator)

> 来源:Agent S32-B
> 目标:S32-E Integrator 在最终合并阶段完成**路由注册 / 菜单挂载 / 权限 manifest 同步**。
> S32-B 严格遵循文件 Ownership,未修改 `api/index.ts`、`router/routes.ts`、`router/modules/*`、权限 seed/manifest、`document/current/*`。

## 1. 本 Agent 交付清单

### 生产代码(全部归 S32-B 所有)
```text
api/routes/analytics.ts
api/services/analytics/{types,common,dashboard,revenue,customers,clinical,inventory,csv}.ts
apps/maoxianqiu/src/api/modules/analytics.ts
apps/maoxianqiu/src/types/analytics.ts
apps/maoxianqiu/src/components/analytics/{KpiCard,ChartCard}.vue
apps/maoxianqiu/src/views/analytics/{dashboard,revenue,customers,clinical,inventory}/index.vue
apps/maoxianqiu/src/composables/business/useAnalyticsContext.ts
```

### 迁移(编号 104–105;106–107 预留未用)
```text
supabase/migrations/20260810000104_analytics_permissions.sql   # 权限码 + 角色授权
supabase/migrations/20260810000105_analytics_report_indexes.sql # 只读聚合索引
```

### 文档
```text
document/analytics/KPI-DEFINITIONS.md   # 全部 KPI 权威口径(§14)
document/s32-handoff/S32-B-HANDOFF.md   # 本文件
```

## 2. 权限

### 权限码(已由 migration 104 写入 `permissions`)
| code | 说明 |
|---|---|
| `analytics.view.store` | 查看门店经营报表(传 storeId 时校验) |
| `analytics.view.tenant` | 查看全院经营报表(不传 storeId 时校验) |
| `analytics.export` | 导出经营报表 CSV(导出额外校验) |

### 授权(已由 migration 104 写入 `role_permissions`)
- `system_admin` / `tenant_owner`:全部三个权限。
- `store_manager`:`analytics.view.store` + `analytics.export`。
- 其他角色(含 cashier/doctor)**不默认开放**收入等经营数据(§15)。

### S32-E 待办:前端权限 manifest
请在前端权限 manifest / 权限管理列表补充上述三个权限码,使其可被分配给自定义角色。

## 3. Route Registration(S32-E 待办)

### 3.1 API 路由(`api/index.ts`)
`api/index.ts` 属于 S32-E 独占文件。请在 import 区加入:
```ts
import analyticsRoutes from './routes/analytics'
```
并在 `app.route('/operations', operationsRoutes)` 附近(或独立分组)注册:
```ts
// S32-B:经营报表与驾驶舱(只读聚合,权限 analytics.view.store/tenant/export)
app.route('/analytics', analyticsRoutes)
```
> 注意:必须确保 `/analytics/*` 不被其他通配路由拦截。

### 3.2 前端路由模块(`router/modules/analytics.ts`)
S32-E 独占该文件。请创建并加入以下内容:
```ts
import type { RouteRecordRaw } from 'vue-router'

// 经营报表与驾驶舱(S32-B)
const routes: RouteRecordRaw[] = [
  { path: '/analytics/dashboard', name: 'analyticsDashboard', component: () => import('@/views/analytics/dashboard/index.vue'), meta: { title: '经营驾驶舱', icon: 'i-carbon:dashboard', auth: 'analytics.view.store' } },
  { path: '/analytics/revenue', name: 'analyticsRevenue', component: () => import('@/views/analytics/revenue/index.vue'), meta: { title: '收入分析', icon: 'i-carbon:chart-line', auth: 'analytics.view.store' } },
  { path: '/analytics/customers', name: 'analyticsCustomers', component: () => import('@/views/analytics/customers/index.vue'), meta: { title: '客户分析', icon: 'i-carbon:user-multiple', auth: 'analytics.view.store' } },
  { path: '/analytics/clinical', name: 'analyticsClinical', component: () => import('@/views/analytics/clinical/index.vue'), meta: { title: '医疗运营', icon: 'i-carbon:stethoscope', auth: 'analytics.view.store' } },
  { path: '/analytics/inventory', name: 'analyticsInventory', component: () => import('@/views/analytics/inventory/index.vue'), meta: { title: '库存分析', icon: 'i-carbon:inventory-management', auth: 'analytics.view.store' } },
]
export default routes
```

### 3.3 菜单挂载(`router/routes.ts`)
`router/routes.ts` 属于 S32-E 独占文件。请在 import 区加入:
```ts
import AnalyticsModule from './modules/analytics'
```
并在 `asyncRoutes` 增加菜单组(建议放在「运营管理」之后、「日结对账」之前):
```ts
{
  meta: { title: '经营分析', shortTitle: '分析', icon: 'i-carbon:chart-multitype' },
  children: [ ...AnalyticsModule ],
},
```

## 4. Required Indexes

migration 105 已新增只读聚合索引:
- `encounters (tenant_id, store_id, started_at)`
- `customers (tenant_id, store_id, created_at)`
- `lab_orders (tenant_id, store_id, requested_at)`
- `imaging_orders (tenant_id, store_id, created_at)`
- `boarding_stays (tenant_id, store_id, check_in_at)`
- `purchase_orders (tenant_id, store_id, created_at)`
- `inventory_movements (warehouse_id, created_at)`

> 均 `create index if not exists`,幂等;未引入 Materialized View(§12,当前查询量级下 SQL 聚合足够)。

## 5. API 契约摘要

统一 Query:`tenantId / storeId / startAt / endAt / groupBy / dimension`
- `startAt/endAt` = 业务日期 `YYYY-MM-DD`,在 Tenant Timezone 内闭区间。
- `storeId` 空 = 全院(需 `analytics.view.tenant`);带 `storeId` = 门店(需 `analytics.view.store`)。
- `groupBy`:day|month(默认 day);`dimension`:store|payment_channel|catalog_type|doctor(默认 store)。

端点:
```http
GET /api/analytics/dashboard
GET /api/analytics/revenue
GET /api/analytics/customers
GET /api/analytics/clinical
GET /api/analytics/inventory
GET /api/analytics/export?report=dashboard|revenue|customers|clinical|inventory
```
- 除 export 外均返回 `{ ok, data, requestId }`。
- export 返回 `text/csv` + `Content-Disposition`,并写入 `audit_logs`(action=`analytics.export`)。

## 6. 其他 Domain 依赖 / 失败策略

- **只读聚合**:本模块仅读取 `invoices/payments/refunds/encounters/appointments/customers/inventory_*/lab_orders/imaging_orders/admissions/inpatient_charges/boarding_service_charges/purchase_orders/warehouses/catalog_items` 等交易表,**不写入任何交易状态**。
- **不依赖 S3.1 Fix 改动**:仅使用稳定的 `requireScopedPermission` / `getContext` / `writeAudit` 公共 API,不触碰 S3.1 正在改的 IAM/Billing/Clinical/Inventory 核心边界。
- **失败策略**:任一子查询失败抛 `internal`;无数据返回空数组/0,不返回假数(尤其 库存周转率、报损)。
- **时区**:全部切片按 `tenants.timezone`,见 KPI-DEFINITIONS.md §0。

## 7. S32-E 集成验收清单

- [ ] `api/index.ts` 注册 `/analytics`
- [ ] `router/modules/analytics.ts` 创建 + `router/routes.ts` 挂载菜单组
- [ ] 权限 manifest 补充 3 个权限码
- [ ] 应用 migration 104–105(注意编号不与 S32-A/C/D 冲突)
- [ ] `pnpm lint:tsc` / 前端 `vue-tsc -b` 通过
- [ ] 手动冒烟:任意有 `analytics.view.store` 的用户打开 `/analytics/dashboard`
- [ ] 全院模式:仅 `analytics.view.tenant` 用户可见「全院」开关
- [ ] CSV 导出:权限 + audit_logs 有记录

## 8. 冲突面提示

- 本 Agent 未改动任何其他 Agent 所属文件;新增文件与 S32-A/C/D 无命名冲突(`api/services/analytics/*`、`views/analytics/*`、`api/modules/analytics.ts`、`types/analytics.ts`、`components/analytics/*`)。
- 迁移编号占用 104–105,与 S32-A(100–103)、S32-C(108–111)、S32-D(112–115) 不重叠。
