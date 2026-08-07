# Sprint S3.1-1 交付说明（合规数据底座）

> 交付范围：todo.md 第十六节"第一批只开发"8 项全部完成。
> 状态：**code_complete（静态验证通过）/ integration_pending**，SQL 测试待 staging 真实执行后方可 `verified`。

## 1. commit SHA

`{{COMMIT_SHA}}`（提交后回填，即本交付说明所在提交）

## 2. 修改文件清单

### 新增（8 项）

| 文件 | 说明 |
|---|---|
| `supabase/migrations/20260808000028_compliance_base.sql` | S3.1 合规数据底座：encounters/admissions/prescriptions 合规字段 + 归档状态机 + 不可变触发器 + 2 张新表 + 8 权限码 |
| `supabase/migrations/20260808000029_compliance_rpc.sql` | 10 个 RPC（8 新 + save/dispense 重定义）+ revoke/grant service_role |
| `supabase/tests/compliance_s3_1.sql` | 合规 SQL 测试（8 个 Part，独立事务，待 staging 执行） |
| `api/routes/compliance.ts` | Hono Command 路由（7 个端点 + mapRpcError + 受控药二重校验） |
| `apps/maoxianqiu/src/api/modules/compliance.ts` | 前端合规 API 模块（Command 走 Hono / Query 直连 + getCurrentEmployeeId） |
| `apps/maoxianqiu/src/types/compliance.ts` | 合规类型定义与状态标签 |
| `apps/maoxianqiu/src/views/system/veterinarian-registration/index.vue` | 执业兽医备案管理页 |
| `document/stage-03/todo.md` | S3.1 任务书（随本 Sprint 纳入版本库） |

### 修改（8 项）

| 文件 | 变更 |
|---|---|
| `api/index.ts` | 挂载 `/compliance` 路由 |
| `api/lib/service-rpc-manifest.ts` | 新增 8 个函数（56 → 63） |
| `api/scripts/check-rpc-manifest.ts` | 规则 2 升级为扫描 migrations 目录全部 .sql（S3.1 禁止改 01~27） |
| `apps/maoxianqiu/src/router/modules/system.ts` | 新增 `/system/veterinarian-registration` 路由（meta.auth） |
| `apps/maoxianqiu/src/types/clinical.ts` | Encounter/Prescription 新列、PrescriptionStatus 增 'issued' |
| `apps/maoxianqiu/src/types/inpatient.ts` | Admission 归档字段 |
| `apps/maoxianqiu/src/views/clinical/encounter/detail.vue` | 归档状态/归档按钮/修订管理/处方开具与延长弹窗 |
| `apps/maoxianqiu/src/views/system/permissions.ts` | 追加 8 项权限码 |

## 3. migration

- 新迁移：`20260808000028_compliance_base.sql`、`20260808000029_compliance_rpc.sql`
- 旧迁移 01~27：**零改动**（已核验）

## 4. schema 变化

- `encounters` / `admissions` 新增：`signed_by_employee_id`、`archive_status(draft/signed/archived)`、`archive_due_at`、`archived_at`、`archived_by_employee_id`、`retention_until`、`retention_status`、`destroy_requested_at`、`destroy_approved_at`；partial index `(tenant_id, archive_due_at) where archive_status <> 'archived'`
- `prescriptions` 新增：`issued_at`、`valid_until`、`prescriber_employee_id`、`prescriber_user_id`、`prescriber_veterinarian_registration_id`、`signed_at`、`signature_method(manual/electronic)`、`dispensed_by_employee_id`、`dispensed_at`、`retention_until`、`retention_status`；status 约束扩为 `draft/issued/dispensed/cancelled`
- `catalog_drug_extensions` 新增：`controlled_class(none/narcotic/psychotropic/toxic/other_controlled)`
- 新表 `medical_record_amendments`（before/after_snapshot jsonb、状态机 pending/approved/rejected/applied）
- 新表 `veterinarian_registrations`（tenant+license_no 唯一、电子签名字段、状态 active/inactive/expired）
- 触发器：`prevent_archived_record_update`（P0003 ARCHIVED_RECORD_IMMUTABLE）、`set_encounter_archive_due`（signed 后 +24h）、`set_admission_archive_due`（discharged 后 +3 日）
- 新表 RLS：仅 SELECT 策略（amend/备案按权限码），写入不开放；revoke all

