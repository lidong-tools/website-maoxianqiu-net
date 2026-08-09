# AGENT-08-HANDOFF — Customer Engagement Portal & Messaging

## STATUS

```text
code_complete
（未执行 tsc / vercel build / supabase db push：按任务约定跳过耗时编译与 DB 迁移执行；
 静态自查 git diff --check 已执行，见 TEST_RESULTS）
```

## SOURCE_RESEARCH

```text
1. api/index.ts 为共享冻结入口，Agent-08 不得直接修改 → 路由挂载见 INTEGRATION_REQUESTS
2. 员工 IAM(authMiddleware + requireScopedPermission + message.manage)与 C 端身份完全分离；
   C 端身份 = customer_identities(OTP 验证码 + HMAC 会话 token)，不与 auth.users 关联
3. 权限模型：permissions 表 + role_permissions 关联表 + roles.permissions 数组兼容；
   requireScopedPermission 仅支持单 code → messaging.ts 新增 requireAnyScopedPermission(任一命中)
4. document_archives(Agent-06,migration 235)已提供 customer_visible/published 契约，
   Portal 报告直接消费，无需新建报告表
5. appointments 表已存在(source 字段需含 customer_portal)，C 端预约一律走
   create_portal_appointment RPC，禁止客户端直接 insert
6. 服务端 Provider 架构(S32-D)：MessagingProvider 接口 + registry 按环境解析；
   Agent-08 扩展为按渠道(email/sms/wechat)解析 + Webhook 验签/解析能力接口
7. Migration 号段确认：Agent-05 用 220~223、Agent-06 用 235，Agent-08 使用 265~267 无冲突
```

## START_HEAD

```text
a728de0b update
```

## COMMIT_SHA

```text
022be82f（feat(stage04-08): customer engagement portal identity/access + messaging multi-channel webhook）
```

## OWNED_FILES

```text
api/routes/portal.ts                    （新增，C 端认证/业务 + Admin 管理）
api/routes/messaging-webhook.ts         （新增，Provider 回调收件）
api/lib/portal-session.ts               （新增，OTP 工具 + HMAC 会话 token）
api/providers/sms.ts                    （新增，SMS Provider + Webhook 验签/解析）
supabase/migrations/20260810000265_portal_identity.sql          （新增）
supabase/migrations/20260810000266_portal_appointment.sql       （新增）
supabase/migrations/20260810000267_messaging_webhook_permissions.sql（新增）
apps/maoxianqiu/src/types/portal.ts            （新增）
apps/maoxianqiu/src/api/modules/portal.ts      （新增）
apps/maoxianqiu/src/views/portal/index.vue     （新增）
apps/maoxianqiu/src/router/modules/portal.ts   （新增）
document/stage-04/handoff/AGENT-08-HANDOFF.md  （新增，本文件）
```

## MODIFIED_EXISTING_FILES

```text
api/providers/types.ts                   扩展 MessageChannel / MessagingWebhookProvider /
                                         ProviderWebhookEvent / MessagingQueryableProvider
api/providers/email.ts                   增加 SendGrid ed25519 Webhook 验签 + parseWebhook
api/providers/registry.ts                按渠道解析 getProviderForChannel/getProviderChannelStatus
api/services/messaging/config.ts         增加 sms/wechat 子配置 + isProductionEnv()
api/lib/types.ts                         AppEnv.Variables 增加 portalIdentity(C 端会话)
api/routes/messaging.ts                  message.manage → messaging.* 细粒度 + 兼容任一命中
api/lib/service-rpc-manifest.ts          追加 4 个 service-role-only RPC
```

## NEW_FILES

```text
api/routes/portal.ts
api/routes/messaging-webhook.ts
api/lib/portal-session.ts
api/providers/sms.ts
supabase/migrations/20260810000265_portal_identity.sql
supabase/migrations/20260810000266_portal_appointment.sql
supabase/migrations/20260810000267_messaging_webhook_permissions.sql
apps/maoxianqiu/src/types/portal.ts
apps/maoxianqiu/src/api/modules/portal.ts
apps/maoxianqiu/src/views/portal/index.vue
apps/maoxianqiu/src/router/modules/portal.ts
document/stage-04/handoff/AGENT-08-HANDOFF.md
```

## MIGRATIONS

