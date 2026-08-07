你现在进入【毛线球宠物医院 SaaS】Stage 03 的 S3.1 — Pilot Ready 开发阶段。

重要前提：

S3.0 静态审计已经通过，当前状态必须保持：

S3.0 STATIC AUDIT = PASS
S3.0 CODE STATUS = code_complete
S3.0 RUNTIME STATUS = integration_pending
VERIFIED = NO
PRODUCTION_READY = NO

这意味着：

1. 基础架构、安全模型和核心代码收口已通过静态审计；
2. 可以开始 S3.1 功能开发；
3. 但 migration / RLS / rpc_security / E2E 尚未在 staging 真实执行；
4. 不得把 code_complete 写成 verified；
5. 不得把当前系统描述为 production_ready；
6. 一旦 staging 环境具备，必须补真实运行验收。

==================================================
一、当前已经确认完成，不要重复重构
==================================================

以下 S3.0 工作已经静态通过，不允许无必要重写：

1. 平台管理员独立授权模型
   - platform_user_roles
   - platform_admin / platform_support / platform_auditor
   - tenant employee role 不得产生 platform admin
   - employee_role_assignments 禁止 system scope
   - tenant invite/change-role 禁止 system role

2. Scoped Permission
   - tenant/store/role/permission 作用域模型
   - Hono role.scope 校验
   - store role 不得提升 tenant 权限

3. Hono Command RPC 安全
   - Browser 不直接调用高风险 Command RPC
   - Hono route RPC 纳入 service-role-only manifest
   - migration 27 revoke public / anon / authenticated
   - service_role 保留执行权限

4. report-data 门店范围
   - allowedStoreIds
   - 报表必须按授权门店过滤

5. 宠物新增 UI
   - PetForm
   - PetCreateDrawer
   - 客户详情可新增宠物

6. Picker
   - Customer / Pet / Employee / Doctor / Store / Admission / CatalogItem 等 Picker
   - 正常业务表单禁止员工手工输入 UUID

7. 病历签署
   - 当前登录用户签署
   - 不允许代签
   - Employee.id 与 auth.users.id 语义已拆分

8. Inventory reservation
   - reserved_until
   - expired reservation 禁止 confirm
   - FEFO
   - confirm/release 边界处理

9. E2E 结构
   - closed-loop A/B/C
   - A 使用 UI 创建宠物
   - 关键 fixture 缺失不得静默 skip

10. Stage-03 v1.1 的方向
   - S3.0 → S3.1 → S3.2 → S3.3
   - C 端属于 S3.2
   - AI 属于 S3.3
   - 普通检验双人审核不是全国法规硬 P0
   - 毒麻双人双锁属于地方监管/医院 SOP 待确认
   - 年度活动报告依据《动物诊疗机构管理办法》第三十条

不要为了“代码更漂亮”重新推翻这些已经确认的架构。

==================================================
二、S3.1 总目标
==================================================

S3.1 的目标不是继续铺大量页面，而是让毛线球达到：

【可供首批宠物医院真实试点的 Pilot Ready 状态】

核心目标：

1. 医疗合规基础能力完成；
2. 医院经营底线能力完成；
3. 医疗核心闭环补强；
4. 所有新增能力继续遵守多租户、门店、权限、审计、安全模型；
5. 为 staging 真实验证做好准备。

开发优先级：

P0-A 合规
P0-B 经营
P0-C 医疗闭环补强
P0-D Staging Gate 准备

禁止在 S3.1 主线中抢跑：

- 完整微信小程序
- 会员储值商业化
- 优惠券/营销引擎
- AI 医疗能力
- 设备深度接入
- 高级供应链
- 大型数据仓库

==================================================
三、S3.1-A 医疗合规 P0
==================================================

--------------------------------
A1. 病历归档
--------------------------------

门（急）诊病历：

就诊结束后 24 小时内归档。

住院病历：

出院后 3 日内归档。

新增/确认字段：

medical_records / encounters 等相关模型至少支持：

archived_at
archive_due_at
archive_status
retention_until
signed_at
signed_by_employee_id
signature_method

状态建议：

draft
signed
archive_due
archived

要求：

