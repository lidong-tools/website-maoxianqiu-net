> 项目：毛线球宠物医院 SaaS  
> 基线代码：`website-maoxianqiu-net-main (9)`  
> 阶段：Stage-03 / S3.1 并发加速开发  
> 原则：**一个文件只能有一个写入 Owner；跨域修改必须通过 Handoff，由最终 Integrator 处理。**  
> E2E：当前独立执行，本批任务不得修改 `e2e/**`，也不以 E2E 完成作为本批开发验收条件。  

# Agent-07 — 最终 Integrator / 收尾检查 Agent

> **本 Agent 不与 Agent-01~06 同时开发。**
>
> 启动条件：六个生产开发 Agent 均提交 HANDOFF 和 Commit。

# 1. 任务角色

你不是第七个“继续加功能”的 Agent。

你负责：

```text
合并
冲突解决
跨域 Hook
数据库顺序
权限一致性
源码复审
Build/Typecheck
状态文档
最终交付报告
```

禁止在没有必要时继续增加新需求。

---

# 2. 输入

必须拿到：

```text
AGENT-01-HANDOFF.md
AGENT-02-HANDOFF.md
AGENT-03-HANDOFF.md
AGENT-04-HANDOFF.md
AGENT-05-HANDOFF.md
AGENT-06-HANDOFF.md
```

以及每个 Agent 的：

```text
branch
commit hash
migration
验证结果
known issues
```

---

# 3. 第一阶段：基线确认

记录：

```text
BASE_COMMIT
```

检查每个分支：

```text
是否真的从同一 Base 开始
是否混入别的 Agent commit
是否修改越权文件
```

发现越权：

```text
不要直接接受
```

先检查原因。

---

# 4. 文件 Ownership 审计

生成：

```text
FILE-OWNERSHIP-REPORT.md
```

检查：

```text
01 是否改了 billing?
02 是否改了 clinical?
04 是否改了 inpatient?
05 是否改了 approvals?
...
```

允许的跨域文件：

必须在 HANDOFF 中解释。

---

# 5. Migration 审计

检查：

```text
54–55 Agent01
56–58 Agent02
59–61 Agent03
62–64 Agent04
65–69 Agent05
70–73 Agent06
```

确认：

```text
没有编号冲突
没有编辑旧 migration
可以空库按顺序应用
RLS 存在
索引合理
权限 code 无重复
```

---

# 6. 合并顺序

建议：

```text
Agent-01
Agent-02
Agent-04
Agent-05
Agent-06
Agent-03
```

每合并一个：

```text
pnpm typecheck
必要 package build
```

不要六个分支一次性 merge 后才看问题。

---

# 7. api/index.ts

只有本 Agent 允许最终修改。

如果 Agent 都在既有 Domain Route 内扩展：

```text
不需要修改。
```

如果新 route 文件必须注册：

统一在这里完成。

避免：

```text
6 个 Agent 同时 import route。
```

---

# 8. router/routes.ts

本批新需求都应放入既有业务分组：

```text
平台租户 → system
会员 → operations
影像 → diagnostics
回访 → crm
采购 → inventory
寄养 → inpatient
```

因此原则上：

```text
router/routes.ts 不需要新增一级模块。
```

如 Agent 修改了 routes.ts：

优先撤销并归回相应 module。

---

# 9. 跨域 Hook 处理

## 9.1 Follow-up

检查 Agent-04 Handoff：

```text
Encounter Follow-up
Discharge Follow-up
```

集成时：

优先 Event/Command 方式。

不要让：

```text
clinical
```

直接操作 followup 表。

最简单可接受：

```text
业务完成
↓
调用内部 Followup Command
```

---

## 9.2 Boarding Billing

检查：

```text
寄养 Checkout
→ 生成 Invoice
```

必须决定事务失败策略：

```text
Invoice 创建失败
→ Boarding 不得标 checked_out
```

或进入：

```text
checkout_pending
```

禁止部分成功造成账务丢失。

---

## 9.3 Membership Billing

检查：

```text
会员折扣
```

是否在：

```text
发票创建时写价格快照
```

而不是读取当前规则渲染历史。

---

## 9.4 Purchasing Inventory

检查：

```text
Purchase Posted
```

是否调用同一套库存不可变流水。

禁止：

```text
直接 update balance
```

---

## 9.5 Imaging Clinical

检查：

```text
影像申请
```

是否关联：

```text
encounter_id
pet_id
customer_id
store_id
```

且 Workbench Deep Link 正确。

---

# 10. 权限统一审计

最终权限事实来源：

```text
employee_role_assignments
role_permissions
platform_user_roles
```

检查新模块权限：

```text
membership
imaging
followup
purchase
supplier
boarding
```

必须：

```text
服务端检查
+
前端显示
```

两边一致。

---

# 11. Tenant / Store 隔离

静态检查所有新 Query：

```text
tenant_id
store_id
```

不能缺。

平台级：

```text
Platform Admin
```

例外必须明确。

