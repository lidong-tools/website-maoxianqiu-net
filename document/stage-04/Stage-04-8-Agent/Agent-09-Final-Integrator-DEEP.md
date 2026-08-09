# Agent-09 — Final Integrator 深度执行指导

## 0. 角色

所有 Agent 都已经直接在同一个：

```text
main
```

开发。

你不是传统 Merge Agent。

你是：

```text
Mainline Integration Controller
```

负责：

```text
共享入口
跨域接口
Migration 审计
权限一致性
Build
Source Gate
Runtime Handoff
```

---

# 1. 开始条件

只有以下 Agent 都有 Handoff 才开始：

```text
01
02
03
04
05
06
07
08
```

执行：

```bash
git branch --show-current
git status --short
git log --oneline -80
```

必须确认：

```text
main
```

并记录当前 SHA。

---

# 2. 第一项：检查同 main 污染

检查：

```text
是否有未提交文件
是否有人 git add 了其它 Agent 文件
是否有 tmp/debug
是否有 secret
是否修改历史 migration
```

对 Source13 121 之前所有 Migration 做 hash/diff。

必须：

```text
historical changed = 0
```

---

# 3. Migration 号段检查

Stage04：

```text
200–284
```

检查：

```text
duplicate version
顺序
外键依赖
函数重定义
permission seed
RPC ACL
```

你自己的修复只能：

```text
285–299
```

禁止为了“整理编号”重命名已经由 Agent 提交的 Migration。

---

# 4. 共享 API 注册

Source13 `api/index.ts` 已经按 Domain：

```text
/audit
/approvals
/settings
/me
/search
/files
/stores
/tenants
/employees
/roles
/customers
/pets
/catalog
/inventory
/operations
/imports
/analytics
/documents
/messaging
/clinical
/billing
/inpatient
/diagnostics
/compliance
/regulatory
/closing
```

新增建议：

```text
/wallet
/medication-safety
/crm-growth
/marketing
/insurance
/document-artifacts
/purchase-requests
/purchase-returns
/portal
```

注册顺序避免：

```text
动态路由吞具体路由
```

并保持 Source13 `/operations/report-data` 先于 `/operations` 的经验。

---

# 5. Frontend Route

统一创建/注册模块：

```text
wallet
medication safety
crm-growth/marketing
insurance
purchase request/return
portal admin
```

路由 meta：

```text
auth permission code
```

不要为 C-End customer portal 复用员工 Admin Permission Route。

---

# 6. Permission Reconciliation

收集所有 Agent Permission。

检查：

```text
code duplicate
semantic overlap
module
role defaults
legacy roles.permissions compatibility（若项目仍需要）
```

避免：

```text
wallet.manage
wallet.admin
stored_value.manage
```

三套同义权限。

---

# 7. RPC Manifest

收集所有新 RPC。

每一个高危 RPC：

```text
manifest
migration revoke
service_role grant
```

执行：

```bash
pnpm check:rpc-manifest
```

但 Handoff 明确：

```text
这是静态 Gate
Runtime ACL 由 Agent-01
```

---

# 8. 跨域集成一：Wallet ↔ Billing

必须证明：

```text
stored_value debit
+
payment insert
```

是单事务或等价原子机制。

退款同理。

检查：

```text
billing PaymentMethod
DB constraint
settings payment context
cashier
closing
reconciliation
analytics
```

全链一致。

---

# 9. 跨域集成二：Medication ↔ Clinical

确认：

```text
Issue Prescription
```

Server 强制安全检查。

不能只有前端按钮。

检查 Override：

```text
permission
reason
audit
```

---

# 10. 跨域集成三：CRM/Marketing

确认：

```text
Segment = Audience 真源
```

Marketing 不复制第二套 Audience Engine。

确认 Pricing：

```text
Membership
Coupon
Package
Manual Discount
```

有唯一顺序。

---

# 11. 跨域集成四：Marketing ↔ Messaging

Campaign 不允许：

```text
直接 Provider SDK
```

只调用 Agent-08 Dispatch Contract。

Messaging 自己处理：

```text
Consent
Subscription
Provider
Idempotency
```

---

# 12. 跨域集成五：Insurance ↔ Documents

Insurance Pack 必须复用：

```text
Documents Adapter
PDF/Archive
```

不能出现：

```text
insurance_pdf_templates
```

另一套 Template System。

---

# 13. 跨域集成六：Purchase ↔ Inventory

确认 Purchase Return 最终写：

```text
inventory_movements
```

Opening Stock Consumer 也写同一库存体系。

检查：

```text
幂等
批次
warehouse scope
```

---

# 14. 跨域集成七：Employee Import ↔ IAM

Import Consumer 不得：

```text
直接 auth admin create
```

而应复用员工领域服务。

确认：

```text
role
store assignment
tenant membership
employee
```

语义一致。

---

# 15. 跨域集成八：Portal ↔ Business

Portal：

```text
Appointment
Documents
Membership
Benefits
```

全部通过 Customer Identity/Pet Access。

绝不能要求客户端传：

```text
employee role
tenant role
customer id 自证
```

---

# 16. Package / Dependencies

只有你改：

```text
package.json
pnpm-lock.yaml
```

Agent-06 若需要 Chromium：
- 评估是否 Vercel 可部署；
- 不盲目加几十 MB 依赖。

Agent-08 Provider SDK 同理。

---

# 17. Typecheck / Build

执行真实命令：

```text
API tsc
Frontend vue-tsc
Vite build
```

同时：

```text
Node ESM checker
Vercel build/smoke
```

不能只引用 Agent 自己说 PASS。

---

# 18. 静态安全扫描

检查：

```text
service role key
password
token
tmp script
console logging sensitive payload
direct authenticated write
new memberships[0]
new client balance update
```

---

# 19. Source Gate Failure Criteria

任何一个成立：

```text
duplicate migration
historical migration changed
API typecheck fail
frontend typecheck fail
build fail
ESM smoke fail
secret found
critical RPC authenticated executable
wallet non-atomic
inventory direct balance update
portal auth bypass
medication server hook missing
webhook no signature
```

则：

```text
FINAL SOURCE GATE = FAIL
```

---

# 20. 状态文档

不要继续 append 历史流水。

重写为当前事实：

```text
document/current/IMPLEMENTATION_STATUS.md
document/current/KNOWN_GAPS.md
document/current/RELEASE_CHECKLIST.md
```

每项状态只能：

```text
implemented
source_verified
runtime_pending
runtime_verified
uat_pending
uat_verified
deferred
disabled
known_gap
```

---

# 21. 交 Agent-01 Runtime Handoff

生成：

```text
document/stage-04/STAGE04-RUNTIME-HANDOFF.md
```

列出：

```text
Migration range
new tables
new RPC
permissions
critical runtime cases
required env
fixtures
known risks
```

Agent-01 不应该自己猜 Stage04 新域怎么测。

---

# 22. 最终输出

```text
STAGE04-FINAL-INTEGRATION-REPORT.md
STAGE04-SOURCE-GATE-REPORT.md
STAGE04-RUNTIME-HANDOFF.md
```

Pilot Ready Decision 必须等 Agent-01。

---

# 23. Commit

```text
chore(stage04-09): finalize stage04 source integration
```
