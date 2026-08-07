# Sprint S3.1-1 交付说明（合规数据底座）

> 交付范围：todo.md 第十六节"第一批只开发"8 项全部完成。
> 状态：**code_complete（静态验证通过）/ integration_pending**，SQL 测试待 staging 真实执行后方可 `verified`。
> 审计反馈：R01-R08 已全部修复并补充回归测试/文档（详见第 4 节"审计反馈修复"小节）。

## 1. commit SHA

`ba753e0b`（S3.1-1 代码交付提交；本说明随 docs 补充提交入库）

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

### 审计修复（R01-R08，基于既有 28/29 迁移 create or replace，不新增 30）

| 文件 | 变更 |
|---|---|
| `supabase/migrations/20260808000028_compliance_base.sql` | R01：`veterinarian_registrations` RLS 改租户上下文权限（去 store_id 引用） |
| `supabase/migrations/20260808000029_compliance_rpc.sql` | R02/R04/R05/R06/R07：v_archived 类型修正、draft 禁直发、单事务发药、触发器/签名同步、有效期时区口径 |
| `api/routes/compliance.ts` | R03：新增 `resolveOperator` 服务端推导操作人，7 路由 schema 移除操作人/租户字段 |
| `apps/maoxianqiu/src/api/modules/compliance.ts` | R03：移除 `getCurrentEmployeeId`，调用不再传 employee id |
| `apps/maoxianqiu/src/types/compliance.ts` | R03：入参类型移除 employeeId/tenantId 字段 |
| `apps/maoxianqiu/src/views/clinical/encounter/detail.vue` | R03：去开方人选择/操作人传参 |
| `apps/maoxianqiu/src/views/system/veterinarian-registration/index.vue` | R03：去操作人/租户传参 |
| `supabase/tests/compliance_s3_1.sql` | R01-R08：回归断言（详见第 10 节） |

## 3. migration 总览

- 新迁移：`20260808000028_compliance_base.sql`、`20260808000029_compliance_rpc.sql`
- 旧迁移 01~27：**零改动**（已核验，S3.1 硬性约束）

## 4. 本 Sprint 变更说明

本次 Sprint 建立 S3.1 合规数据底座，覆盖第一批 8 项，按业务规则逐项说明：

1. **病历归档（门急诊 24h / 住院出院 3 日）**
   - `encounters`/`admissions` 引入归档状态机 `archive_status`（`draft→signed→archived`，`archive_due` 为派生态，不落存储参与归档判定）。
   - 归档截止触发器（`before update of status`，insert 不触发）：门诊 `signed` 后 `archive_due_at = coalesce(ended_at, now()) + 24h`；住院 `discharged` 后 `archive_due_at = coalesce(discharged_at, now()) + 3 days`。
   - `archive_encounter`/`archive_admission` RPC：仅 `signed`/`discharged` 可归档，操作员必须是本租户在职员工，归档时写 `archived_at`/`archived_by_employee_id`。

2. **保留期（retention，≥3 年）**
   - 归档即设定 `retention_until = now() + 3 years`（受控处方另有 5 年规则，见第 8 项）；`retention_status` 四态 `active/destroy_requested/destroy_approved`（销毁流程属 S3.1-2，字段先就位）。

3. **归档后正文不可变**
   - DB 层兜底触发器 `prevent_archived_record_update`（`P0003 ARCHIVED_RECORD_IMMUTABLE`）：归档后任何直接 UPDATE 被拦截（postgres 直连同样拦截）。
   - 唯一放行通道：amendment apply 通过 `set_config('app.allow_archived_update','true',true)` 显式放行，保证修订必须走审批流。

4. **归档后修订审批流（amendment）**
   - 新表 `medical_record_amendments`：`requested_by`/`reason`/`before_snapshot`/`after_snapshot`（jsonb 快照）/状态机 `pending→approved→rejected→applied`。
   - 三个 RPC：`request_record_amendment`（仅已归档可申请，同记录 pending 去重 `AMENDMENT_ALREADY_PENDING`）、`review_record_amendment`（approved/rejected + 拒绝原因，已决不可再审）、`apply_record_amendment`（仅 approved 可执行，更新正文 + 写 `encounter_revisions` 递增版本 + 记 after_snapshot，已应用不可重复执行）。

