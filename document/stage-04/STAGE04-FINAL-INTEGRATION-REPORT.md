# STAGE04-FINAL-INTEGRATION-REPORT（Agent-09 Final Integrator）

> 依据：`document/stage-04/Stage-04-8-Agent/Agent-09-Final-Integrator-DEEP.md` §0/§22。
> 角色：Mainline Integration Controller。所有 Agent 同在 `main` 分支开发；本报告汇总 Stage-04 集成结果。
> **Pilot Ready Decision 必须等 Agent-01**（runtime gate 之后才能声明）。

## 1. 交付范围

| 域 | Agent | Migration | API 路由 | 前端 |
| --- | --- | --- | --- | --- |
| Runtime/UAT 基础 | 01 | — | — | — |
| Release Guard | 02 | — | — | — |
| 钱包/储值 | 03 | 200~203 | `/wallet` | wallet 模块 |
| 用药安全 | 04 | 210~211 | `/medication-safety` | medication-safety 模块 |
| CRM 增长/营销 | 05 | 220~223 | `/crm-growth`、`/marketing` | crmGrowth/marketing 模块 + 营销增长菜单 |
| 保险/文档 | 06 | 235 | `/insurance`、`/document-artifacts` | insurance 模块 |
| 采购/导入 | 07 | 250~252 | `/purchase-requests`、`/purchase-returns`、`/import-consumers` | purchase/import 模块 |
| 门户/消息 | 08 | 265~267 | `/portal`、`/messaging/webhook` | portal 模块 + 客户门户菜单 |
| 集成/修复 | 09 | 285 | 全部挂载 | 菜单/路由注册 |

## 2. 共享入口集成

- `api/index.ts`：11 个新路由挂载，顺序保证具体路由先于动态路由（`/messaging/webhook` 先于 `/messaging`；`/inventory/purchase-*` 先于 `/inventory` 具体路由）。
- `apps/maoxianqiu/src/router/routes.ts`：新增「营销增长」（i-carbon:marketing）、「客户门户」（i-carbon:chat）两级菜单；既有菜单挂接新模块（客户宠物→CRM Growth，诊疗核心→Medication Safety，运营管理→Insurance）。
- 根 `package.json`：补 `check:api-esm` / `release:preflight` / `release:smoke`。

## 3. Agent-09 集成修复（migration 285）

- **问题**：Agent-08 `create_portal_appointment` 以 `source='customer_portal'` 写 appointments，但 migration 19 约束 `appointments_source_check` 仅允许 `walk_in/phone/online` → C 端预约首次执行必抛 CHECK violation。
- **修复**：migration 285 幂等 drop + 重建约束（含 `customer_portal`），附 audit_logs 条目。Forward Fix，不改历史 migration。

## 4. 跨域契约（DEEP §8~§15）汇总

| 契约 | 实现方式 | 集成状态 |
| --- | --- | --- |
| Wallet ↔ Billing 原子 | migration 203 同事务（debit + payment/refund） | ✅ 静态确认 |
| Medication ↔ Clinical hook | 211 服务端阻塞 + override（权限/reason/audit） | ✅ 静态确认 |
| CRM/Marketing 真源 | Segment = Audience 真源；营销无第二套引擎 | ✅ 静态确认 |
| Marketing ↔ Messaging | 无 Provider SDK，走 Agent-08 Dispatch Contract | ✅ 静态确认 |
| Insurance ↔ Documents | 复用 document_archives + PDF/签名 Provider | ✅ 静态确认 |
| Purchase ↔ Inventory | 退货/期初写 inventory_movements | ✅ 静态确认 |
| Employee Import ↔ IAM | invite_employee RPC + deleteUser 补偿 | ✅ 静态确认 |
| Portal ↔ Business | C 端独立会话，身份从会话推导 | ✅ 静态确认 |

## 5. 权限一致性

- 新增权限码：`wallet.*`、`medication_safety.*`、`crm.segment.*`/`crm.churn.view`、`marketing.*`、`insurance.*`、`documents.pdf.generate`/`documents.archive.view`/`documents.signature.manage`、`purchase_request.*`、`purchase_return.*`、`imports.employee.execute`/`imports.opening_stock.execute`、`portal.*`、`messaging.*`（兼容 `message.manage`）。
- 无重复/语义重叠；全部在 migration 内 seed；前端菜单 meta.auth 与后端一致。

## 6. RPC Manifest

- 当前共 **170 个** service-role-only 函数（Stage-04 新增 39 个）。
- 静态规则：routes 中 `service.rpc()` ⊆ manifest ⊆ migration revoke 清单。
- `check:rpc-manifest` 未重跑（用户约束），Agent-01 staging 阶段执行。

## 7. 静态安全

- 无硬编码 secret；无 tmp/debug；无敏感 payload 日志；前端无 RPC 直连；余额/会员调整全部服务端 RPC。
- Portal OTP 只存 hash；Webhook 验签强制；C 端与员工 IAM 完全隔离。

## 8. 验证状态

```text
Source Gate（静态）: PASS（详见 STAGE04-SOURCE-GATE-REPORT.md）
typecheck / build / ESM: 未执行（用户约束，交 Agent-01）
Runtime Gate: runtime_pending（依赖 staging，详见 STAGE04-RUNTIME-HANDOFF.md）
Pilot Ready Decision: 等 Agent-01（未声明）
```

## 9. 文档交付物

```text
document/current/IMPLEMENTATION_STATUS.md   （重写为当前事实）
document/current/KNOWN_GAPS.md              （重写为当前事实）
document/current/RELEASE_CHECKLIST.md       （重写为当前事实）
document/stage-04/STAGE04-RUNTIME-HANDOFF.md   （→ Agent-01）
document/stage-04/STAGE04-SOURCE-GATE-REPORT.md
document/stage-04/STAGE04-FINAL-INTEGRATION-REPORT.md（本文件）
document/stage-04/handoff/AGENT-01~08-HANDOFF.md（各 Agent）
```

## 10. Commit

```text
chore(stage04-09): finalize stage04 source integration
```
