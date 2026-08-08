# 实施状态文档（IMPLEMENTATION_STATUS）

> 本文件与代码保持对齐，由每次交付更新。所有 P0 任务均以"任务提交要求"（v0.5 第 21 节）报告代码、migration、API、UI、权限、测试与风险。
>
> 依据：`document/stage-02/毛线球-最新开发指导文档-v0.5.md` 附录 A（第四部分第 20 节）推荐执行顺序。

## 状态总览

| 任务 | 内容 | 状态 | 说明 |
| --- | --- | --- | --- |
| DEV-000 | 基线对齐 | ✅ 完成 | 代码主体已铺开，与 v0.5 设计文档对齐 |
| P0-01 | scoped permission | ✅ 完成 | `requireScopedPermission` 按目标租户+门店解析真实作用域 |
| P0-02 | service role route 收口 | ✅ 完成 | 审计全部 service role 路由，逐路由 scoped 授权 |
| P0-03 | 旧文件接口下线 | ✅ 完成 | 旧 `/api/upload`、`/api/files` 已下线，统一新 R2 私有签名 |
| P0-04 | Picker 补齐 | ✅ 完成 | 经盘点基本齐全，无需重新开发 |
| P0-05 | 打印真实数据 | ✅ 完成 | 打印绑定真实业务 DTO（print-data 接口） |
| P0-06 | 报表统一 | ✅ 完成 | 浏览器聚合迁移至 Hono `/operations/report-data` + PostgreSQL 聚合 |
| P0-07 | 消息策略 | ✅ 完成 | 决策：方案 A——消息模块退出 MVP（见 PRD-v0.5 增补修订版第 14 节） |
| P0-08 | 库存一致性 | ✅ 完成 | migration 25：FEFO 批次扣减 + reserved_until 自动/批量释放 + 处方发药/取消联动 |
| P0-09 | 真实闭环 E2E | ✅ 代码完成 / ⏳ 待 staging 执行 | 闭环 A/B/C 已编写并通过 tsc；需 staging 环境实际执行 |
| P0-10 | 文档与命令修正 | ✅ 完成 | 根 package.json 补 test:e2e 脚本；AGENTS.md 重写；新增本组文档 |
| S3.0 | Stage02 审计收口 | ✅ 完成 | AUD-001~011 全部落地（明细见下文「S3.0 审计收口」） |
| S3.0-R | 定向复审收口 | ✅ 代码完成 / ⏳ 待 staging 执行 | S30-R01~R07 全部落地（明细见下文「S3.0 定向复审（S30-R01~R07）」） |
| S3.0-F | S30-F01~F04 复审收口 | ✅ code_complete / ⏳ integration_pending（待 staging 验证） | 平台管理员独立模型 + RPC 默认拒绝（全量 revoke + manifest CI 规则）+ rpc_security.sql 独立可执行 + 文档证据（明细见下文「S3.0 复审（S30-F01~F04）」） |
| S31-MERGE-FINAL | 合并批次最终收尾 | ✅ code_complete / ⏳ runtime integration_pending | FINAL-01~04 全部落地（明细见下文「S31-MERGE-FINAL 合并收尾」） |
| S31-A/B/C/D | S3.1 并发任务集成收尾 | ✅ code_complete / ⏳ runtime integration_pending | A（租户初始化 35~38）+ B（日结对账 39~43）+ C（医疗闭环 44~49）已合并入主线；D 收尾：RPC manifest / lint / typecheck / build 全绿（明细见下文「S3.1 并发集成收尾（Integration Owner D）」） |
| S3.1-PARALLEL | S3.1 并发加速开发（Agent-01~07） | ✅ code_complete / ⏳ runtime integration_pending | 平台租户 + 会员产品化 + 影像 + 回访 + 采购 + 寄养六个新模块收口；Integrator 修复 RPC manifest（迁移 90）+ 寄养→计费原子集成（迁移 91）+ 病历/出院→自动回访 + 前端权限清单补齐；build/typecheck/manifest 全绿（明细见下文「S3.1 并发加速开发（Agent-01~07）」） |

## 已交付任务明细

### P0-01 scoped permission
- 重构授权为 `requireScopedPermission({ code, tenantId, storeId })`，按调用者成员身份解析真实作用域，平台管理员以 `PLATFORM_ADMIN_ROLE = 'system_admin'` 判定。
- API：`api/lib/permission.ts`；前端无改动。
- 权限：原 permission 码不变，仅校验口径变化。

### P0-02 service role route 收口
- 审计全部 domain 路由（customers / pets / clinical / billing / inventory / inpatient / operations 等），所有 service client 查询路由补 scoped 授权并强制按 `scope.tenantId` 过滤。
- API：`api/routes/*.ts`、`api/middlewares/auth.ts`。
- 禁止事项落实：不得允许客户端自由指定 tenant 后 service role 直接查询。

### P0-03 旧文件接口下线
- 下线旧 `/api/upload`、`/api/files` 两套生产文件接口，统一新模型（files 表 + R2 私有签名 URL）。
- API：`api/index.ts` 删除旧挂载。
- 禁止事项落实：不再保留两套生产文件接口。

### P0-05 打印真实数据
- 打印接口绑定真实业务 DTO（print-data），替代演示数据。
- API：`api/routes/print-data.ts`（含示例 `GET /print-data/:id`）；前端打印页接入。
- 待完善项见 KNOWN_GAPS（P1 打印能力项）。

### P0-06 报表统一
- 新增 `api/routes/report-data.ts`：`GET /operations/report-data/:reportCode` 服务端聚合 5 类报表。
- `api/index.ts` 挂载顺序：report-data 必须挂在 `/operations` 之前，否则被 operationsRoutes 拦截。
- UI：`apps/maoxianqiu/src/views/operations/reports/index.vue` 删除约 500 行浏览器跨表聚合。
- 禁止事项落实：浏览器不再负责大规模跨表聚合。

### P0-07 消息策略
- 决策：方案 A（消息模块退出 MVP）。
- 文档：`document/stage-03/01-产品需求说明书-PRD-v0.5-增补修订版.md` 第 14 节。
- 代码：消息相关页面/接口按 MVP 边界裁剪，不生产 Mock sent。