---

# 12. Audit

新模块关键 Command：

```text
Tenant Suspend/Resume
Membership Change
Points Adjust
Imaging Publish
Followup Complete
Purchase Approve/Post
Boarding Checkin/Checkout
```

必须产生 Audit。

---

# 13. System Settings 一致性

验证：

```text
UI 保存
↓
Effective Setting
↓
业务 RPC 真读取
```

重点：

```text
discount approval threshold
```

---

# 14. Cashier 收尾

检查：

```text
Due
Tendered
Applied
Change
```

确保：

```text
90 / 100 / 90 / 10
```

不会被 RPC 拒绝。

---

# 15. 状态机检查

逐项：

```text
Followup
Purchase
Imaging
Boarding
Approval
Lab
```

检查：

```text
UI 主按钮
API command
DB constraint
```

三者一致。

---

# 16. 生产占位扫描

运行搜索：

```text
开发中
即将上线
TODO
FIXME
mock
模拟
xyz@xyz.com
```

逐个判断：

### 允许

```text
dev/example
注释
明确 Feature Flag
```

### 不允许

```text
生产导航真实页面
```

---

# 17. Raw ID 扫描

检查：

```text
customer_id
pet_id
admission_id
catalog_item_id
supplier_id
```

是否直接作为业务页面主文本。

应该优先：

```text
名称
业务编号
手机号
床位
SKU
```

---

# 18. 时间 / 时区

所有新模块：

```text
Followup scheduled_at
Purchase expected_at
Imaging scheduled_at
Boarding time
Tenant trial_ends_at
```

必须使用统一业务时区格式化。

---

# 19. Dark Mode / Accessibility

检查：

```text
hard-coded gray/red/white
icon-only 无 aria-label
无 Tooltip
```

仅做必要修复。

不要在收尾阶段再重构整个视觉系统。

---

# 20. Typecheck / Build

必须在完整合并分支执行：

```text
pnpm install（标准项目环境已安装时不重复）
pnpm typecheck
pnpm build
```

按 Monorepo 实际 script 执行。

任何失败：

```text
不允许更新为 completed。
```

---

# 21. E2E 边界

本 Agent：

```text
不评价当前 E2E 完成度
```

因为 E2E 独立执行。

但是：

```text
不得修改 e2e 断言来迁就生产代码。
```

如果生产变更确实改变流程：

```text
生成 E2E-HANDOFF.md
```

交给当前 E2E Agent。

---

# 22. 更新文档

只有本 Agent 修改：

```text
document/current/IMPLEMENTATION_STATUS.md
document/current/KNOWN_GAPS.md
```

状态必须使用：

```text
implemented
verified
deferred
blocked
```

不要只有：

```text
完成
```

---

# 23. 最终状态建议

新功能未经过 Runtime/E2E 时：

```text
code_complete
integration_verified
runtime_verification_pending
```

不要写：

```text
production_ready
```

---

# 24. 最终必须输出

创建：

```text
document/parallel-final/
01-FINAL-INTEGRATION-REPORT.md
02-FILE-OWNERSHIP-REPORT.md
03-MIGRATION-REVIEW.md
04-PERMISSION-REVIEW.md
05-CROSS-DOMAIN-HOOKS.md
06-REMAINING-GAPS.md
07-E2E-HANDOFF.md
```

---

# 25. 最终检查清单

## Agent-01

```text
[ ] Permissions Single Source
[ ] Context
[ ] Platform Admin
[ ] Tenant List
[ ] Tenant Detail
[ ] Suspend/Resume
[ ] Store Detail
```

## Agent-02

```text
[ ] Settings Real
[ ] Cash Change
[ ] Self Approval Blocked
[ ] Membership
[ ] Points
[ ] Discount Rules
[ ] Billing Pricing Snapshot
```

## Agent-03

```text
[ ] Workbench Scope
[ ] Dirty Guard
[ ] Lab Workflow
[ ] Imaging
[ ] Report Version
```

## Agent-04

```text
[ ] Customer 360
[ ] Followup
[ ] Customer Import Deep Link
```

## Agent-05

```text
[ ] Supplier
[ ] Purchasing
[ ] Inventory Posting
```

## Agent-06

```text
[ ] Boarding
[ ] Cage Lock
[ ] Daily Record
[ ] Checkout Billing Hook
```

---

# 26. 最终停止条件

如果出现以下任一项：

```text
跨 Tenant 泄漏
权限前后端不一致
重复库存过账
收费金额不一致
医疗发布可静默覆盖
住院/寄养双占房位
自审批
Migration 不能顺序执行
```

停止宣告完成。

先修 P0。

---

# 27. 最终交付定义

完成后对用户提交新的完整代码包，并说明：

```text
已完成：
A01...
A02...
...

仍待：
E2E Runtime
外部 Provider
后续 P1
```

不要把独立 E2E 线未结束隐藏掉。

---

**你是最后一道源码质量门，不是最后一个继续堆需求的人。**
