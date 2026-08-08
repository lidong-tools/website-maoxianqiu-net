> Agent-02 HANDOFF — Finance / Settings / Approval + 会员与积分产品化
> 环境说明:所有 Agent 共用同一工作目录与 `main` 分支,本 HANDOFF 按此记录。

# Agent-02 Handoff

## 1. 基础信息

- Base Commit: `d32e862a update`(HEAD)
- 分支:共享 `main` 工作树(未建独立分支,与其他 Agent 同一目录)
- 模块:会员中心产品化(等级 / 客户会员 / 积分流水 / 折扣规则 / Billing 快照接入)
- 状态:开发完成;本 Agent 文件 typecheck 全部通过,`vite build --mode test` 成功

## 2. 本轮工作定位

上一轮 P0 修复(设置唯一性/生效配置/自审禁止/找零/0 元语义/支付上下文/审批分页)已在此共享工作树中以未提交改动存在(`api/routes/settings.ts`、`api/routes/approvals.ts`、`api/routes/billing.ts`、cashier 页面、迁移 `20260809000054-56`)。本轮在既有 P0 之上完成 Agent-02 新需求:会员与积分产品化,未改动历史迁移。

## 3. 修改文件

| 文件 | 改动 |
|---|---|
| `supabase/migrations/20260810000056_membership_discount_rules.sql` | **新增** `membership_discount_rules` 表(tenant/tier/store/catalog_item/catalog_type 多维度定向)+ RLS + `points.view` 权限码 + 角色授权 |
| `supabase/migrations/20260810000057_membership_billing_integration.sql` | **新增** `invoice_items.membership_discount_percent` 快照列 + `get_effective_membership_discount`(具体项目 > 目录类型 > 等级默认;指定门店 > 全门店)+ `preview_membership_discount` 批量预览 RPC + **create_invoice 增加 `p_apply_membership_discount`** 服务端权威重算快照 |
| `api/routes/operations.ts` | 新增会员中心路由段:等级 CRUD / 客户会员列表+调整 / 积分流水只读 / 折扣规则 CRUD / 会员定价预览 |
| `api/routes/billing.ts` | create_invoice schema 增加 `applyMembershipDiscount` 透传 RPC;itemsJson 增加 `catalog_type`(供类型级折扣规则匹配) |
| `apps/maoxianqiu/src/types/operations.ts` | 新增 `MembershipDiscountRule` / `CustomerMembershipWithCustomer` / `PointTransactionWithCustomer` / `MembershipPricingPreview` 等类型 |
| `apps/maoxianqiu/src/types/billing.ts` | `CreateInvoiceInput` 增加 `applyMembershipDiscount` |
| `apps/maoxianqiu/src/api/modules/operations.ts` | 新增会员中心 11 个 API 方法(等级/客户会员/积分/折扣规则/定价预览) |
| `apps/maoxianqiu/src/router/modules/operations.ts` | 新增 `/operations/memberships`(auth: membership.view) |
| `apps/maoxianqiu/src/views/operations/memberships/index.vue` | **新增**会员中心页:会员等级 / 客户会员 / 积分流水 / 折扣规则四个 Tab |
| `apps/maoxianqiu/src/views/billing/cashier/index.vue` | 选客户后加载会员折扣预览,结算栏展示会员折扣,提交时透传 `applyMembershipDiscount` |

## 4. Migration(Agent-02 预留 56–58,本轮用 56/57)

| Migration | 内容 |
|---|---|
| `20260810000056_membership_discount_rules.sql` | `membership_discount_rules` 表 + 索引 + RLS(读=租户成员,写=membership.manage)+ `points.view` 权限码,授权 system_admin / tenant_owner / store_manager |
| `20260810000057_membership_billing_integration.sql` | 会员折扣定价逻辑 + Billing 快照接入(见下) |

`discount_percent` 语义与既有 `membership_tiers.discount_percent` 一致:**100 = 不打折,90 = 9 折(收取 90%)**。

## 5. 会员折扣真实接入 Billing(关键设计)

```text
客户
  ↓ customer_memberships(未过期) + membership_tiers(is_active)
有效会员
  ↓ 规则解析(优先级:具体 Catalog Item > Catalog Type > Tier Default;Store 规则 > Tenant 全门店)
适用折扣
  ↓ create_invoice(p_apply_membership_discount = true) 服务端权威重算
写入 invoice_items 价格快照(unit_price/discount_amount/amount + membership_discount_percent 列)
```