### P0-08 库存一致性
- migration：`supabase/migrations/20260807000025_inventory_reserve_consistency.sql`
  - `inventory_movements` 增加 `reserved_until timestamptz` + 部分索引。
  - 重建 `reserve_inventory`（新增 `p_reserved_until`，默认 24h）。
  - 重建 `confirm_inventory_reservation`：确认前自动释放过期预留 + FEFO 批次扣减。
  - 新增 `release_expired_reservations` 批量释放 RPC。
  - 权限：revoke public + grant authenticated。
- API：
  - `api/routes/clinical.ts`：处方发药先确认预留（无预留即时 FEFO 发药）；取消处方先释放预留。
  - `api/routes/billing.ts`：取消发票联动释放该就诊下处方的未处理预留。
  - `api/routes/inventory.ts`：`POST /reserve/release-expired` 运维端点（inventory.release 权限）。
- 验证：`api` 目录 tsc 通过。

### P0-09 真实闭环 E2E
- 结构：`test.describe.configure({ mode: 'serial' })` 单一串行 test，走完整业务链路，每阶段用 Supabase REST 断言数据库状态。
- 辅助：`e2e/helpers/api.ts`（apiBaseFor / getAccessToken / newIdemKey / createApiClient / supabaseSelect / supabaseInsert）。
- 闭环 A：`e2e/tests/closed-loop-a.spec.ts` —— 客户→宠物→预约→候诊→就诊→病历→处方→发药→收费支付→签署只读。
- 闭环 B：`e2e/tests/closed-loop-b-inventory.spec.ts` —— 入库→余额→盘点(UI)→调拨→流水。
- 闭环 C：`e2e/tests/closed-loop-c-inpatient.spec.ts` —— 入院→房位占用→护理任务→换房→自动计费→出院。
- 验证：`tsc -p e2e/tsconfig.json` 通过；`playwright test --list` 收集 14 个用例无编译错误。
- 未验证项：真实执行须 staging 环境（E2E 管理员账号 + Supabase + dev server），见 RELEASE_CHECKLIST。

### P0-10 文档与命令修正
- 根 `package.json` 新增：
  - `test:e2e`、`test:e2e:ui`、`test:e2e:report`。
- `AGENTS.md` 重写为毛线球项目规则（Vue 3.5.40 / Fantastic Admin + Reka UI / 禁新增 Element Plus / Command 走 Hono / service role 必须 scoped authorization / example 页面不视为产品功能）。
- 本目录（`document/current/`）新增 IMPLEMENTATION_STATUS / KNOWN_GAPS / RELEASE_CHECKLIST。

## S3.0 审计收口

> 依据：`document/stage-02/毛线球-Stage02源码审计与Stage03执行指导-v1.1.md` 第 18 章 S3.0 任务清单。11 个 AUD 任务全部落地，代码与文档已对齐。

| AUD | 内容 | 状态 | 说明 |
| --- | --- | --- | --- |
| AUD-001 | 基线证明 | ✅ 完成 | S3.0 全部改动待一次 commit 关联（见提交说明） |
| AUD-002 | scoped permission 作用域串用 | ✅ 完成 | `api/lib/permission.ts`：区分 tenant-wide（store_id IS NULL）与 store-scoped 角色分配；`AccessScope` 新增 `allowedStoreIds`；平台管理员判定收紧为 `is_system && scope='system'` |
| AUD-003 | report-data 门店数据范围 | ✅ 完成 | `api/routes/report-data.ts`：引入 `ReportQuery.allowedStoreIds`，5 类报表在查询层按门店集合强制过滤（refunds 按发票归属、inventory 按仓库归属） |
| AUD-004 | 宠物新增 UI | ✅ 完成 | 新增 `PetForm`、`PetCreateDrawer` 业务组件；客户详情页接入「新增宠物」入口并刷新 |
| AUD-005 | 清理正式表单手填 ID | ✅ 完成 | 全部正式表单替换/统一为业务 Picker，误导性「XX ID」标签与提示文案业务化 |
| AUD-006 | 打印选择器收尾 | ✅ 完成 | `operations/print`：lab_report/vaccine_certificate 接入 `DiagnosticOrderPicker`，移除实体 ID 手填兜底 |
| AUD-007 | inventory 过期预留确认缺陷 | ✅ 完成 | migration 25 修复：确认时自身预留已过期直接拒绝（RESERVATION_EXPIRED）；stale loop 排除当前确认 id；新增 RLS 回归测试 `supabase/tests/rls_inventory_reserve.sql` |
| AUD-008 | E2E 禁止核心 skip | ✅ 完成 | 闭环 A/B/C 缺 seed（drug 商品/仓库/笼位）由 skip 改为 FAIL；清理过时 `.spec.js` 编译产物避免双跑 |
| AUD-009 | 闭环 A 顺序确认 | ✅ 完成 | 按默认建议 prescription → invoice → payment → dispense 调整；不再由测试代码擅自先发药后收费 |
| AUD-010 | typecheck/lint/build 全绿 | ✅ 完成 | 前端 `vue-tsc -b`、api `tsc --noEmit`、e2e `tsc`、ESLint、`vite build` 全部通过 |
| AUD-011 | current 文档与源码重新对齐 | ✅ 完成 | 本文件 + KNOWN_GAPS + RELEASE_CHECKLIST 同步更新；关闭 P1-01 等已修复缺口 |

### AUD-002 scoped permission 修复明细
- `api/lib/permission.ts`：
  - `RoleRow` 增加 `is_system`；`AccessScope` 增加 `allowedStoreIds: string[]`。
  - 新增 `collectRolePermissions()` 从 role_permissions 关联表 + roles.permissions 聚合权限码。
  - `ScopedRequirement` 支持 `dataScope?: boolean`（报表只读聚合模式）。
  - 匹配逻辑：传 storeId 时允许 `store_id === storeId || null`；命令模式（未传 storeId）仅匹配 tenant-wide 分配。
  - 平台管理员纵深防御：`code==='system_admin' && is_system && scope==='system'` 并组装全租户门店为 allowedStoreIds。