## 5. API

`api/routes/compliance.ts` 7 个端点（全部 service-role-only，权限码校验在 Hono 层）：

| 端点 | 方法 | 权限 | RPC |
|---|---|---|---|
| `/compliance/records/archive` | POST | medical_record.archive | archive_encounter / archive_admission |
| `/compliance/records/amendments/request` | POST | medical_record.amend.request | request_record_amendment |
| `/compliance/records/amendments/:id/review` | POST | medical_record.amend.approve | review_record_amendment |
| `/compliance/records/amendments/:id/apply` | POST | medical_record.amend.request | apply_record_amendment |
| `/compliance/veterinarian-registrations/upsert` | POST | veterinarian_registration.manage | upsert_veterinarian_registration |
| `/compliance/prescriptions/:id/issue` | POST | prescription.issue（受控另需 prescription.controlled_issue） | issue_prescription |
| `/compliance/prescriptions/:id/extend-validity` | POST | prescription.extend_validity | extend_prescription_validity |

- 受控药二重校验：Hono 先查明细含 `controlled_class <> 'none'` 再追加权限码；RPC 内再做业务规则校验
- Query 类（列表）走 Supabase 直连 + RLS 兜底

## 6. 页面

- `encounter/detail.vue`：归档状态标签（含"已超时"派生）、归档按钮、修订管理区块（申请/批准/拒绝/执行 + payload 表单）、处方开具弹窗（开方人 + 有效期）、延长有效期弹窗、prescriptionLocked 只读控制
- `system/veterinarian-registration/index.vue`：备案列表（join employees）+ 新增备案 FaDrawer

## 7. permission code（8 个新增）

`medical_record.archive`、`medical_record.amend.request`、`medical_record.amend.approve`、`veterinarian_registration.read`、`veterinarian_registration.manage`、`prescription.issue`、`prescription.extend_validity`、`prescription.controlled_issue`

授权：system_admin / store_manager / doctor 三角色（roles.permissions 数组同步），`veterinarian_registration.read` 授全体员工。

## 8. audit event（10 个）

`medical_record.archive`、`medical_record.amend.request`、`medical_record.amend.approve`、`medical_record.amend.reject`、`medical_record.amend.apply`、`veterinarian_registration.upsert`、`prescription.issue`、`prescription.extend_validity`、`prescription.save`（保留）、`prescription.dispense`（保留）。

## 9. tests

- `supabase/tests/compliance_s3_1.sql`：8 个 Part（归档截止触发器 / 归档与保存期 / 归档不可变 / Amendment 全流与拒绝分支 / 兽医备案 / 有效期 / 受控药 / save-dispense 防护），自建断言、单一事务、固定 UUID fixture，结尾 COMPLIANCE_S3_1_PASSED
- `pnpm check:rpc-manifest` PASS（routes 65 处调用 ⊆ manifest 63 个函数；63 个全部纳入 revoke）
- `npx tsc --noEmit -p api/tsconfig.json` PASS
- `pnpm --filter './apps/*' -r run lint`（vue-tsc）PASS

## 10. 未完成项

- SQL 测试与 E2E 需 staging 环境真实执行（无本地数据库，未生成执行日志）
- RLS 行为（amendment 申请以 amend.request 权限 SELECT 新表）待 staging 验证
- S3.1-2~4（license/年报/疫情/废弃物/tenant init/日结/对账/医疗闭环补强/集成收口）未开始，按要求停止

## 11. 风险

- 归档截止/保留期规则依赖触发器语义（`before update of status` 不覆盖 insert），已用测试覆盖
- `prevent_archived_record_update` 为全局兜底，amendment apply 依赖 `set_config('app.allow_archived_update')` 显式放行，误用可能阻塞正常 update，待 staging 回归
- 无本地数据库，migration 28/29 仅静态自检，语法/行为以 staging `supabase db reset` 为准

## 12. 下一 Sprint 依赖

- S3.1-2 经营+监管底线（license/年报/疫情/废弃物/tenant init/日结/对账）可复用本 Sprint 的权限码/审计/RPC 模式
- staging 环境就绪后：先执行 migration + compliance_s3_1.sql + rpc_security.sql 回归，再开始 S3.1-2
