# Agent-01 — Runtime / UAT / DB Gate 深度执行指导

## 0. 你的角色

你不是业务开发 Agent。你是 **独立 QA / Runtime Verification Agent**。

所有业务 Agent 都可能说“我的代码完成了”，但只有你可以用运行证据证明：

```text
migration 能跑
RLS 真隔离
RPC ACL 真生效
业务并发真安全
E2E 真闭环
人工 UAT 真可用
```

你直接工作在：

```text
main
```

但原则上不修改业务逻辑。

---

# 1. Source13 调研结论

必须先阅读：

```text
AGENTS.md
e2e/playwright.config.ts
e2e/helpers/**
e2e/tests/closed-loop-a.spec.ts
e2e/tests/closed-loop-b-inventory.spec.ts
e2e/tests/closed-loop-c-inpatient.spec.ts
scripts/e2e-setup.sh
supabase/tests/**
document/current/RELEASE_CHECKLIST.md
```

Source13 当前事实：

- Playwright：
  - `workers: 1`
  - `fullyParallel: false`
  - `testDir: './tests'`
  - hash router
  - 默认本地 Vite 9000
- 已有核心闭环：
  - A：医疗/收银
  - B：库存
  - C：住院
- `scripts/e2e-setup.sh` 当前不安全：
  - `set -e`，没有 `-u/-o pipefail`
  - 一开始执行 `supabase db reset --linked --yes`
  - 未在 destructive command 前验证关键变量
  - 错误使用 `E2E_ACCOUNT_PASSWORD` 作为 `PGPASSWORD`

这些必须先修。

---

# 2. Ownership

你可以修改：

```text
scripts/e2e-setup.sh
scripts/runtime-*.sh
scripts/runtime-*.ts
e2e/**
supabase/tests/**
document/testing/**
```

原则上禁止修改：

```text
api/routes/**
api/services/**
apps/maoxianqiu/src/views/**
业务 Migration
```

如果发现业务 Bug：

```text
写 Issue / PILOT-BLOCKERS
→ 指明 Owner Agent
→ 不自行越权重构
```

只有“测试工具本身 bug”允许你修。

---

# 3. 第一步：重构 e2e-setup 为安全工具

目标不是“能跑”，而是**不会误重置错误数据库**。

必须：

```bash
set -euo pipefail
```

启动第一段必须先检查：

```text
E2E_USERNAME 或 E2E_ACCOUNT_EMAIL
E2E_PASSWORD 或 E2E_ACCOUNT_PASSWORD
DATABASE_URL
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
```

建议统一名称：

```text
E2E_USERNAME
E2E_PASSWORD
```

兼容旧变量仅作为 fallback。

### 禁止

```bash
PGPASSWORD="$E2E_PASSWORD"
```

数据库密码应该来自：

```text
DATABASE_URL
```

或专门：

```text
DB_PASSWORD
```

二者不可和 Auth 用户密码混用。

### destructive reset 安全开关

不要直接：

```bash
supabase db reset --linked --yes
```

改为显式模式：

```text
RUNTIME_DB_MODE=local
RUNTIME_DB_MODE=staging-reset
RUNTIME_DB_MODE=upgrade-rehearsal
```

只有：

```text
ALLOW_DESTRUCTIVE_DB_RESET=YES
```

且环境确认是测试环境才允许 linked reset。

如果 host/project 被识别为 production：

```text
立即退出
```

---

# 4. Blank DB Migration Gate

建立脚本：

```text
scripts/runtime-blank-db.sh
```

目标：

```text
空数据库
→ migration 0..latest
→ seed/fixtures
→ schema checks
```

必须记录：

```text
开始时间
结束时间
migration count
latest version
失败 migration
数据库版本
Supabase CLI version
```

验收：

```text
exit 0
migration unique
latest applied
无 SQL compile error
```

---

# 5. Existing DB Upgrade Gate

必须与 Blank DB 分开。

准备一个：

```text
Stage-03 最终 schema snapshot / 测试库
```

然后：

```text
Source13/Stage03 数据库
→ Stage04 latest
```

验证：

```text
历史数据未丢
余额/库存/处方/发票关键表 row count 合理
新列 default/backfill 正确
旧 API 仍能读
```

禁止只跑：

```text
db reset
```

就声称 Existing Upgrade 通过。

---

# 6. RPC ACL Runtime Gate

不要只跑：

```text
pnpm check:rpc-manifest
```

必须直接查询 PostgreSQL：

```text
pg_proc
pg_namespace
has_function_privilege('authenticated', ...)
has_function_privilege('anon', ...)
has_function_privilege('service_role', ...)
```

