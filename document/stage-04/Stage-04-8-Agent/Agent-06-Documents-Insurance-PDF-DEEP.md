# Agent-06 — Documents / Insurance / PDF / Archive / E-Signature 深度执行指导

## 0. 合并范围

你负责一条完整业务链：

```text
Insurance Claim Pack
↓
Documents Adapter
↓
PDF
↓
R2 Archive
↓
Hash
↓
Signature lifecycle
```

禁止保险 Agent 再造一套 PDF，也禁止 PDF Agent 脱离业务文档。

---

# 1. Source13 调研

必须阅读：

```text
api/routes/documents.ts
api/services/documents/index.ts
api/services/documents/renderer.ts
api/services/documents/types.ts
api/services/documents/base.ts
api/services/documents/adapters/**

supabase/migrations/20260810000108_document_templates.sql
20260810000109_document_default_templates.sql
20260810000113_document_template_write_boundary.sql

api/routes/files-v2.ts
api/lib/r2.ts
apps/maoxianqiu/src/types/file.ts

api/routes/clinical.ts
api/routes/diagnostics.ts
api/routes/billing.ts
api/routes/inpatient.ts
```

Source13 Document 已支持：

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

Template Scope：

```text
store → tenant → system
```

已有 `document_history`。

已有 R2 Private Files。

---

# 2. 非目标

不要：

```text
重写 Documents V2
创建第二套 Templates
创建第二套 Files/R2
让 Chromium 任意访问内网 URL
把 HTML 当最终不可变归档
声称内部签名就是法律可靠电子签名
```

---

# 3. Ownership

```text
api/routes/insurance.ts
api/routes/document-artifacts.ts
api/services/insurance/**
api/services/document-artifacts/**
api/providers/pdf/**
api/providers/signature/**
apps/.../api/modules/insurance.ts
apps/.../types/insurance.ts
apps/.../views/operations/insurance/**
supabase/migrations/*235-*249*
supabase/tests/insurance*
supabase/tests/document_artifacts*
```

现有 Documents 核心只做必要扩展。

---

# 4. Insurance Claim Pack

建议：

```text
insurance_claim_packs
insurance_claim_pack_items
insurance_claim_exports
```

Pack Header：

```text
id
tenant_id
store_id
customer_id
pet_id
encounter_id nullable
admission_id nullable
status draft/generated/archived/cancelled
version
created_by
created_at
updated_at
```

Items 不复制业务真相，记录引用：

```text
source_type
source_id
display_order
required
included
```

---

# 5. Pack 数据来源

按 Encounter/Admission 聚合：

```text
Customer
Pet
Encounter
Diagnosis
Prescription
Invoice / Items
Lab Reports
Imaging Reports
Discharge
Veterinarian
Store/License
```

必须只取：

```text
已签/已发布/合规可输出
```

例如：

```text
未发布 Lab
未发布 Imaging
Draft Prescription
```

不能进入正式理赔包。

---

# 6. Snapshot

生成时必须保留：

```text
source refs
source version/status
render data snapshot/hash
template version
```

否则半年后源数据合法修订后无法证明当时提交内容。

建议：

```text
insurance_claim_exports
```

存：

```text
pack_id
pack_version
data_snapshot jsonb
data_hash
document_archive_id
generated_by
generated_at
```

不要存无边界的所有医疗全文，保留必要字段。

---

# 7. PDF 设计

现有 `renderer.ts` 已将业务数据填 HTML。

Stage04 PDF：

```text
Rendered HTML
↓
Server PDF Renderer
↓
bytes/hash
↓
R2
↓
document_archive
```

Renderer 可以用 Chromium/Puppeteer，但：

```text
资源必须可控
```

### SSRF 防护

禁止 PDF HTML 加载：

```text
http://169.254.169.254
localhost
private network
任意外网
file://
```

默认：

```text
不允许网络资源
```

图片应：

```text
data URI
可信 R2 signed content
受控 static asset
```

---

# 8. PDF 性能

Vercel Serverless 可能对 Chromium：

```text
包大小
启动
内存
timeout
```

敏感。

你必须评估当前生产 Runtime。

若直接在 Vercel 不可靠：

```text
抽象 PdfProvider
```

允许：

```text
external rendering worker
```

但本 Agent 不允许静默假设 Puppeteer 一定适用。

Handoff 必须写实际选择与部署限制。

---

# 9. Archive Model

建议：

```text
document_archives
```

字段：

```text
id
tenant_id
store_id
document_type
entity_type
entity_id
document_history_id
template_id
template_version
file_id
sha256
mime_type
size_bytes
status active/superseded/archived
created_by
created_at
```

File 必须复用：

```text
public.files + R2
```

不要存第二个 object table。

---

# 10. 不可变性

Archive 一旦生成：

```text
PDF bytes 不更新
hash 不更新
```

业务修订后：

```text
生成新 archive
旧 archive → superseded
```

而不是覆盖原文件。

---

# 11. Signature

Stage03 P2 的“reliable e-signature provider”与内部签名不同。

首版：

```text
signature_requests
signature_events
signature_artifacts
```

Provider Interface：

```text
createRequest
getStatus
verifyWebhook
downloadArtifact
```

如果没有真实合规 Provider：

```text
provider=internal/manual
status 只能表达内部流程
```

UI/文案不能写：

```text
“已完成合法可靠电子签名”
```

除非接入合规 Provider。

---

# 12. Insurance PDF API

建议：

```text
POST /insurance/claim-packs
GET  /insurance/claim-packs/:id
POST /insurance/claim-packs/:id/generate
GET  /insurance/claim-packs/:id/exports

POST /document-artifacts/:documentType/:entityId/pdf
GET  /document-artifacts/archives
POST /document-artifacts/archives/:id/sign
```

生成 Command 带 Idempotency：

```text
tenant + entity + version + template + idempotency
```

---

# 13. Permission

```text
insurance.view
insurance.generate
documents.pdf.generate
documents.archive.view
documents.signature.manage
```

医疗数据仍需二次业务权限门。

不能只凭：

```text
documents.view
```

读取全部病历。

---

# 14. Customer-visible

为 Agent-08 Portal 提供 Archive Contract：

```text
customer_visible
published
```

可以在 archive 或业务源上判断。

Portal 绝不能直接列出全部 `document_archives`。

---

# 15. 前端

Insurance 页面：

```text
选择 Encounter/Admission
材料检查清单
缺失项
生成版本
PDF
历史 Export
```

Documents Center：

```text
PDF
Archive History
Hash/Version
Signature Status
```

---

# 16. 测试

```text
cross tenant pack
unpublished report excluded
same idempotency same export
source amended → new version
PDF hash
R2 download permission
archived PDF immutable
SSRF URL rejected
signature webhook replay
signature event audit
```

---

# 17. 失败条件

```text
新建第二套 storage
PDF 直接 window.print 当归档
生成后覆盖同一个 PDF
未发布报告进入理赔
Chromium 可访问任意 URL
内部签名冒充合规电子签名
Portal 可以通过 fileId 越权下载
```

---

# 18. Handoff

必须：

```text
PDF_PROVIDER
SERVERLESS_COMPATIBILITY
SSRF_POLICY
ARCHIVE_IMMUTABILITY
INSURANCE_INCLUDED_STATUSES
SIGNATURE_PROVIDER_STATUS
PORTAL_ARCHIVE_CONTRACT
```

---

# 19. Commit

```text
feat(stage04-06): implement insurance pdf archive and signature lifecycle
```