### AUD-003 report-data 修复明细
- `api/routes/report-data.ts`：
  - 5 类报表（收入/退款/库存/客户/医疗）查询统一注入 `query.allowedStoreIds`。
  - refunds 无 store_id：先按允许门店收敛 invoice id 集合再查 refunds。
  - inventory_balances 无 store_id：先按 `warehouses.store_id` 收敛 warehouse id 集合；空集合直接返回空报表。
  - 路由 handler 显式传 storeId 时，`allowedStoreIds` 收敛到该门店。

### AUD-007 库存一致性修复明细
- migration `20260807000025_inventory_reserve_consistency.sql`：
  - `confirm_inventory_reservation`：当前预留 `reserved_until < now()` 直接抛 `RESERVATION_EXPIRED`（防重复检查之后、扣减之前）。
  - stale loop 查询排除当前确认的 `m.id <> v_reserve.id`，避免确认自身被重复 release。
- API：`api/routes/inventory.ts` 新增 RESERVATION_EXPIRED → 409「该预留已过期,请重新预留或释放」映射。
- 测试：`supabase/tests/rls_inventory_reserve.sql`（R1~R6 覆盖过期确认拒绝、并发释放、重复确认、库存竞争、stale loop 回归）。

## S3.0 定向复审（S30-R01~R07）

> 依据：S3.0 定向复审结论（V1.1）。7 项定向任务全部落地；未验证项一律标注"待 staging 执行"，不标"✅完成"。

| R | 内容 | 状态 | 说明 |
| --- | --- | --- | --- |
| S30-R01 | 数据库 scoped permission | ✅ 代码完成 / ⏳ 待 staging 执行 | migration 26 重建 `has_permission()`（scope 感知）；tenant 上下文仅 tenant/system role；store 上下文仅目标 store role 或 tenant-wide role；新增 store→tenant 提升负向测试 |
| S30-R02 | Hono role scope | ✅ 代码完成 / ⏳ 待 staging 执行 | `resolveScopedAccess` 在计算 permission union 前校验 `role.scope`；禁止 scope=store + store_id=NULL 被当 tenant role；数据库触发器 `trg_era_scope` 拒绝非法 role assignment |
| S30-R03 | SECURITY DEFINER RPC 安全 | ✅ 代码完成 / ⏳ 待 staging 执行 | 高危 Command RPC 全部 revoke public/anon/authenticated + grant service_role（见 migration 26 第 6 节）；前端支付/退款/库存/诊断等 RPC 直连全部改走 Hono；新增 `rpc_security.sql` direct RPC 测试 |
| S30-R04 | employee.id / auth.users.id 语义修复 | ✅ 完成 | 病历签署取消 EmployeePicker，强制当前登录 user.id（`apiClinical.signEncounter(id)` 无 doctorId 参数）；EmployeePicker 新增 `value-key`（默认 employees.id / 'user_id' 取 auth.users.id）；字段语义经 COMMENT ON COLUMN 固化 |
| S30-R05 | E2E A 真实 UI | ✅ 代码完成 / ⏳ 待 staging 执行 | closed-loop-a 步骤 2 使用 UI 新建宠物（客户详情页「新增宠物」），禁止 `api.post('/pets')` 绕过；步骤 10 签署通过 UI 真实完成 |
| S30-R06 | Picker 最后清场 | ✅ 完成 | inventory receipt 商品预留改 `BusinessCatalogItemPicker`；inpatient nursing / handover 交接班人改 `value-key="user_id"`；print 非可选取类型禁用输入兜底；普通员工界面手填 UUID/实体 ID 已清理 |
| S30-R07 | 证据和文档 | ✅ 完成 | 本文件 + KNOWN_GAPS + RELEASE_CHECKLIST + Stage-03 v1.1 更新；未验证项不标完成 |

### S30-R01 修复明细
- migration `20260807000026_scoped_permission_hardening.sql` 重建 `has_permission(p_tenant_id, p_store_id, p_permission)`：
  - tenant 上下文（`p_store_id IS NULL`）：仅 `era.store_id IS NULL AND r.scope IN ('system','tenant')`；
  - store 上下文（`p_store_id` 给定）：`era.store_id = p_store_id AND r.scope='store'` 或 `era.store_id IS NULL AND r.scope IN ('system','tenant')`；
  - `is_system_admin()` 短路放行。
- 系统角色 scope 归一：`system_admin→'system'`；`store_manager/staff/cashier/doctor→'store'`。
- seed.sql 角色插入显式携带 `scope` 列，`on conflict (code) do update` 增加 `scope = excluded.scope`；新增 `doctor` 角色（scope='store'）。
- 测试 `supabase/tests/rls_scoped_permission.sql`：S1~S11 覆盖本店有权/非本店无权/store→tenant 提升禁止/tenant 角色租户级/门店级兼容/system_admin 放行/三类触发器负向/RLS 写本店与非本店客户。

### S30-R02 修复明细
- `api/lib/permission.ts` `resolveScopedAccess()`：
  - 2b 查完 assignment 后加载候选角色并建立 `roleScope` Map；
  - `tenantWideAssigns` = `store_id IS NULL && scope ∈ (system, tenant)`；`storeAssigns` = `store_id 非空 && scope='store'`；
  - 匹配：传 storeId 时 `(a.store_id === storeId && isStoreRole) || (a.store_id === null && isTenantWideRole)`；dataScope 时 `isStoreRole || isTenantWideRole`；command 无 storeId 时 `store_id === null && isTenantWideRole`；
  - `validTenantWideRoleIds` 二次过滤，`roles` 复用已加载角色行（少一次查询）。
- 数据库触发器 `validate_era_scope()` + `trg_era_scope`（before insert/update on `employee_role_assignments`）：
  - `STORE_ROLE_REQUIRES_STORE`：scope='store' 且 store_id NULL；
  - `TENANT_ROLE_FORBIDS_STORE`：scope∈(system,tenant) 且 store_id 非空；
  - `ROLE_TENANT_MISMATCH`：租户自定义角色跨租户分配。
