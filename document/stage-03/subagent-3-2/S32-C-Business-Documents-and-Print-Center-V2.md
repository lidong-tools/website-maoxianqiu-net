> 项目：毛线球宠物医院 SaaS  
> 阶段：Stage-03 / S3.2 并发功能开发  
> 基线：在 S3.1 Fix Pipeline 仍独立执行的前提下，从当前稳定 Main/Base Commit 创建本批 Feature 分支。  
> 核心原则：**S3.2 Agent 不得修改 S3.1 Fix 正在修复的 IAM、Billing 核心、Clinical 核心、Inventory 核心安全边界。**  
> E2E：继续独立运行。本批 Agent 不修改 `e2e/**`。  
> 文件 Ownership：一个生产文件只能有一个写入 Owner；跨域需求只能写 Handoff，不得直接修改其他 Agent 所属文件。  

# S32-C — 业务文档与打印中心 V2

## 1. 目标

把现有 Print Center 升级成：

```text
业务文档中心
```

支持：

```text
处方
收费单
病历摘要
检验报告
影像报告
住院出院记录
疫苗证明
寄养交接单
```

---

# 2. Ownership

```text
api/routes/documents.ts
api/services/documents/**
apps/maoxianqiu/src/views/operations/documents/**
apps/maoxianqiu/src/api/modules/documents*
apps/maoxianqiu/src/types/documents*
apps/maoxianqiu/src/components/documents/**
```

Migration：

```text
108–111
```

---

# 3. 禁止

```text
billing core
clinical core
diagnostics core
inpatient core
settings core
e2e/**
```

读取业务对象允许。

写入其它 Domain 禁止。

---

# 4. 文档类型

定义：

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

---

# 5. 模板模型

建议新增：

```text
document_templates
```

字段：

```text
id
tenant_id
store_id nullable
document_type
name
version
template_json / template_html
paper_size
is_default
is_active
created_by
created_at
updated_at
```

读取优先级：

```text
Store Default
Tenant Default
System Default
```

---

# 6. 不允许模板直接执行任意 JS

模板只能使用安全变量：

```text
{{hospital.name}}
{{store.name}}
{{customer.name}}
{{pet.name}}
{{invoice.total}}
```

禁止：

```text
eval
script
任意 JS 表达式
```

---

# 7. 文档渲染

建议：

```text
Business DTO
↓
Document Data Adapter
↓
Template Renderer
↓
HTML
↓
Print / PDF
```

每种业务对象都通过 Adapter。

不要模板直接查询数据库。

---

# 8. API

```http
GET  /api/documents/templates
POST /api/documents/templates
PATCH /api/documents/templates/:id

POST /api/documents/preview
POST /api/documents/render
GET  /api/documents/history
```

---

# 9. Preview

Preview 是核心：

```text
左：
模板/纸型

右：
实时文档预览
```

支持：

```text
A4
80mm
58mm
```

---

# 10. PDF

如果后端已有成熟 PDF 生成能力：

```text
复用
```

否则第一阶段：

```text
Browser Print
```

也可以。

不要为了 PDF 引入重量很大的外部服务。

---

# 11. 打印历史

如果现有：

```text
print_jobs
```

可复用。

至少记录：

```text
document_type
entity_type
entity_id
template_id
operator
printed_at
```

---

# 12. 权限

建议：

```text
documents.view
documents.print
documents.template.manage
```

高风险：

```text
医疗报告
处方
```

必须在读取业务 DTO 时重新验证业务权限。

---

# 13. 审计

至少：

```text
template create/update
document render
document print
```

对于医疗文档：

```text
打印行为建议写 Audit。
```

---

# 14. 与 Settings 的边界

模板中的：

```text
Logo
医院名称
门店信息
```

只读取 Settings/Tenant/Store。

本 Agent：

```text
不修改 System Settings 页面
```

如果需要模板入口：

```text
写 Handoff
```

---

# 15. 业务 Adapter

至少：

```text
InvoiceDocumentAdapter
PrescriptionDocumentAdapter
LabReportDocumentAdapter
ImagingReportDocumentAdapter
DischargeDocumentAdapter
VaccinationDocumentAdapter
BoardingDocumentAdapter
```

如果某业务域当前 DTO 不足：

```text
写 Handoff
```

不要跨域改 API。

---

# 16. 不做

```text
电子签章 CA
第三方打印驱动协议
复杂 Office 编辑器
Word 导出
WYSIWYG 全功能设计器
```

模板编辑第一版可以：

```text
表单配置 + Preview
```

---

# 17. 验收

```text
[ ] 8 类业务文档
[ ] Template
[ ] Tenant Default
[ ] Store Override
[ ] A4
[ ] 80mm
[ ] Preview
[ ] Print
[ ] History
[ ] 医疗权限
[ ] Audit
[ ] 无任意脚本执行
[ ] Typecheck
[ ] Build
```

---

# 18. Handoff

```text
document/s32-handoff/S32-C-HANDOFF.md
```

必须列：

```text
各 Domain Adapter 输入字段
缺失 DTO
Settings Hook
Route
Permission
```
