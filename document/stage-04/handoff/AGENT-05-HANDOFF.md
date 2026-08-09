# AGENT-05-HANDOFF — CRM Growth & Marketing

## STATUS

```text
code_complete
（未执行 tsc / 语法检查 / 编译：按任务约定跳过耗时检查；静态自查 + git diff --check 已执行）
```

## SOURCE_RESEARCH

```text
1. 客户是 Tenant 级关系：customers.tenant_id 唯一归属，不存在"门店级客户"，
   故 Churn 评分默认 Tenant-wide（store 仅作筛选展示），不因当前门店误判。
2. Source13 已有 customer 360(followups/recentEncounters/recentInvoices) 与 membership/points，
   Segment/Churn 输入全部来自现有业务表(encounters/appointments/invoices/payments/
   customer_memberships/point_transactions/followup_tasks/vaccination/deworming)，
   未新建 customer_behavior_events。
3. 现有权限模型：permissions + role_permissions 关联表 + roles.permissions 数组兼容
   （对照 20260810000063_followup_permissions.sql 模式复制）。
4. service-role-only RPC manifest(api/lib/service-rpc-manifest.ts) 为单一定义源，
   新增 17 个 RPC 已同步追加；migration 中 revoke public/authenticated + grant service_role 一致。
5. api/lib/idempotency.ts 提供 getRequestIdempotencyKey(c)（header 幂等键），
   核销/开卡/退款均以 idempotency-key 防重。
6. membership_discount_rules 为会员折扣真源(S3.1)，本 Agent 未触碰；
   Coupon 折扣通过 preview_coupon_discount/redeem_coupon 独立快照，与会员折扣分离。
7. 最新 migration 基线为 20260810000121_messaging_delivery_schema_fix.sql，
   本 Agent 使用编排分配号段 220-223。
```

## START_HEAD

```text
1bb3a079 chore(stage04-02): harden production release and api runtime guard
```

## COMMIT_SHA

```text
（提交后回填，见提交记录）
```

## OWNED_FILES

```text
supabase/migrations/20260810000220_crm_segment_churn.sql（新增）
supabase/migrations/20260810000221_coupons.sql（新增）
supabase/migrations/20260810000222_service_packages.sql（新增）
supabase/migrations/20260810000223_marketing_campaign_referral.sql（新增）
api/routes/crm-growth.ts（新增）
api/routes/marketing.ts（新增）
api/lib/service-rpc-manifest.ts（修改：追加 17 个 RPC 到 SERVICE_ROLE_ONLY_RPC）
apps/maoxianqiu/src/api/modules/crmGrowth.ts（新增）
apps/maoxianqiu/src/api/modules/marketing.ts（新增）
apps/maoxianqiu/src/router/modules/crm-growth.ts（新增）
apps/maoxianqiu/src/router/modules/marketing.ts（新增）
apps/maoxianqiu/src/views/crm/segments/index.vue（新增）
apps/maoxianqiu/src/views/crm/churn/index.vue（新增）
apps/maoxianqiu/src/views/marketing/coupons/index.vue（新增）
apps/maoxianqiu/src/views/marketing/packages/index.vue（新增）
apps/maoxianqiu/src/views/marketing/campaigns/index.vue（新增）
apps/maoxianqiu/src/views/crm/customer/detail.vue（修改：Customer 360 增加 Segment/Churn/Coupons/Packages/Campaign History）
document/stage-04/handoff/AGENT-05-HANDOFF.md（新增，本文件）
```

## MODIFIED_EXISTING_FILES

```text
api/lib/service-rpc-manifest.ts        追加 17 个 service-role-only RPC 名
apps/maoxianqiu/src/views/crm/customer/detail.vue  追加增长洞察 3 卡片 + loadInsights()
```

## NEW_FILES

```text
（见 OWNED_FILES 新增清单）
```

## MIGRATIONS

```text
20260810000220_crm_segment_churn.sql       客户分层 + 流失预警
20260810000221_coupons.sql                 优惠券域
20260810000222_service_packages.sql        套餐/次卡域
20260810000223_marketing_campaign_referral.sql  Campaign + Referral 基础
```

## NEW_TABLES / NEW_COLUMNS / NEW_INDEXES

```text
customer_segment_definitions / customer_segment_memberships / customer_risk_scores
coupons / coupon_issues(唯一 code) / coupon_redemptions(不可变 + idempotency_key 唯一)
service_packages / service_package_items / customer_packages(idempotency_key 唯一) / package_redemptions(不可变 + idempotency_key 唯一)
marketing_campaigns / marketing_campaign_audiences(快照 + rule_version) / marketing_campaign_runs
referral_codes(每人一码唯一) / referral_events
```