- 存量非法数据幂等修复（4a 删除重复 tenant-wide / 4b 归并 store_id 为 NULL）。

### S30-R03 修复明细
- migration 26 第 6 节 DO 块对约 35 个高危 Command RPC 执行 `revoke all ... from public/anon/authenticated` + `grant execute ... to service_role`（billing/inventory/clinical/inpatient/diagnostics/crm/operations 全清单）。
- 前端 RPC 直连改走 Hono：
  - `diagnostics.ts`：`scanReminders`/`issueCertificate`/`publishLabResults`/`reviewLabResults` → Hono `POST diagnostics/reminders/scan`、`certificates/issue`、`lab-orders/publish`、`lab-orders/review`；
  - `customer.ts`：`create/update/archive` → Hono `POST /customers`、`PATCH /customers/:id`、`POST /customers/:id/archive`；
  - `pet.ts`：`create/update/archive` → Hono `POST /pets`、`PATCH /pets/:id`、`POST /pets/:id/archive`；
  - `clinical.ts`：`signEncounter` → Hono `POST clinical/encounters/:id/sign`。
- 安全边界声明：不得依赖 SECURITY DEFINER + RLS 作为权限边界；RPC 仅 service_role 可执行。
- 测试 `supabase/tests/rpc_security.sql`：R1~R7 普通 authenticated 直调 `process_payment`/`process_refund`/`reserve_inventory`/`confirm_inventory_reservation`/`sign_encounter`/`admit_patient`/`publish_lab_results` 必须 permission denied；R8 service_role 调用放行（revoke 未误伤服务端）。

### S30-R04 修复明细
- `apps/maoxianqiu/src/views/clinical/encounter/detail.vue`：
  - 移除 BusinessEmployeePicker 签署选择器；
  - `openSign()` 用 `supabase.auth.getUser()` 取当前登录用户，弹窗只读展示账号；
  - `onSign()` 调 `apiClinical.signEncounter(encounter.id)`（后端签名强制 `doctorId = user.id`，非当前用户 403）。
- `EmployeePicker/index.vue` 新增 `valueKey?: 'id' | 'user_id'`（默认 'id'）：
  - `'id'` → employees.id；`'user_id'` → employees.user_id（auth.users.id）。
- 字段语义（migration 26 COMMENT ON COLUMN 固化）：
  - `encounters.doctor_id/signed_by/nurse_id`、`appointments.doctor_id`、`nurse_tasks.assigned_to`、`shift_handovers.outgoing_user/incoming_user/acknowledged_by`、`prescriptions.doctor_id` = **auth.users.id**；
  - `admissions.doctor_id` = **employees.id**。
- 使用点：nursing 负责人、handover 交班/接班人均 `value-key="user_id"`。

### S30-R05 修复明细
- `e2e/tests/closed-loop-a.spec.ts`：
  - 步骤 2 宠物：`page.goto('/#/crm/customer/${customerId}')` → 点「新增宠物」→ 填名字/品种 → 保存 → 断言「宠物建档成功」→ REST 按 name 查 petId（不再 `api.post('/pets')`）；
  - 步骤 10 签署：goto 病历详情 → 点「签署」→ 弹窗断言「签署人」可见 → 点「确认」→ 断言「病历已签署」→ DB 断言 status='signed' + signed_at/signed_by 非空 → 已签署直接修改返回 409。

### S30-R06 修复明细
- `views/inventory/receipt/index.vue`：预留表单 `catalogItemId` 手填 FaInput → `BusinessCatalogItemPicker`（placeholder「点击余额表『预留』自动填充」）。
- `views/inpatient/nursing/index.vue`：负责人 Picker `value-key="user_id"`；label「负责人 ID(可选)」→「负责人(可选)」。
- `views/inpatient/handover/index.vue`：交班人/接班人 Picker `value-key="user_id"`。
- `views/operations/print/index.vue`：`PICKABLE_ENTITY_TYPES`（invoice/medical_record/prescription/lab_report/vaccine_certificate）之外的类型禁用输入 + 提交前 warning「该业务类型暂不支持打印」。
- 全量排查：`views` 无手填 UUID placeholder、无误导性「XX ID」输入标签、无 `supabase.rpc()` 直连残留。

## S3.0 复审（S30-F01~F04）

> 依据：S3.0 复审结论（第二次）。剩余工作收敛为 4 项，全部落地；未验证项一律标注"待 staging 执行"，不标"✅完成"。
>
> **S3.0 整体状态：code_complete（runtime = integration_pending）**。S30-FINAL 修复 rpc_security.sql 源码错误（P5 legacy fixture 缺 auth.users）并完成静态校验后，代码阶段视为完成；仅当 staging 的 migration / RLS / E2E 全部真实通过后，才可将状态标记为 **verified**。

| F | 内容 | 状态 | 说明 |
| --- | --- | --- | --- |
| S30-F01 | 平台管理员独立模型 | ✅ 代码完成 / ⏳ 待 staging 执行 | 新增 `platform_user_roles`（platform_admin/platform_support/platform_auditor）；`is_system_admin()` 只读平台授权来源；ERA 禁止 scope='system' 角色；tenant invite/change-role 拒绝 system role；角色管理 UI 不展示 system role；legacy store_members/ERA 不自动升级 |
| S30-F02 | RPC 默认拒绝 | ✅ 代码完成 / ⏳ 待 staging 执行 | 补齐 11 个遗漏 Hono Command RPC revoke + 审计 generate_customer_no/generate_invoice_no/update_import_job；全部 Command RPC revoke public/anon/authenticated + grant service_role（migration 27 revoke 55 个函数名）；新增 service-role-only manifest + CI 静态规则（`check:rpc-manifest` 已 PASS） |
| S30-F03 | rpc_security.sql 独立可执行 | ✅ 代码完成 / ⏳ 待 staging 执行 | 自建 assert_true/assert_rpc_denied/assert_rpc_authorized/assert_raises；21 个 authenticated 负向（含 11 新增 + 3 审计）+ 16 个 service_role 正向 + 平台升级负向 P1~P5 |
| S30-F04 | 文档和证据 | ✅ 完成 | 本文件 + KNOWN_GAPS + RELEASE_CHECKLIST 同步更新；"浏览器直连高危 RPC 已关闭"仅在全量 revoke 落地后表述 |