5. **执业兽医备案（veterinarian registration）**
   - 新表 `veterinarian_registrations`：`tenant_id + license_no` 唯一、证照号/主管机构/地区/有效期/状态（active/inactive/expired）、电子签名字段（provider/subject_id）。
   - `upsert_veterinarian_registration` 幂等；**开方前置校验**：`issue_prescription` 要求开方员工持有该租户有效（active 且未过期）备案，否则 `PRESCRIBER_NOT_REGISTERED`。

6. **处方有效期（默认当日结束 / 最长 3 天）**
   - 状态机扩展 `draft→issued→dispensed/cancelled`；`issue_prescription` 生产 `issued`（`issued_at`/`signature_method='manual'`）。
   - `valid_until` 默认 `date_trunc('day', now()) + 1 day`（当日结束）；超出 `issued_at + 3 days` 拒绝（`VALIDITY_EXCEEDS_MAX`）。
   - `extend_prescription_validity`：仅 `issued` 可延长，新值必须晚于现值（`VALIDITY_NOT_EXTENDED`）、不得超过 3 天上限。
   - `dispense_prescription`：`issued` 处方过期禁止发药（`PRESCRIPTION_EXPIRED`），兼容旧 `draft` 直发流程。

7. **处方保留期（普通 3 年 / 受控 5 年）**
   - `issue_prescription` 按是否含受控药设定 `retention_until`：受控 5 年、普通 3 年。

8. **受控药最低全国规则（单独处方 / 麻醉一日量 / 保留 5 年）**
   - `catalog_drug_extensions.controlled_class`（none/narcotic/psychotropic/toxic/other_controlled）。
   - 受控药必须**单独处方**：受控与非受控混开 `CONTROLLED_MIX_REGULAR`、多受控类别混开 `CONTROLLED_MIX_CLASS`，均拒绝。
   - 麻醉药品**每张处方不得超过一日量**：`duration_days > 1` 拒绝（`NARCOTIC_DAILY_LIMIT`）。
   - 权限双保险：Hono 层先查明细含受控药则追加 `prescription.controlled_issue` 权限码，RPC 内再做业务规则校验。

9. **兼容性处理**：`save_prescription`/`dispense_prescription` 保持原签名重定义——`save` 增加已 issued/dispensed 禁止覆盖保存（`PRESCRIPTION_ALREADY_ISSUED`）+ 归档病历禁止保存（`ARCHIVED_RECORD_IMMUTABLE`）；`dispense` 增加过期校验 + 记录 `dispensed_by_employee_id`/`dispensed_at`，不破坏既有 clinical 路由与前端。

### 审计反馈修复（R01-R08）

审计反馈 8 项全部修复。全部基于既有 migration 28/29 `create or replace`（含触发器/函数重定义），**未新增 migration 30**，遵守"01~29 不做结构性改动"约束：

