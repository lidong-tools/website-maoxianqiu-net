# 实施状态文档（IMPLEMENTATION_STATUS）

> 本文件与代码保持对齐，由每次交付更新。所有 P0 任务均以"任务提交要求"（v0.5 第 21 节）报告代码、migration、API、UI、权限、测试与风险。
>
> 依据：`document/stage-02/毛线球-最新开发指导文档-v0.5.md` 附录 A（第四部分第 20 节）推荐执行顺序。

## 状态总览

| 任务 | 内容 | 状态 | 说明 |
| --- | --- | --- | --- |
| DEV-000 | 基线对齐 | ✅ 完成 | 代码主体已铺开，与 v0.5 设计文档对齐 |
| P0-01 | scoped permission | ✅ 完成 | `requireScopedPermission` 按目标租户+门店解析真实作用域 |
| P0-02 | service role route 收口 | ✅ 完成 | 审计全部 service role 路由，逐路由 scoped 授权 |
| P0-03 | 旧文件接口下线 | ✅ 完成 | 旧 `/api/upload`、`/api/files` 已下线，统一新 R2 私有签名 |
| P0-04 | Picker 补齐 | ✅ 完成 | 经盘点基本齐全，无需重新开发 |
| P0-05 | 打印真实数据 | ✅ 完成 | 打印绑定真实业务 DTO（print-data 接口） |
| P0-06 | 报表统一 | ✅ 完成 | 浏览器聚合迁移至 Hono `/operations/report-data` + PostgreSQL 聚合 |
| P0-07 | 消息策略 | ✅ 完成 | 决策：方案 A——消息模块退出 MVP（见 PRD-v0.5 增补修订版第 14 节） |
| P0-08 | 库存一致性 | ✅ 完成 | migration 25：FEFO 批次扣减 + reserved_until 自动/批量释放 + 处方发药/取消联动 |
| P0-09 | 真实闭环 E2E | ✅ 代码完成 / ⏳ 待 staging 执行 | 闭环 A/B/C 已编写并通过 tsc；需 staging 环境实际执行 |
| P0-10 | 文档与命令修正 | ✅ 完成 | 根 package.json 补 test:e2e 脚本；AGENTS.md 重写；新增本组文档 |
| S3.0 | Stage02 审计收口 | ✅ 完成 | AUD-001~011 全部落地（明细见下文「S3.0 审计收口」） |

## 已交付任务明细

### P0-01 scoped permission
- 重构授权为 `requireScopedPermission({ code, tenantId, storeId })`，按调用者成员身份解析真实作用域，平台管理员以 `PLATFORM_ADMIN_ROLE = 'system_admin'` 判定。
- API：`api/lib/permission.ts`；前端无改动。
- 权限：原 permission 码不变，仅校验口径变化。

### P0-02 service role route 收口
- 审计全部 domain 路由（customers / pets / clinical / billing / inventory / inpatient / operations 等），所有 service client 查询路由补 scoped 授权并强制按 `scope.tenantId` 过滤。
- API：`api/routes/*.ts`、`api/middlewares/auth.ts`。
- 禁止事项落实：不得允许客户端自由指定 tenant 后 service role 直接查询。

### P0-03 旧文件接口下线
- 下线旧 `/api/upload`、`/api/files` 两套生产文件接口，统一新模型（files 表 + R2 私有签名 URL）。
- API：`api/index.ts` 删除旧挂载。
- 禁止事项落实：不再保留两套生产文件接口。

### P0-05 打印真实数据
- 打印接口绑定真实业务 DTO（print-data），替代演示数据。
- API：`api/routes/print-data.ts`（含示例 `GET /print-data/:id`）；前端打印页接入。
- 待完善项见 KNOWN_GAPS（P1 打印能力项）。

### P0-06 报表统一
- 新增 `api/routes/report-data.ts`：`GET /operations/report-data/:reportCode` 服务端聚合 5 类报表。
- `api/index.ts` 挂载顺序：report-data 必须挂在 `/operations` 之前，否则被 operationsRoutes 拦截。
- UI：`apps/maoxianqiu/src/views/operations/reports/index.vue` 删除约 500 行浏览器跨表聚合。
- 禁止事项落实：浏览器不再负责大规模跨表聚合。

