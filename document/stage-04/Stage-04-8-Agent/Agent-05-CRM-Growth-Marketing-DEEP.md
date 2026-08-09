# Agent-05 — CRM Growth & Marketing 深度执行指导

## 0. 合并范围

你同时负责：

```text
客户分层
流失预警
优惠券
套餐/次卡
Campaign
营销 Audience
生日营销
Referral 基础
```

原因：这些能力共享同一个 Customer Audience / Eligibility 逻辑，绝对不能拆成两套。

---

# 1. Source13 调研

必须阅读：

```text
api/routes/customers.ts
GET /customers/:id/360
followup endpoints

api/routes/analytics.ts
api/services/analytics/customers.ts
api/services/analytics/revenue.ts

api/routes/operations.ts
membership-tiers
customer-memberships
point-transactions
discount-rules
membership-pricing-preview

supabase/migrations/20260810000062_followup_tasks.sql
20260806000018_operations.sql
20260810000056_membership_discount_rules.sql

apps/maoxianqiu/src/views/crm/customer/**
apps/maoxianqiu/src/views/crm/followups/**
apps/maoxianqiu/src/views/operations/memberships/**
```

Source13 已有：

```text
Customer 360
Follow-up
Membership
Points
Membership Discount
Reminders
Analytics
```

Stage04 必须复用这些事实。

---

# 2. Source of Truth

Segment 输入从现有业务表读取：

```text
customers
pets
encounters
appointments
invoices/payments
customer_memberships
point_transactions
reminders
followup_tasks
vaccination/deworming
```

禁止新建：

```text
customer_behavior_events
```

除非有清晰必要。

首版优先 SQL Aggregation/View/RPC。

---

# 3. 分层设计原则

不要上黑盒机器学习。

首版：

```text
规则 + Score
```

必须可解释。

建议内置维度：

```text
Recency
Frequency
Monetary
Membership
Pet Count
Vaccination Due
Deworming Due
No-show
Follow-up overdue
```

---

# 4. 数据模型

## customer_segment_definitions

```text
id
tenant_id
code
name
description
rule_json
priority
active
created_by
created_at
updated_at
```

## customer_segment_memberships

若物化：

```text
segment_id
customer_id
score
matched_at
expires_at
explanation jsonb
```

可以定期重算。

若实时查询性能足够，也可不物化全部，但 Campaign Audience 需要可重现 Snapshot。

## customer_risk_scores

```text
customer_id
risk_type churn
score
level low/medium/high
explanation
calculated_at
model_version
```

---

# 5. Explainability

必须能显示类似：

```text
高流失风险 82

原因：
- 167 天未到院 +35
- 去年 5 次，今年 0 次 +25
- 疫苗逾期 43 天 +15
- 有未完成 Follow-up +7
```

禁止只返回：

```text
risk=0.82
```

---

# 6. 时间与 Scope

Segment 应按：

```text
tenant
可选 store filter
```

但客户是 Tenant 级关系，不能因为当前 Store 只看一个门店就错误地认为客户“180 天没来”，如果他去了同 Tenant 其它 Store。

因此必须明确：

```text
Customer Churn 默认 Tenant-wide
Store-specific campaign 可额外筛 Store
```

---

# 7. Coupon Domain

建议：

```text
coupons
coupon_rules
coupon_issues
coupon_redemptions
```

Coupon Template：

```text
fixed amount
percentage
min spend
max discount
catalog type/item scope
store scope
valid from/to
quota
per customer limit
stacking policy
```

Coupon Issue：

```text
customer_id
code/token
status available/redeemed/expired/cancelled
```

---

# 8. Redemption

权威 Redemption 不能由前端算。

Billing 集成应：

```text
Invoice Draft
↓
Server Pricing Preview
↓
Validate coupon
↓
Lock issue/quota
↓
Apply discount snapshot
↓
Confirm redemption
```

要避免：

```text
两个收银台同时核销同券
```

使用：

```text
row lock/CAS
```

---

# 9. Package/Card Domain

不要和 Catalog Package 混淆。

建议：

```text
service_packages
service_package_items
customer_packages
package_redemptions
```