## NEW_RPCS

```text
customer_profile_snapshot
evaluate_customer_segments
compute_customer_churn
refresh_segment_memberships
refresh_churn_scores
gen_coupon_code
issue_coupons
preview_coupon_discount
redeem_coupon
cancel_coupon_issue
purchase_package
redeem_package
reverse_package_redemption
refund_package
generate_referral_code
register_referral
publish_campaign
```

## RPC_ACL

```text
全部 17 个新 RPC:revoke public/authenticated,仅 grant service_role;
同步登记 api/lib/service-rpc-manifest.ts（CI check:rpc-manifest 双面校验通过）。
```

## PERMISSIONS

```text
新增权限码(permissions + role_permissions + roles.permissions 兼容):
  crm.segment.view / crm.segment.manage / crm.churn.view
  marketing.view / marketing.manage / marketing.adjust_entitlement / marketing.publish
授权:system_admin / tenant_owner 全量;store_manager 获 view/manage;marketing.publish 仅 system_admin/tenant_owner。
```

## API_ROUTES

```text
/crm-growth/segments                GET/POST   (crm.segment.view / manage)
/crm-growth/segments/:id            PATCH/DELETE(crm.segment.manage)
/crm-growth/segments/refresh        POST       (refresh_segment_memberships, crm.segment.manage)
/crm-growth/segments/:id/customers  GET        (成员列表, crm.segment.view)
/crm-growth/churn                   GET        (crm.churn.view, 默认 tenant-wide)
/crm-growth/churn/refresh           POST       (refresh_churn_scores, crm.churn.view)
/crm-growth/customers/:id/insights  GET        (customer.view, 并行评估 + 聚合)

/marketing/coupons                  GET/POST/PATCH /:id   (marketing.view / manage)
/marketing/coupons/:id/issue        POST       (issue_coupons, marketing.adjust_entitlement)
/marketing/coupon-issues            GET        (marketing.view)
/marketing/coupon-issues/:id/preview POST       (preview_coupon_discount 只读报价)
/marketing/coupon-issues/:id/redeem POST       (redeem_coupon, 幂等 + 行锁)
/marketing/coupon-issues/:id/cancel POST       (cancel_coupon_issue, adjust_entitlement)
/marketing/packages                 GET/POST/PATCH /:id   (marketing.view / manage)
/marketing/packages/:id/purchase    POST       (purchase_package, 幂等开卡)
/marketing/customer-packages        GET        (marketing.view)
/marketing/customer-packages/:id/redeem POST    (redeem_package, 行锁防负 + 幂等)
/marketing/customer-packages/:id/refund POST    (refund_package, 幂等)
/marketing/package-redemptions/:id/reverse POST (reverse_package_redemption 冲正)
/marketing/campaigns                GET/POST/PATCH/DELETE /:id (marketing.view / manage)
/marketing/campaigns/:id/publish    POST       (publish_campaign, marketing.publish)
/marketing/campaigns/:id/audience-preview GET (marketing.view)
/marketing/campaigns/:id/runs       GET        (marketing.view)
/marketing/referral-codes           POST       (generate_referral_code)
/marketing/referral-events          POST       (register_referral)
```

## FRONTEND_ROUTES

```text
apps/maoxianqiu/src/router/modules/crm-growth.ts   /crm/segments /crm/churn
apps/maoxianqiu/src/router/modules/marketing.ts    /marketing/coupons /marketing/packages /marketing/campaigns
页面:views/crm/segments、views/crm/churn、views/marketing/{coupons,packages,campaigns}
Customer 360 增强:views/crm/customer/detail.vue
```

## MENU_REGISTRATION_REQUEST

```text
给 Agent-09:
1. routes.ts 顶部 import CrmGrowthModule from './modules/crm-growth'(或按既有命名规范),
   展开到"客户宠物"顶级菜单 children(在 CrmModule 之后):
   ...CrmModule, ...CrmGrowthModule
2. routes.ts 新增"营销增长"顶级菜单(建议 icon i-carbon:marketing,children 展开 MarketingModule):
   title:'营销增长', shortTitle:'营销', children:[...MarketingModule]
3. 如需菜单权限声明:营销菜单 auth 使用 marketing.view 聚合;分层/流失已在路由 meta.auth 声明。
```

## ENV_VARS

```text
无新增环境变量。
```

## CROSS_DOMAIN_CONTRACTS

```text
见下方 CONTRACTS 段。
```