### P0-07 消息策略
- 决策：方案 A（消息模块退出 MVP）。
- 文档：`document/stage-03/01-产品需求说明书-PRD-v0.5-增补修订版.md` 第 14 节。
- 代码：消息相关页面/接口按 MVP 边界裁剪，不生产 Mock sent。

### P0-08 库存一致性
- migration：`supabase/migrations/20260807000025_inventory_reserve_consistency.sql`
  - `inventory_movements` 增加 `reserved_until timestamptz` + 部分索引。
  - 重建 `reserve_inventory`（新增 `p_reserved_until`，默认 24h）。
  - 重建 `confirm_inventory_reservation`：确认前自动释放过期预留 + FEFO 批次扣减。
  - 新增 `release_expired_reservations` 批量释放 RPC。
  - 权限：revoke public + grant authenticated。
- API：
  - `api/routes/clinical.ts`：处方发药先确认预留（无预留即时 FEFO 发药）；取消处方先释放预留。
  - `api/routes/billing.ts`：取消发票联动释放该就诊下处方的未处理预留。
  - `api/routes/inventory.ts`：`POST /reserve/release-expired` 运维端点（inventory.release 权限）。
- 验证：`api` 目录 tsc 通过。

### P0-09 真实闭环 E2E
- 结构：`test.describe.configure({ mode: 'serial' })` 单一串行 test，走完整业务链路，每阶段用 Supabase REST 断言数据库状态。
- 辅助：`e2e/helpers/api.ts`（apiBaseFor / getAccessToken / newIdemKey / createApiClient / supabaseSelect / supabaseInsert）。
- 闭环 A：`e2e/tests/closed-loop-a.spec.ts` —— 客户→宠物→预约→候诊→就诊→病历→处方→发药→收费支付→签署只读。
- 闭环 B：`e2e/tests/closed-loop-b-inventory.spec.ts` —— 入库→余额→盘点(UI)→调拨→流水。
- 闭环 C：`e2e/tests/closed-loop-c-inpatient.spec.ts` —— 入院→房位占用→护理任务→换房→自动计费→出院。
- 验证：`tsc -p e2e/tsconfig.json` 通过；`playwright test --list` 收集 14 个用例无编译错误。
- 未验证项：真实执行须 staging 环境（E2E 管理员账号 + Supabase + dev server），见 RELEASE_CHECKLIST。

### P0-10 文档与命令修正
- 根 `package.json` 新增：
  - `test:e2e`、`test:e2e:ui`、`test:e2e:report`。
- `AGENTS.md` 重写为毛线球项目规则（Vue 3.5.40 / Fantastic Admin + Reka UI / 禁新增 Element Plus / Command 走 Hono / service role 必须 scoped authorization / example 页面不视为产品功能）。
- 本目录（`document/current/`）新增 IMPLEMENTATION_STATUS / KNOWN_GAPS / RELEASE_CHECKLIST。

## S3.0 审计收口

> 依据：`document/stage-02/毛线球-Stage02源码审计与Stage03执行指导-v1.1.md` 第 18 章 S3.0 任务清单。11 个 AUD 任务全部落地，代码与文档已对齐。