- **历史发票不受后续规则修改影响**:折扣在创建时以 `discount_amount`/`amount`/`membership_discount_percent` 落库,之后改规则不会重算老发票。
- **审批阈值只看手动折扣**:`invoice.discount_amount` 仅统计收银员手动折扣,会员折扣不触发大额审批(避免把自动优惠计入审批)。
- 金额一致性校验(ITEM_AMOUNT_MISMATCH)在 `p_apply_membership_discount=true` 时跳过,由服务端权威重算。
- `get_effective_membership_discount` 与 `preview_membership_discount` 均为 security definer + search_path 收紧 + revoke public + grant authenticated。

## 6. 新增 API(全部走 Hono Command + 权限 + 审计)

```text
GET    /operations/membership-tiers            # membership.view
POST   /operations/membership-tiers            # membership.manage(审计)
PATCH  /operations/membership-tiers/:id        # membership.manage(审计;禁用物理删除,用 is_active)
GET    /operations/customer-memberships        # membership.view(含客户姓名/手机/等级,支持关键词)
PATCH  /operations/customer-memberships/:id    # membership.manage(调等级/有效期)
GET    /operations/point-transactions          # points.view(只读)
GET    /operations/discount-rules              # membership.view
POST   /operations/discount-rules              # membership.manage(审计)
PATCH  /operations/discount-rules/:id          # membership.manage(审计)
DELETE /operations/discount-rules/:id          # membership.manage(审计)
POST   /operations/membership-pricing-preview  # membership.view(调 preview_membership_discount RPC)
```

## 7. 新增 Route

```text
/operations/memberships  会员中心(auth: membership.view)
```

## 8. 跨域 Hook

- **会员 → Cashier 价格计算**:Cashier 页面选客户后调 `previewMembershipPricing`,结算栏展示会员折扣,提交 `create_invoice` 时透传 `applyMembershipDiscount=true`。Hook 在 Agent-02 域内闭环(billing.ts 为 Agent-02 域)。
- **积分流水只读**:沿用 `point_transactions` 无 update/delete 策略;手工调整走既有 `adjust_points` RPC(operations.ts 已有,带幂等 + 审计)。
- 会员折扣**不**复用 Approval Center(自动优惠不进审批);Integrator 无需在 approvals.ts 挂接。

## 9. 未完成项 / 已知边界

1. **整仓 vue-tsc 仍非零退出**:共享工作树中其他 Agent(06)在制品 `inpatient-boarding.ts` 引用尚不存在的 `boarding/index.vue`,非本 Agent 责任;本 Agent 文件 0 报错。
2. **未跑真实 DB migration**(db:push/dry-run);建议 Integrator 对 56/57 做 dry-run。依赖既有 `touch_updated_at`(000015)与 `get_effective_setting`(09055),按序应用即可。
3. **储值钱包未做**:本轮仅保留 `stored_value` 支付方式枚举,未建真实储值账户/钱包;列为下一阶段需求。
4. **折扣规则表单使用项目 UUID 输入**(非选择器):`FaInput` 直填 catalog_item_id,Product 选择器尚未接入,功能完整但交互可后续优化。
5. **未运行 E2E**(本批约定 E2E 独立,不改 `e2e/**`)。

## 10. 风险

- `create_invoice` 函数签名新增第 13 参数 `p_apply_membership_discount`(带 default),`revoke/grant` 已按 13 参签名重写;若 Integrator 其他域有同名函数覆盖需注意参数数。
- `invoice_items` 增加可空列 `membership_discount_percent`,既有插入语句不受影响。
- 会员折扣预览为前端展示用,实际折扣以服务端 create_invoice 重算为准(前端不参与折扣计算,避免伪造)。

## 11. 验证证据

```text
- tsc --noEmit -p api/tsconfig.json:api/routes/operations.ts、billing.ts 无错误
- vue-tsc -b(apps/maoxianqiu):memberships 页面 / operations.ts(api+types+router)/ billing.ts(cashier+types) 无错误
- vite build --mode test:成功(仅 chunk 大小警告)
- 整仓 typecheck 因 Agent-06 在制品非零退出(见 §9.1),与本次改动无关
- 未运行 E2E
```
