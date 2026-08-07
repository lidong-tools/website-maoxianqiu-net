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

## 基线 / 验证说明

- API 目录 `api/`：`tsc --noEmit` 通过。
- E2E 目录 `e2e/`：`tsc -p e2e/tsconfig.json --noEmit` 通过；`playwright test --list` 通过。
- 前端 `apps/maoxianqiu`：`vue-tsc` 存在既有 P1-01 遗留错误（见 KNOWN_GAPS），非本次任务引入。
- 本地环境未执行：migration 空库/旧库升级、RLS/RPC 全量验证、闭环 A/B/C 真实运行（依赖 staging）。

## 更新记录

| 日期 | 更新内容 |
| --- | --- |
| 2026-08-07 | 初始化：汇总 DEV-000 ~ P0-10 实施状态 |
