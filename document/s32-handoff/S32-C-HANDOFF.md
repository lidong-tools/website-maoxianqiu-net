# S32-C Handoff — 业务文档与打印中心 V2

> 阶段：Stage-03 / S3.2
> Agent：S32-C（Documents）
> 目标：S3.2 Integrator(S32-E) 与 S3.1 Integrator 最终接入

---

## 1. 交付内容

新建（全部为 S32-C 独占文件，未修改任何既有生产文件；未触碰 IAM/Billing/Clinical/Inventory/Settings 核心边界）：

| 文件 | 说明 |
|---|---|
| `api/routes/documents.ts` | Documents 路由（**需 S32-E 挂载**） |
| `api/services/documents/types.ts` | 服务层类型 + 文档类型/纸型常量 |
| `api/services/documents/renderer.ts` | 安全模板渲染器（仅 `{{path}}` / `{{#each}}`，无 eval） |
| `api/services/documents/format.ts` | 格式化工具 |
| `api/services/documents/base.ts` | 通用信息抓取（医院/门店/客户/宠物/医生/操作员） |
| `api/services/documents/index.ts` | 服务编排：模板解析（门店→租户→系统）+ 渲染管道 |
| `api/services/documents/adapters/*.ts` | 8 类业务 Adapter（见 §2） |
| `supabase/migrations/20260810000108_document_templates.sql` | `document_templates` + `document_history` + RLS + 权限 seed |
| `supabase/migrations/20260810000109_document_default_templates.sql` | 8 类系统默认模板种子 |
| `apps/maoxianqiu/src/types/documents.ts` | 前端类型 |
| `apps/maoxianqiu/src/api/modules/documents.ts` | 前端 API 模块 |
| `apps/maoxianqiu/src/components/documents/DocumentEntityPicker/index.vue` | 业务单据选择器（复用既有 picker + 远程搜索） |
| `apps/maoxianqiu/src/components/documents/DocumentPreviewPanel/index.vue` | 文档实时预览面板（iframe srcdoc + 纸型宽度） |
| `apps/maoxianqiu/src/views/operations/documents/index.vue` | 业务文档中心（左配置/右预览/历史/模板管理） |

---

## 2. 各 Domain Adapter 输入字段（只读，未跨域写）

文档渲染管道：`业务 DTO → Document Data Adapter → Template Renderer → HTML`。所有 Adapter 只读各自 Domain 数据表，模板不直接查库。

| 文档类型 | Adapter 文件 | 读取数据源 | 输出 section 关键字段 |
|---|---|---|---|
| `invoice` | `adapters/invoice.ts` | `invoices` + `invoice_items` | invoiceNo/status/subtotal/discountAmount/taxAmount/total/paidAmount/paymentMethod/items[] |
| `prescription` | `adapters/prescription.ts` | `prescriptions` + `prescription_items` | status/createdAt/items[]（drugName/dosage/frequency/durationDays/quantity/unit/instructions） |
| `medical_record_summary` | `adapters/medical-record.ts` | `encounters` | status/startedAt/chiefComplaint/historyPresent/examFindings/diagnosisCodesText/treatmentPlan/followUpDate/signedAt |
| `lab_report` | `adapters/lab-report.ts` | `lab_orders` + `lab_order_analytes` + `lab_analytes` | orderNo/status/requestedAt/completedAt/analytes[]（name/resultDisplay/resultClass/unit/refRange） |
| `imaging_report` | `adapters/imaging.ts` | `imaging_orders` + `imaging_reports` | orderNo/imagingType/status/reportStatus/findings/impression/recommendation/authorName/reviewerName |
| `discharge_summary` | `adapters/discharge.ts` | `admissions`（status=discharged） | status/admittedAt/dischargedAt/admissionReason/dischargeReason/dischargeNotes/totalCharge/doctorName |
| `vaccination_certificate` | `adapters/vaccination.ts` | `vaccine_certificates` + `vaccinations` + `catalog_items` | certificateNo/status/issuedDate/vaccinations[]（vaccineName/doseNo/administeredDate/batchNo/manufacturer/nextDueDate） |
| `boarding_handover` | `adapters/boarding.ts` | `boarding_stays` + `boarding_daily_records` | boardingNo/status/checkInAt/dietNotes/walkingNotes/medicationNotes/vaccineVerified/emergencyContact{name,phone,relation}/totalCharge/dailyRecords[] |

通用字段（所有文档）：`hospital{name,shortName}` / `store{name,code,address,phone}` / `customer{name,phone,gender}` / `pet{name,species,breed,gender,weight}` / `doctor{name,title}` / `operator{name}` / `meta.printedAt`。

