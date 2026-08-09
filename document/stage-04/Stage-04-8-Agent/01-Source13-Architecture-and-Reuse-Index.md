# Source13 架构与复用索引 — Stage-04 开发前必读

> 本文件不是任务清单，而是告诉所有 Agent：**Source13 中已经有什么，应该复用哪里。**

---

# 1. 后端 Foundation

## Request Context

文件：

```text
api/lib/request-context.ts
```

可用：

```text
getContext()
requireTenant()
resolveRequestedTenant()
resolveRequestedStore()
```

新 API 不得自行读取 Header 后再实现一套 Context。

## Permission

文件：

```text
api/lib/permission.ts
```

核心：

```text
requireScopedPermission()
assertTenantAccess()
assertStoreTenant()
```

新 Service Role Route 必须使用 `requireScopedPermission()`。

## Supabase

```text
api/lib/supabase.ts
```

Service Role 只能存在服务端。

## Audit

```text
api/lib/audit.ts
```

任何高价值 Domain Command 应通过 `writeAudit()`。

## Idempotency

```text
api/lib/idempotency.ts
```

新关键 Command 复用当前 `Idempotency-Key` 机制。

## RPC Manifest

```text
api/lib/service-rpc-manifest.ts
api/scripts/check-rpc-manifest.ts
```

注意：静态 checker 只是开发 Gate，Runtime ACL 仍需 Agent-01 实库验证。

---

# 2. CRM / Membership

现有：

```text
supabase/migrations/20260806000015_crm_customers_pets.sql
api/routes/customers.ts
```

Customer 已有旧字段：

```text
member_level
member_points
balance
```

但 Source13 后续已经引入正式：

```text
membership_tiers
customer_memberships
point_transactions
membership_discount_rules
```

对应：

```text
supabase/migrations/20260806000018_operations.sql
supabase/migrations/20260810000056_membership_discount_rules.sql
supabase/migrations/20260810000057_membership_billing_integration.sql
api/routes/operations.ts
apps/maoxianqiu/src/views/operations/memberships/index.vue
```

### 重要约束

Stage-04：

```text
customer_memberships = 会员真源
point_transactions = 积分真源
```

`customers.member_level/member_points/balance` 是历史兼容字段，不应继续扩展成新商业域真源。

尤其：

```text
customers.balance 不能直接当储值账户。
```

---

# 3. Billing

```text
api/routes/billing.ts
supabase/migrations/20260806000020_billing.sql
apps/maoxianqiu/src/views/billing/cashier/index.vue
apps/maoxianqiu/src/types/billing.ts
```

现有 Payment/Refund：

```text
process_payment RPC
process_refund RPC
tenant idempotency
audit
```

Source13 存在一个明显历史不一致：

```text
daily closing/reconciliation 已认识 stored_value
但 billing.ts / payments constraint / settings payment-context
仍主要只允许 cash/wechat/alipay/card/other。
```

Agent-03 必须用 Forward Migration 和 Hono 类型统一修复，不能只改 UI。

---

# 4. Clinical / Prescription

```text
supabase/migrations/20260806000019_clinical.sql
api/routes/clinical.ts
apps/maoxianqiu/src/views/clinical/encounter/detail.vue
```

已有：

```text
prescriptions
prescription_items
save_prescription
dispense_prescription
medical_orders
nurse_tasks
```

Agent-04 用药安全必须挂在：

```text
save/issue/dispense workflow
```

而不是另造一套 Prescription。

---

# 5. CRM 360 / Follow-up / Analytics

```text
api/routes/customers.ts
GET /customers/:id/360
followup_tasks
api/routes/analytics.ts
api/services/analytics/**
```

Agent-05 分层与流失需要优先复用现有：

```text
encounters
invoices/payments
customer_memberships
reminders
followup_tasks
appointments
```

不得在前端加载全量业务表后计算 Segment。

---

# 6. Documents / R2

Documents：

```text
api/routes/documents.ts
api/services/documents/**
api/services/documents/adapters/**
supabase/migrations/20260810000108_document_templates.sql
20260810000113_document_template_write_boundary.sql
```

已有类型：

```text
prescription
invoice
medical_record_summary
lab_report
imaging_report
discharge_summary
vaccination_certificate
boarding_handover
```

Files/R2：

```text
api/routes/files-v2.ts
api/lib/r2.ts
```

已有：

```text
upload intent
presigned upload
complete
presigned download
archive
physical delete
```

Agent-06 不得再建第二套 file storage。

---

# 7. Inventory / Purchasing

```text
api/routes/inventory.ts
20260810000065_suppliers.sql
20260810000066_purchase_orders.sql
20260810000096_purchasing_integrity.sql
```

已有 PO：

```text
draft
submitted
approved
partially_received
received
posted/cancelled
```

已有 Inventory Command：

```text
post_goods_receipt
dispense_inventory
post_stock_count
transfer_inventory
reserve_inventory
```

Agent-07 Purchase Return / Opening Stock 必须最终生成现有 `inventory_movements` 语义，不得直接改余额快照。

---

# 8. Import V2

```text
api/routes/imports.ts
api/services/imports/**
20260810000100_import_center_v2.sql
20260810000114_import_execution_integrity.sql
20260810000119_import_awaiting_domain_apply.sql
```

已有命令队列：

```text
employee_invite_imports
opening_stock_import_requests
```

当前 UI 已将未闭环类型隐藏。

Agent-07 的目标是“消费已有 Queue”，不是重新设计 Import Wizard。

---

# 9. Messaging

```text
api/routes/messaging.ts
api/services/messaging/**
api/providers/**
20260810000112
115
118
121
```

现有核心已通过 Source Gate：

```text
idempotent create
initial CAS claim
retry CAS
sending state
attempt history
delivery snapshots
```

Agent-08 只能扩展：

```text
webhook
provider event
sms/wechat adapter
permission granularity
```

禁止破坏 `engine.ts` 现有 CAS。

---

# 10. Frontend 统一组件

```text
useAppTenantStore()
useStoreScopedPage()
usePageUnsavedGuard()
PermissionButton
```

新 Store-scoped 页面必须跟随当前门店变化刷新。

有编辑表单必须考虑 Unsaved Guard。

---

# 11. E2E

```text
e2e/playwright.config.ts
e2e/tests/closed-loop-a.spec.ts
closed-loop-b-inventory.spec.ts
closed-loop-c-inpatient.spec.ts
```

当前 E2E workers=1，避免同账号并发风控。

Source13 的：

```text
scripts/e2e-setup.sh
```

仍有：

- destructive reset 在前；
- 环境变量未先强校验；
- `PGPASSWORD="$E2E_ACCOUNT_PASSWORD"` 语义错误。

这是 Agent-01 首要修复。

---

# 12. Vercel/ESM

Source13 自身仍显示：

```text
package.json: "type": "module"
api/tsconfig.json: moduleResolution="bundler"
```

但用户已确认 Source13 后的线上 ESM P0 已修复。

因此 Agent-02：

```text
CURRENT MAIN > SOURCE13
```

对 ESM 部署文件必须以当前 main 为真源，Source13 只用于理解问题来源。

绝对禁止把 Source13 的旧 tsconfig 恢复回 main。