### S30-F01 平台管理员独立模型明细
- migration `20260808000027_platform_admin_model.sql`：
  - 新增 `platform_user_roles` 表（user_id + role ∈ platform_admin/platform_support/platform_auditor，unique(user_id, role)），启用 RLS 且无 policy → 普通 authenticated 默认拒绝；`trg_platform_role_audit` 审计触发器写 audit_logs。
  - 重定义 `is_system_admin()`：security definer，仅查询 `platform_user_roles(role='platform_admin')`；新增 `is_platform_role(text)` 供 RLS/RPC 使用同一平台授权来源；revoke public + grant authenticated。
  - `validate_era_scope()` 触发器新增 `SYSTEM_ROLE_FORBIDDEN_ERA`：scope='system' 角色（如 system_admin）禁止通过 `employee_role_assignments` 分配。
  - 存量清理：删除 `employee_role_assignments` 中全部 scope='system' 分配；`store_members` 不处理、不自动升级（平台管理员只能由 service_role 通过 platform_user_roles 显式授予）。
- Hono：`api/lib/permission.ts` `resolveScopedAccess()` 平台管理员判定改读 `platform_user_roles`（不再经 employees + ERA + roles 推导）；`api/routes/employees.ts` invite/change-role、`api/routes/user.ts` create 新增 system role 拒绝（403）；`apps/maoxianqiu/src/api/modules/role.ts` list() 双保险过滤 scope='system'（租户角色管理 UI 不展示）。
- 测试：`supabase/tests/rpc_security.sql` Part 3（P1 tenant admin 不能给自己/他人授 platform_admin；P2 system role 禁止 ERA；P3 无平台授权 is_system_admin()=false；P4 service_role 授权后 =true；P5 legacy store_members.system_admin 不自动升级）。
- 夹具：9 个 RLS 测试文件的 system_admin ERA 改为 `platform_user_roles(platform_admin)` 插入，与 is_system_admin() 新来源对齐。

### S30-F02 RPC 默认拒绝明细
- **RPC 数量口径（historical S3.0 baseline，S30 时点数据；当前合并源码口径见上文「S31-MERGE-FINAL」72 处 / 67 个 / 72 个 / missing 0，不再写 58）**：
  - api/routes RPC 调用：**59 处**；
  - Hono route unique RPC：**52 个**；
  - service-role-only manifest：**55 个**；
  - 内部辅助 RPC：**3 个**（generate_customer_no / generate_invoice_no / update_import_job，仅服务端/内部辅助调用，不在 routes 中）；
  - migration 27 revoke：**55 个函数名**（即 service-role-only manifest 全量）。
- migration 27 第 5 节 DO 块对 **55 个函数名**（service-role-only manifest 全量）执行 `revoke all from public/anon/authenticated` + `grant execute to service_role`：
  - 11 个新增遗漏：archive_file / archive_store / complete_upload / create_import_job / create_upload_intent / invite_employee / merge_customers / migrate_catalog_to_store / replace_role_permissions / restore_store / set_employee_status；
  - 内部辅助 3 个（审计结论）：generate_customer_no / generate_invoice_no / update_import_job；
  - 其余 Hono route RPC：41 个（billing/clinical/crm/catalog/iam/diagnostics/files/inpatient/inventory/operations/pets）——与 52 个 Hono route unique RPC（11 新增 + 41 原有）对应。
- CI 静态规则（替代手工维护"高危 RPC 名单"）：
  - `api/lib/service-rpc-manifest.ts`：`SERVICE_ROLE_ONLY_RPC` 55 个函数名（service-role-only manifest）。
  - `api/scripts/check-rpc-manifest.ts` 双规则：① `api/routes/*.ts` 中 `service.rpc()` 调用（59 处，unique 52 个）⊆ manifest（55 个）；② manifest 全部 55 个函数名 ∈ migration 27 revoke 清单。根 `package.json` 新增 `check:rpc-manifest`（已执行 PASS：routes 59 处调用全校验通过，manifest 55 个函数全在 migration 27）。
- 原则：所有 Hono Command RPC revoke public/anon/authenticated + grant service_role；不得依赖 SECURITY DEFINER + RLS 作为权限边界。

### S30-F03 rpc_security.sql 独立可执行明细
- 文件自建 `tests.assert_*` 断言函数并 `grant usage on schema tests`，不依赖其他测试文件，可独立执行（单事务 begin/rollback，无残留）。
- Part 1：authenticated 直连 **21 个 RPC** 必须 permission denied（11 新增 + 3 审计 + 7 原有抽查），全部使用精确函数签名避免 undefined_function 误判（如 archive_store(uuid,uuid,uuid)、invite_employee(uuid,uuid,text,text)、migrate_catalog_to_store 用 `select * from`）。
- Part 2：service_role 直连 **16 个 RPC** 正常进入业务函数（仅 permission denied 判失败，业务错误放行）——证明 revoke 未误伤 Hono 服务端。
- Part 3：平台升级负向 P1~P5（见 S30-F01 明细）。
- 每个 DO 块开头 `execute 'reset role'` 规避 SET LOCAL 跨块持久化。
- S30-FINAL 修复：P5 legacy fixture 使用用户 `...00bb`，但 `store_members.user_id references auth.users(id)`，缺 auth.users 会致 FK 失败；现先 `insert into auth.users(...00bb)` 再插入 legacy store_members，保证 `psql "$DATABASE_URL" -f supabase/tests/rpc_security.sql` 可从空库独立运行。

## S31-MERGE-FINAL 合并收尾

> 依据：`document/stage-03/sprint/毛线球-S31-MERGE-FINAL-单人收尾执行文档.md`。
> 本轮仅收尾、不扩功能：FINAL-01~04 全部落地；未在 staging 真实执行，一律标注 runtime integration_pending。

**当前状态（完成后）：**