1. 签署 != 归档；
2. 归档前允许合法补充；
3. 超过 archive_due_at 未归档需要进入待办/告警；
4. archived 后不得直接 UPDATE 正文；
5. UI 清晰显示：
   - 草稿
   - 已签署
   - 待归档
   - 已归档
   - 已超时

不要用一个 boolean 代替状态机。

--------------------------------
A2. 归档后修改 Amendment
--------------------------------

归档后原则上不可覆盖修改。

特殊修改必须走：

request amendment
→ 负责人批准
→ 创建新版本 / amendment
→ 保留旧版本

建议模型：

medical_record_amendments

字段：

id
tenant_id
store_id
medical_record_id
requested_by
requested_at
reason
status
approved_by
approved_at
rejected_reason
new_version_id
created_at

状态：

pending
approved
rejected
applied

要求：

- 原始版本永远保留；
- before/after 可追溯；
- 操作写 audit_logs；
- 普通医生不能直接覆盖 archived 记录。

--------------------------------
A3. 病历保存期
--------------------------------

病历：

retention >= 3 years

与病历关联的：

- lab report
- imaging
- pathology
- consent
- attachment
- prescription
- discharge summary

生命周期不得早于病历。

不要现在实现自动物理删除。

只实现：

retention_until
retention_status
destroy_requested_at
destroy_approved_at

未来再做销毁任务。

--------------------------------
A4. 执业兽医备案
--------------------------------

员工模型增加执业兽医相关信息，建议独立表：

veterinarian_registrations

字段：

employee_id
tenant_id
license_no
registration_no
registration_authority
registration_region
valid_from
valid_until nullable
status
signature_specimen_file_id nullable
electronic_signature_provider nullable
electronic_signature_subject_id nullable

要求：

1. 只有有效备案的执业兽医可以开具受限处方/签署要求执业兽医完成的医疗记录；
2. 不得仅通过 role='doctor' 判断执业资格；
3. 资格过期/停用时阻止对应操作；
4. 所有资格变更进入审计。

--------------------------------
A5. 兽医处方有效期
--------------------------------

处方新增：

issued_at
valid_until
prescriber_employee_id
prescriber_user_id
prescriber_veterinarian_registration_id
signed_at
signature_method
dispensed_by_employee_id
dispensed_at

规则：

1. 默认 valid_until = issued_at 当日结束；
2. 特殊情况下允许延长；
3. 最大不得超过 3 天；
4. valid_until > issued_at + 3 days 必须拒绝；
5. 过期处方禁止执行 dispense；
6. 修改处方有效期需权限和审计。

--------------------------------
A6. 处方保存期
--------------------------------

普通兽医处方：

retention >= 3 years

麻醉 / 精神 / 毒性药品处方：

retention >= 5 years

catalog / drug 增加受控类型：

controlled_class:

none
narcotic
psychotropic
toxic
other_controlled

处方生成 retention_until 时根据药品类别计算最长要求。

--------------------------------
A7. 受控药最低全国规则
--------------------------------

必须实现：

1. 麻醉药品单独处方；
2. 麻醉药每张处方不超过一日量；
3. 精神药品单独处方；
4. 毒性药品单独处方；
5. 处方保存至少 5 年；
6. 高风险操作权限；
7. 审计。

不要强制实现：

- 双人双锁
- 双人发药
- 空瓶回收

除非后续确认目标地区监管或医院 SOP。

这些做成可配置 policy 预留。

--------------------------------
A8. 处方输出
--------------------------------

兽医处方打印至少支持监管字段：

- 动物诊疗机构
- 地址/电话
- 病历号
- 动物主人
- 动物信息
- 诊断
- 药品名称
- 规格
- 数量
- 用法
- 用量
- 开具日期
- 执业兽医
- 发药人员
- 签名/盖章区域

保留一式三联的打印配置。

电子签名未接入可靠 Provider 前：

不得把普通签名图片宣传为可靠电子签名。

--------------------------------
A9. 动物诊疗许可证
--------------------------------

新增：

institution_licenses

字段：

tenant_id
store_id
license_no
issuing_authority
diagnosis_scope
issued_at
valid_from
valid_until nullable
status
certificate_file_id
certificate_qr nullable

支持：

- 查看
- 上传证照
- 变更历史
- 审计
- 可配置到期提醒

