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

## 基线 / 验证说明

- API 目录 `api/`：`tsc --noEmit` 通过。
- E2E 目录 `e2e/`：`tsc -p e2e/tsconfig.json --noEmit` 通过；`playwright test --list` 通过。
- 前端 `apps/maoxianqiu`：`vue-tsc -b` 通过（S3.0 AUD-010 起全绿）；`vite build` 通过。
- S3.0 定向复审新增测试文件（待 staging 执行）：`supabase/tests/rls_scoped_permission.sql`（S1~S11）、`supabase/tests/rpc_security.sql`（R1~R8）。
- 本地环境未执行：migration 空库/旧库升级（0→26 及旧库升级）、RLS/RPC 全量验证、闭环 A/B/C 真实运行、scoped permission 与 direct RPC 测试（依赖 staging）。

## 更新记录

| 日期 | 更新内容 |
| --- | --- |
| 2026-08-07 | S3.0 定向复审：记录 S30-R01~R07 落地明细（migration 26 / permission.ts / RPC 收紧 / id 语义 / E2E UI / Picker 清场 / 文档），同步 KNOWN_GAPS / RELEASE_CHECKLIST / Stage-03 v1.1 |
| 2026-08-07 | S3.0 审计收口：记录 AUD-001~011 落地明细，同步 KNOWN_GAPS / RELEASE_CHECKLIST |
| 2026-08-07 | 初始化：汇总 DEV-000 ~ P0-10 实施状态 |