- **R01 修 veterinarian RLS**：`veterinarian_registrations` 表**无 `store_id` 列**，原策略引用 `store_id` 会导致建策略即报错。修复：改为租户上下文权限 `public.has_permission(tenant_id, null, 'veterinarian_registration.read')`（`has_permission` 的 `store_id = null` 语义即 tenant 上下文，仅匹配 tenant/system scope 的 tenant-wide 分配）。RLS 整体仍为"租户成员 + 备案读权限"两条件。
- **R02 修 Amendment 类型错误**：`request_record_amendment` 声明区 `v_archived boolean` 却 `select ... archive_status into ...`（`archive_status` 为 text），PL/pgSQL 类型不匹配。修复：`v_archived text`。
- **R03 操作人全部服务端推导**：所有 Command RPC 的操作人（归档人/申请人/审批人/执行人/开方人/延长期操作人/备案操作人）一律由登录用户（`c.get('user').id`）反查 `employees`（`user_id` + `status='active'`）得到；租户 id 同样由员工档案推导（`upsert_vet_reg` 用 `operator.tenantId` 作为可信 scope）。前端 7 个路由 schema 全部移除 `operatorEmployeeId`/`requestedByEmployeeId`/`reviewerEmployeeId`/`appliedByEmployeeId`/`prescriberEmployeeId`/`tenantId` 字段，页面同步移除开方人/操作人选择器与 `getCurrentEmployeeId`。
- **R04 禁止 draft 直接发药**：`dispense_prescription` 仅接受 `status = 'issued'` 处方，draft 必须先 `issue`（`PRESCRIPTION_NOT_DISPENSABLE`）。
- **R05 发药改为单事务 RPC**：状态转换（issued→dispensed）+ 逐项库存扣减（优先 `confirm_inventory_reservation` 确认预留，否则 `dispense_inventory` 即时 FEFO 扣减）在同一个 plpgsql 事务内原子提交/回滚，消除 API 层"先扣库存后转状态"两步编排的非原子窗口；`dispensed_items`/`skipped_items` 计数写入审计。
- **R06 同步 archive_status / signed_by_employee_id**：
  - 归档截止触发器 `set_encounter_archive_due`/`set_admission_archive_due`（create or replace 覆盖 migration 28 定义）：签署/出院时同步 `archive_status = 'signed'`（未 archived 时），保证归档状态机（draft→signed→archived）与状态转移同源。
  - `sign_encounter`（create or replace 覆盖 migration 19 定义）：增加归档后不可签（`ARCHIVED_RECORD_IMMUTABLE`）；`signed_by_employee_id` 由签署人（`p_doctor_id` = 登录用户 id）反查在职员工得到；同步 `archive_status = 'signed'`；审计含 `signed_by_employee_id`。
- **R07 修处方有效期时区和边界**：统一 Asia/Shanghai 自然日口径（timestamptz 比较先换算业务时区再比）：
  - 默认 `valid_until` = 开具日（上海）23:59:59（当日结束）：`(date_trunc('day', now() at time zone 'Asia/Shanghai') + interval '1 day' - interval '1 second') at time zone 'Asia/Shanghai'`；
  - 上限 = 开具日（上海）23:59:59 + 3 天：`(date_trunc('day', now() at time zone 'Asia/Shanghai') + interval '4 days' - interval '1 second') at time zone 'Asia/Shanghai'`；
  - `extend_prescription_validity` 上限同样基于 `issued_at` 的上海自然日换算，与 issue 口径一致。
- **R08 补测试和文档**：见第 10 节 tests 更新与本说明。

## 5. 新增 migration 列表

### 20260808000028_compliance_base.sql（数据底座）

| 段 | 内容 |
|---|---|
| 1. encounters 合规字段 | `signed_by_employee_id`、`archive_status`、`archive_due_at`、`archived_at`、`archived_by_employee_id`、`retention_until`、`retention_status`、`destroy_requested_at`、`destroy_approved_at` |
| 2. admissions 同款字段 | 同上字段集 |
| 3. 归档截止触发器 | `set_encounter_archive_due`（signed 后 24h）/ `set_admission_archive_due`（discharged 后 3 日），`before update of status` |
| 4. 归档不可变触发器 | `prevent_archived_record_update`（P0003 ARCHIVED_RECORD_IMMUTABLE，`set_config('app.allow_archived_update')` 放行） |
| 5. prescriptions 合规字段 | `issued_at`/`valid_until`/`prescriber_employee_id`/`prescriber_user_id`/`prescriber_veterinarian_registration_id`/`signed_at`/`signature_method`/`dispensed_by_employee_id`/`dispensed_at`/`retention_until`/`retention_status`；status 约束扩为 `draft/issued/dispensed/cancelled` |
| 6. catalog_drug_extensions | `controlled_class`（none/narcotic/psychotropic/toxic/other_controlled） |
| 7. medical_record_amendments 表 | `before_snapshot`/`after_snapshot` jsonb、状态机、审批/拒绝/应用时间戳；RLS 仅 SELECT（amend.request 或 amend.approve） |
| 8. veterinarian_registrations 表 | `tenant_id+license_no` 唯一、有效期、状态、电子签名字段；RLS 仅 SELECT（registration.read） |
| 9. 索引 | partial index `(tenant_id, archive_due_at) where archive_status <> 'archived'` |
| 10. 权限与收紧 | 8 权限码 + 三角色授权 + roles.permissions 同步 + `revoke all on table` 两新表 |