```text
20260810000265_portal_identity.sql
20260810000266_portal_appointment.sql
20260810000267_messaging_webhook_permissions.sql
（按号段顺序执行，无依赖冲突；均幂等 create if not exists / create or replace）
```

## NEW_TABLES

```text
customer_identities            C 端身份(与 auth.users 无关联)
customer_pet_access            宠物访问授权(owner/family/caregiver + view/appointment/report)
customer_consents              客户 Consent(版本化,privacy/marketing/electronic_report/notification)
notification_subscriptions     通知订阅(客户+渠道+场景,拒绝总开关)
verification_challenges        OTP 验证码挑战(只存 sha256 hash + 盐)
portal_appointment_requests    预约请求幂等表(tenant_id + idempotency_key 唯一)
message_provider_events        Provider 回调事件收件箱(provider + provider_event_id 唯一)
```

## NEW_COLUMNS

```text
无（未修改既有表结构；appointments.source 已有既有取值集合，
create_portal_appointment 内以 source='customer_portal' 写入——若该列原 CHECK 约束
不含 customer_portal，需在 267 号段后补充 migration，见 KNOWN_GAPS）
```

## NEW_INDEXES

```text
idx_customer_identities_tenant_subject / customer / status
idx_customer_pet_access_pet_customer / customer
idx_customer_consents_customer_type / tenant_time
idx_notification_subs_customer_channel_scene / tenant_channel
idx_verification_challenges_recipient_time / pending
idx_portal_appointment_requests  (tenant_id + idempotency_key 唯一 + 查询索引)
idx_message_provider_events_provider_event / delivery_time / provider_msg
```

## NEW_RPCS

```text
portal_create_otp_challenge(uuid, text, text, text, text, text, text, timestamptz)
  → 创建 OTP 挑战(60s 速率限制 + 旧挑战失效 + 只存 hash)
portal_verify_otp(uuid, text)
  → 原子消费验证码(次数/过期/一次性) + 自动匹配/绑定 identity
create_portal_appointment(uuid, uuid, uuid, timestamptz, timestamptz, text, text)
  → C 端预约(幂等 + 宠物可见性校验 + source='customer_portal',doctor_id=null)
apply_provider_event(text, text, uuid, text, text, jsonb)
  → Webhook 事件幂等落库 + delivery 状态 CAS 推进(状态只前进)
```

## RPC_ACL

```text
全部 4 个 RPC 均:revoke public / anon / authenticated → grant service_role
（已在各自 migration 的 revoke/grant 块完成，并在 api/lib/service-rpc-manifest.ts 注册）
```

## PERMISSIONS

```text
migration 265: portal.identity.view/manage、portal.pet.access.view/manage、
               portal.consent.view/manage、portal.subscription.view/manage、portal.webhook.view
               seed 到 system_admin / store_manager
migration 267: messaging.view / messaging.send / messaging.template.manage /
               messaging.retry / messaging.provider.manage
               自动授予已持有 message.manage 的角色(role_permissions + roles.permissions 同步)
读取策略:messaging.view 或 message.manage 任一命中即放行(RLS + 路由双保险)
```

## API_ROUTES

```text
C 端(无员工鉴权,身份 = OTP + HMAC 会话 token):
  POST /api/portal/auth/request-otp        发送验证码(60s 限速,生产未配置通道拒绝)
  POST /api/portal/auth/verify-otp         验证码消费 + 签发会话 token
  GET  /api/portal/me                      身份/客户/Consent 摘要/订阅
  GET  /api/portal/pets、/pets/:id         可见宠物(owner + 显式授权)
  GET  /api/portal/appointments、POST /api/portal/appointments(幂等 RPC)
  GET  /api/portal/encounters、/reports(customer_visible+published 归档)
  GET  /api/portal/membership、/benefits
  GET  /api/portal/notification-subscriptions、PUT(批量 upsert)
Admin(员工 IAM + portal.* 权限码):
  GET/POST /api/portal/admin/identities、POST /identities/:id/revoke
  GET/POST /api/portal/admin/pet-access、POST /pet-access/:id/revoke
  GET  /api/portal/admin/consents
  GET  /api/portal/admin/subscriptions
  GET  /api/portal/admin/provider-status(多通道状态,不含 Secret)
  GET  /api/portal/admin/webhook-events
Messaging Webhook(外部回调,验签保护):
  POST /api/messaging/webhook/email|sms     验签→解析→apply_provider_event
  （sms 共享密钥 HMAC;email SendGrid ed25519;未配置/验签失败一律拒绝）
```