不要假设全国统一许可证有效期。

--------------------------------
A10. 年度动物诊疗活动报告
--------------------------------

依据：

《动物诊疗机构管理办法》第三十条

能力：

annual_regulatory_reports

字段：

tenant_id
store_id
report_year
status
generated_at
submitted_at
submitted_by
report_snapshot
attachment_file_id

状态：

draft
generated
submitted
accepted
rejected

系统应能从已有业务数据生成年度汇总草稿。

第一版只需要：

生成
预览
导出
记录提交状态

不需要直接连接政府系统。

--------------------------------
A11. 疫情报告
--------------------------------

新增事件模型：

epidemic_events

状态：

detected
reported
isolated
resolved

字段：

tenant
store
pet
suspected_disease
detected_at
reported_at
reported_by
isolation_required
isolated_at
treatment_restricted
restriction_reason
culling_required
resolved_at
notes

禁止使用：

customed
customed_blocked

要求：

- 报告行为进入 audit；
- 明确记录是否治疗受限；
- 不自动做医疗判断。

--------------------------------
A12. 医疗废弃物
--------------------------------

建立最小台账：

medical_waste_records

字段：

tenant
store
waste_type
quantity
unit
generated_at
handover_at
handler_employee_id
receiver
disposal_method
attachment_file_id
notes

第一版重点：

记录
查询
导出
审计

不做复杂供应链。

==================================================
四、S3.1-B 经营底线 P0
==================================================

--------------------------------
B1. Tenant Initialization
--------------------------------

新租户初始化必须形成完整事务/流程：

create tenant
→ first store
→ default warehouse
→ default cashier context
→ owner/admin
→ default roles
→ base dictionary
→ print settings
→ audit

要求：

- 幂等；
- 半失败可恢复；
- 不允许产生“看起来创建成功但缺关键数据”的租户；
- 初始化状态可查询。

建议：

tenant_initialization_status

pending
running
completed
failed

--------------------------------
B2. 日结
--------------------------------

新增：

daily_closings

字段至少：

tenant_id
store_id
business_date
status
opened_at
closed_at
closed_by
gross_amount
paid_amount
refund_amount
receivable_amount
cash_amount
card_amount
wechat_amount
alipay_amount
stored_value_amount
other_amount
snapshot
created_at

要求：

- 一门店一天只能一个正式 closing；
- close 后不可直接修改；
- 更正走 adjustment；
- 高风险操作审计。

--------------------------------
B3. 对账
--------------------------------

reconciliation_records

至少支持：

- cash expected
- cash actual
- external payment expected
- external payment actual
- stored value
- refunds
- difference
- difference reason
- confirmed_by

真实支付尚未接入时：

仍可做系统账面日结。

--------------------------------
B4. 审计后台
--------------------------------

当前 audit_logs 已有数据基础。

必须补查询 UI：

支持：

- 日期
- tenant
- store
- employee
- action
- resource_type
- resource_id
- request_id
- high risk
- before/after

权限：

audit.read.store
audit.read.tenant
audit.export

普通业务用户只能查看授权范围。

审计日志不得编辑。

--------------------------------
B5. 最小回访任务
--------------------------------

新增：

followup_tasks

字段：

tenant
store
customer
pet nullable
source_type
source_id
task_type
scheduled_at
assignee_employee_id
status
channel
result
next_followup_at
created_at

状态：

pending
in_progress
completed
cancelled

来源至少：

appointment
encounter
vaccination
diagnostic
manual

第一版不做复杂流失预测。

==================================================
五、S3.1-C 医疗闭环补强
==================================================

--------------------------------
C1. 护士任务自动生成
--------------------------------

医生创建：

- 医嘱
- 注射
- 输液
- 处置
- 护理

后自动生成 nurse task。

要求：

- source_type/source_id
- 不重复生成
- 有 idempotency
- cancelled source 自动取消未执行任务
- 已执行任务不允许被源单删除

--------------------------------
C2. 护士任务超时与异常
--------------------------------

字段：

scheduled_at
started_at
completed_at
overdue_at
exception_code
exception_reason

状态：

pending
in_progress
completed
failed
cancelled

工作台显示：

- overdue
- due soon
- exception

