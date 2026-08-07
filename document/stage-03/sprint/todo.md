你现在作为【毛线球宠物医院 SaaS】Stage-03 并发开发工程师。

你的任务不是接管整个 Stage-03。

你只负责一个独立并发工作包：

S3.1-PARALLEL-01
【监管运营基础包】

目标：

在不干扰主开发线 S3.1 Sprint 1 医疗合规收尾的前提下，
独立完成以下 4 个模块：

1. 动物诊疗许可证
2. 年度动物诊疗活动报告
3. 疫情事件台账
4. 医疗废弃物台账

============================================
一、严格边界
============================================

禁止修改以下主线核心逻辑：

- clinical sign_encounter
- prescription issue / dispense
- inventory transaction
- veterinarian registration 核心逻辑
- medical record archive/amendment
- platform_user_roles
- scoped permission 核心实现
- api/lib/permission.ts
- service RPC authorization architecture

除非为了新增本工作包的 permission code / manifest entry
做最小必要增加。

禁止重构已有框架。

禁止开发：

- 日结
- 对账
- tenant initialization
- 护士任务
- 检验
- 住院
- C端
- 会员
- 营销
- AI

这些由其他 Sprint/员工负责。

============================================
二、架构规则
============================================

必须继续遵守当前项目架构：

Frontend:
Vue 3 + Vite + TypeScript

Backend:
Hono

Database:
Supabase PostgreSQL + RLS

高风险 Command：

Browser
→ Hono
→ scoped permission
→ service role
→ PostgreSQL transactional RPC

禁止 Browser 直接调用 Command RPC。

新增 Command RPC 必须：

- SECURITY DEFINER
- SET search_path
- revoke public
- revoke anon
- revoke authenticated
- grant service_role

并加入：

api/lib/service-rpc-manifest.ts

保证：

pnpm check:rpc-manifest

通过。

============================================
三、数据库 migration
============================================

你必须先查看当前最新 migration。

由于主线员工可能同时新增 migration，
不要自行假定 migration 30 一定可用。

在开始编码前：

git pull / rebase 当前开发基线

确认最新 migration number。

你的 migration 建议使用专属编号区间，例如：

PARALLEL 当前保留：

31～34

但如果主线已经占用，
必须重新编号。

不要修改已经存在/已提交的旧 migration。

============================================
四、模块 1：动物诊疗许可证
============================================

新增：

institution_licenses

建议字段：

id
tenant_id
store_id

license_no
issuing_authority
diagnosis_scope

issued_at
valid_from
valid_until nullable

status

certificate_file_id nullable
certificate_qr nullable

created_at
created_by

updated_at
updated_by

状态：

draft
active
suspended
revoked
expired

要求：

1. 支持一个门店许可证历史版本。
2. 不允许 UPDATE 覆盖历史证照而完全丢失旧信息。
3. 关键修改必须 audit。
4. 支持附件。
5. 支持有效状态查询。
6. 支持可配置到期提醒字段/查询。
7. 不要假设全国统一许可证固定有效期。

权限：

license.read
license.manage

scope：

store-level 优先。

store_manager 可以管理授权门店许可证。

tenant-level 管理员未来可以管理全部门店。

RLS 必须按照：

tenant + store

限制。

页面：

系统 / 合规 / 动物诊疗许可证

至少支持：

- 列表
- 查看
- 新增
- 编辑
- 上传证照
- 状态
- 历史
- 到期时间

普通用户不要输入 tenantId/storeId UUID。

使用 StorePicker / 当前门店上下文。

============================================
五、模块 2：年度动物诊疗活动报告
============================================

法规依据：

《动物诊疗机构管理办法》第三十条。

不要写成第二十七条。

新增：

annual_regulatory_reports

字段：

id
tenant_id
store_id
report_year

status

generated_at
generated_by

submitted_at
submitted_by

accepted_at nullable
rejected_at nullable
rejected_reason nullable

report_snapshot jsonb
attachment_file_id nullable

created_at
updated_at

状态：

draft
generated
submitted
accepted
rejected

要求：

第一版实现：

生成草稿
→ 预览
→ 导出
→ 标记已提交
→ 记录结果

不要实现政府系统 API 对接。

生成报告时必须保存：

report_snapshot

不能每次查看都重新实时计算导致历史数据改变。

建议第一版快照至少包含：

- 门店基本信息
- 诊疗数量
- 医生数量
- 执业兽医数量
- 动物类别基本统计
- 处方数量
- 疫情事件数量
- 医疗废弃物记录概要

如果现有数据无法可靠计算：

明确写 null / unavailable，

不要伪造。

权限：

regulatory_report.read
regulatory_report.generate
regulatory_report.submit

Command：

generate
submit
accept/reject 如仅平台内部模拟，可暂不开放租户。

所有 generate / submit 必须 audit。

============================================
六、模块 3：疫情事件台账
============================================

新增：

epidemic_events

字段：

id
tenant_id
store_id

customer_id nullable
pet_id nullable
encounter_id nullable

suspected_disease

detected_at
detected_by

reported_at nullable
reported_by nullable

isolation_required boolean
isolated_at nullable

treatment_restricted boolean
restriction_reason nullable

culling_required boolean nullable

resolved_at nullable
resolved_by nullable

notes

status

created_at
updated_at

状态：

detected
reported
isolated
resolved

禁止出现：

customed
customed_blocked

要求：

1. 系统负责记录，不替医生自动做疫情诊断。
2. “是否限制治疗”等必须由授权用户明确填写。
3. report / resolve 必须 audit。
4. 支持关联宠物、病历。
5. 普通业务 UI 不输入 UUID。
6. 使用 PetPicker / EncounterPicker 等已有组件。