```text
S3.1 Sprint 1            = code_complete / runtime integration_pending
S3.1-PARALLEL-01         = code_complete / runtime integration_pending
Stage-03 当前合并批次     = code_complete / runtime integration_pending
```

| F | 内容 | 状态 | 说明 |
| --- | --- | --- | --- |
| FINAL-01 | migration 32/34 函数签名 | ✅ 完成 | 修 3 个 PostgreSQL 非法签名（DEFAULT 后接无 DEFAULT 的 input 参数）：`save_institution_license.p_license_no` / `save_epidemic_event.p_suspected_disease` / `save_waste_record.p_waste_type` 全部补 `default null`；函数内部 LICENSE_NO_REQUIRED / SUSPECTED_DISEASE_REQUIRED / WASTE_TYPE_REQUIRED 业务校验保留；migration 32 与 34 最终函数签名一致 |
| FINAL-02 | annual report vet count 时间/门店边界 | ✅ 完成 | `generate_regulatory_report` 执业兽医数补时间有效性：`vr.valid_from <= 今天`、`vr.valid_until >= 今天`、`esa.starts_at <= now`、`esa.ends_at > now`；保留 `vr.status='active'` 与 store-scoped 口径；migration 32 与 34 统计口径一致 |
| FINAL-03 | can_access_store store↔tenant 自校验 | ✅ 完成 | migration 33 最外层补 `exists(store.id=p_store_id AND store.tenant_id=p_tenant_id)`；store 不存在或跨租户一律 false；tenant_owner 仍可访问本租户全部合法门店（无需逐店分配）；store_manager 仍仅限授权门店；`permission_integration_s3_1.sql` 新增 3 条回归断言（owner+跨租户 store / 不存在 store / manager+跨租户 store 均 FAIL） |
| FINAL-04 | current docs + 构建证据 | ✅ 完成 | 重跑 check:rpc-manifest / lint / typecheck / build 并保留原始输出；RPC 数量按当前最终源码重新统计（见下） |

### FINAL-04 RPC 数量（当前最终源码实际输出）

- api/routes `service.rpc()` 调用：**72 处**（`check:rpc-manifest` 实际输出）
- Hono route unique RPC：**67 个**（脚本实测去重）
- service-role-only manifest：**72 个**（`SERVICE_ROLE_ONLY_RPC`）
- 未在 routes 直接调用的 manifest 函数：**5 个**（archive_encounter / archive_admission / generate_customer_no / generate_invoice_no / update_import_job，由 migration revoke 兜底）
- missing RPC 数：**0**（`check:rpc-manifest` 结果 PASS）

### FINAL-04 构建校验（原始输出摘要）

```text
pnpm check:rpc-manifest
  [check:rpc-manifest] OK: api/routes 中 72 处 service.rpc() 调用全部属于 manifest(72 个函数)
  [check:rpc-manifest] OK: manifest 全部 72 个函数均已纳入 migrations revoke(public/anon/authenticated) + grant service_role
  [check:rpc-manifest] 结果:PASS

pnpm lint
  lint:tsc     → pnpm --filter './apps/*' -r run lint（vue-tsc -b）全部 Done（含 apps/maoxianqiu）
  lint:eslint  → 0 errors / 7 warnings（api/routes/operations.ts 既有 JSDoc @param 提示，非本次改动；
                 首次运行 eslint 进程在 Windows 以 0xC0000005 崩溃为瞬时环境问题，重跑 exit 0）
  lint:stylelint → 通过（exit 0）

typecheck（monorepo 无 root typecheck，按真实 script 执行）
  api       : pnpm exec tsc --noEmit -p api/tsconfig.json    → PASS
  e2e       : pnpm exec tsc --noEmit -p e2e/tsconfig.json   → PASS
  frontend  : vue-tsc -b（lint:tsc 内）                       → PASS

build
  pnpm --filter @fantastic-admin/maoxianqiu build（vue-tsc -b && vite build）→ ✓ built in 31.07s
  （仅 chunk > 500 kB 提示，非阻断）
```

### FINAL-04 migration 历史说明

- migration 31/32（以及 33/34）尚未应用于任何共享开发数据库、staging 或 production；本轮直接修正尚未发布的 migration 32/33/34 属允许范围，不做 fix-forward。
- SQL 测试静态确认（runtime 真实执行依赖 staging）：`permission_integration_s3_1.sql` / `regulatory_s3_1.sql` / `compliance_s3_1.sql` / `rpc_security.sql` 均为合法 UUID、正确 auth.user / employee ID 语义、函数签名与最终实现一致、无旧 RPC 参数、无旧状态机断言。
- runtime（migration 01→latest / RLS / SQL tests / E2E）真实执行 = **integration_pending**。

## S3.1 并发集成收尾（Integration Owner D）

> 依据：`document/stage-03/sprint-1-1/毛线球-S31-集成任务D-Integration-Owner.md`。
> 员工 A（租户初始化）/ B（日结与对账）/ C（医疗闭环）三个开发分支已合并入主线；本轮为 D 的集成收尾：合并确认、回归、文档、最终交付。未在 staging 真实执行，一律标注 runtime integration_pending。

**当前状态（完成后）：**

```text
S3.1 Sprint 1（A 租户初始化 + B 日结对账 + C 医疗闭环） = code_complete / runtime integration_pending
```

### D-1 合并确认（migration 35~49）

- 主线 HEAD：`e7c12a88`（需求文档）。
- 相关 commit：
  - A 租户初始化（migration 35~38 + seed + Hono + 前端 + 测试）：`41b8c771` / `b25a190a` / `7ca99051` / `e7181ee6`
  - B 日结与对账（migration 39~43 + API + 前端 + seed + 测试）：`469a72ef`
  - C 医疗闭环（migration 44~49 + API + 前端 + seed + RBAC revoke）：`3f7387e8`
- migration 35~49 全部存在、编号唯一、无旧 migration 被修改；与并发任务 A/B/C 文档交付清单一致。

### D-2 RPC manifest 与前端直连检查

- `pnpm check:rpc-manifest` **PASS**（本轮 Build Gate 最终执行，原始输出）：
  - api/routes `service.rpc()` 调用：**96 处**，全部 ∈ service-role-only manifest（**96 个函数**）；
  - manifest 全部 96 个函数均已纳入 migrations revoke（public/anon/authenticated）+ grant service_role；
  - missing RPC 数：**0**。
