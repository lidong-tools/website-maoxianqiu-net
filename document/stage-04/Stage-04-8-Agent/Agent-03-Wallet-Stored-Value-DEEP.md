# Agent-03 — Wallet / Stored Value 深度执行指导

## 0. 需求目标

Stage03 PRD 明确要求：

```text
stored value
```

Source13 目前只有“储值概念的残留”，没有真正 Wallet Domain。

你的任务是建立：

```text
客户储值账户
充值
赠送
消费
退款返还
人工调整
冻结
不可变流水
收银集成
```

---

# 1. Source13 调研结论

必须先打开：

```text
supabase/migrations/20260806000015_crm_customers_pets.sql
20260806000018_operations.sql
20260806000020_billing.sql
20260810000056_membership_discount_rules.sql
20260810000057_membership_billing_integration.sql
20260809000040_daily_closing_rpc.sql
20260809000042_reconciliation_rpc.sql

api/routes/operations.ts
api/routes/billing.ts
api/routes/settings.ts
apps/maoxianqiu/src/views/operations/memberships/index.vue
apps/maoxianqiu/src/views/billing/cashier/index.vue
apps/maoxianqiu/src/types/billing.ts
apps/maoxianqiu/src/types/closing.ts
```

### Source13 当前事实

1. `customers` 仍有历史字段：

```text
member_level
member_points
balance
```

2. 但正式会员已经有：

```text
membership_tiers
customer_memberships
point_transactions
membership_discount_rules
```

3. `daily_closing` / `reconciliation` 已识别：

```text
stored_value
```

4. 但 Billing 核心仍不一致：

```text
payments.method constraint
api/routes/billing.ts z.enum
apps/.../types/billing.ts PaymentMethod
settings paymentContextSchema
```

主要还是：

```text
cash/wechat/alipay/card/other
```

### 强制结论

```text
customers.balance 不是 Stage04 Wallet 真源。
```

不能为了省事直接更新：

```sql
customers.balance = customers.balance - ?
```

---

# 2. Ownership

新建：

```text
api/routes/wallet.ts
api/services/wallet/**
apps/maoxianqiu/src/api/modules/wallet.ts
apps/maoxianqiu/src/types/wallet.ts
apps/maoxianqiu/src/views/operations/wallet/**
supabase/migrations/*200-*209*
supabase/tests/wallet*.sql
```

可以定点修改：

```text
api/routes/billing.ts
api/routes/settings.ts
apps/maoxianqiu/src/types/billing.ts
apps/maoxianqiu/src/views/billing/cashier/index.vue
```

但如果和 Agent-09 共享冲突，优先输出 Integration Snippet。

禁止修改历史 Migration。

---

# 3. Migration 设计

建议：

```text
200_stored_value_accounts
201_stored_value_ledger
202_stored_value_commands_rpc
203_stored_value_permissions
204_stored_value_billing_method
205_stored_value_refund_integration
206_stored_value_rls_lockdown
```

不要求机械用满号段。

---

# 4. Data Model

## stored_value_accounts

建议字段：

```text
id uuid PK
tenant_id uuid NOT NULL
customer_id uuid NOT NULL
currency text NOT NULL default 'CNY'
balance numeric(14,2) NOT NULL default 0
status active/frozen/closed
version bigint NOT NULL default 0
opened_at
closed_at
created_by
created_at
updated_at
```

Unique：

```text
tenant_id + customer_id + currency
```

Check：

```text
balance >= 0
```

### customer_id Scope

RPC 内必须验证 Customer：

```text
customers.tenant_id == account.tenant_id
```

不能只依赖 UUID 存在。

---

## stored_value_ledger

不可变：

```text
id
tenant_id
account_id
customer_id
direction credit/debit
type recharge/bonus/payment/refund/adjustment/reversal
amount
balance_before
balance_after
reference_type
reference_id
idempotency_key
operator_id
reason
metadata
created_at
```

Unique：

```text
tenant_id + idempotency_key
```

禁止 UPDATE/DELETE。

---

# 5. 余额一致性策略

推荐：

```text
Account.balance = 可快速读取快照
Ledger = 审计真相
```

每次事务：

```text
SELECT account FOR UPDATE
↓
校验状态/余额
↓
insert ledger
↓
update balance/version
↓
commit
```

不能：

```text
Node 读余额
Node 计算
普通 update
```

---

# 6. Command/RPC

建议内部 RPC：

```text
open_stored_value_account
credit_stored_value
debit_stored_value
refund_stored_value
adjust_stored_value
set_stored_value_account_status
```

也可使用一个通用 `post_stored_value_transaction`，但外部 Hono API 必须按业务意图拆开。