对所有 `SERVICE_ROLE_ONLY_RPC` 验证：

```text
PUBLIC      false
anon        false
authenticated false
service_role true
```

把结果输出为表格。

---

# 7. RLS Matrix

至少准备角色：

```text
platform_admin
tenant_owner
store_manager
doctor
nurse
cashier
inventory role
普通无权限员工
```

准备：

```text
Tenant A / Store A1 / A2
Tenant B / Store B1
```

负向测试必须覆盖：

```text
A 账号读 B tenant
A1 store role 读 A2
store role 调 tenant-wide command
无权限用户 service-role API
suspended tenant
expired trial
```

任何一个越权：

```text
P0
Runtime Gate FAIL
```

---

# 8. 新 Stage04 Domain Runtime Case

## Wallet

验证：

```text
充值 100
并发扣款 80 + 80
只能一个成功
余额不能负
重复 idempotency 不重复扣
退款只返一次
```

## Medication Safety

验证：

```text
Blocking rule 真阻止
Warning 可继续
Override 需要 permission + reason
旧 rule version 可追溯
```

## CRM/Marketing

```text
同一客户 Segment 解释稳定
Coupon quota 并发不超发
Package redemption 不重复
```

## Documents/Insurance

```text
PDF hash 稳定
Archive object 可下载
跨 Tenant archive 不可读
```

## Supply Chain

```text
Purchase Return 两次 post 不重复减库存
Opening Stock consumer 重试不重复入库
```

## Portal/Messaging

```text
未授权家庭成员看不到宠物
未发布报告不可见
Webhook 重放不重复改状态
```

---

# 9. E2E 扩展

保留现有 Closed Loop A/B/C。

新增 Stage04：

```text
stage04-wallet.spec.ts
stage04-medication-safety.spec.ts
stage04-crm-marketing.spec.ts
stage04-insurance-documents.spec.ts
stage04-supply-chain.spec.ts
stage04-portal-messaging.spec.ts
```

不要为了速度把 workers 调高后共享同一账号/同一数据。

如果要并行：

```text
每 worker 独立账号 + 独立 fixture
```

否则继续 workers=1。

---

# 10. Manual UAT 设计

必须提供角色驱动验收，而不是“页面点一遍”。

每条 Case 包含：

```text
Case ID
Requirement
Role
Tenant
Store
Preconditions
Data Setup
Steps
Expected UI
Expected DB
Expected Audit
Actual
PASS/FAIL/BLOCKED
Severity
Evidence
Issue
```

人工验收至少四类：

```text
Happy Path
Validation Failure
Permission Failure
Retry/Double Click
```

---

# 11. UAT 重点列表

### 管理员

```text
Tenant/Store
Role
Settings
Membership
Marketing
Provider
```

### 前台/收银

```text
Customer
Appointment
Cashier
Wallet
Coupon/Package
```

### 医生

```text
Encounter
Prescription
Medication Safety
Documents
Insurance
```

### 库存

```text
PO
Purchase Request
Receive
Return
Opening Stock Import
```

### 客户 C 端

```text
Identity
Pet Access
Appointment
Published Report
Notification Subscription
```

---

# 12. 报告格式

输出：

```text
document/testing/STAGE04-RUNTIME-GATE.md
document/testing/STAGE04-RLS-RPC-REPORT.md
document/testing/STAGE04-E2E-REPORT.md
document/testing/STAGE04-MANUAL-UAT-PLAN.md
document/testing/STAGE04-MANUAL-UAT-RESULT.md
document/testing/STAGE04-PILOT-BLOCKERS.md
```

每个 FAIL 必须写：

```text
Owner Agent
Severity
Repro Steps
Expected
Actual
Evidence
Recommended Fix Boundary
```

---

# 13. 绝对禁止

```text
为了让测试绿直接改业务判断
测试里绕过 UI 完成 UAT
缺 fixture 就 skip
API 500 当作业务失败 PASS
没有 DB assertion 只看 Toast
只验证 system_admin
```

---

# 14. 完成条件

只有以下全部成立你才能写：

```text
runtime_gate_pass
```

- Blank DB PASS
- Existing Upgrade PASS
- RPC ACL PASS
- RLS Matrix PASS
- Core Domain Runtime PASS
- Stage04 新域关键 Case PASS
- E2E PASS 或明确无 P0/P1 Blocked
- 人工 UAT 有真实结果

否则：

```text
STATUS = integration_pending
```

---

# 15. Commit

```text
test(stage04-01): establish runtime db e2e and manual uat gate
```
