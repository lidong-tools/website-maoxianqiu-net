# S32-D Handoff — 消息通知真实 Provider

> 阶段：Stage-03 / S3.2
> Agent：S32-D（Messaging）
> 目标：S3.2 Integrator(S32-E) 与 S3.1 Integrator 最终接入

---

## 1. 交付内容

新建（全部为 S32-D 独占文件，未修改任何既有文件）：

| 文件 | 说明 |
|---|---|
| `api/routes/messaging.ts` | Messaging 路由（需 S32-E 挂载） |
| `api/services/messaging/config.ts` | 服务端环境变量配置（Secret 只在服务端） |
| `api/services/messaging/template-engine.ts` | 白名单变量渲染引擎（禁止任意表达式） |
| `api/services/messaging/engine.ts` | 发送编排：建投递 + Provider 发送 + 尝试落库 + 重试 |
| `api/providers/types.ts` | Provider 接口抽象 |
| `api/providers/mock.ts` | Mock Provider（仅开发/演示） |
| `api/providers/email.ts` | 真实 Email Provider（SendGrid 兼容 HTTP API，原生 fetch） |
| `api/providers/registry.ts` | Provider 解析注册表 |
| `supabase/migrations/20260810000112_messaging_provider.sql` | `message_delivery_attempts` 表 + `scene`/snapshot 列 |
| `apps/maoxianqiu/src/types/messaging.ts` | 前端类型 |
| `apps/maoxianqiu/src/api/modules/messaging.ts` | 前端 API 模块 |
| `apps/maoxianqiu/src/views/operations/messaging/index.vue` | 消息中心控制台（模板/发送/投递） |

---

## 2. Provider

- 首批实现 **Email**（SendGrid 兼容 HTTP API，`Authorization: Bearer <API_KEY>`）。
- 接口抽象：`api/providers/types.ts` 的 `MessagingProvider`，Provider 不知道任何业务 Domain。
- Mock Provider 保留仅用于本地开发/演示；**生产环境发送入口会拒绝 Mock**（`engine.assertSendAllowed`）。

## 3. ENV（服务端环境变量）

```text
MESSAGING_PROVIDER   email | mock（兼容旧值 real → 有凭据时按 email 解析）
MESSAGING_API_KEY    SendGrid API Key（必填，绝不下发前端/不进模板字段）
MESSAGING_SENDER     发件人邮箱（必填）
MESSAGING_API_URL    可选，默认 https://api.sendgrid.com/v3/mail/send
```

兼容旧变量：`MESSAGE_PROVIDER` / `MESSAGE_SENDER`（与 `operations.ts` 的 `isRealMessageProviderConfigured` 语义对齐）。

前端 `isMockProvider()` 依赖 `VITE_MESSAGE_PROVIDER`；若要让前端控制台正确显示"已配置"，部署时需同步设置 `VITE_MESSAGE_PROVIDER=real`。

## 4. 路由挂载（S32-E 必做）

在 `api/index.ts` 增加：

```ts
import messagingRoutes from './routes/messaging'
app.route('/messaging', messagingRoutes)
```

建议挂在 `/operations` 之前（路径无冲突，仅风格一致）。前端路由（`apps/maoxianqiu/src/router/modules/operations.ts`）为消息中心添加菜单，路径如 `/operations/messaging` → `views/operations/messaging/index.vue`。注意：既有的 `views/operations/message/*`（templates/deliveries）仍被旧路由使用，可保留或由 Integrator 决定替换。

## 5. Webhook（本轮未实现 → Delivery Confirmation Deferred）

- Email Provider（SendGrid）本轮仅确认 `sent`（HTTP 202），**不伪装 delivered**。
- `delivered` 状态已在状态机/类型中预留；未来接 SendGrid Event Webhook 时实现 `POST /api/messaging/provider/:provider/webhook`（签名校验 + 防重放 + Idempotent）。
- 现有旧链路 `POST /operations/deliveries/:id/send`（调 `send_delivery` RPC）在 migrations 中**无对应 RPC 定义**（运行期手建 stub）。本模块提供完整可用的真实发送链路；是否切换旧链路由 Integrator 决策。

## 6. Trigger Contract

本 Agent 不直接修改 Appointment/Vaccination/Followup/Lab。业务触发方通过调用本模块的发送命令接入：

```text
POST /api/messaging/send
{
  tenantId, storeId?, scene,
  templateId 或 templateCode(+channel),
  recipient, channel?, variables
}
```

- `variables` 仅接受白名单 key（`customer.name / customer.phone / pet.name / pet.species / appointment.time / appointment.type / store.name / doctor.name / hospital.name / order.total`）。
- 模板 body 中的 `{{...}}` 必须全部命中白名单，否则保存/发送被拒绝。
- 场景：`appointment_reminder / vaccine_reminder / revisit_reminder / lab_report`（可扩展）。
- 重试：`POST /api/messaging/deliveries/:id/retry`，最多 3 次，人工触发。

## 7. Settings Future Hook

S3.1 正在修复 Settings；本轮 Provider 配置只从服务端环境变量读取。Integrator 后续接入 System Settings 时：

- 将 `MESSAGING_PROVIDER/API_KEY/SENDER` 迁移为租户级设置项（当前为全局 env）。
- 变更 Provider 配置时写审计（本模块已在 `config.ts` 保留扩展点）。

## 8. Permission

- 路由授权当前复用 **`message.manage`**（已 seed，与既有 RLS/operations.ts 一致），保证接线即可用。
- 建议后续拆分（需 S32-E 更新权限 seed/manifest，并同步调整本路由的 `requireScopedPermission` code）：
  - `messaging.view`
  - `messaging.send`
  - `messaging.template.manage`
  - `messaging.retry`
- 模板/投递的 RLS 仍以 `message.manage` 为准；`message_delivery_attempts` 只读策略通过投递归属校验。

## 9. Audit

- `messaging.template.create` / `messaging.template.update`（模板变更）
- `messaging.send`（手动发送）
- `messaging.retry`（重试）
- Provider 配置变更：本轮 env 读取，暂无运行时变更事件；接入 Settings 后补充。

## 10. 需要 Integrator 关注

1. `api/index.ts` 挂载 `/messaging` 路由。
2. 前端菜单路由指向 `messaging/index.vue`。
3. 生产部署设置 `MESSAGING_PROVIDER=email` + `MESSAGING_API_KEY` + `MESSAGING_SENDER`（及 `VITE_MESSAGE_PROVIDER=real`）。
4. 权限 seed 增加 `messaging.*`（若采用细粒度拆分）。
5. `message_delivery_attempts` 表 RLS 已就绪；`message_deliveries` 新增 `scene/subject_snapshot/variables_snapshot` 列与 `delivered` 状态。
6. 是否将旧 `/operations/deliveries/:id/send` 链路切换到本模块的真实 Provider（建议切换，旧 `send_delivery` RPC 未在仓库定义）。
