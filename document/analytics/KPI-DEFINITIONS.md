# 经营报表 KPI 定义(权威口径)

> 模块:S32-B 经营报表与驾驶舱
> 版本:v1
> 适用范围:`/api/analytics/*` 全部指标。
>
> 本文件是唯一口径来源。前端 Tooltip 展示的 definition 字段与此处保持一致;
> 任何口径调整必须先更新本文件,再同步 API 与前端。

## 0. 通用约定

- **金额**:一律 `numeric(12,2)`,API 返回 number,前端仅展示不做业务计算。
- **时间语义**:`startAt`/`endAt` 为业务日期(`YYYY-MM-DD`),在 **Tenant Timezone** 内解释为
  `[start 00:00:00, end 23:59:59]` 的闭区间。
- **时区(§11)**:门店无时区字段,一律沿用 `tenants.timezone`(缺省 `Asia/Shanghai`)。
  所有"今日/按日切片"均按该时区计算,禁止用 Server UTC 直接切天。
- **数据范围(§10)**:传 `storeId` = 仅该门店;不传 `storeId`(全院)= 仅 `analytics.view.tenant`
  用户可见,数据收敛到被授权门店集合(`allowedStoreIds`)。
- **有效发票**:`invoices.status ∈ (confirmed, paid, partially_paid, refunded)`,
  排除 `draft` / `cancelled`。

---

## 1. 驾驶舱 Dashboard

| KPI | 定义 | 源表 | 过滤 | 聚合 | 时区 | 排除 |
|---|---|---|---|---|---|---|
| 今日收入 | 今日净收入 = 今日有效发票合计 − 今日退款 | invoices / refunds | 有效发票;created_at ∈ 今日(tz) | SUM(total) − SUM(refund.amount) | Tenant | draft/cancelled |
| 本月收入 | 本月净收入 = 本月有效发票合计 − 本月退款 | invoices / refunds | 有效发票;created_at ∈ 本月(tz) | SUM(total) − SUM(refund.amount) | Tenant | draft/cancelled |
| 今日门诊 | 今日开始就诊数 | encounters | started_at ∈ 今日(tz) | COUNT | Tenant | 无 |
| 本月新增客户 | 本月建档客户数 | customers | created_at ∈ 本月(tz) | COUNT | Tenant | archived/merged 仍计(建档口径) |
| 平均客单价 | 本月净收入 ÷ 本月有效发票数 | invoices / refunds | 同本月收入 | NET / COUNT | Tenant | 无 |
| 退款金额 | 本月退款合计 | refunds(经 invoices 收敛门店) | created_at ∈ 本月(tz) | SUM(amount) | Tenant | 无 |
| 住院收入 | 本月住院计费合计 | inpatient_charges | store_id ∈ 范围;charge_date ∈ 本月 | SUM(amount) | Tenant | 无 |
| 寄养收入 | 本月寄养计费合计 | boarding_service_charges | store_id ∈ 范围;charge_date ∈ 本月 | SUM(amount) | Tenant | 无 |
| 会员贡献 | 银卡/金卡/钻石客户本月有效发票合计 | invoices + customers | customer.member_level ∈ (silver,gold,diamond) | SUM(total) | Tenant | draft/cancelled |
| 低库存 | 可用数量 ≤ 0 的 SKU 数 | inventory_balances | 经 warehouses 收敛门店 | COUNT | 即时(非时间切片) | 无 |
| 近效期 | 查询周期结束日起 30 天内到期且有剩余库存的活跃批次数 | inventory_batches | status=active;quantity_remaining>0;expiry_date ∈ [endDate, endDate+30] | COUNT | 即时 | 无 |

---

## 2. 收入分析 Revenue

| 指标 | 定义 | 源表 | 过滤 | 聚合 | 时区 | 排除 |
|---|---|---|---|---|---|---|
| Gross Revenue | 有效发票合计 | invoices | 有效发票;created_at ∈ 周期(tz) | SUM(total) | Tenant | draft/cancelled |
| Refund | 当期退款合计 | refunds(经 invoices 收敛门店) | created_at ∈ 周期(tz) | SUM(amount) | Tenant | 无 |
| Net Revenue | Gross − Refund | — | — | — | — | — |
| Invoice Count | 有效发票数 | invoices | 同上 | COUNT | Tenant | draft/cancelled |
| Average Ticket(客单价) | Net Revenue ÷ Invoice Count | — | — | — | — | 无 |

### 维度(§5)

- **store**:按 `invoices.store_id` 分组。
- **payment_channel**:按 `invoices.payment_method`(cash/wechat/alipay/card/other)分组。
- **catalog_type**:按 `invoice_items.category`(service/drug/vaccine/exam/product)分组;
  说明:退款不拆分到目录类型,该维度 net = gross。
- **doctor**:经 `invoices.encounter_id → encounters.doctor_id` 归因;无 encounter 关联的发票归入"未归因"。
  说明:退款不拆分到医生,该维度 net = gross。

---

## 3. 客户分析 Customer

