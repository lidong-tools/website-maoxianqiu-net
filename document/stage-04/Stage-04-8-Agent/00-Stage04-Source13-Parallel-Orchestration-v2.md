# 毛线球 Stage-04 — Source13 深度调研版并发开发总编排 v2

> 基线源码：`website-maoxianqiu-net-main (13).zip`  
> 开发组织：**8 个执行 Agent + 1 个 Final Integrator，全部在同一个 `main` 分支直接开发。**  
> 本文是所有 Agent 的最高优先级开发约束。若单个 Agent 文档与本文冲突，以本文为准。  
> 用户已确认：线上 Vercel Node ESM `/api/health` P0 已在 Source13 之后修复，因此 **不得按 Source13 的旧 `api/tsconfig.json` 反向覆盖当前 main 的 ESM 修复**。

---

# 1. 为什么本阶段必须“依托源码扩展”，禁止重做

Source13 已不是空项目，而是一套已经经过多轮 Source Gate 审计的宠物医院 SaaS。现有关键能力已经形成稳定架构：

```text
Vue 3 + Fantastic Admin
Hono API
Supabase PostgreSQL/RLS/RPC
Cloudflare R2
Tenant/Store Context
Scoped Permission
Service Role Command Boundary
Audit
Idempotency
Medical/Finance/Inventory immutable patterns
```

现有源码关键事实：

- `api/lib/request-context.ts`
  - `X-Tenant-Id` / `X-Store-Id`
  - `resolveRequestedTenant()`
  - `resolveRequestedStore()`
- `api/lib/permission.ts`
  - `requireScopedPermission()`
  - `assertTenantAccess()`
  - `assertStoreTenant()`
- `api/lib/audit.ts`
  - 业务审计统一入口
- `api/lib/idempotency.ts`
  - HTTP Idempotency-Key 读取
- `api/lib/service-rpc-manifest.ts`
  - 高危 RPC service-role-only 清单
- `api/routes/billing.ts`
  - Payment/Refund/Invoice 的 Hono + RPC + 幂等模式
- `api/routes/inventory.ts`
  - Receipt/Dispense/Count/Transfer/Reserve 的锁与幂等模式
- `api/routes/customers.ts`
  - Customer 360 / Follow-up
- `api/routes/operations.ts`
  - Membership / Points / Discount Rules
- `api/routes/imports.ts` + `api/services/imports/**`
  - Import V2 状态机与命令队列
- `api/routes/documents.ts` + `api/services/documents/**`
  - Document Adapter / Template / Render / History
- `api/routes/messaging.ts` + `api/services/messaging/**`
  - Provider / CAS Claim / Idempotent Delivery
- `api/routes/clinical.ts`
  - Encounter / Prescription / Medical Orders
- `api/routes/files-v2.ts` + `api/lib/r2.ts`
  - 私有 R2 上传/下载/归档
- `apps/maoxianqiu/src/composables/business/useStoreScopedPage.ts`
  - 页面 Tenant/Store 切换刷新
- `apps/maoxianqiu/src/composables/business/useUnsavedChangesGuard.ts`
  - 高风险表单离开保护
- `apps/maoxianqiu/src/components/business/PermissionButton/index.vue`
  - 权限按钮模式
- `apps/maoxianqiu/src/router/modules/*.ts`
  - 路由权限元信息模式

**Stage-04 的目标不是造第二套系统，而是继续现有架构。**

---

# 2. Agent 分组与原因

| Agent | 领域 | 原需求 |
|---|---|---|
| Agent-01 | Runtime / UAT / DB Gate | 人工 UAT + Runtime Gate |
| Agent-02 | Production Deployment & Release Guard | API/Vercel 生产稳定性、防回归 |
| Agent-03 | Wallet / Stored Value | 储值账户 |
| Agent-04 | Medication Safety | 用药安全规则 |
| Agent-05 | CRM Growth & Marketing | 分层/流失 + 优惠券/套餐/营销 |
| Agent-06 | Documents & Insurance | 保险理赔 + PDF/Archive/E-Signature |
| Agent-07 | Supply Chain & Import | 采购申请/退货 + Import Consumers |
| Agent-08 | Customer Engagement | C 端门户 + Messaging/Webhook/多渠道 |
| Agent-09 | Final Integrator | 共享入口、最终集成、Source Gate |

分组原则：

```text
CRM Segment → Marketing Audience
Insurance Pack → PDF/Archive/Signature
Portal Identity → Customer Messaging
Purchase/Inventory → Opening Stock Import
```

这些需求若拆成不同 Agent，最容易造出重复的数据模型和跨 Agent 接口冲突，因此必须由同一 Agent 负责。

---

# 3. 同 main 并发的硬规则

所有 Agent 开始前必须：

```bash
git branch --show-current
git status --short
git log -1 --oneline
```

