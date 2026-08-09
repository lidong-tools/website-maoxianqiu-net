# Agent-08 — Customer Engagement / Portal / Messaging 深度执行指导

## 0. 合并范围

你负责：

```text
C 端身份
宠物访问授权
客户 Consent
通知订阅
C 端 API
Messaging Webhook
SMS / WeChat / Email 多渠道 Adapter
```

这里合并是因为：

```text
客户身份 → 客户通知
```

不能分成两个互相不认识的系统。

---

# 1. Source13 调研

必须阅读：

```text
customers/pets:
api/routes/customers.ts
api/routes/pets.ts
20260806000015_crm_customers_pets.sql

appointments/medical:
api/routes/clinical.ts

documents/reports:
api/routes/documents.ts
api/services/documents/**
api/routes/diagnostics.ts

membership:
api/routes/operations.ts

reminders:
20260806000018_operations.sql
api/routes/operations.ts
api/routes/diagnostics.ts

messaging:
api/routes/messaging.ts
api/services/messaging/**
api/providers/**
20260810000112
115
118
121
```

Source13 Messaging 已有：

```text
template
delivery
attempt
provider
idempotency
initial CAS
retry CAS
sending
stale handling
```

这些不允许回退。

---

# 2. C-End Authorization 与员工 IAM 完全分开

Source13 员工权限基于：

```text
auth.users
employees
tenant_memberships
employee_role_assignments
employee_store_assignments
roles/permissions
```

C 端不能给客户创建员工角色。

建立：

```text
customer_identities
customer_pet_access
customer_consents
notification_subscriptions
```

C-End Authorization：

```text
verified identity
→ customer mapping
→ pet access
→ resource visibility
```

---

# 3. customer_identities

建议：

```text
id
tenant_id
customer_id
provider
subject
phone/email
verified_at
status active/revoked
metadata
created_at
updated_at
```

Provider：

```text
phone
email
wechat
```

Unique 应防：

```text
同 tenant 同 provider subject 绑定多个 customer
```

---

# 4. 验证

如果做短信/邮件验证码：

```text
verification_challenges
```

必须：

```text
hash code
expires_at
attempt count
used_at
rate limit
```

数据库不能存明文 OTP 长期保留。

不要自己造薄弱随机数。

---

# 5. Pet Access

```text
customer_pet_access
```

字段：

```text
tenant_id
pet_id
customer_id
access_type owner/family/caregiver
permissions view/appointment/report...
status
granted_by
expires_at
revoked_at
```

Source13 `pets.customer_id` 是主人关系。

默认 Owner Access 可从现有数据建立，但不能认为：

```text
customer_id 相同 = 所有家庭账号天然授权
```

---

# 6. Consent

```text
customer_consents
```

至少：

```text
privacy
marketing
electronic_report
notification
```

记录：

```text
version
accepted_at
revoked_at
source
```

Marketing 消息必须尊重：

```text
marketing consent
```

医疗必要通知与营销通知应区分。

---

# 7. Notification Subscription

```text
notification_subscriptions
```

维度：

```text
customer
channel
scene
enabled
destination/identity
```

Scene：

```text
appointment
vaccine
deworming
report_published
followup
marketing
billing
```

不要只有“总开关”。

---

# 8. Portal API

建议单独：

```text
/api/portal
```

不要把 C 端直接暴露员工 `/api/customers/:id`。

至少：

```text
GET /portal/me
GET /portal/pets
GET /portal/pets/:id
GET /portal/appointments
POST /portal/appointments
GET /portal/encounters
GET /portal/reports
GET /portal/membership
GET /portal/benefits
GET/PUT /portal/notification-subscriptions
```

每个 API 根据当前 Customer Identity 推 Scope。

禁止接受客户端任意：

```text
customerId
```

然后直接查。

---

# 9. Customer-visible Report

Source13 Documents/Diagnostics 有内部状态。

Portal 只能看到：

```text
published
customer_visible
```

建议 Agent-06 提供 Archive Contract。