## FRONTEND_ROUTES

```text
/portal/admin  客户门户管理(综合 Tab:客户身份 / 宠物访问授权 / Consent / 通知订阅 / Webhook 事件)
权限码:portal.identity.view(主菜单)
```

## MENU_REGISTRATION_REQUEST

```text
请 Agent-09 在 src/router/routes.ts(共享冻结)增加:
  import PortalModule from './modules/portal'
  并在 asyncRoutes 追加分组:
  { meta: { title: '客户门户', shortTitle: '门户', icon: 'i-carbon:chat' },
    children: [...PortalModule] }
```

## ENV_VARS

```text
Agent-08 新增（生产必填）：
  PORTAL_SESSION_SECRET                 Portal 会话 token HMAC 密钥(生产未配置拒绝签发)
  MESSAGING_SMS_API_URL                 SMS Provider POST JSON 端点(必填才启用短信)
  MESSAGING_SMS_API_KEY                 SMS Bearer 密钥(仅服务端)
  MESSAGING_SMS_SIGN                    SMS 短信签名文本
  MESSAGING_WEBHOOK_SECRET              SMS Webhook 共享签名密钥(未配置拒收回调)
  MESSAGING_EMAIL_WEBHOOK_PUBLIC_KEY    SendGrid Event Webhook ed25519 公钥(base64 SPKI)
预留(未接入真实渠道前无效)：
  MESSAGING_WECHAT_APP_ID / MESSAGING_WECHAT_APP_SECRET
请 Agent-09 同步至 document/deployment/ENVIRONMENT-MATRIX.md 必填清单
```

## CROSS_DOMAIN_CONTRACTS

```text
1. document_archives(Agent-06):Portal 报告只读 customer_visible=true AND published=true
   AND status='active' 的归档;entity_id ∈ 客户 encounters/prescriptions/invoices
2. appointments(共享):C 端预约由 create_portal_appointment RPC 写入,
   source='customer_portal',doctor_id=null;status 初始 'pending'
3. customers/pets/encounters/prescriptions/invoices/membership_tiers/customer_memberships/
   point_transactions(共享只读):Portal 按 tenant_id + customer_id 读取
4. audit_logs(共享):C 端/Webhook 无员工 context,手动 insert(user_id/tenant_id 可空,
   metadata.actorType='portal'/'messaging-webhook')
5. message_deliveries/attempts(既有 S32-D 状态机):apply_provider_event 按
   provider_message_id 反查 delivery 并 CAS 推进,不绕过既有引擎
6. api/lib/service-rpc-manifest.ts(共享):已追加 4 个 RPC 名,CI check:rpc-manifest 需通过
```

## TESTS_RUN

```text
未运行耗时检查(按任务约定跳过 tsc / vercel build / supabase push)。
已执行:git diff --check(见 TEST_RESULTS)。
静态自查:portal.ts / messaging-webhook.ts 引用均已在 registry/types 补齐实现;
hashOtpCode 与 portal_verify_otp RPC 的 sha256(salt||code) 已对齐(发现并修复 HMAC 不一致)。
```

## TEST_RESULTS

```text
git diff --check: PASS(无空白错误)
（tsc / vercel build / supabase db push 留待发布流程或 Agent-09 集成 Gate）
```

## KNOWN_GAPS

```text
1. appointments.source 既有 CHECK 约束若未包含 'customer_portal',create_portal_appointment
   首次执行将失败 → 需确认既有 migration 是否已含该值;未含时追加一个补丁 migration
   (ALTER ... DROP CONSTRAINT + ADD CONSTRAINT 含 customer_portal)
2. messaging.ts 的 requireAnyScopedPermission 逐个尝试权限码,存在"已持有旧 message.manage
   的角色在 migration 267 执行前"的过渡窗口(不阻塞,migration 执行后自动收敛)
3. Webhook 事件只做状态推进,不触发"失败补偿/重试入队"(由既有 retryDelivery 人工/定时触发);
   自动补偿队列 deferred
4. Wechat Provider 为占位实现(isConfigured()=false),真实模板消息接入 deferred
5. Portal C 端 H5/小程序工程不在本仓库 Admin 前端范围内,仅提供服务端 API 与类型
```

