# S32-A-HANDOFF — 数据导入中心 V2 跨域交接

> 归属：S32-A（Import Center V2）→ S32-E Integrator 接入
> 本文件供 S3.2 Integrator 最终合并时使用。

## 1. 需要 Integrator 完成的接线（阻塞项）

### 1.1 注册新路由（S32-E 独占 `api/index.ts`）

`api/routes/imports.ts` 已创建，但**尚未挂载**。请在 `api/index.ts` 增加：

```ts
import importsRoutes from './routes/imports'
// ...
// S32-A:导入中心 V2
app.route('/imports', importsRoutes)
```

路由清单（前缀 `/api/imports`）：

```text
GET  /imports/templates/:type?format=xlsx|csv&tenantId=xxx   模板下载
GET  /imports?tenantId&storeId&type&status(逗号分隔)&from&limit 任务列表
POST /imports/upload                                          上传+解析+建任务
POST /imports/:id/mapping                                     保存字段映射+去重策略
POST /imports/:id/validate                                    校验(写错误明细)
POST /imports/:id/start                                       执行导入
GET  /imports/:id                                             任务详情
GET  /imports/:id/errors                                      错误明细(分页)
POST /imports/:id/cancel                                      取消
```

### 1.2 权限码（已随 Migration 101 seed，无需再改权限清单）

| 权限码 | 语义 | 已授予角色 |
|---|---|---|
| `imports.view` | 查看导入任务/结果/错误 | system_admin / tenant_owner / store_manager |
| `imports.create` | 新建/上传/映射 | 同上 |
| `imports.execute` | 校验/执行 | 同上 |
| `imports.cancel` | 取消 | 同上 |
| `imports.manage` | 兼容旧 `/operations/imports` | 保留 |

> 注意：新页面路由 meta 仍为 `imports.manage`（`router/modules/operations.ts` 未改，S32-E 独占）。如需将导航鉴权切换为 `imports.view`，请在集成期调整。

### 1.3 RPC Manifest

本 Agent **未新增任何 RPC**（全部经 Hono service-role 直写/直查），`service-rpc-manifest.ts` 无需改动。

## 2. Opening Stock Hook（库存期初，S32-A §8）

- **边界遵守**：导入 Agent 不直接 `update inventory_balances / inventory_batches`。
- **已实现**：`opening-stock` 导入执行时，把校验通过的期初入账命令写入新表：
  - 表：`public.opening_stock_import_requests`（`status='pending'`）
  - 字段：`catalog_code / catalog_item_id / warehouse_code / warehouse_id / batch_no / quantity / unit_cost / expiry_date / row_number / import_job_id / store_id`
- **待 Integrator 接入**：由 Inventory Command 消费 `status='pending'` 的请求，创建 `inventory_batches` + 更新 `inventory_balances`（或调用既有库存入账 RPC），成功后置 `status='applied'`；跳过置 `skipped`；失败置 `failed` 并写 `error_message`。
- **建议接口**：`apply_opening_stock(tenant_id, store_id, request_id, operator_id)`（由库存侧提供）。

## 3. Employee Invitation Hook（员工待邀请，S32-A §9）

- **边界遵守**：导入 Agent 不创建 auth 用户、不发送邀请、不改 IAM。
- **已实现**：`employee` 导入执行时，把校验通过的"待邀请"写入新表：
  - 表：`public.employee_invite_imports`（`status='pending'`）
  - 字段：`email / name / phone / employee_no / title / role_code / store_codes(text[]) / row_number / import_job_id / store_id`
- **待 Integrator 接入**：由 IAM/Employee 邀请 API 消费 `status='pending'` 的记录：按 `role_code` + `store_codes` 解析角色与门店分配，走既有员工邀请流程；成功后置 `sent`；已存在置 `duplicate`；失败置 `failed`。

## 4. 新增 Migration（编号锁 100–103）

| 文件 | 内容 |
|---|---|
| `20260810000100_import_center_v2.sql` | 扩展 `import_jobs`（type 增 `catalog-item/employee/opening-stock`，status 增 `uploaded/mapped/validated/queued/cancelled`，新增 `mapping/duplicate_strategy/valid_rows/invalid_rows/started_at/finished_at/error_summary` 列）；新建 `import_job_errors`；新建命令队列 `opening_stock_import_requests` / `employee_invite_imports`；RLS（读策略放租户成员，写仅 service role） |
| `20260810000101_import_center_v2_permissions.sql` | seed `imports.view/create/execute/cancel`（保留 `imports.manage`）到 system_admin / tenant_owner / store_manager |

- 未占用 92–99（S3.1 Fix 保留）。
- `import_job_errors` / 两张命令队列表 RLS 仅开放 select（租户成员），写仅 service role；无新增 RPC。

## 5. 依赖与解析说明（重要决策）

- **零新增依赖**：受限网络无法安装 `exceljs`，且仓库无任何 xlsx 库。
- **已自研** `api/services/imports/codec.ts`：最小 XLSX 读写器（Node 内置 `zlib`）+ CSV 解析器。
  - 模板生成 `.xlsx`（Excel/WPS 可开）；上传支持 CSV/XLSX。
  - 局限：XLSX 仅覆盖常规结构（sharedStrings / inlineStr / 数值），非常规/加密文件解析返回空表并提示"另存为 CSV"。
  - 已通过本地 round-trip 验证（生成→解析→表头归一化→默认映射）。

## 6. 本 Agent 修改文件清单

```text
api/routes/imports.ts
api/services/imports/constants.ts
api/services/imports/codec.ts
api/services/imports/execute.ts
api/services/imports/fields.ts
api/services/imports/lookup.ts
api/services/imports/parse.ts
api/services/imports/template.ts
api/services/imports/validate.ts
apps/maoxianqiu/src/api/modules/imports.ts
apps/maoxianqiu/src/types/imports.ts
apps/maoxianqiu/src/components/imports/ImportResultSummary.vue
apps/maoxianqiu/src/components/imports/ImportWizard.vue
apps/maoxianqiu/src/views/operations/imports/index.vue
supabase/migrations/20260810000100_import_center_v2.sql
supabase/migrations/20260810000101_import_center_v2_permissions.sql
document/s32-handoff/S32-A-HANDOFF.md
```

**未修改**：`api/index.ts`（S32-E）、router（S32-E）、permission helper / me-context（S3.1）、billing/clinical/inventory 核心（S3.1）、`e2e/**`。

## 7. 验收提示（供 Integrator 回归）

- 5 类模板可下载（xlsx/csv）。
- 上传→映射→预览→校验→去重策略→执行→结果/错误明细 闭环。
- `imports.view/create/execute/cancel` 权限生效。
- 库存期初只写 `opening_stock_import_requests`，余额/批次未被导入侧直改。
- 员工导入只写 `employee_invite_imports`，未创建账号。