### 20260808000029_compliance_rpc.sql（RPC + 授权收紧）

| RPC | 关键校验（错误码） |
|---|---|
| archive_encounter | signed 才可归档（ENCOUNTER_NOT_SIGNABLE）、重复归档（ENCOUNTER_ALREADY_ARCHIVED）、操作员归属（OPERATOR_NOT_FOUND）；retention = 3 年；audit |
| archive_admission | discharged（ADMISSION_NOT_DISCHARGED）、重复（ADMISSION_ALREADY_ARCHIVED）、操作员（OPERATOR_NOT_FOUND） |
| request_record_amendment | 类型校验（INVALID_RECORD_TYPE）、原因必填（AMENDMENT_REASON_REQUIRED）、仅已归档（RECORD_NOT_ARCHIVED）、pending 去重（AMENDMENT_ALREADY_PENDING）；before_snapshot |
| review_record_amendment | 决策枚举（INVALID_DECISION）、仅 pending（AMENDMENT_NOT_PENDING）、拒绝原因落库 |
| apply_record_amendment | 仅 approved（AMENDMENT_NOT_APPROVED）、set_config 放行触发器、写 encounter_revisions、after_snapshot |
| upsert_veterinarian_registration | license 必填（LICENSE_NO_REQUIRED）、状态枚举（INVALID_REGISTRATION_STATUS）、员工归属（EMPLOYEE_NOT_FOUND）、幂等 |
| issue_prescription | 仅 draft（PRESCRIPTION_NOT_DRAFT）、开方人存在（PRESCRIBER_NOT_FOUND）、有效备案（PRESCRIBER_NOT_REGISTERED）、受控混开（CONTROLLED_MIX_CLASS / CONTROLLED_MIX_REGULAR）、麻醉一日量（NARCOTIC_DAILY_LIMIT）、有效期上限（VALIDITY_EXCEEDS_MAX）；retention 受控 5 年/普通 3 年 |
| extend_prescription_validity | 仅 issued（PRESCRIPTION_NOT_ISSUED）、只可延长（VALIDITY_NOT_EXTENDED）、3 天上限（VALIDITY_EXCEEDS_MAX） |
| save_prescription（重定义） | 归档病历禁存（ARCHIVED_RECORD_IMMUTABLE）、已 issued 禁覆盖（PRESCRIPTION_ALREADY_ISSUED） |
| dispense_prescription（重定义） | 仅 draft/issued 可发（PRESCRIPTION_NOT_DISPENSABLE）、issued 过期禁发（PRESCRIPTION_EXPIRED）、记录发药人/时间 |

末尾 DO 块：revoke public/anon/authenticated + grant service_role（10 个函数）。

## 6. 新增/修改 API

### 新增 `api/routes/compliance.ts`（7 端点，全部 service-role-only）

| 端点 | 方法 | 权限 | RPC |
|---|---|---|---|
| `/compliance/records/archive` | POST | medical_record.archive | archive_encounter / archive_admission |
| `/compliance/records/amendments/request` | POST | medical_record.amend.request | request_record_amendment |
| `/compliance/records/amendments/:id/review` | POST | medical_record.amend.approve | review_record_amendment |
| `/compliance/records/amendments/:id/apply` | POST | medical_record.amend.request | apply_record_amendment |
| `/compliance/veterinarian-registrations/upsert` | POST | veterinarian_registration.manage | upsert_veterinarian_registration |
| `/compliance/prescriptions/:id/issue` | POST | prescription.issue（受控另需 prescription.controlled_issue） | issue_prescription |
| `/compliance/prescriptions/:id/extend-validity` | POST | prescription.extend_validity | extend_prescription_validity |

实现要点：zod schema + parseJsonBody + requireScopedPermission（scope 为唯一可信 tenantId/storeId）+ service.rpc + mapRpcError（NOT_FOUND→404、业务规则→422、兜底→500）+ writeAudit + ok；`:id` 路由先 `fetchRecordScope` 查库取归属再授权；受控药二重权限校验（先查明细含 `controlled_class <> 'none'` 再追加权限码）。Query 类（列表）走 Supabase 直连 + RLS 兜底。**R03：7 个 Command 全部新增 `resolveOperator(service, c)` 服务端推导操作人（登录用户反查在职员工），schema 不再接收操作人/租户字段**。

