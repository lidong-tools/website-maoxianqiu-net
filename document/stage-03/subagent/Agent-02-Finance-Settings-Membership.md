> 项目：毛线球宠物医院 SaaS  
> 基线代码：`website-maoxianqiu-net-main (9)`  
> 阶段：Stage-03 / S3.1 并发加速开发  
> 原则：**一个文件只能有一个写入 Owner；跨域修改必须通过 Handoff，由最终 Integrator 处理。**  
> E2E：当前独立执行，本批任务不得修改 `e2e/**`，也不以 E2E 完成作为本批开发验收条件。  

# Agent-02 — Billing / Settings / Approval + 新需求：会员与积分产品化

## 1. 任务目标

### 当前 P0

- `system_settings` Tenant Default 唯一性；
- 设置值强类型；
- 设置真正驱动收费规则；
- Cashier 现金找零；
- 0 元/挂账语义；
- Payment Context 真正驱动收银；
- Approval 禁止自审；
- Approval Counts / 分页；
- 设置写操作审计。

### 新需求

把已经存在数据库底座的：

```text
会员等级
客户会员关系
积分账户
积分流水
```

从“有表/有 API”升级成完整产品模块。

新增：

```text
会员中心
+
会员折扣规则
+
收费时实际使用会员规则
```

---

# 2. Ownership

允许：

```text
api/routes/billing.ts
api/routes/settings.ts
api/routes/approvals.ts
api/routes/operations.ts     # 会员/积分相关段

apps/maoxianqiu/src/views/billing/**
apps/maoxianqiu/src/views/system/settings/**
apps/maoxianqiu/src/views/operations/approvals/**
apps/maoxianqiu/src/views/operations/memberships/**

apps/maoxianqiu/src/router/modules/billing.ts
apps/maoxianqiu/src/router/modules/operations.ts

apps/maoxianqiu/src/api/modules/operations.ts
apps/maoxianqiu/src/types/operations.ts
```

Migration：

```text
20260810000056_*
20260810000057_*
20260810000058_*
```

---

# 3. 禁止

```text
api/index.ts
router/routes.ts

clinical/**
diagnostics/**
crm/**
inventory/**
inpatient/**
e2e/**
```

---

# 4. 先完成 Settings 真实性

必须解决：

```text
UI 设置折扣审批阈值
↓
真实 Billing RPC 读取同一值
```

建立可信函数：

```text
get_effective_setting(
  tenant,
  store,
  namespace,
  key
)
```

优先级：

```text
Store Override
Tenant Default
System Default
```

---

# 5. 修复 Settings UNIQUE

现有：

```text
tenant_id + NULL store_id + namespace + key
```

必须真正唯一。

升级前：

```text
检测重复
保留最新
清理旧数据
再加正确 UNIQUE
```

---

# 6. 设置 Registry

禁止 Generic API 接受任意 value。

建立 Schema：

```text
billing.discount.approval.threshold
billing.refund.approval.threshold
inventory.adjustment.approval.threshold
inventory.transfer.approval.threshold
inventory.near_expiry.reminder.days
```

至少确保：

```text
类型
范围
必填
```

正确。

---

# 7. Cashier 找零

区分：

```text
Tendered Amount
Applied Payment
Change
```

现金：

```text
Due = 90
Tendered = 100
Applied = 90
Change = 10
```

RPC 只冲销：

```text
90
```

非现金默认：

```text
Tendered = Applied = Due
```

---

# 8. 0 元/挂账

必须明确产品语义。

推荐：

```text
不允许实收=0 直接显示“收银成功”
```

如果支持挂账：

```text
[保存挂账]
```

单独动作。

不允许：

```text
未支付 Invoice
→ Toast 收银成功
```

---

# 9. Approval 禁止自审

至少：

```text
Invoice Discount
Medical Amendment
```

必须在可信 RPC：

```text
requester != reviewer
```

UI 也要提示：

```text
本人申请不可审批
```

---

# 10. 新需求：会员中心

新增：

```text
/operations/memberships
```

内部 Tabs：

```text
会员等级
客户会员
积分流水
折扣规则
```

---

# 11. 会员等级

复用已有：

```text
membership_tiers
```

支持：

```text
code
name
discount_percent
points_multiplier
is_active
sort_order
```

UI：

```text
等级
基础折扣
积分倍率
客户数
状态
```

禁止物理删除已使用等级。

---

# 12. 客户会员

复用：

```text
customer_memberships
```

列表：

```text
客户
等级
积分
加入时间
到期时间
状态
```

需要：

```text
客户姓名/手机
```

不能显示 Customer UUID 为主要识别。

支持：

```text
分配等级
调整有效期
```

---

# 13. 积分

复用：

```text
point_transactions
adjust_points RPC
```

要求：

```text
流水不可更新/删除
```

手工调整必须：

```text
reason
operator
audit
idempotency
```

---

# 14. 新增会员折扣规则

当前只有：

```text
membership_tiers.discount_percent
```

但 PRD 还要求：

```text
按目录类型
指定项目排除
适用门店
```

建议新增：

```text
membership_discount_rules
```

字段建议：

```text
id
tenant_id
tier_id
store_id nullable
catalog_type nullable
catalog_item_id nullable
discount_percent
priority
is_active
created_at
updated_at
```

规则：

```text
具体 Catalog Item
>
Catalog Type
>
Tier Default
```

Store Rule：

```text
Store
>
Tenant
```

---

# 15. 会员折扣真实接入 Billing

收费创建价格快照时：

```text
客户
↓
有效会员
↓
适用规则
↓
得出折扣
↓
写入 invoice item snapshot
```

历史发票：

```text
不因之后修改会员规则而变化
```

这是关键。

不能：

```text
查看老发票时重新计算当前折扣。
```

---

# 16. 本轮不做完整储值

虽然 PRD 有储值：

```text
充值
赠送金
余额流水
```

本 Agent 本轮**不新建完整钱包**。

保留：

```text
stored_value payment method
```

但不要假装已经有真实储值账户。

在 Handoff 中把：

```text
Stored Value Wallet
```

列为下一阶段需求。

---

# 17. API

建议形成：

```text
GET/POST/PATCH membership tiers
GET/PATCH customer membership
GET point transactions
POST points adjust
GET/POST/PATCH discount rules
GET effective membership pricing preview
```

写操作必须：

```text
Hono + Permission + Audit
```

不要继续扩大 Browser direct write。

---

# 18. Permission

至少：

```text
membership.view
membership.manage
points.view
points.adjust
```

如果已有 code：

```text
复用
```

不要造重复近义权限。

---

# 19. 验收

```text
[ ] 15% 阈值真实生效
[ ] Cash 90/100/10 正常
[ ] 0 元不误报成功
[ ] Payment Context 真控制 Cashier
[ ] 本人不可自审
[ ] 会员等级管理可用
[ ] 客户可分配会员
[ ] 积分流水不可改
[ ] 手工积分调整可审计
[ ] Catalog 折扣规则可配置
[ ] Billing 使用真实会员折扣
[ ] 价格快照不被后续规则修改
[ ] Typecheck
[ ] Build
```

---

# 20. Handoff

```text
document/parallel-handoff/AGENT-02-HANDOFF.md
```

重点：

```text
Settings Registry
Discount Rule Priority
Cashier Payment Semantics
Membership Pricing Contract
```