第一条必须输出：

```text
main
```

禁止创建分支：

```bash
git checkout -b ...
git switch -c ...
```

禁止：

```bash
git add .
git add -A
git commit -am
git reset --hard
git rebase
git push --force
```

每个 Agent 只能：

```bash
git add <明确 ownership 文件>
git diff --cached --name-only
```

只有确认缓存区完全属于自己后才能 commit。

---

# 4. 开发前必须执行“源码确认”，禁止靠文档猜

每个 Agent 在编码前必须：

1. `rg` 搜索当前 main 是否已经有同名 Table/API/Permission；
2. 打开对应历史 Migration，而不是只看当前文档；
3. 查现有 Route 是否已经有可复用 Command；
4. 查 frontend type/API module 是否已有对应模型；
5. 查 `service-rpc-manifest.ts`；
6. 查 `document/current/*` 当前状态；
7. 写一段 `SOURCE_RESEARCH` 到自己的 Handoff。

禁止：

```text
“我认为不存在”
“看起来应该有”
“文档说有所以直接用”
```

必须以 **当前 main 文件** 为准。

---

# 5. 共享文件冻结

并发阶段以下文件默认只允许 Agent-09 修改：

```text
api/index.ts
apps/maoxianqiu/src/router/routes.ts
全局 route/menu aggregation
根 package.json
pnpm-lock.yaml
document/current/IMPLEMENTATION_STATUS.md
document/current/KNOWN_GAPS.md
document/current/RELEASE_CHECKLIST.md
```

业务 Agent需要新增：

```text
API Route
Frontend Route
Menu
Permission
Package dependency
Environment variable
```

时：

- 自己创建领域文件；
- 在 Handoff 中写 `INTEGRATION_REQUESTS`；
- 不抢共享入口。

### Agent-02 例外

Agent-02 可独占：

```text
vercel.json
api/tsconfig.json
api/[[...route]].ts
scripts/release-*
scripts/check-api-*
document/deployment/**
```

但 Source13 之后 ESM P0 已修，**必须先读取当前 main，禁止把旧 Source13 配置覆盖回去**。

### Agent-01 例外

Agent-01 可独占：

```text
scripts/e2e-*
scripts/runtime-*
e2e/**
supabase/tests/**
document/testing/**
```

---

# 6. Migration 号段

当前 Source13 最新 Migration：

```text
20260810000121_messaging_delivery_schema_fix.sql
```

Stage-04 使用独立高位段，避免小修复冲突：

```text
Agent-03  200–209
Agent-04  210–219
Agent-05  220–234
Agent-06  235–249
Agent-07  250–264
Agent-08  265–284
Agent-09  285–299
```

例如：

```text
20260810000200_stored_value_accounts.sql
```

硬规则：

```text
不得修改 121 及以前任何 Migration
不得重命名已执行 Migration
不得补写旧号
不得让两个 Agent 共用同一版本
```

---

# 7. 数据库写边界

Source13 的正确模式是：

```text
Frontend
  ↓
Hono Route
  ↓ requireScopedPermission
Service Role
  ↓
PostgreSQL RPC / Domain transaction
```

新领域默认：

```text
authenticated direct INSERT/UPDATE/DELETE = 禁止
```

尤其以下数据禁止浏览器直接写：

```text
余额
Ledger
Inventory Movement
财务 Payment/Refund
医疗状态
药物 Override
Coupon Redemption
Package Redemption
Purchase Approval
Import Consumer State
Signature State
Message Delivery State
Customer Consent
Portal Identity
```

如果 Agent 为图快直接用前端 Supabase `.insert/.update()` 修改上述数据：

```text
直接判定任务失败
```

---

# 8. Scoped Permission

所有 Hono Service Role Route 必须：

```ts
await requireScopedPermission(c, {
  code: 'xxx',
  tenantId,
  storeId,
})
```

禁止仅依赖：

```text
前端 auth()
RLS
传入 tenantId
memberships[0]
```

Tenant Context 优先：

```text
Explicit ID
→ request context X-Tenant-Id
→ legacy fallback（仅旧逻辑）
```

新代码不允许主动增加新的 `memberships[0]` 依赖。

---

# 9. RPC ACL

新增高危 RPC：

1. 加到 `api/lib/service-rpc-manifest.ts`；
2. Migration 中显式：

```sql
revoke all on function ... from public;
revoke all on function ... from anon;
revoke all on function ... from authenticated;
grant execute on function ... to service_role;
```

3. Agent Handoff 必须列 `NEW_RPCS`；
4. Agent-09 最终跑 `check:rpc-manifest`；
5. Agent-01 Runtime Gate 用 `pg_proc` + `has_function_privilege()` 做真实 ACL 验证。

静态脚本不能替代数据库 Runtime ACL。

---

# 10. 幂等与并发标准