权限：

epidemic.read
epidemic.report
epidemic.resolve

scope：

store-level。

禁止 Store A 查看 Store B。

============================================
七、模块 4：医疗废弃物台账
============================================

新增：

medical_waste_records

字段：

id
tenant_id
store_id

waste_type
quantity
unit

generated_at

handover_at nullable
handler_employee_id nullable

receiver nullable
disposal_method nullable

attachment_file_id nullable

notes

created_at
created_by
updated_at

第一版重点：

记录
查询
修改未交接记录
交接
导出
审计

状态建议：

draft
recorded
handed_over

权限：

waste.read
waste.manage

store-level。

交接动作必须 audit。

Employee 使用 Picker。

不得输入员工 UUID。

============================================
八、API
============================================

新增独立 route：

建议：

api/routes/regulatory.ts

或拆为：

api/routes/licenses.ts
api/routes/regulatory-reports.ts
api/routes/epidemic.ts
api/routes/waste.ts

如果项目当前倾向按领域合并：

优先 regulatory.ts。

不要把代码塞进：

clinical.ts
inventory.ts
compliance.ts

避免和主线员工产生大量 merge conflict。

Query 可以：

Supabase + RLS

高风险 Command：

例如：

license state change
annual report generate
annual report submit
epidemic report
epidemic resolve
waste handover

必须：

Hono → RPC。

============================================
九、前端
============================================

建议独立目录：

views/regulatory/

license/
annual-report/
epidemic/
medical-waste/

不要大改现有 clinical 页面。

公共组件尽量复用。

如果需要新增 Picker：

只新增领域独立组件。

不要修改已有 Picker 的核心行为，
除非确实存在 bug。

============================================
十、权限
============================================

新增：

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

默认权限：

store_manager：

license.read
license.manage

regulatory_report.read

epidemic.read
epidemic.report
epidemic.resolve

waste.read
waste.manage

doctor：

license.read
regulatory_report.read
epidemic.read
epidemic.report
waste.read

不要授予医生：

license.manage
regulatory_report.submit
waste.manage

tenant_owner：

可以拥有上述全部 tenant/store 权限，
但注意 tenant_owner 的最终模型由主线员工负责。

如果当前 tenant_owner 尚未 merge：

不要自己重复创建 tenant_owner。

你的 migration 只添加 permission code。

待主线合并后由权限 seed/reconciliation 统一授权。

============================================
十一、Audit
============================================

必须记录：

license.create
license.update
license.status_change

regulatory_report.generate
regulatory_report.submit

epidemic.report
epidemic.isolate
epidemic.resolve

waste.create
waste.update
waste.handover

actor 必须来自当前 authenticated user，
不得客户端传 operatorEmployeeId。

复用主线最终的：

resolveCurrentEmployee(user, tenantId, storeId?)

如果该 helper 尚未 merge：

在自己的 branch 不要复制另一套权限模型。

可以：

等待主线 helper merge 后 rebase，
或只做极小兼容 wrapper。

============================================
十二、测试
============================================

必须新增 SQL tests。

建议：

supabase/tests/regulatory_s3_1.sql

至少测试：

License：

Store A manager
→ Store A PASS

Store A manager
→ Store B FAIL

expired/status edge

Annual report：

generate snapshot PASS

未经授权 submit FAIL

snapshot 生成后历史内容固定

Epidemic：

create/report PASS

Store A → Store B FAIL

resolve unauthorized FAIL

Waste：

create PASS

handover PASS

handover actor audit

Store A → Store B FAIL

还必须确认：

Hono route RPC
⊆ service-role-only manifest

============================================
十三、合并冲突控制
============================================

这是并发任务最重要的要求之一。

尽量不要修改：

api/lib/permission.ts
api/routes/clinical.ts
api/routes/inventory.ts
api/routes/compliance.ts

如果必须修改：

控制在最小 diff。

以下文件可能产生共享冲突：

api/index/router
router modules
service-rpc-manifest.ts
permission seed migration
menu/router configuration
components.d.ts

修改前先 pull/rebase。

最终交付时列出：

CONFLICT_PRONE_FILES

让主开发人员知道哪些文件需要特别 merge。

============================================
十四、Git 工作方式
============================================

使用独立 branch，例如：

feature/s31-regulatory-parallel

每个模块尽量独立 commit：

REG-01 license
REG-02 annual report
REG-03 epidemic
REG-04 waste
REG-05 tests/docs

不要在 branch 中合并主线未完成代码后强推。

需要同步时：

rebase 主开发 branch。

============================================
十五、完成状态
============================================

你完成后只能写：

S3.1-PARALLEL-01 = code_complete
runtime = integration_pending

不能写：

verified
production_ready

因为 staging 尚未执行。

============================================
十六、最终交付
============================================

完成后停止开发。

提交：

1. 完整源码 ZIP
2. changed/diff ZIP
3. branch
4. HEAD commit SHA
5. commit 列表

6. migration 列表

7. 新增 tables

8. 新增 RPC

9. service-rpc-manifest 变化

10. API route

11. 页面

12. permissions

13. audit events

14. SQL tests

15. E2E/API tests（如有）

16. lint 原始结果
17. typecheck 原始结果
18. build 原始结果
19. check:rpc-manifest 原始结果

20. 已知问题

21. CONFLICT_PRONE_FILES

22. 与主线 merge 的依赖

完成后停止。

不要主动开始下一任务。