### 修改

| 文件 | 变更 |
|---|---|
| `api/lib/service-rpc-manifest.ts` | SERVICE_ROLE_ONLY_RPC 新增 8 函数（56 → 63） |
| `api/index.ts` | `app.route('/compliance', complianceRoutes)` |
| `api/scripts/check-rpc-manifest.ts` | 规则 2 从"仅 migration 27"升级为"扫描 migrations 目录全部 .sql 聚合"（S3.1 禁止改 01~27，新 revoke 在 migration 29） |

## 7. 新增/修改页面

### 新增
- `apps/maoxianqiu/src/views/system/veterinarian-registration/index.vue`：备案列表（join employees 显示姓名/工号/职称）+ 新增备案 FaDrawer（EmployeePicker×2 + 证照/有效期/状态字段）。

### 修改
| 文件 | 变更 |
|---|---|
| `apps/maoxianqiu/src/views/clinical/encounter/detail.vue` | 归档状态标签（含"已超时"红色派生）；归档按钮（signed 且 `auth('medical_record.archive')`）；修订管理区块（申请/批准/拒绝/执行 + payload 表单）；处方开具弹窗（选开方人 + 有效期）；延长有效期弹窗；`prescriptionLocked` 控制只读 |
| `apps/maoxianqiu/src/router/modules/system.ts` | 新增 `/system/veterinarian-registration`，meta.auth='veterinarian_registration.read' |
| `apps/maoxianqiu/src/views/system/permissions.ts` | 追加 8 项权限码 |
| `apps/maoxianqiu/src/types/clinical.ts` / `inpatient.ts` | Encounter/Prescription/Admission 合规列 + PrescriptionStatus 增 'issued' |

## 8. 新增 permission codes（8 个）

| code | 名称 | module | system_admin | store_manager | doctor |
|---|---|---|---|---|---|
| medical_record.archive | 病历归档 | compliance | ✔ | ✔ | ✔ |
| medical_record.amend.request | 病历修订申请 | compliance | ✔ | ✔ | ✔ |
| medical_record.amend.approve | 病历修订审批 | compliance | ✔ | ✔ | ✘ |
| veterinarian_registration.read | 查看执业兽医备案 | compliance | ✔ | ✔ | ✔ |
| veterinarian_registration.manage | 管理执业兽医备案 | compliance | ✔ | ✔ | ✘ |
| prescription.issue | 开具处方 | prescription | ✔ | ✔ | ✔ |
| prescription.extend_validity | 延长处方有效期 | prescription | ✔ | ✔ | ✘ |
| prescription.controlled_issue | 开具受控药品处方 | prescription | ✔ | ✔ | ✔ |

`roles.permissions` 数组按同矩阵同步（兼容旧代码读取）；`revoke` 收紧：新表仅 service_role 可写。

## 9. 新增 audit events（10 个）

| action | 触发点 | entity_type |
|---|---|---|
| medical_record.archive | archive_encounter / archive_admission | encounter / admission |
| medical_record.amend.request | request_record_amendment | medical_record_amendment |
| medical_record.amend.approve | review_record_amendment(approved) | medical_record_amendment |
| medical_record.amend.reject | review_record_amendment(rejected) | medical_record_amendment |
| medical_record.amend.apply | apply_record_amendment（含 before/after 快照元数据） | medical_record_amendment |
| veterinarian_registration.upsert | upsert（含 before/after to_jsonb） | veterinarian_registration |
| prescription.issue | issue_prescription | prescription |
| prescription.extend_validity | extend_prescription_validity | prescription |
| prescription.save（保留） | save_prescription 重定义 | prescription |
| prescription.dispense（保留） | dispense_prescription 重定义 | prescription |

## 10. 新增/修改 tests

### 新增 `supabase/tests/compliance_s3_1.sql`（独立可执行，待 staging）

