> 项目：毛线球宠物医院 SaaS
> 阶段：Stage-03 / S3.2 并发功能开发
> 文档：S32-E 遗留 Gap 清单
> 生成：2026-08-08（agent-E）

# S32 遗留 Gap

> 这些 Gap 不影响 S3.2 四个模块的独立可用性，但需要在最终 Mainline Integration 或后续迭代处理。
> 涉及 S3.1 文件归属的项，S32-E 未擅自修改，统一交给 Mainline Integrator。

> **状态更新（2026-08-08）**：S3.1 已合并（`27590d84`）。S32-E 集成在合并后整树 **API typecheck + 前端 typecheck + `vite build` 全部通过**。
> 跨域 Hook（§2）仍未接入——S3.1 合并后**未提供**所需的 Inventory RPC / IAM 消费者 / Clinical 触发接线，因此仍为 gap，且**不应由 S3.2 单独实现 IAM/Inventory 核心**（规格 §6）。

---

## 1. Messaging（S32-D）

### 1.1 Webhook 未实现（Delivery Confirmation Deferred）
- **Gap**：`POST /api/messaging/provider/:provider/webhook`（SendGrid Event Webhook）本轮未实现。Email Provider 仅确认 `sent`（HTTP 202），不产生 `delivered` 状态回执。
- **影响**：`delivered` 状态机与类型已预留，但无真实回执链路。
- **后续**：接入 SendGrid Event Webhook，需签名校验 + 防重放 + 幂等。

### 1.2 权限细粒度拆分 deferred
- **Gap**：规格想拆分 `messaging.view / messaging.send / messaging.template.manage / messaging.retry`，当前路由统一复用既有 `message.manage`。
- **影响**：权限粗粒度，但安全无缺口（复用已 seed 的 `message.manage`）。
- **后续**：若需拆分，需（1）migration seed 4 个 `messaging.*` 码；（2）同步修改 `api/routes/messaging.ts` 的 `requireScopedPermission` code；（3）前端 manifest 补码。S32-E 未代为实现（避免动 S32-D 文件 + 避免死权限码）。

### 1.3 旧发送链路切换
- **Gap**：旧 `POST /operations/deliveries/:id/send`（调 `send_delivery` RPC，仓库无对应 RPC 定义，运行期手建 stub）仍存在。
- **建议**：Mainline 切换至 S32-D 真实 Provider 链路；旧链路是否下线由 Integrator 决策。

### 1.4 部署环境变量
- **Gap**：生产需设置 `MESSAGING_PROVIDER=email` + `MESSAGING_API_KEY` + `MESSAGING_SENDER`，前端需同步 `VITE_MESSAGE_PROVIDER=real` 才能正确显示"已配置"。

---

## 2. Import（S32-A）跨域 Hook（S3.1 已合并，仍未接入）

> S3.1 已合并，但**未提供**消费者/RPC。按规格 §6，S3.2 不单独实现 IAM/Inventory 核心，故以下仍为 gap，需 S3.1 域负责人提供能力后由 Mainline 接入。

### 2.1 Opening Stock → Inventory Command
- S32-A 已写命令队列 `opening_stock_import_requests`（status='pending'），**未直改库存**。
- **阻塞**：仓库**无** `apply_opening_stock` RPC，也无任何 Inventory 侧消费逻辑（S3.1 未提供）。
- **待接**：Inventory 提供 RPC（建议 `apply_opening_stock(tenant_id, store_id, request_id, operator_id)`）→ 消费 pending → 建 `inventory_batches` + 更新 `inventory_balances` → `applied/skipped/failed`。

### 2.2 Employee Invite → IAM 邀请
- S32-A 已写 `employee_invite_imports`（status='pending'），**未创建 auth 用户**。
- **能力已存在**：S3.1 有 `POST /employees/invite` + RPC `invite_employee`（migration `iam_completion.sql`）。
- **缺消费者**：无人消费 `employee_invite_imports` pending 记录 → 按 role_code + store_codes 调 `invite_employee` → `sent/duplicate/failed`。
- **归属**：该消费者属 IAM 域集成逻辑，建议由 S3.1 Employee/IA 侧实现，或由 Mainline Integrator 新增 S32-E 集成胶水（需先确认归属）。

---

## 3. Documents（S32-C）缺失业务 DTO

| Gap | 说明 |
|---|---|
| Logo / 医院自定义页眉 | 当前 `hospital` 仅读 `tenants.name/short_name`，未读 Settings 的 Logo/自定义配置。需 Settings 提供读取入口。 |
| 影像图片附件 | `imaging_report` 未内嵌影像图（attachments 表存有，但需附件 URL 能力，S3.1 Files 提供）。 |
| 处方合规字段 | 麻精药品特殊标记/兽医备案号需 Clinical/Compliance 补充字段。 |
| `discharge_summary` 独立表 | 当前从 `admissions(discharged)` 取数，多版本出院小结需新增 `discharge_summaries` 表（S3.1 Inpatient 维护）。 |
| 旧打印中心收敛 | `print_templates`（旧打印中心）与 `document_templates`（新文档中心）并存，是否收敛待 Mainline 裁决。 |

---

## 4. 权限 manifest 残留

- 前端 `permissions.ts` 中 `print.manage` / `reports.view` 为旧打印/报表中心权限码，新文档中心与报表页已分流。旧打印中心页面仍挂这些码，若后续收敛旧打印中心可清理。

---

## 5. 历史 Migration 修改（S3.1 已提交，S32-E 未触碰）

- ⚠️ `supabase/migrations/20260806000021_inpatient.sql` 被修改（笼位释放逻辑：改用 `v_admission.cage_id` 直放，不依赖 `v_cage` 快照变量）。**已随 S3.1 提交**。
- S32-E 规格禁止 S3.2 编辑历史 migration，因此未触碰。
- **风险提示**：修改已执行过的 migration 文件会导致已有数据库与文件不一致；Mainline 需确认其迁移回放策略（如是修复历史 bug 的补丁，应评估是否应新增 forward migration 而非改历史文件）。

---

## 6. 验证状态（S3.1 合并后）

- ✅ **API typecheck**（`npx tsc --noEmit`）通过。
- ✅ **前端 typecheck**（`vue-tsc -b`）通过。
- ✅ **`vite build`** 通过（`✓ built in 1m 9s`）。
- ⏳ **Runtime / E2E 冒烟**：仍未执行（S3.2 无独立 E2E；依赖 Mainline 后补）。
- 需要补：
  - 权限冒烟：`imports.view/create/execute/cancel`、`analytics.view.store/tenant/export`、`documents.view/print/template.manage`、`message.manage`
  - 导入闭环（模板下载→上传→映射→校验→执行→错误明细）
  - 文档预览/渲染/打印 + 医疗文档权限门
  - 消息发送/投递/重试（mock + 真实 Email）
  - 1280/1440/1920 与 Dark Mode 复核（新页面）