---

## 3. 缺失 DTO / 后续增强（需其他 Domain 或 Integrator 处理）

1. **Logo / 医院信息（Settings Hook）**：当前 `hospital` 仅读取 `tenants` 表 name/short_name，未读取 Settings 中的 Logo。若需在模板输出 Logo/自定义页眉，需 Settings 提供 `settings` 读取入口或配置字段。
2. **影像图片附件**：`imaging_report` 未包含影像图片（attachments 表存 `entity_type in ('imaging_order','imaging_report')`、`purpose in ('attachment','image')`）。若要在报告中内嵌影像图，需附件 URL 能力（由 S3.1 Files/attachments 提供）。
3. **处方合规字段**：处方 Adapter 读取 `prescriptions`/`prescription_items`；若需打印麻精药品特殊标记/兽医备案号，需 Clinical/Compliance 补充字段。
4. **`discharge_summary` 无独立表**：数据来自 `admissions`（discharged）。若后续需要多版本出院小结（如多次修订），建议新增 `discharge_summaries` 表并由 S3.1 Inpatient 维护。
5. **`document_templates` 与既有 `print_templates` 并存**：新模块使用 `document_templates`（支持 store/version/paper_size/安全变量）；旧打印中心 `print_templates` 仍存在。S32-E 可决定是否最终收敛旧打印中心到新文档中心。

---

## 4. 路由挂载（S32-E 必做）

在 `api/index.ts` 增加：

```ts
import documentsRoutes from './routes/documents'
app.route('/documents', documentsRoutes)
```

建议挂载位置：与其它业务路由并列（`/operations` 前后均可，路径 `/api/documents/*` 无冲突）。

前端路由（`apps/maoxianqiu/src/router/modules/operations.ts`）为业务文档中心添加菜单：

```ts
{
  path: '/operations/documents',
  name: 'operationsDocuments',
  component: () => import('@/views/operations/documents/index.vue'),
  meta: { title: '业务文档中心', icon: 'i-ri:file-list-line', auth: 'documents.view' },
}
```

---

## 5. 权限（已在 migration 108 中 seed）

| 权限码 | 说明 | 授予角色 |
|---|---|---|
| `documents.view` | 查看/预览/渲染/历史 | system_admin + store_manager |
| `documents.print` | 打印 | system_admin + store_manager |
| `documents.template.manage` | 模板管理（建/改） | system_admin + store_manager |

医疗类文档在服务端**额外重新校验业务权限门**（`requireScopedPermission` dataScope）：
`imaging_report → imaging.view`、`discharge_summary → inpatient.view`、`boarding_handover → boarding.view`。
前端菜单请使用 `documents.view`；若菜单希望限制到有打印权限的用户，可加 `documents.print`。

> 说明：权限码已写入 migration（`permissions`/`role_permissions`/`roles.permissions` 数组三处同步，幂等）。S32-E 无需再 seed，但若 Integrator 有权限 manifest/seed 汇总，请将上述三个码并入。

---

## 6. RLS / Command 边界

- `document_templates`：SELECT 允许租户成员 + 系统模板（tenant_id is null）；写操作要求 `documents.template.manage` 且 `tenant_id is not null`（系统模板仅 service_role 种子可写）。
- `document_history`：只读（SELECT = 租户成员 + 门店可达）；写入仅 service_role（Hono 路由代理），与 `security_events` 一致。
- 渲染/打印路由：先查实体取得 tenant/store → `requireScopedPermission(dataScope)` → 校验 documents.view（打印另校验 documents.print）→ 医疗文档再按业务门校验。全程 service role 聚合，RLS 不参与路由内查询。

---

## 7. 审计

| 动作 | action | 触发 |
|---|---|---|
| 模板创建 | `documents.template.create` | POST /documents/templates |
| 模板更新 | `documents.template.update` | PATCH /documents/templates/:id |
| 文档渲染 | `documents.render` | POST /documents/render |
| 文档打印 | `documents.print` | POST /documents/print（医疗文档强制留痕） |

预览（POST /documents/preview）不写审计、不落历史。

---

## 8. 模板安全

- 渲染器仅支持 `{{path}}`（HTML 转义）与 `{{#each path}}...{{/each}}`；禁止 eval / Function / `<script>` / `javascript:` / 内联事件 / `{{{` / `#if/#unless/#for`。
- 保存模板时服务端二次校验（`validateTemplateHtml`）。
- 模板变量全部来自 Adapter 输出的安全数据树，不直接查库。