| KPI | 定义 | 源表 | 过滤 | 聚合 | 时区 | 排除 |
|---|---|---|---|---|---|---|
| 新增客户 | 周期内建档客户数 | customers | created_at ∈ 周期(tz) | COUNT | Tenant | 无 |
| 活跃客户 | 周期内有就诊或消费的客户数 | encounters + invoices | 客户 id 并集 | COUNT(DISTINCT customer_id) | Tenant | 无 |
| 复诊客户 | 周期内就诊次数 ≥ 2 的客户数 | encounters | 按 customer_id 计数 ≥ 2 | COUNT | Tenant | 无 |
| 复诊率 | 复诊客户 ÷ 周期内就诊 ≥1 次客户数 | encounters | 见定义 | 比值 | Tenant | 分母不含仅消费未就诊客户 |
| 会员贡献 | 各会员层级客户本期有效发票合计 | invoices + customers | member_level ≠ normal | SUM(total) | Tenant | draft/cancelled |

### 会员层级明细(tierBreakdown)
按 `customers.member_level`(normal/silver/gold/diamond)统计客户数与该层级本期消费。

### 客户消费分层(consumptionTiers)
按客户本期有效发票净消费分桶:`0` / `1–500` / `501–2000` / `2001–5000` / `>5000`(元)。

### 复诊率定义(必须展示在页面 Tooltip 与本文档)
> 复诊率 = 查询周期内就诊次数 ≥ 2 的客户数 ÷ 查询周期内就诊次数 ≥ 1 的客户数。
> 分母不含仅消费未就诊的客户。

---

## 4. 医疗运营 Clinical

| KPI | 定义 | 源表 | 过滤 | 聚合 | 时区 | 排除 |
|---|---|---|---|---|---|---|
| 预约数 | 周期内预约总数 | appointments | scheduled_start ∈ 周期(tz) | COUNT | Tenant | 无(含取消) |
| 到店率 | 到店预约 ÷ (预约数 − 取消数) | appointments | 到店 = status ∈ (checked_in, in_progress, completed) | 比值 | Tenant | 分母剔除 cancelled |
| No-show | no_show 预约数 | appointments | status = no_show | COUNT | Tenant | 无 |
| 接诊数 | 周期内开始就诊数 | encounters | started_at ∈ 周期(tz) | COUNT | Tenant | 无 |
| 完成病历 | 周期内签署病历数 | encounters | signed_at ∈ 周期(tz) | COUNT | Tenant | 未签署不算 |
| 检验单量 | 周期内检验单数 | lab_orders | requested_at ∈ 周期(tz) | COUNT | Tenant | 无 |
| 影像单量 | 周期内影像单数 | imaging_orders | created_at ∈ 周期(tz) | COUNT | Tenant | 无 |
| 住院量 | 周期内入院数 | admissions | admitted_at ∈ 周期(tz) | COUNT | Tenant | 无 |

> 不做医疗质量评分、医生诊疗优劣排名(§7,避免错误激励)。

---

## 5. 库存分析 Inventory

| KPI | 定义 | 源表 | 过滤 | 聚合 | 时区 | 排除 |
|---|---|---|---|---|---|---|
| 库存 SKU | 有在库的目录项数 | inventory_balances | quantity_on_hand > 0 | COUNT(DISTINCT catalog_item_id) | 即时 | 无 |
| 库存价值 | Σ(在库 × 目录成本价) | inventory_balances + catalog_items | 经 warehouses 收敛门店 | SUM(qty_on_hand × cost_price) | 即时 | 无 |
| 低库存 | 可用数量 ≤ 0 的 SKU 数 | inventory_balances | on_hand − reserved ≤ 0 | COUNT | 即时 | 无 |
| 近效期 | 30 天内到期且有剩余库存的活跃批次 | inventory_batches | status=active;remaining>0;expiry ∈ [today, today+30] | COUNT | Tenant(今日基准) | 无 |
| 报损 | 负向 adjust 且 reference_type 含 报损/waste/damage/报废/expire 的调整价值 | inventory_movements + catalog_items | movement_type=adjust;quantity<0;reference_type 匹配 | SUM(\|quantity\| × cost_price) | Tenant | 非报损调整不计 |
| 采购金额 | 周期内创建、非草稿/取消采购订单合计 | purchase_orders | created_at ∈ 周期;status ∉ (draft, cancelled) | SUM(total_cost) | Tenant | draft/cancelled |
| 库存异动 | 周期内异动记录数 | inventory_movements | created_at ∈ 周期 | COUNT | Tenant | 无 |

> **不做**:库存周转率(§8)。当前无法从现有数据可靠计算(缺少标准周转周期定义),
> 为避免展示虚假数字,v1 不提供。

### 报损口径说明
系统未将"报损"建模为独立 movement_type。v1 以
`movement_type='adjust' AND quantity<0 AND reference_type ~ /waste|damage|报损|报废|损耗|expire/i`
识别报损;若业务侧报损记录不满足该特征,数值会偏低甚至为 0,属预期(宁可缺数,不填假数)。

---

## 6. 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v1 | 2026-08-08 | 初版口径,与 S32-B API 实现一致 |
