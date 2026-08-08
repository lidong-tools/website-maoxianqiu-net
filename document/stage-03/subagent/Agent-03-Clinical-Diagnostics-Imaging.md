> 项目：毛线球宠物医院 SaaS  
> 基线代码：`website-maoxianqiu-net-main (9)`  
> 阶段：Stage-03 / S3.1 并发加速开发  
> 原则：**一个文件只能有一个写入 Owner；跨域修改必须通过 Handoff，由最终 Integrator 处理。**  
> E2E：当前独立执行，本批任务不得修改 `e2e/**`，也不以 E2E 完成作为本批开发验收条件。  

# Agent-03 — Clinical / Diagnostics + 新需求：影像工作流

## 1. 任务目标

### 当前 P0

- 医生工作台只显示真实候诊；
- 当前宠物历史；
- 当前 Encounter 检验；
- Workbench Dirty Guard；
- Encounter 409 Conflict UX；
- Lab Workflow 统一；
- Lab Dirty Guard；
- 每个状态一个 Primary Action。

### 新需求

实现 PRD §12.3：

```text
B 超
X 光 / CR
CT / MRI 预留
```

流程：

```text
申请
→ 预约
→ 执行
→ 上传影像/附件
→ 报告
→ 审核
→ 发布
```

MVP：

```text
只做工作流 + 文件 + 报告
不做 DICOM PACS
```

---

# 2. Ownership

```text
api/routes/clinical.ts
api/routes/diagnostics.ts
api/routes/compliance.ts   # 仅医疗修订必要部分

apps/maoxianqiu/src/views/clinical/**
apps/maoxianqiu/src/views/diagnostics/**
apps/maoxianqiu/src/router/modules/clinical.ts
apps/maoxianqiu/src/router/modules/diagnostics.ts

apps/maoxianqiu/src/api/modules/clinical.ts
apps/maoxianqiu/src/api/modules/diagnostics.ts
apps/maoxianqiu/src/types/clinical.ts
apps/maoxianqiu/src/types/diagnostics.ts
```

Migration：

```text
20260810000059_*
20260810000060_*
20260810000061_*
```

---

# 3. 禁止

```text
api/index.ts
router/routes.ts

billing/**
settings/**
crm/**
inventory/**
inpatient/**
e2e/**
```

---

# 4. 医生工作台收口

左栏只允许：

```text
checked_in
in_progress
```

行为：

```text
checked_in → 开始接诊
in_progress → 打开已有 Encounter
```

取消、未到店、完成预约不得出现在当前候诊主队列。

---

# 5. 患者历史 Scope

选中患者后：

```text
最近就诊
=
当前 pet_id
```

右侧检验：

```text
=
current encounter_id
```

禁止把宠物所有历史检验混入“本次就诊”。

---

# 6. Dirty Guard

必须覆盖：

```text
切患者
切路由
切门店
刷新/关闭页面
```

已经自动保存成功时：

```text
clean
```

---

# 7. 409 Conflict UX

收到版本冲突：

```text
病历已被其他人更新
```

提供：

```text
查看最新
复制我的未保存内容
取消
```

禁止自动覆盖。

---

# 8. Lab Workflow

后端输出统一：

```text
workflowStage
primaryAction
canEditResult
canReview
canPublish
```

前端不再自行拼：

```text
lab_order.status
+
lab_sample.status
+
review
```

---

# 9. 新需求：影像数据模型

建议新增：

```text
imaging_orders
imaging_reports
```

### imaging_orders

```text
id
tenant_id
store_id
order_no
encounter_id
customer_id
pet_id
requested_by
imaging_type
catalog_item_id
scheduled_at
performed_at
performed_by
status
clinical_question
notes
created_at
updated_at
```

状态：

```text
requested
scheduled
in_progress
performed
reported
reviewed
published
cancelled
```

### imaging_reports

```text
id
tenant_id
store_id
imaging_order_id
findings
impression
recommendation
author_id
reviewer_id
status
version
published_at
created_at
updated_at
```

---

# 10. 影像附件

必须复用现有：

```text
files
attachments
R2
```

不要新建：

```text
imaging_files
```

除非 attachments 模型确实无法表达实体关联。

附件类型：

```text
source images
report attachment
external report
```

大文件使用现有预签名直传机制。

---

# 11. 影像 UI

新增：

```text
/diagnostics/imaging
```

工作台：

```text
Stage Tabs
待预约
待执行
待报告
待审核
已发布

左：
影像申请列表

右：
患者摘要
临床问题
附件
报告
审核状态
```

---

# 12. 新建影像申请

医生工作台内增加：

```text
[申请影像]
```

由 Agent-03 自己完成，因为 Clinical 与 Diagnostics 都归本 Agent。

字段：

```text
患者
Encounter
影像类型
项目
临床问题
期望时间
```

---

# 13. 报告

报告支持：

```text
Findings
Impression
Recommendation
```

审核后：

```text
不可直接修改原发布版本
```

如需修改：

```text
产生新版本
```

至少保留：

```text
version
author
reviewer
published_at
```

---

# 14. 权限

建议：

```text
imaging.view
imaging.order
imaging.perform
imaging.report
imaging.review
imaging.publish
```

使用实际岗位：

```text
doctor
imaging technician
review doctor
```

映射。

---

# 15. Audit

必须审计：

```text
create order
perform
report edit
review
publish
cancel
```

---

# 16. 不做

```text
DICOM Storage
PACS
影像测量工具
设备 Worklist 协议
云阅片
AI 读片
```

---

# 17. 验收

```text
[ ] Workbench 真候诊
[ ] 当前宠物历史正确
[ ] 当前 Encounter Lab 正确
[ ] Workbench Dirty Guard
[ ] Conflict UX
[ ] Lab 状态一致
[ ] Imaging 创建
[ ] Imaging 排程
[ ] 执行
[ ] 文件上传
[ ] 报告
[ ] 审核
[ ] 发布
[ ] 已发布报告不可静默覆盖
[ ] Tenant/Store 隔离
[ ] Audit
[ ] Typecheck
[ ] Build
```

---

# 18. Handoff

```text
document/parallel-handoff/AGENT-03-HANDOFF.md
```

明确：

```text
Imaging State Machine
Attachment Entity Type
Clinical Workbench Hook
Permission Codes
```