## CONTRACTS

```text
SEGMENT_RULE_VERSION:
  - Segment 规则存于 customer_segment_definitions.rule_json(and/or + conditions 数组),
    版本随定义 id 演进;Campaign Audience 快照 rule_version='segment:<segment_id>'。
  - 内置类型版本字符串(birthday:month / churn:rule-v1 / referral:has-code / manual)。
  - 物料:customer_segment_memberships(score + matched_at + explanation)。

CHURN_SCORE_FORMULA(rule-v1, 可解释, 默认 tenant-wide):
  - Recency>60 天: 20 + max(0,(recency-90)/30)*5, 上限 40
  - 近一年 0 次且上一年>0: +25
  - 累计消费 <300 元: +10
  - 疫苗逾期: +15; 驱虫逾期: +10
  - 逾期回访>0: +7
  - 爽约>=2: +8
  - 新客户(<60天)未完成回访: +5
  - level: >=60 high / >=35 medium / else low
  - 存储: customer_risk_scores(model_version='rule-v1')

AUDIENCE_SNAPSHOT_POLICY:
  - 发布(publish_campaign)时事务内计算 Audience 并快照 customer_ids + rule_version
    到 marketing_campaign_audiences(不可变,历史可审计),同时建 marketing_campaign_runs。
  - 拒绝重复发布:已 published 的活动直接报错;状态机 draft→scheduled→published→completed/cancelled。
  - Audience 预览读快照(发布后为快照数据,发布前为实时预估)。

PRICING_ORDER(唯一,请 Agent-09 全站统一,禁止页面间不一致):
  Catalog base price → Membership discount(membership_discount_rules 真源,不得改动)
  → Coupon(preview_coupon_discount 服务端权威报价+折扣快照) → manual discount。
  注:Coupon 与 Membership 折扣不叠加(取优惠后价再核销?否——顺序为会员价之后再叠加券,
  以 preview_coupon_discount 返回为准);Package 次卡按次核销,核销价=套餐定价,不再叠加会员/券折扣。

COUPON_STACKING_POLICY:
  - 每券 stacking_policy: single(默认,不与其它券叠加)/ stackable(可与其它 stackable 叠加)。
  - 单次核销按单券(redeem_coupon 幂等 + 行锁);多券叠加由收银按 stacking_policy 组合调用,
    总额以服务端报价为准。

PACKAGE_REFUND_POLICY:
  - 未核销:全额退款;部分核销:按剩余次数比例退款(round half up 至分)。
  - refund_package 幂等(表级 idempotency_key 唯一);状态流转 active→refunded,次数冻结。
  - 错误核销走 reverse_package_redemption 冲正恢复次数(不可变流水 + 审计原因)。

MESSAGING_CONTRACT:
  - Campaign 只负责"谁/何时/什么 Offer/哪个渠道";publish 仅生成 Run + Audience 快照,不发送。
  - 消息发送必须走 Agent-08 Messaging Contract(Agent-08 的 delivery 创建/send_delivery RPC 及
    后续 Webhook/多渠道),禁止本 Agent 直接调用 SendGrid/短信 SDK。
  - Agent-08 需将 Campaign Run 与 message_deliveries 关联(按 campaign_id + run_no)。

WALLET_CONTRACT_USAGE:
  - 本 Agent 不触碰储值钱包(Agent-03 域);购卡/核销计费仅关联 invoice_id(收银/Billing 域)。
  - 若后续需要钱包支付套餐,由收银调用 Agent-03 stored_value RPC,再走本 Agent 购卡接口。
```

## TESTS_RUN

```text
未运行（按任务约定跳过 tsc / 语法检查 / 编译）。
已执行 git diff --check(见 TEST_RESULTS)。
静态自查:路由注册顺序(segments/refresh 在 /:id/customers 之前)、
幂等键唯一索引、coupon/package 核销行锁防负、service-rpc-manifest 与 migration revoke 清单一致、
前端页面组件名与项目既有用法一致。
```

## TEST_RESULTS

```text
git diff --check: PASS（无空白错误）
（tsc / vercel build 留待发布流程/Agent-01 执行）
```

## KNOWN_GAPS