例：

```text
洗护 10 次卡
疫苗年度套餐
复诊 5 次包
```

需要：

```text
validity
remaining quantity
allowed store
eligible catalog item
```

Redemption Ledger 不可变。

并发核销防负次数。

---

# 10. Campaign

```text
marketing_campaigns
marketing_campaign_audiences
marketing_campaign_offers
marketing_campaign_runs
```

Campaign 只负责：

```text
谁
什么时候
用什么 Offer
通过哪个 Channel
```

消息发送本身调用 Agent-08 的 Messaging Contract。

禁止 Marketing 直接：

```text
调用 SendGrid SDK
写 message_deliveries
```

---

# 11. Audience

Audience 必须复用：

```text
Segment
Risk
Membership
Pet attributes
Store relation
```

**禁止再做第二套 customer filters 引擎。**

Campaign 发布时应 Snapshot：

```text
audience customer ids
rule version
```

否则以后 Segment 变化会让历史活动无法审计。

---

# 12. Birthday / Referral

## Birthday

Source13 Customer 有：

```text
birthday
```

可生成生日 Campaign。

但不要把生日 Scan 和 Provider 写在一起。

## Referral

首版建议：

```text
referral_codes
referral_events
```

只做基础“推荐关系 + 奖励资格”。

奖励可：

```text
Points
Coupon
Wallet bonus（若 Agent-03 contract ready）
```

不能直接跨域写余额。

---

# 13. 与 Membership 的关系

Source13 已有：

```text
membership_discount_rules
```

Coupon/Package 不应篡改 Membership Rule。

Pricing 优先级必须明确，例如：

```text
Catalog base price
→ Membership discount
→ Coupon
→ manual discount
```

或其它产品规则。

你必须在 Handoff 中给 Agent-09 一个**唯一的 Pricing Order**。

不允许不同页面顺序不同。

---

# 14. API

建议：

```text
/crm-growth/segments
/crm-growth/churn
/crm-growth/customers/:id/insights

/marketing/coupons
/marketing/coupon-issues
/marketing/packages
/marketing/customer-packages
/marketing/campaigns
/marketing/campaigns/:id/audience-preview
/marketing/campaigns/:id/publish
```

---

# 15. 权限

```text
crm.segment.view
crm.segment.manage
marketing.view
marketing.manage
marketing.publish
marketing.adjust_entitlement
```

Campaign publish 建议比 manage 更高权限。

---

# 16. Frontend

Customer 360 增：

```text
Segment
Churn Risk
Active Coupons
Packages
Campaign History
```

运营页面：

```text
Segment
Coupon
Package
Campaign
```

不要塞进一个 2000 行 Vue 页面。

---

# 17. 批量计算

不要浏览器拉全 Customers 计算。

可选：

```text
SQL aggregate RPC
scheduled job
materialized snapshot
```

Source13 已有 `jobs` 表，可复用队列框架，但不要无消费者只塞 job。

---

# 18. 测试

Segment：

```text
跨 Store 客户
无消费
新客户
高频客户
风险解释稳定
```

Coupon：

```text
quota
per customer limit
expired
wrong store
wrong catalog
double redemption concurrency
```

Package：

```text
double redeem
expiry
wrong service
refund/reversal
```

Campaign：

```text
audience snapshot
duplicate publish
message dispatch idempotency
```

---

# 19. 失败条件

```text
前端算 Segment
黑盒 risk 无 explanation
Marketing 自己发送 Provider
Coupon 只前端校验
Package remaining 可直接 UPDATE
建第二套 Audience Engine
改掉 membership_discount_rules 真源
```

---

# 20. Handoff

必须给：

```text
SEGMENT_RULE_VERSION
CHURN_SCORE_FORMULA
AUDIENCE_SNAPSHOT_POLICY
PRICING_ORDER
COUPON_STACKING_POLICY
PACKAGE_REFUND_POLICY
MESSAGING_CONTRACT
WALLET_CONTRACT_USAGE
```

---

# 21. Commit

```text
feat(stage04-05): implement crm growth and marketing engine
```