| AUD | 内容 | 状态 | 说明 |
| --- | --- | --- | --- |
| AUD-001 | 基线证明 | ✅ 完成 | S3.0 全部改动待一次 commit 关联（见提交说明） |
| AUD-002 | scoped permission 作用域串用 | ✅ 完成 | `api/lib/permission.ts`：区分 tenant-wide（store_id IS NULL）与 store-scoped 角色分配；`AccessScope` 新增 `allowedStoreIds`；平台管理员判定收紧为 `is_system && scope='system'` |
| AUD-003 | report-data 门店数据范围 | ✅ 完成 | `api/routes/report-data.ts`：引入 `ReportQuery.allowedStoreIds`，5 类报表在查询层按门店集合强制过滤（refunds 按发票归属、inventory 按仓库归属） |
| AUD-004 | 宠物新增 UI | ✅ 完成 | 新增 `PetForm`、`PetCreateDrawer` 业务组件；客户详情页接入「新增宠物」入口并刷新 |
| AUD-005 | 清理正式表单手填 ID | ✅ 完成 | 全部正式表单替换/统一为业务 Picker，误导性「XX ID」标签与提示文案业务化 |
| AUD-006 | 打印选择器收尾 | ✅ 完成 | `operations/print`：lab_report/vaccine_certificate 接入 `DiagnosticOrderPicker`，移除实体 ID 手填兜底 |
| AUD-007 | inventory 过期预留确认缺陷 | ✅ 完成 | migration 25 修复：确认时自身预留已过期直接拒绝（RESERVATION_EXPIRED）；stale loop 排除当前确认 id；新增 RLS 回归测试 `supabase/tests/rls_inventory_reserve.sql` |
| AUD-008 | E2E 禁止核心 skip | ✅ 完成 | 闭环 A/B/C 缺 seed（drug 商品/仓库/笼位）由 skip 改为 FAIL；清理过时 `.spec.js` 编译产物避免双跑 |
| AUD-009 | 闭环 A 顺序确认 | ✅ 完成 | 按默认建议 prescription → invoice → payment → dispense 调整；不再由测试代码擅自先发药后收费 |
| AUD-010 | typecheck/lint/build 全绿 | ✅ 完成 | 前端 `vue-tsc -b`、api `tsc --noEmit`、e2e `tsc`、ESLint、`vite build` 全部通过 |
| AUD-011 | current 文档与源码重新对齐 | ✅ 完成 | 本文件 + KNOWN_GAPS + RELEASE_CHECKLIST 同步更新；关闭 P1-01 等已修复缺口 |

### AUD-002 scoped permission 修复明细
- `api/lib/permission.ts`：
  - `RoleRow` 增加 `is_system`；`AccessScope` 增加 `allowedStoreIds: string[]`。
  - 新增 `collectRolePermissions()` 从 role_permissions 关联表 + roles.permissions 聚合权限码。
  - `ScopedRequirement` 支持 `dataScope?: boolean`（报表只读聚合模式）。
  - 匹配逻辑：传 storeId 时允许 `store_id === storeId || null`；命令模式（未传 storeId）仅匹配 tenant-wide 分配。
  - 平台管理员纵深防御：`code==='system_admin' && is_system && scope==='system'` 并组装全租户门店为 allowedStoreIds。

### AUD-003 report-data 修复明细
- `api/routes/report-data.ts`：
  - 5 类报表（收入/退款/库存/客户/医疗）查询统一注入 `query.allowedStoreIds`。
  - refunds 无 store_id：先按允许门店收敛 invoice id 集合再查 refunds。
  - inventory_balances 无 store_id：先按 `warehouses.store_id` 收敛 warehouse id 集合；空集合直接返回空报表。
  - 路由 handler 显式传 storeId 时，`allowedStoreIds` 收敛到该门店。

### AUD-007 库存一致性修复明细
- migration `20260807000025_inventory_reserve_consistency.sql`：
  - `confirm_inventory_reservation`：当前预留 `reserved_until < now()` 直接抛 `RESERVATION_EXPIRED`（防重复检查之后、扣减之前）。
  - stale loop 查询排除当前确认的 `m.id <> v_reserve.id`，避免确认自身被重复 release。
- API：`api/routes/inventory.ts` 新增 RESERVATION_EXPIRED → 409「该预留已过期,请重新预留或释放」映射。
- 测试：`supabase/tests/rls_inventory_reserve.sql`（R1~R6 覆盖过期确认拒绝、并发释放、重复确认、库存竞争、stale loop 回归）。

## 基线 / 验证说明

- API 目录 `api/`：`tsc --noEmit` 通过。
- E2E 目录 `e2e/`：`tsc -p e2e/tsconfig.json --noEmit` 通过；`playwright test --list` 通过。
- 前端 `apps/maoxianqiu`：`vue-tsc -b` 通过（S3.0 AUD-010 起全绿）；`vite build` 通过。
- 本地环境未执行：migration 空库/旧库升级、RLS/RPC 全量验证、闭环 A/B/C 真实运行（依赖 staging）。

## 更新记录

| 日期 | 更新内容 |
| --- | --- |
| 2026-08-07 | S3.0 审计收口：记录 AUD-001~011 落地明细，同步 KNOWN_GAPS / RELEASE_CHECKLIST |
| 2026-08-07 | 初始化：汇总 DEV-000 ~ P0-10 实施状态 |
