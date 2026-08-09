# Agent-07 — Supply Chain & Import 深度执行指导

## 0. 合并范围

你负责：

```text
Purchase Request
Purchase Return
Employee Import Consumer
Opening Stock Import Consumer
```

目标是补现有采购/库存前后链，不重写现有 PO 和 Import V2。

---

# 1. Source13 调研

必须阅读：

```text
api/routes/inventory.ts
supabase/migrations/20260806000017_inventory.sql
20260810000065_suppliers.sql
20260810000066_purchase_orders.sql
20260810000067_purchase_lifecycle_rpc.sql
20260810000068_purchase_receive_rpc.sql
20260810000069_purchase_post_rpc.sql
20260810000096_purchasing_integrity.sql

api/routes/imports.ts
api/services/imports/**
20260810000100_import_center_v2.sql
20260810000114_import_execution_integrity.sql
20260810000119_import_awaiting_domain_apply.sql

api/routes/employees.ts
```

Source13 已有：

```text
suppliers
purchase_orders
purchase_order_items
draft/submit/approve/cancel/receive/post
partially_received
goods receipt
inventory movement
opening_stock_import_requests
employee_invite_imports
```

---

# 2. 不允许做什么

```text
重写 purchase_orders
新建第二套 Inventory Balance
直接更新库存余额
Employee Import 直接写 auth.users
重新做 Import Wizard
把 awaiting_domain_apply 直接改 completed 而不 Apply
```

---

# 3. Purchase Request

建议：

```text
purchase_requests
purchase_request_items
purchase_request_approvals（若复用 approvals 不合适）
```

状态：

```text
draft
submitted
approved
rejected
converted_to_po
cancelled
```

字段：

```text
tenant_id
store_id
warehouse_id
request_no
requester_id
reason
required_at
status
version
```

Item：

```text
catalog_item_id
requested_qty
unit
estimated_unit_cost
note
```

---

# 4. Request → PO

批准后可：

```text
convert to purchase order
```

必须复用现有 PO 创建逻辑。

推荐：

```text
RPC convert_purchase_request_to_po
```

事务：

```text
lock request
验证 approved
创建 PO draft
复制 items
写 source_request_id
request → converted_to_po
```

重复调用返回同一个 PO。

---

# 5. Purchase Return

建议：

```text
purchase_returns
purchase_return_items
```

状态：

```text
draft
submitted
approved
shipped
posted
cancelled
```

每个 Item 必须关联：

```text
original purchase_order
receipt / inventory movement
batch
catalog
warehouse
qty
```

---

# 6. Return Post

退货本质：

```text
库存减少
```

必须通过正式 Inventory Movement Command。

不能：

```sql
update inventory_batches set quantity=...
```

直接改。

RPC 需要：

```text
SELECT relevant batch FOR UPDATE
check available qty
insert negative/return movement
update derived balance if现有架构需要
mark return posted
```

幂等：

```text
tenant + idempotency
```

---

# 7. 采购财务边界

当前 PO 主要是库存采购，不一定已经有 AP 应付账款。

不要擅自引入完整会计系统。

本阶段退货只需要记录：

```text
return amount snapshot
supplier
source PO
```

若产生退款/应付冲销：

```text
留 Integration Event / field
```

不要假装完整财务总账。

---

# 8. Employee Import Consumer

Source13 `employee_invite_imports` 已含：

```text
tenant_id
store_id
email
name
role/store data
status pending
```

Consumer 必须调用现有 IAM 领域：

```text
api/routes/employees.ts
invite
assign-store
change-role
```

更好做法：

```text
抽取 employees domain service
```

由 Route 和 Import Consumer 共用。

不要从 Consumer HTTP 调自己 API。

---

# 9. Employee Consumer 状态

建议：

```text
pending
processing
applied
failed
```

Claim：

```text
pending → processing CAS
```

成功记录：

```text
employee_id / invited_user_id
applied_at
```

失败：

```text
error_code
error_message
```

重试应可控。

---

# 10. Opening Stock Consumer

Source13 已生成：

```text
opening_stock_import_requests
```

Consumer 应调用新的/现有 Inventory Opening Command。

Opening Stock 不是普通 Receipt：

```text
source_type=opening_stock_import
```

但最终必须落：

```text
inventory_movements
batch
```

与现有库存真源一致。

---

# 11. Import Job 收口

当一个 Import Job 下所有 Domain Requests：

```text
applied
```

才可：

```text
awaiting_domain_apply → completed
```

有失败：

```text
partially_completed 或 failed
```

取决于是否已有成功。

不要成功 99 行失败 1 行仍标 completed。

---

# 12. Worker 模式

Source13 有 `jobs` 表，但未必有完整 Worker Runtime。

首版可：

```text
POST /imports/:id/apply
```

由管理用户触发消费。

也可同步消费小批量。

如果使用 job queue，必须同时实现 Consumer Runner，不允许“只 insert jobs”。

---

# 13. API

建议：

```text
/purchase-requests
/purchase-requests/:id/submit
/purchase-requests/:id/approve
/purchase-requests/:id/reject
/purchase-requests/:id/convert

/purchase-returns
/purchase-returns/:id/submit
/purchase-returns/:id/approve
/purchase-returns/:id/post

/imports/:id/apply-domain
/import-consumers/employee/:id/retry
/import-consumers/opening-stock/:id/retry
```

---

# 14. Permission

```text
purchase_request.view
purchase_request.manage
purchase_request.approve
purchase_return.view
purchase_return.manage
purchase_return.approve
imports.employee.execute
imports.opening_stock.execute
```

不要默认复用 `inventory.manage` 处理所有审批。

---

# 15. Frontend

Inventory：

```text
采购申请
采购退货
```

Import Center：

当 Admin 有对应权限：

```text
Employee / Opening Stock 类型重新启用
```

但只有 Consumer Runtime 已完成后才能打开。

如果 Consumer 未 runtime verified：

```text
继续隐藏
```

---

# 16. 并发测试

```text
same request convert twice → same PO
approve by requester forbidden（若 policy）
return qty > received → fail
return twice post → one movement
two returns same batch overdraw → one fail
employee consumer double claim
opening stock double apply
cross tenant warehouse
supplier mismatch
```

---

# 17. 失败条件

```text
退货直接改库存数量
Opening Stock 另建库存真源
Import Job 未 Apply 就 completed
Employee Consumer 直接 auth admin 写用户且绕过 IAM Domain
采购申请批准后重复生成多个 PO
```

---

# 18. Handoff

必须：

```text
PURCHASE_REQUEST_TO_PO_CONTRACT
RETURN_INVENTORY_MOVEMENT_TYPE
RETURN_FINANCE_BOUNDARY
EMPLOYEE_CONSUMER_DOMAIN_CALL
OPENING_STOCK_COMMAND
IMPORT_TERMINAL_STATE_RULE
```

---

# 19. Commit

```text
feat(stage04-07): complete supply chain and import consumers
```