如果业务源没有 `customer_visible`，Stage04 需要 Forward Migration 明确增加。

默认：

```text
false
```

而不是默认公开。

---

# 10. Appointment

C 端预约创建要复用 Clinical Appointment Domain。

不能 Portal 直接：

```text
insert appointments
```

需要内部 Domain Service/RPC：

```text
source=customer_portal
```

并限制客户可填字段。

不能让客户指定：

```text
tenant
任意 doctor id
内部 status
```

---

# 11. Messaging Provider 扩展

现有 `api/providers/types.ts` 已预留：

```text
sms
email
wechat
work_wechat
```

Stage04 建立更稳定接口：

```text
send()
verifyWebhook()
parseWebhook()
queryStatus?()
```

不要为了统一接口破坏现有 Email Provider。

---

# 12. Webhook Event

建议：

```text
message_provider_events
```

字段：

```text
provider
provider_event_id
delivery_id
provider_message_id
event_type
payload_snapshot
received_at
processed_at
status
```

Unique：

```text
provider + provider_event_id
```

Webhook：

```text
先验签
再解析
再 idempotent insert
再状态推进
```

没有签名验证：

```text
P0 FAIL
```

---

# 13. Delivery 状态

Source13：

```text
queued
sending
sent
delivered
failed
retry
```

可扩：

```text
bounced
unknown
```

状态只能前进到合理状态。

Webhook 晚到：

```text
不能把 delivered 降回 sent
```

也不能让旧 provider event 覆盖新 retry。

---

# 14. SMS/WeChat

如果没有真实 Provider 凭据：

```text
Adapter status = disabled/not_configured
```

API 应返回：

```text
PROVIDER_NOT_CONFIGURED
```

不能：

```text
mock success
status=sent
```

这会制造虚假通知记录。

---

# 15. Permission

管理员 Messaging 权限细化：

```text
messaging.view
messaging.send
messaging.template.manage
messaging.retry
messaging.provider.manage
```

C-End 用户不使用这些 Permission Code。

---

# 16. Marketing Contract

Agent-05 Campaign 只能调用：

```text
Messaging Dispatch Contract
```

输入：

```text
tenant
scene
customer
channel preference
template
variables
idempotency
```

Messaging 自己负责：

```text
consent/subscription
recipient resolution
provider
delivery
```

Marketing 不应知道：

```text
SendGrid API
Wechat token
```

---

# 17. 前端

本 Agent 不需要立刻造完整消费者小程序 UI（若项目当前只做 Admin + API）。

至少做 Portal Admin：

```text
Identity binding audit
Pet access
Consent
Subscriptions
Provider configuration status
Webhook events
```

真正小程序前端可以后续单独客户端项目。

如果本阶段实现 Web Portal，要保持与员工 Admin 分离路由/布局。

---

# 18. 测试

Identity：

```text
same provider duplicate binding
unverified identity
revoked identity
cross tenant
```

Pet Access：

```text
owner
family granted
family revoked
other customer denied
```

Report：

```text
draft denied
published but customer_visible=false denied
visible allowed
```

Webhook：

```text
invalid signature
duplicate event
out-of-order event
unknown provider message id
```

Messaging：

```text
provider not configured
network timeout
retry
same idempotency
consent off
subscription off
```

---

# 19. 失败条件

```text
Portal 复用 employee roles
API 接收任意 customerId 作为权威身份
默认所有报告客户可见
Webhook 不验签
Provider 未配置却 mock sent
Marketing 直接 SDK 发消息
破坏 Source13 CAS
```

---

# 20. Handoff

```text
IDENTITY_MODEL
PET_ACCESS_MODEL
CONSENT_VERSIONING
PORTAL_AUTH_MECHANISM
CUSTOMER_VISIBLE_POLICY
APPOINTMENT_DOMAIN_HOOK
MESSAGING_PROVIDER_MATRIX
WEBHOOK_SIGNATURE_STRATEGY
MARKETING_DISPATCH_CONTRACT
```

---

# 21. Commit

```text
feat(stage04-08): implement customer portal and multichannel messaging
```