| Part | 覆盖 |
|---|---|
| 1 | 归档截止触发器：门诊 signed 后 archive_due_at = ended_at + 24h（±1h 断言）；住院 discharged 后 +3 日；**R06：签署/出院同步 archive_status='signed'** |
| 2 | archive_encounter 成功（retention ≥3 年）/ 重复归档拒绝 / 未签署拒绝；archive_admission 成功 / 未出院拒绝 / 越租户操作员拒绝（OPERATOR_NOT_FOUND） |
| 3 | 归档后直接 UPDATE 被 ARCHIVED_RECORD_IMMUTABLE 拦截（postgres 直连同样拦截） |
| 4 | Amendment 全流：request→pending+before_snapshot→重复申请拒绝→未批准 apply 拒绝→approved→apply→applied+after_snapshot+encounter_revisions+1→已应用不可重复；未归档申请拒绝；拒绝分支（INVALID_DECISION / rejected+原因 / AMENDMENT_NOT_PENDING） |
| 5 | 兽医备案：**R01：RLS 策略定义断言（has_permission(tenant_id, null, ...)，不含 store_id 引用）**；无备案开方拒绝→upsert active→开方成功（issued/**R07 默认有效期=上海当日 23:59:59**/signature manual/retention 3 年/记录备案 id）→备案过期开方拒绝→恢复 |
| 6 | 有效期：**R07：>开具日+3 天拒绝（上海自然日口径）**→extend 正常/超上限/缩短拒绝→过期 dispense 拒绝+正常 issued dispense 成功 |
| 7 | 受控药：麻醉 duration=2 拒绝（NARCOTIC_DAILY_LIMIT）→duration=1 成功且 retention 5 年；受控+普通混开拒绝；麻醉+精神混开拒绝 |
| 8 | issued 后 save 拒绝（PRESCRIPTION_ALREADY_ISSUED）；**R04：draft 直发被拒（PRESCRIPTION_NOT_DISPENSABLE，原"直发兼容"断言反转）** |
| 9 | **R06：sign_encounter 签署同步 signed_by_employee_id（反查在职员工 c1）+ archive_status='signed' + archive_due_at；归档后不可签署（ARCHIVED_RECORD_IMMUTABLE）** |

实现：自建 `tests.assert_true`/`assert_raises`、单一事务 begin/rollback、固定 UUID fixture（99999999-...）、`execute 'reset role'` 规避 SET LOCAL 跨块持久化、结尾 COMPLIANCE_S3_1_PASSED。R01-R08 断言映射见文件头注释。

### 修改（CI 校验）
- `api/scripts/check-rpc-manifest.ts`：规则 2 升级为 migrations 目录全 .sql 聚合扫描（新 revoke 在 migration 29）。
- 验证结果：`pnpm check:rpc-manifest` PASS（routes 65 处调用 ⊆ manifest 63 个函数；63 个全部纳入 revoke）；`npx tsc --noEmit -p api/tsconfig.json` PASS；`pnpm --filter './apps/*' -r run lint`（vue-tsc）PASS。

## 11. 未完成项

- SQL 测试与 E2E 需 staging 环境真实执行（无本地数据库，未生成执行日志）
- RLS 行为（amendment 申请以 amend.request 权限 SELECT 新表）待 staging 验证
- S3.1-2~4（license/年报/疫情/废弃物/tenant init/日结/对账/医疗闭环补强/集成收口）未开始，按要求停止

## 12. 风险

- 归档截止/保留期规则依赖触发器语义（`before update of status` 不覆盖 insert），已用测试覆盖
- `prevent_archived_record_update` 为全局兜底，amendment apply 依赖 `set_config('app.allow_archived_update')` 显式放行，误用可能阻塞正常 update，待 staging 回归
- 无本地数据库，migration 28/29 仅静态自检，语法/行为以 staging `supabase db reset` 为准

## 13. 下一 Sprint 依赖

- S3.1-2 经营+监管底线（license/年报/疫情/废弃物/tenant init/日结/对账）可复用本 Sprint 的权限码/审计/RPC 模式
- staging 环境就绪后：先执行 migration + compliance_s3_1.sql + rpc_security.sql 回归，再开始 S3.1-2