--------------------------------
C3. 检验标本
--------------------------------

新增/完善：

lab_samples

字段：

lab_order_id
sample_no
sample_type
collected_at
collected_by
received_at
received_by
status
rejected_reason

状态：

planned
collected
received
testing
completed
rejected

--------------------------------
C4. 危急值闭环
--------------------------------

lab result 支持：

is_critical
critical_value_code
notified_at
notified_to
acknowledged_at
acknowledged_by

流程：

critical result
→ notify
→ acknowledge
→ audit

不要默认强制所有检验双人审核。

普通检验双人审核做成 tenant policy。

--------------------------------
C5. 检验结果引用病历
--------------------------------

医生可从病历：

选择已发布检验结果
→ 插入摘要/引用
→ 保存 result id reference

禁止复制后失去来源。

必须保留：

source_lab_result_id

--------------------------------
C6. 住院每日病程
--------------------------------

新增：

inpatient_progress_notes

字段：

admission_id
record_date
author_employee_id
content
status
signed_at
created_at

每天允许多条，但要有时间顺序。

出院前检查：

- 是否存在要求完成但未完成的 progress
- 是否存在未处理护理任务
- 是否存在未结费用

--------------------------------
C7. 出院结算
--------------------------------

流程：

prepare discharge
→ calculate charges
→ pending settlement
→ payment
→ discharge
→ archive

要求：

- 未结算情况下默认不能正常 discharge；
- 特殊免结需要权限和原因；
- 出院时间与收费状态一致；
- 触发住院病历 3 日归档 deadline。

--------------------------------
C8. 打印补强
--------------------------------

Pilot 阶段至少保证：

- invoice
- prescription
- medical record
- lab report
- vaccine certificate
- discharge summary

纸张：

58mm
80mm
A4

要求：

@media print
分页
Logo
医院信息
客户/宠物
医生
页脚
签名区域

暂不要求 Puppeteer PDF。

==================================================
六、数据库开发规则
==================================================

Stage 03 从：

migration 28

开始。

禁止修改已经交付的旧 migration 01～27。

每个新 migration 必须：

1. 可重放；
2. 明确 RLS；
3. 明确 grant/revoke；
4. 明确 foreign key；
5. 明确 index；
6. 不产生跨 tenant 唯一冲突；
7. 不信任客户端 tenantId/storeId；
8. SECURITY DEFINER 必须：
   - set search_path
   - 明确 execute grant
   - 如为 Command，则纳入 service-role-only manifest

所有新 Hono Command RPC 必须同步：

api/lib/service-rpc-manifest.ts

并保证：

pnpm check:rpc-manifest

继续通过。

==================================================
七、API 规则
==================================================

继续遵守：

Query：
简单数据可 Supabase + RLS。

Command：
高风险写操作：

Browser
→ Hono
→ scoped permission
→ service role
→ PostgreSQL RPC

例如：

archive medical record
amend medical record
issue prescription
controlled drug prescription
daily closing
reconciliation confirm
regulatory submit

不得浏览器直调 transactional RPC。

==================================================
八、权限要求
==================================================

新增权限码示例：

medical_record.archive
medical_record.amend.request
medical_record.amend.approve

veterinarian_registration.read
veterinarian_registration.manage

prescription.issue
prescription.extend_validity
prescription.controlled_issue

license.read
license.manage

regulatory_report.read
regulatory_report.generate
regulatory_report.submit

epidemic.read
epidemic.report
epidemic.resolve

waste.read
waste.manage

daily_closing.read
daily_closing.close
daily_closing.adjust

reconciliation.read
reconciliation.confirm

audit.read.store
audit.read.tenant
audit.export

followup.read
followup.create
followup.execute

所有权限继续带 tenant/store scope。

==================================================
九、审计要求
==================================================

S3.1 新增以下动作必须进入 audit：

- 病历归档
- 病历 amendment request/approve/apply
- 执业兽医资格变更
- 处方开具
- 处方有效期延长
- 受控药处方
- 许可证修改
- 年报生成/提交
- 疫情报告/处理
- 废弃物记录关键变更
- 日结
- 日结调整
- 对账确认
- 回访完成
- 危急值确认
- 出院

audit 至少：