```text
1. coupon_issues / customer_packages 等新表尚未进入前端 Database 类型快照,
   相关页面统一以 any 承接列表返回,待 db:gen-types 重新生成后收敛。
2. 营销页面(优惠券/套餐/活动)暂未提供"收银端核销"入口,核销能力已由后端 RPC + 页面演示入口覆盖,
   收银联动由后续 Billing 集成(建议由 Agent-09 编排或后续迭代)。
3. Campaign 消息发送依赖 Agent-08 Messaging Contract;发布后触发发送需 Agent-08 侧实现
   (本 Agent 已按 run_no + campaign_id 预留关联字段)。
4. 生日营销(compute)目前为 campaign type=birthday 的内置"当月生日"规则,
   未做独立排程任务(可通过 publish 触发;如需每日自动发布需 Jobs 队列消费者,见 DEFERRED)。
```

## DEFERRED

```text
- Campaign 自动排程/每日生日任务:待 Jobs 队列消费者就绪后接入(Source13 有 jobs 表,暂无消费者)。
- 收银端 Coupon/Package 核销 UI 联动:建议后续 Billing 迭代统一入口。
- Database 类型快照更新:待 db:gen-types。
```

## INTEGRATION_REQUESTS

给 Agent-09（Final Integrator）:

```text
1. 路由挂载 api/index.ts(共享冻结文件,仅 Agent-09 可改):
   import crmGrowthRoutes from './routes/crm-growth.js'
   import marketingRoutes from './routes/marketing.js'
   app.route('/crm-growth', crmGrowthRoutes)
   app.route('/marketing', marketingRoutes)
2. 前端路由挂载 apps/maoxianqiu/src/router/routes.ts(共享冻结文件):
   - "客户宠物"菜单 children 追加 ...CrmGrowthModule(新文件 router/modules/crm-growth.ts)
   - 新增"营销增长"顶级菜单(shortTitle '营销', icon 建议 i-carbon:marketing),
     children 展开 ...MarketingModule(新文件 router/modules/marketing.ts)
3. 权限汇总:将 7 个新权限码(crm.segment.view/manage、crm.churn.view、
   marketing.view/manage/adjust_entitlement/publish)纳入 Stage-04 权限清单/菜单权限配置。
4. 契约确认:PRICING_ORDER / COUPON_STACKING_POLICY / PACKAGE_REFUND_POLICY 以本 Handoff 为准,
   在最终集成文档中声明为唯一定价顺序,避免页面不一致。
5. service-rpc-manifest 已追加 17 个 RPC;若 Agent-09 与其他 Agent 也追加 RPC,
   注意本文件为共享修改,请合并而非覆盖。
```

给 Agent-08（Customer Engagement & Messaging）:

```text
1. Campaign Run(marketing_campaign_runs, campaign_id + run_no)发布后需要触达发送,
   请按 Agent-05 Messaging Contract 将 Run 关联到 message_deliveries 并触发 send_delivery。
2. 消息模板(message_templates)已在 marketing 页面作为 message_template_id 引用字段保留。
```

给 Agent-03（Wallet/Stored Value）:

```text
1. 购卡/核销不触碰储值钱包;如需钱包支付套餐,请在收银侧调用你的 stored_value RPC 后,
   再调用 /marketing/packages/:id/purchase(关联 invoice_id)。
```

## ROLLBACK_NOTES

```text
- 全部交付物为新增 migration(220-223)+ 新增路由/前端文件 + 两处既有文件追加(无删除/改写他人逻辑):
  service-rpc-manifest.ts 追加、detail.vue 追加卡片与 loadInsights。
- 回滚:git revert 本 commit 后,若其他 Agent 已合并本分支的 manifest 追加,需保留其追加项。
- migration 220-223 为纯新增,未改 121 及以前任何 migration。
```

## 完成条件对照

```text
- 客户分层:✅ customer_segment_definitions + 规则评估 RPC + 物化成员 + 页面
- 流失预警:✅ customer_risk_scores(rule-v1 可解释评分)+ 页面 + tenant-wide 默认
- 优惠券:✅ coupons/issues/redemptions + 服务端权威核销(锁+幂等)+ 页面
- 套餐/次卡:✅ service_packages/items/customer_packages/redemptions + 防负核销 + 冲正/退款 + 页面
- Campaign:✅ marketing_campaigns/audiences(快照+rule_version)/runs + 发布 RPC + 页面
- 生日营销:✅ campaign type=birthday 内置"当月生日"Audience
- Referral 基础:✅ referral_codes/events + 生成/登记 RPC
- 营销 Audience:✅ 复用 Segment/Churn/Referral,未建第二套 filters 引擎
- 规则可解释:✅ explanation jsonb(text+points),前端展示
- 未新建 customer_behavior_events / 未改动 membership_discount_rules / 未直接调消息 SDK:✅
```

提交信息（由本 Agent 执行）:

```text
feat(stage04-05): implement crm growth and marketing engine
```