- 前端 direct `supabase.rpc()` = **0**（全仓扫描确认；S3.1 新增 Command 一律走 Hono，服务端 `service.rpc()` + 权限码）。

### D-3 Permission reconciliation

- 权限码 seed 与 migration 一致：tenant.initialize / tenant.initialization.read / daily_closing.* / reconciliation.* / nurse_task.manage / lab_sample.* / lab_critical.* / progress.* / settlement.* 均已在 `supabase/seed.sql` 注册。
- 角色授权矩阵：system_admin / tenant_owner / store_manager 全量；cashier 只读；doctor 部分（标本+危急值只读+病程只读）；nurse 标本+危急值只读+病程只读；迁移 37/49 已 revoke+grant service_role。
- Hono 路由权限码与 seed/migration 一致（closing / tenants / clinical / diagnostics / inpatient）。
- ✅ S3.1 审计收口：seed.sql 权限目录表与角色数组已全量同步前端 `views/system/permissions.ts`（含 boarding/purchase/imaging/followup/analytics/documents/audit/approval/settings/platform.tenant 等新域权限码；system_admin 全量、store_manager/doctor/nurse/tenant_owner 按域补齐）。原"tenant_owner 缺 S3.1-A/S31-C 医疗权限""seed 无 nurse 角色"缺口已关闭（nurse 角色本就在 seed 中，原描述过时）。

### D-4 Router / Menu / Migration 静态检查

- Router：closing（/closing、/reconciliation）、system（/system/tenant-init）、clinical（/clinical/nurse-tasks、/clinical/medical-orders）、diagnostics（/diagnostics/lab-samples、/diagnostics/critical-values）、inpatient（/inpatient/progress-notes、/inpatient/settlement）全部注册，无重复 path；menu 与路由一致。
- Migration 35~49 静态质量：幂等（ON CONFLICT / 幂等键 / advisory lock）、约束（unique / CHECK 状态机 / FK / numeric(12,2)）、RLS、审计（audit_logs）、SECURITY DEFINER + search_path、service-role-only revoke/grant 齐全。

### D-5 SQL 测试静态检查

- `supabase/tests/tenant_initialization_s3_1.sql` / `daily_closing_s3_1.sql` / `reconciliation_s3_1.sql`：独立可执行（自建 tests.assert_*、单事务 begin/rollback、固定合法 UUID）、函数签名与最终实现一致、权限矩阵断言齐全。
- ✅ S3.1 审计收口：新增 `supabase/tests/medical_loop_s3_1.sql`（单事务 begin/rollback，ML1~ML12 断言矩阵覆盖：权限矩阵 / 入院 / 医嘱→护士任务幂等 / 标本流转 / 危急值 / 病程签署不可变 / 出院结算 / 跨租户拒绝 / discharge_patient 笼位释放）；P0-01 Forward Fix（migration 115）由 ML11 验证。
- 剩余缺口：E2E 无 Loop D（tenant init）/ Loop E（billing→closing→reconciliation）/ Loop F（admission→settlement→discharge）。

### D-6 Build Gate（实际运行，保留原始输出）

- `pnpm check:rpc-manifest` → **PASS**（96 处 / 96 个 / missing 0，见 D-2）。
- `pnpm lint` → **exit 0**（lint:tsc vue-tsc -b 全 apps Done；lint:eslint 0 errors / 8 warnings（既有 JSDoc @param 提示，非本次改动）；lint:stylelint 通过）。修复的收尾改动：14 个文件共 30+ TS/ESLint 错误（FaFormItem 缺 name、info.getValue() unknown 需类型断言、模板中 ref 误用 .value、未使用变量/导入、单行多语句 style/max-statements-per-line、api/routes/closing.ts 未使用 scope）。
- typecheck：
  - api：`pnpm exec tsc --noEmit -p api/tsconfig.json` → **PASS**（修复 api/index.ts 缺 tenantRoutes import、tenants.ts requireScopedPermission tenantId 类型收窄）；
  - e2e：`pnpm exec tsc --noEmit -p e2e/tsconfig.json` → **PASS**；
  - frontend：vue-tsc -b（lint:tsc 内）→ **PASS**。
- build：`pnpm --filter @fantastic-admin/maoxianqiu build`（vue-tsc -b && vite build）→ **✓ built in 35.46s**（exit 0）。修复：清理 `apps/maoxianqiu/src` 下 **276 个 .js 编译产物**（rolldown 解析 `@/types/diagnostics` 等模块时优先命中旧 `.js` 产物导致 MISSING_EXPORT；产物已被根 `.gitignore` 的 `**/*.js` 忽略，非仓库内容）。

### D-7 交付与文档

- 本文件 + KNOWN_GAPS + RELEASE_CHECKLIST 同步更新；状态保持 `code_complete / runtime integration_pending`（无 staging，不得写 verified）。
- 本轮不扩展 Customer 360 / Membership / Marketing / C-end / AI 范围。

## S3.1 并发加速开发（Agent-01~07）

> 六个新模块并发开发 + 最终 Integrator 收口。完整审计见 `document/parallel-final/01~07`。

### 新增模块（migration 54~73 + 90/91）

- **平台租户管理（Agent-01）**：`/system/tenants` 列表/详情 + `POST /tenants/:id/suspend|resume`（带原因 + 审计）；停用后 `resolveScopedAccess` 全局拦截 + RLS helper 对非 active 租户返回 false；`/api/me/context` 为唯一权限事实来源。
- **会员产品化（Agent-02）**：等级/客户会员/积分流水/折扣规则 + `create_invoice` 服务端权威会员折扣快照（历史发票不受规则修改影响）。
- **影像工作流（Agent-03）**：申请/排程/执行/报告/审核/发布 + 附件；已发布报告不可直改（版本化）。
- **回访任务（Agent-04）**：`/crm/followups` 全生命周期 + Customer 360 + 全局搜索（P0-29）。
- **采购闭环（Agent-05）**：供应商 + 采购单 draft→submit→approve→receive→post；过账复用 `post_goods_receipt`。
- **寄养 Boarding（Agent-06）**：房位/预约/入住/每日记录/服务费/离店；`cages_single_occupancy_check` 防双占。