## DEFERRED

```text
- C 端 H5/小程序 UI(API 与类型已就绪)
- WeChat 模板消息真实 Provider + 回调验签
- Webhook failed 事件的自动补偿/重试入队
- OTP 发送审计去重(同一挑战重复发送的幂等展示)
- Admin 客户选择器(当前表单用 uuid 输入框)
```

## INTEGRATION_REQUESTS

给 Agent-09(Final Integrator):

```text
1. api/index.ts 挂载(两行 import + 两行 route,不修改其它路由):
   import portalRoutes from './routes/portal.js'
   import messagingWebhookRoutes from './routes/messaging-webhook.js'
   app.route('/portal', portalRoutes)
   app.route('/messaging/webhook', messagingWebhookRoutes)
2. src/router/routes.ts 增加 PortalModule(见 MENU_REGISTRATION_REQUEST)
3. 执行 supabase db push(或纳入迁移 Gate)时按 265→266→267 顺序应用
4. ENV_VARS 声明纳入 release-preflight 必填(见 ENV_VARS 节)
5. 确认 appointments.source CHECK 约束已含 'customer_portal'(见 KNOWN_GAPS 1)
6. Webhook 路由为无鉴权外部回调入口,确认 index.ts 的全局中间件不拦截 /messaging/webhook
   (验签由 messaging-webhook.ts 内部完成)
7. CI check:rpc-manifest:新增 4 个 RPC 已注册,revoke 清单已含同名函数
```

给 Agent-01(Runtime/UAT):

```text
1. 冒烟验证:POST /api/portal/auth/request-otp(dev 环境回退 Mock)→ verify-otp → /api/portal/me
2. 验证生产未配置 PORTAL_SESSION_SECRET / SMS 通道时,request-otp 返回 422 而非 500
3. Webhook 冒烟:本地构造 sha256=<hmac(body)> 头调用 /messaging/webhook/sms
   (未配置 MESSAGING_WEBHOOK_SECRET 时返回 401)
```

## ROLLBACK_NOTES

```text
- 本 Agent 交付:3 个 migration + 3 个 API 新文件 + 2 个 lib/provider 新文件 +
  前端 4 个文件 + 对 5 个既有文件的最小扩展(均为新增分支/接口,无删除既有行为)。
- 回滚:git revert 本 commit;3 个 migration 未被应用时直接丢弃即可;
  已应用时需按 267→266→265 逆序执行 drop table(表/索引/RPC 全部为本 Agent 新建)。
- messaging.ts 权限细化若需回退:恢复 requireScopedPermission(message.manage) 即可,
  不影响既有 message.manage 角色(migration 267 的 seed 为幂等)。
- 服务端旧版本(未挂载 /portal、/messaging/webhook)运行期间,C 端/回调入口 404,
  不影响既有员工端功能。
```

## 完成条件对照

```text
- C 端身份(OTP + 会话 token,与员工 IAM 分离):✅ migration 265 + portal-session + portal.ts
- 宠物访问授权(owner + 显式授权 + 权限/有效期):✅ migration 265 + portal.ts
- 客户 Consent / 通知订阅(维度化):✅ migration 265 + portal.ts C 端/Admin
- C 端 API(me/pets/appointments/encounters/reports/membership/benefits):✅ portal.ts
- Messaging 多渠道 Adapter(SMS 真实 + WeChat 占位 + Email Webhook):✅ sms.ts / email.ts / registry
- Webhook 收件(验签 → 解析 → 幂等 → CAS 推进):✅ messaging-webhook.ts + apply_provider_event
- 权限细粒度 messaging.* + 兼容 message.manage:✅ migration 267 + messaging.ts
- RPC ACL(仅 service_role)+ manifest:✅ 265/266/267 revoke/grant + service-rpc-manifest
- Portal Admin 前端(5 个管理面):✅ types/portal + api/modules/portal + views/portal + router
```

提交信息(由本 Agent 执行)：

```text
feat(stage04-08): customer engagement portal identity/access + messaging multi-channel webhook
```
