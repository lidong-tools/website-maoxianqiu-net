> 项目：毛线球宠物医院 SaaS  
> 基线代码：`website-maoxianqiu-net-main (9)`  
> 阶段：Stage-03 / S3.1 并发加速开发  
> 原则：**一个文件只能有一个写入 Owner；跨域修改必须通过 Handoff，由最终 Integrator 处理。**  
> E2E：当前独立执行，本批任务不得修改 `e2e/**`，也不以 E2E 完成作为本批开发验收条件。  

# Agent-05 — Inventory + 新需求：供应商与采购订单

## 1. 目标

保持当前：

```text
快速入库
盘点
调拨
```

不被破坏。

新增正式采购基础闭环：

```text
供应商
↓
采购单草稿
↓
提交
↓
审核
↓
收货
↓
过账
↓
库存增加
```

本轮不做完整 ERP 应付。

---

# 2. Ownership

```text
api/routes/inventory.ts

apps/maoxianqiu/src/views/inventory/**
apps/maoxianqiu/src/router/modules/inventory.ts
apps/maoxianqiu/src/api/modules/inventory*
apps/maoxianqiu/src/types/inventory*
apps/maoxianqiu/src/components/purchasing/**
```

Migration：

```text
20260810000065_*
20260810000066_*
20260810000067_*
20260810000068_*
20260810000069_*
```

---

# 3. 禁止

```text
api/index.ts
router/routes.ts

billing/**
settings/**
clinical/**
crm/**
inpatient/**
e2e/**
```

---

# 4. 供应商

新增：

```text
suppliers
```

建议：

```text
id
tenant_id
supplier_no
name
contact_name
phone
address
unified_credit_code
payment_terms
status
categories
notes
created_at
updated_at
```

供应商 Tenant 级。

状态：

```text
active
inactive
```

---

# 5. 采购订单

新增：

```text
purchase_orders
purchase_order_items
```

Header：

```text
tenant_id
store_id
warehouse_id
po_no
supplier_id
status
expected_at
submitted_by/at
approved_by/at
posted_by/at
total_cost
note
created_at
updated_at
```

Item：

```text
catalog_item_id
ordered_qty
received_qty
unit_cost
batch_no
expires_at
```

---

# 6. 状态机

PRD：

```text
draft
→ submitted
→ approved
→ received
→ posted
```

可取消：

```text
draft/submitted → cancelled
```

规则：

- Draft 可编辑；
- Submitted 后不可直接修改 Item；
- Approved 后进入收货；
- Posted 后不可再修改；
- Posted 必须只执行一次。

---

# 7. 库存联动

**最关键原则：不复制库存算法。**

采购过账：

```text
Purchase
↓
调用既有 Inventory Receive/Post 能力
↓
生成 inventory_batches
↓
生成 inventory_transactions
```

不得新写第二套：

```text
quantity += ...
```

绕开库存不可变流水。

---

# 8. 幂等

过账必须：

```text
Idempotency Key
```

重复点击：

```text
只产生一次库存入库
```

---

# 9. UI：供应商

新增：

```text
/inventory/suppliers
```

页面：

```text
供应商
联系人
电话
账期
状态
最近采购
操作
```

Detail Drawer：

```text
基础信息
采购历史
```

---

# 10. UI：采购

新增：

```text
/inventory/purchasing
```

列表：

```text
采购单号
供应商
门店/仓库
状态
金额
预计到货
创建人
```

Detail：

```text
Header
+
vxe-table 明细
+
状态时间线
+
FixedBar
```

---

# 11. Draft 编辑

表格：

```text
商品
订购数量
采购价
批次（收货时）
效期（收货时）
金额
```

Draft 阶段：

```text
数量/成本
```

收货阶段再填：

```text
received quantity
batch
expiry
```

---

# 12. 审批

本轮采购审批可在采购详情内部完成。

如果未来统一 Approval Center：

```text
提交 Handoff
```

不要让 Agent-05 修改：

```text
api/routes/approvals.ts
```

MVP：

```text
inventory.purchase.approve
```

直接业务域 Command。

---

# 13. Permission

建议：

```text
supplier.view
supplier.manage

purchase.view
purchase.create
purchase.submit
purchase.approve
purchase.receive
purchase.post
```

复用现有角色：

```text
store_manager
inventory_manager / pharmacist
```

若不存在对应角色，不新增角色，只给现有合适角色映射权限。

---

# 14. 快速入库定位

原：

```text
/inventory/receipt
```

保留。

文案改为：

```text
快速入库
```

适合：

```text
临时补录
无采购单入库
```

采购订单过账：

```text
不跳快速入库表单
```

直接走库存事务能力。

---

# 15. 本轮不做

```text
采购申请预算
询价/比价
合同
应付账款
付款
发票匹配
复杂采购退货
```

采购退货只可：

```text
预留数据设计
```

不要阻塞闭环。

---

# 16. 验收

```text
[ ] 供应商 CRUD
[ ] Supplier Tenant Scope
[ ] 采购 Draft
[ ] Submit
[ ] Approve
[ ] Receive
[ ] Post
[ ] 重复 Post 不重复加库存
[ ] Inventory Transaction 一致
[ ] Posted 不可修改
[ ] 权限
[ ] Audit
[ ] 原快速入库不回归
[ ] Typecheck
[ ] Build
```

---

# 17. Handoff

```text
document/parallel-handoff/AGENT-05-HANDOFF.md
```

明确：

```text
Purchase State Machine
Inventory Post Contract
Approval Center Future Hook
Permission Codes
```