tenant_id
store_id
actor_user_id
actor_employee_id
action
resource_type
resource_id
before
after
request_id
occurred_at

==================================================
十、S3.1 测试要求
==================================================

每个模块不能只交页面。

必须同时完成：

数据库
API
权限
UI
测试

新增：

1. compliance SQL tests
2. API tests
3. E2E

至少覆盖：

病历：
- 门诊 archive_due
- 住院 archive_due
- archived 直接修改失败
- amendment 成功
- 未授权 amendment 失败

处方：
- 默认当日有效
- >3 天失败
- expired dispense 失败
- controlled drug retention
- 非有效执业兽医开方失败

日结：
- 单店单日唯一
- close 后不可修改
- adjustment
- 权限

权限：
- Store A 不可操作 Store B
- tenant role 不可越 tenant
- platform role 独立

==================================================
十一、Staging 工作同步准备
==================================================

不要等待 S3.1 全写完才准备 staging。

在 S3.1 开发同时整理：

STAGING_SETUP_CHECKLIST.md

需要：

Supabase staging
R2 staging
Vercel Preview
E2E users
CI secrets

但是：

绝对禁止在当前 production Supabase 上执行：

db reset
破坏性 migration rehearsal
并发测试
跨租户攻击测试

==================================================
十二、Stage 03 状态管理
==================================================

只允许：

not_started
in_development
code_complete
integration_pending
verified
production_ready

禁止：

“页面完成”
“基本完成”
“95%”
“看起来可用”

代替正式状态。

S3.1 开发过程中：

模块代码写完：
code_complete

需要 staging：
integration_pending

真实测试通过：
verified

==================================================
十三、开发节奏
==================================================

建议按 4 个 Sprint：

Sprint S3.1-1
【合规数据底座】

- 病历归档
- amendment
- retention
- 执业兽医备案
- 处方有效期
- 处方 retention

Sprint S3.1-2
【监管 + 经营底线】

- license
- annual report
- epidemic
- medical waste
- tenant initialization
- daily closing
- reconciliation

Sprint S3.1-3
【医疗闭环补强】

- audit UI
- followup
- nurse task generation
- lab sample
- critical value
- lab → record
- inpatient progress
- discharge settlement
- printing

Sprint S3.1-4
【集成收口】

- permissions
- tests
- E2E
- docs
- staging preparation
- migration rehearsal scripts

不要四个 Sprint 一次性全部并行写。

==================================================
十四、每个 Sprint 的提交要求
==================================================

每个 Sprint 提交：

1. commit SHA
2. 修改文件清单
3. migration
4. schema 变化
5. API
6. 页面
7. permission code
8. audit event
9. tests
10. 未完成项
11. 风险
12. 下一 Sprint 依赖

禁止只写：

“已完成”。

==================================================
十五、S3.1 最终退出标准
==================================================

代码层：

- lint PASS
- typecheck PASS
- build PASS
- check:rpc-manifest PASS
- migration 数量/版本准确
- 无浏览器 Command RPC
- 无手工 UUID 正常业务输入

合规：

- archive
- retention
- amendment
- prescription validity
- veterinarian registration
- controlled drug minimum rules
- license
- annual report
- epidemic
- waste

经营：

- initialization
- closing
- reconciliation
- audit UI
- followup

医疗：

- nurse task
- lab sample
- critical value
- record reference
- inpatient progress
- discharge settlement

运行验收：

- migration
- RLS
- rpc_security
- permission
- idempotency
- inventory concurrency
- E2E A/B/C
- compliance E2E

只有全部真实运行通过，才可以：

S3.1 = verified
Pilot Ready = YES

==================================================
十六、现在立即执行
==================================================

从：

Sprint S3.1-1

开始。

第一批只开发：

1. 病历归档
2. archive deadline
3. retention
4. amendment
5. veterinarian registration
6. prescription validity
7. prescription retention
8. controlled drug minimum regulation

完成 Sprint S3.1-1 后停止，不要直接继续 Sprint 2。

提交完整源码和 Sprint 交付说明，等待审计。

不要提前开发：
C 端、会员、营销、AI、设备、供应链高级功能。

最终目标不是“继续增加代码量”，而是：

让毛线球从
code_complete
逐步达到
verified
pilot_ready。
