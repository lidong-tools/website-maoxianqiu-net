> 项目：毛线球宠物医院 SaaS  
> 阶段：Stage-03 / S3.2 并发功能开发  
> 基线：在 S3.1 Fix Pipeline 仍独立执行的前提下，从当前稳定 Main/Base Commit 创建本批 Feature 分支。  
> 核心原则：**S3.2 Agent 不得修改 S3.1 Fix 正在修复的 IAM、Billing 核心、Clinical 核心、Inventory 核心安全边界。**  
> E2E：继续独立运行。本批 Agent 不修改 `e2e/**`。  
> 文件 Ownership：一个生产文件只能有一个写入 Owner；跨域需求只能写 Handoff，不得直接修改其他 Agent 所属文件。  

# S32-D — 消息通知真实 Provider

## 1. 目标

替换当前：

```text
Mock Provider
```

建立至少一个真实消息 Provider。

第一阶段建议：

```text
Email 或 SMS 二选一
```

如果当前部署环境已经具备某个 Provider 凭据，则优先该 Provider。

不要一轮同时做四个 Provider。

---

# 2. Ownership

```text
api/routes/messaging.ts
api/services/messaging/**
api/providers/**

apps/maoxianqiu/src/views/operations/messaging/**
apps/maoxianqiu/src/api/modules/messaging*
apps/maoxianqiu/src/types/messaging*
apps/maoxianqiu/src/components/messaging/**
```

Migration：

```text
112–115
```

---

# 3. 禁止

```text
settings core
billing
clinical
crm
diagnostics
inpatient
permission helpers
e2e/**
```

跨域自动通知全部写 Handoff。

---

# 4. 产品能力

```text
消息模板
变量
发送
状态
Provider Response
失败重试
投递历史
```

---

# 5. 首批业务场景

```text
预约提醒
疫苗提醒
回访提醒
检验报告通知
```

注意：

本 Agent 不直接修改 Appointment/Vaccination/Followup/Lab。

只建立：

```text
Messaging Command
```

和 Trigger Contract。

---

# 6. Provider Interface

```ts
interface MessagingProvider {
  send(input): Promise<{
    providerMessageId?: string
    status: 'sent' | 'queued' | 'failed'
    raw?: unknown
  }>
}
```

Provider 不知道业务 Domain。

---

# 7. 数据模型

优先复用现有：

```text
message_templates
message_deliveries
```

如不足，可增加：

```text
message_delivery_attempts
```

字段：

```text
delivery_id
provider
attempt_no
request_snapshot
response_snapshot
status
error_code
error_message
created_at
```

---

# 8. 模板变量

不能让业务人员输入 JSON。

UI：

```text
可用变量：
客户姓名
宠物姓名
预约时间
门店名称
医生姓名
```

点击插入：

```text
{{customer.name}}
```

---

# 9. 模板安全

变量必须来自白名单。

禁止：

```text
任意对象路径
函数调用
任意表达式
```

---

# 10. API

```http
GET  /api/messaging/templates
POST /api/messaging/templates
PATCH /api/messaging/templates/:id

POST /api/messaging/send
GET  /api/messaging/deliveries
GET  /api/messaging/deliveries/:id
POST /api/messaging/deliveries/:id/retry
```

---

# 11. 发送边界

发送 Request 必须：

```text
tenant
store
scene
recipient
template
variables
```

Provider Secret：

```text
只在服务端
```

不得进入：

```text
Frontend
DB 明文模板字段
```

---

# 12. Provider 配置

当前 S3.1 正在修 Settings。

因此本 Agent：

```text
只定义 Config Interface
```

例如：

```text
MESSAGING_PROVIDER
MESSAGING_API_KEY
MESSAGING_SENDER
```

先从 Server Environment 读取。

最终由 Integrator 后续接入 System Settings。

---

# 13. Retry

建议：

```text
最多 3 次
```

重试：

```text
人工触发
```

第一版不需要复杂自动 Queue。

如果已有队列能力可复用。

---

# 14. 状态

统一：

```text
queued
sent
delivered
failed
```

如果 Provider 没 Delivery Callback：

```text
sent
```

就是最高可确认状态。

不要假装：

```text
delivered
```

---

# 15. 回执

如果 Provider 支持 Webhook：

```text
/api/messaging/provider/:provider/webhook
```

必须：

```text
验证签名
防重放
Idempotent
```

如果本轮不做 Webhook，则明确：

```text
Delivery Confirmation Deferred
```

---

# 16. Permission

建议：

```text
messaging.view
messaging.send
messaging.template.manage
messaging.retry
```

---

# 17. Audit

至少：

```text
template change
manual send
retry
provider config change（未来）
```

---

# 18. 不做

```text
营销自动化
群发营销
AI 文案
微信生态全接入
Campaign Builder
复杂 Journey
```

---

# 19. 验收

```text
[ ] 至少一个真实 Provider
[ ] 模板
[ ] 变量白名单
[ ] 发送
[ ] Delivery History
[ ] Retry
[ ] Provider Secret 不进前端
[ ] 失败原因
[ ] Permission
[ ] Audit
[ ] Mock Provider 不再作为正式主入口
[ ] Typecheck
[ ] Build
```

---

# 20. Handoff

```text
document/s32-handoff/S32-D-HANDOFF.md
```

必须列：

```text
Provider
ENV
Webhook（如有）
Trigger Contract
Settings Future Hook
Permission
```