所有 RPC：

```text
service_role only
manifest
search_path=public
tenant scoped
```

---

# 7. API

建议：

```text
GET  /wallet/accounts?tenantId&customerId
GET  /wallet/accounts/:id/ledger
POST /wallet/accounts
POST /wallet/accounts/:id/recharge
POST /wallet/accounts/:id/adjust
POST /wallet/accounts/:id/freeze
POST /wallet/accounts/:id/unfreeze
```

Payment/Refund 不是通过 `/wallet/debit` 手工点。

收银应由 Billing Domain 调 Wallet Command。

---

# 8. Cashier Integration

Source13 `billing.ts` 的 `process_payment` 已经有成熟幂等模式。

Stage04 必须实现一个**原子业务顺序**。

推荐：

```text
Billing process stored_value payment
↓
锁 invoice
↓
锁 wallet account
↓
debit wallet
↓
insert payments(method=stored_value)
↓
update invoice paid_amount/status
↓
同事务完成
```

最安全方案：

```text
扩展 process_payment RPC
```

让 `stored_value` 在同一个 PostgreSQL 事务里扣 Wallet + 写 Payment。

不要：

```text
先 /wallet/debit
再 /billing/payments
```

否则第二步失败会造成余额已扣但发票未支付。

---

# 9. Billing Schema 必须统一

需要 Forward Migration 同步：

```text
payments_method_check
invoices_payment_method_check（如继续使用）
payment_contexts method constraint（如果 DB 有）
```

加入：

```text
stored_value
```

后端：

```text
api/routes/billing.ts
api/routes/settings.ts
```

前端：

```text
apps/.../types/billing.ts
cashier
```

必须一致。

只改 UI：

```text
任务失败
```

---

# 10. Refund

如果原 Payment：

```text
method=stored_value
```

退款必须：

```text
process_refund
↓
Wallet credit refund
↓
refund row
↓
invoice status
```

同事务。

不得允许：

```text
Refund 到 Wallet
但 refunds 表失败
```

---

# 11. Recharge

Recharge 是“钱进入储值账户”，它本身需要一个支付来源。

至少记录：

```text
recharge source
external payment method
external transaction no
cashier operator
```

不要把充值当成凭空 `credit`。

赠送金：

```text
bonus
```

与本金建议在 ledger type 上区分。

如果产品暂不区分本金/赠送余额，不要假装已经支持“赠送金优先消费”。

---

# 12. Legacy customers.balance

必须决定：

### 推荐

```text
不再作为业务真源
```

新页面不读它。

可以：

- 暂时保留字段兼容；
- 文档标 deprecated；
- 不做双写，避免两套余额漂移。

若确实需要 Legacy UI 兼容，必须由同一事务镜像，且明确最终移除计划。

---

# 13. Permission

建议：

```text
wallet.view
wallet.recharge
wallet.adjust
wallet.freeze
```

不要只给一个 `wallet.manage` 包打天下。

`wallet.adjust` 应只给：

```text
tenant_owner / finance manager
```

普通 cashier 不应随意人工调账。

---

# 14. Frontend

在 Membership/Operations 下新增：

```text
储值账户
```

页面至少：

```text
客户搜索
余额
状态
充值
流水
调整
冻结
```

高风险操作：

```text
二次确认
reason mandatory
PermissionButton
```

Cashier：

```text
选择 stored_value 时显示：
余额
本次扣款
扣后余额
```

实际权威校验仍在 Server。

---

# 15. 测试

SQL/Runtime 必须：

```text
充值 100
重复同 idempotency → 仍 100
并发 debit 80 + 80 → 只有一个成功
余额不负
frozen account 不能扣
cross tenant customer → fail
refund replay → 只返一次
manual adjust 无权限 → fail
ledger update/delete → fail
```

Billing：

```text
stored_value payment
partial stored_value
refund stored_value
daily closing channel
reconciliation
```

---

# 16. 失败条件

以下任一出现直接不通过：

```text
使用 customers.balance 做真源
前端直接更新余额
Debit 和 Payment 两事务
Wallet ledger 可 UPDATE/DELETE
无 tenant idempotency
stored_value 只改前端 enum
退款不回 Wallet
```

---

# 17. Handoff

额外必须提供：

```text
WALLET_TRUTH_SOURCE
BILLING_ATOMICITY
LEGACY_BALANCE_DECISION
PAYMENT_METHOD_SCHEMA_CHANGES
RPC_LOCKING_STRATEGY
```

---

# 18. Commit

```text
feat(stage04-03): implement transactional stored value wallet
```
