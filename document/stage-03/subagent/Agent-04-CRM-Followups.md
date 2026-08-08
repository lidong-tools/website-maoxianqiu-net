> 项目：毛线球宠物医院 SaaS  
> 基线代码：`website-maoxianqiu-net-main (9)`  
> 阶段：Stage-03 / S3.1 并发加速开发  
> 原则：**一个文件只能有一个写入 Owner；跨域修改必须通过 Handoff，由最终 Integrator 处理。**  
> E2E：当前独立执行，本批任务不得修改 `e2e/**`，也不以 E2E 完成作为本批开发验收条件。  

# Agent-04 — CRM + 新需求：客户回访任务

## 1. 目标

### 当前收口

- Customer Import 死入口；
- Customer Detail 就诊历史占位；
- Customer 360 补齐；
- CRM Raw ID / Status / DateTime；
- 客户业务深链。

### 新需求

实现 Stage-03 已明确要求的：

```text
最小回访任务
```

流程：

```text
pending
→ in_progress
→ completed

pending/in_progress
→ cancelled
```

核心原则：

```text
消息发送成功 ≠ 回访完成
```

---

# 2. Ownership

```text
api/routes/customers.ts
api/routes/pets.ts

apps/maoxianqiu/src/views/crm/**
apps/maoxianqiu/src/router/modules/crm.ts
apps/maoxianqiu/src/api/modules/customer*
apps/maoxianqiu/src/types/customer*
apps/maoxianqiu/src/components/followups/**
```

Migration：

```text
20260810000062_*
20260810000063_*
20260810000064_*
```

---

# 3. 禁止

```text
api/index.ts
router/routes.ts

clinical/**
inpatient/**
billing/**
inventory/**
diagnostics/**
e2e/**
```

若需要 Encounter/Discharge 自动触发：

```text
写 Handoff
```

不要跨域改。

---

# 4. 先清理 Customer 现有占位

## Customer Import

当前客户页：

```text
导入功能开发中
```

改为真实 Deep Link：

```text
/operations/imports?type=customers&action=create
```

不要修改 Import Center 源码，除非只通过 query contract。

---

# 5. Customer 360

Customer Detail 至少真实显示：

```text
客户基本信息
宠物
最近就诊
最近消费
会员摘要（如 Agent-02 已集成则消费其 DTO）
回访任务
```

当前“就诊历史开发中”必须删除。

可以通过 Hono 聚合：

```http
GET /api/customers/:id/360
```

---

# 6. 新需求：followup_tasks

建议表：

```text
followup_tasks
```

字段：

```text
id
tenant_id
store_id
customer_id
pet_id nullable

source_type
source_id nullable

task_type
scheduled_at
assignee_employee_id

channel
status

result_code nullable
result_note nullable
started_at nullable
completed_at nullable
completed_by nullable

next_followup_at nullable

created_by
created_at
updated_at
```

---

# 7. source_type

允许：

```text
manual
encounter
discharge
reminder
complaint
```

MVP 不要塞：

```text
AI
营销活动
流失模型
```

---

# 8. task_type

建议：

```text
post_visit
post_discharge
medication
recheck
customer_care
other
```

---

# 9. 状态机

```text
pending → in_progress
pending → cancelled

in_progress → completed
in_progress → cancelled
```

完成必须有：

```text
result
```

取消必须：

```text
reason
```

---

# 10. UI

新增：

```text
/crm/followups
```

页面：

```text
逾期
今天
未来
已完成

时间
客户/宠物
来源
任务类型
负责人
状态
下一步
```

行 Primary：

```text
pending → 开始
in_progress → 登记结果
```

---

# 11. Detail Drawer

显示：

```text
客户
宠物
来源业务
负责人
计划时间
历史记录
结果
下一次回访
```

Deep Link：

```text
客户
宠物
来源 Encounter / Admission
```

如果跨域目标 route 已存在，使用 route name。

---

# 12. 客户详情嵌入

Customer Detail 新增：

```text
回访
```

Tab：

```text
待办
历史
[新建回访]
```

---

# 13. 自动触发边界

本 Agent 只完成：

```text
Manual Create
+
API 能接受 source_type/source_id
```

以下自动 Hook 写入 Handoff：

```text
Encounter Follow-up Date
→ 生成 follow-up task

Discharge Finalized
→ 生成 post-discharge follow-up
```

由 Agent-07 与相应 Domain Owner 合并。

这样避免 Agent-04 修改：

```text
clinical.ts
inpatient.ts
```

---

# 14. Permission

建议：

```text
followup.view
followup.manage
followup.complete
```

负责人只能看到自己任务还是门店全部任务：

MVP：

```text
有 followup.view
→ 当前 Store 全部

无 view 但业务需要个人任务
→ 后续再设计 self scope
```

不要临时创造不完整 self permission。

---

# 15. 回访结果与沟通记录

MVP 可以：

```text
结果直接保存在 followup_tasks
```

不要为了“沟通记录”立即增加另一套复杂 CRM Timeline 表。

Handoff 中注明：

```text
未来 Customer Communications 可以消费 Followup Completed Event。
```

---

# 16. 不做

```text
AI 回访
自动短信
自动拨号
客户流失评分
营销同意
优惠券召回
```

---

# 17. 验收

```text
[ ] Customer Import 不再死入口
[ ] Customer Detail 有真实就诊历史
[ ] Customer 360 正常
[ ] Followup 创建
[ ] 开始
[ ] 完成
[ ] 取消
[ ] 结果必填
[ ] next_followup_at 可形成下一任务建议
[ ] Tenant/Store Scope
[ ] Permission
[ ] Audit
[ ] Customer Detail 嵌入
[ ] Typecheck
[ ] Build
```

---

# 18. Handoff

```text
document/parallel-handoff/AGENT-04-HANDOFF.md
```

特别写：

```text
Encounter Hook
Discharge Hook
Import Deep Link Contract
Customer360 DTO
```