### Integrator 修复（Agent-07，migration 90/91）

- **RPC 权限一致性**：Agent-02/03/05 新 RPC 用旧 grant-authenticated 且未登记 manifest → `migration 90` 统一 service_role-only + manifest 补 9 个 → `check:rpc-manifest` PASS（115 处 / 116 个 / missing 0）。
- **寄养离店 → Billing Invoice（原子）**：`migration 91` 在 `boarding_checkout` 同一事务内调 `create_invoice`，发票失败整体回滚（寄养不标 checked_out、笼位不释放、无孤儿发票），返回体带 invoiceId。
- **病历随访日期 → 自动回访**：`clinical.ts` 填 followUpDate 时经 `api/lib/followup.ts` 生成 post_visit（去重、best-effort）。
- **出院 → 自动回访**：`inpatient.ts` discharge 成功后生成 post_discharge（去重、best-effort）。
- **前端权限清单补齐**：`permissions.ts` 补 imaging/followup/boarding/supplier/purchase/points.view 6 组码（服务端已有、前端角色配置缺失）。

### Build Gate（实际运行）

- `npx tsc --noEmit -p api/tsconfig.json` → PASS
- `npx vue-tsc -b`（apps/maoxianqiu）→ PASS
- `npx tsx api/scripts/check-rpc-manifest.ts` → PASS（115 / 116 / missing 0）
- `npx vite build`（apps/maoxianqiu）→ PASS（✓ built in 1m 24s,exit 0）

## 基线 / 验证说明

- API 目录 `api/`：`tsc --noEmit` 通过。
- E2E 目录 `e2e/`：`tsc -p e2e/tsconfig.json --noEmit` 通过；`playwright test --list` 通过。
- 前端 `apps/maoxianqiu`：`vue-tsc -b` 通过（S3.0 AUD-010 起全绿）；`vite build` 通过。
- S3.0 定向复审新增测试文件（待 staging 执行）：`supabase/tests/rls_scoped_permission.sql`（S1~S11）、`supabase/tests/rpc_security.sql`（Part1 RPC 负向 + Part2 service_role 正向 + Part3 平台升级负向）。
- S30-F01 平台授权：`check:rpc-manifest` CI 静态规则已本地执行 PASS；`platform_user_roles` 表随 migration 27 创建。
- 本地环境未执行：migration 空库/旧库升级（0→27 及旧库升级）、RLS/RPC 全量验证、闭环 A/B/C 真实运行、scoped permission 与 direct RPC 测试（依赖 staging）。

## 更新记录

| 日期 | 更新内容 |
| --- | --- |
| 2026-08-08 | S3.1 并发加速开发（Agent-01~07）收口：六新模块（平台租户 54 / 会员 56-57 / 影像 59-61 / 回访 62-63 / 采购 65-69 / 寄养 70-73）合并；Integrator 修复 RPC manifest（迁移 90，9 个 RPC 收紧 service_role + 补登记 → check:rpc-manifest PASS 115/116/missing 0）、寄养→计费原子集成（迁移 91）、病历/出院→自动回访（followup.ts）、前端权限清单补齐 6 组码；build/typecheck 全绿（api tsc PASS、vue-tsc PASS、vite build 1m24s PASS）；审计文档 parallel-final/01~07；状态 code_complete / runtime integration_pending |
| 2026-08-08 | S31-MERGE-FINAL 审计复核（定向审计报告 FINAL-X01/X02）：migration 34 `save_epidemic_event.p_suspected_disease` 补 `default null`（migration 32/34 三个函数签名最终完全一致）；KNOWN_GAPS / RELEASE_CHECKLIST 旧 RPC 数字（59/52/55）标注 **historical S3.0 baseline**，当前口径 72/67/72/missing 0 不变；状态保持 code_complete / runtime integration_pending |
| 2026-08-08 | S31-MERGE-FINAL 合并收尾：FINAL-01 修 migration 32/34 函数签名（3 个 DEFAULT 后无默认参数补 default null）；FINAL-02 generate_regulatory_report 兽医数补门店+时间边界（valid_from/valid_until/starts_at/ends_at）；FINAL-03 can_access_store 补 store↔tenant 自校验（跨租户/不存在一律 false）+ 3 条回归断言；FINAL-04 统一 current docs + 重跑 check:rpc-manifest（PASS 72/72/missing 0）/ lint / typecheck / build（✓ 31.07s）；同步 KNOWN_GAPS / RELEASE_CHECKLIST |
| 2026-08-08 | S30-FINAL 收口：修复 rpc_security.sql P5 legacy fixture（先建 auth.users ...00bb 再插 store_members，可独立执行）；统一 RPC 数量口径（59 处 / 52 个 / 55 个 / 3 个 / 55 个函数名，不再写 58）；S3.0 状态标注 code_complete（runtime = integration_pending），待 staging 验证后方可 verified |
| 2026-08-08 | S3.0 复审（S30-F01~F04）：平台管理员独立模型（platform_user_roles + is_system_admin 独立来源 + ERA 禁 system role + UI 隐藏 + legacy 不升级）、RPC 默认拒绝（补齐 11 个 + 审计 3 个 + manifest CI 规则）、rpc_security.sql 独立可执行、文档证据；同步 KNOWN_GAPS / RELEASE_CHECKLIST |
| 2026-08-07 | S3.0 定向复审：记录 S30-R01~R07 落地明细（migration 26 / permission.ts / RPC 收紧 / id 语义 / E2E UI / Picker 清场 / 文档），同步 KNOWN_GAPS / RELEASE_CHECKLIST / Stage-03 v1.1 |
| 2026-08-07 | S3.0 审计收口：记录 AUD-001~011 落地明细，同步 KNOWN_GAPS / RELEASE_CHECKLIST |
| 2026-08-07 | 初始化：汇总 DEV-000 ~ P0-10 实施状态 |