以下动作必须有 Idempotency：

```text
储值充值/扣款/退款
套餐核销
优惠券核销
采购退货过账
Import Consumer apply
消息发送/Provider webhook
PDF 生成（相同业务请求）
签名状态回调
```

Key 至少：

```text
tenant_id + idempotency_key
```

真正影响余额/库存/状态的操作需：

```text
SELECT ... FOR UPDATE
或
CAS conditional UPDATE
```

禁止：

```text
先读余额 → Node 计算 → 普通 update
```

---

# 11. Audit 标准

已有 `writeAudit()`。

以下动作必须 Audit：

```text
钱
积分/储值
药物风险 Override
Marketing 发布
Coupon/Package 调整
保险材料生成
PDF 归档
签名
采购审批/退货
Import Consumer
Portal Identity/Consent
Messaging Send/Retry/Webhook
```

最低字段：

```text
tenantId
storeId
actor
action
entityType
entityId
requestId
idempotencyKey（适用时）
metadata
```

禁止 Audit 里写：

```text
完整密码
完整 Token
Provider Secret
敏感医疗全文
```

---

# 12. 前端统一模式

必须复用：

```text
useAppTenantStore()
useStoreScopedPage()
usePageUnsavedGuard()
PermissionButton
FaTable/FaForm/FaDialog
现有 Empty/Loading/Error 模式
```

禁止：

```text
另加 Element Plus
手填 UUID
前端自算权威余额
前端自算权威折扣
前端自算库存
页面硬编码 Tenant
```

路由权限沿用：

```ts
meta: {
  auth: 'permission.code'
}
```

---

# 13. 依赖关系

## Agent-03

提供：

```text
Wallet balance/debit/refund contract
```

Agent-05/09 需要复用。

## Agent-05

提供：

```text
Segment/Audience/Coupon/Package contract
```

Agent-08 Portal 可只读暴露客户自己的权益。

## Agent-06

提供：

```text
PDF/Archive contract
```

Agent-08 Portal 可展示 customer-visible archive。

## Agent-07

必须复用：

```text
Existing Inventory Commands
Existing Employee Invite Domain
```

## Agent-08

提供：

```text
Messaging Dispatch Contract
Portal Identity Contract
```

Marketing 不能直接控制 Provider。

---

# 14. “完成”的定义

Agent 不得因为：

```text
表创建了
API 写了
页面能打开
build 通过
```

就写 `verified`。

Agent 最多写：

```text
code_complete
```

只有 Agent-01 Runtime/UAT 实际验证后才能：

```text
runtime_verified
uat_verified
```

只有 Agent-09 根据所有 Gate 才能：

```text
pilot_ready
```

---

# 15. 每个 Agent Handoff 模板

每个 Agent 必须创建：

```text
document/stage-04/handoff/AGENT-XX-HANDOFF.md
```

必须完整填写：

```text
STATUS
SOURCE_RESEARCH
START_HEAD
COMMIT_SHA
OWNED_FILES
MODIFIED_EXISTING_FILES
NEW_FILES
MIGRATIONS
NEW_TABLES
NEW_COLUMNS
NEW_INDEXES
NEW_RPCS
RPC_ACL
PERMISSIONS
API_ROUTES
FRONTEND_ROUTES
MENU_REGISTRATION_REQUEST
ENV_VARS
CROSS_DOMAIN_CONTRACTS
TESTS_RUN
TEST_RESULTS
KNOWN_GAPS
DEFERRED
INTEGRATION_REQUESTS
ROLLBACK_NOTES
```

---

# 16. Agent 提交前自检

必须执行：

```text
git diff --check
git status --short
git diff --cached --name-only
```

若该 Agent 可以独立 typecheck，则执行。

若项目因其它 Agent 半成品暂时全量 typecheck 失败：

- 不能偷偷修别人的代码；
- Handoff 中注明失败来自哪个共享文件/领域；
- 保留自己领域定向检查证据。

---

# 17. 最终并发顺序

```text
Wave 0:
Agent-01 Runtime/UAT foundation
Agent-02 Release Guard

Wave 1:
Agent-03 Wallet
Agent-04 Medication
Agent-05 CRM/Marketing
Agent-06 Documents/Insurance
Agent-07 Supply Chain/Import
Agent-08 Portal/Messaging

Wave 2:
Agent-09 Shared Integration

Wave 3:
Agent-01 Runtime DB + E2E + Manual UAT
```

---

# 18. 最终 Gate

```text
Migration Unique
Historical Migration Immutable
API Typecheck
Frontend Typecheck
Vite Build
Node/Vercel Runtime
Secret Scan
RPC ACL
RLS
Domain Runtime
E2E
Manual UAT
```

只有全部通过：

```text
PILOT_READY = YES
```

否则保持：

```text
PILOT_READY = NO
```
