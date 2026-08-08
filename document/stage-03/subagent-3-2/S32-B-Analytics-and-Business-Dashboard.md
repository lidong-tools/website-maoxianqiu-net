> 项目：毛线球宠物医院 SaaS  
> 阶段：Stage-03 / S3.2 并发功能开发  
> 基线：在 S3.1 Fix Pipeline 仍独立执行的前提下，从当前稳定 Main/Base Commit 创建本批 Feature 分支。  
> 核心原则：**S3.2 Agent 不得修改 S3.1 Fix 正在修复的 IAM、Billing 核心、Clinical 核心、Inventory 核心安全边界。**  
> E2E：继续独立运行。本批 Agent 不修改 `e2e/**`。  
> 文件 Ownership：一个生产文件只能有一个写入 Owner；跨域需求只能写 Handoff，不得直接修改其他 Agent 所属文件。  

# S32-B — 经营报表与驾驶舱

## 1. 目标

开发：

```text
医院经营驾驶舱
+
收入分析
+
客户分析
+
医疗运营
+
库存分析
```

本 Agent 默认只读，不修改交易状态。

---

# 2. Ownership

```text
api/routes/analytics.ts
api/services/analytics/**
apps/maoxianqiu/src/views/analytics/**
apps/maoxianqiu/src/api/modules/analytics*
apps/maoxianqiu/src/types/analytics*
apps/maoxianqiu/src/components/analytics/**
```

Migration：

```text
104–107
```

只允许：

```text
View
Index
Materialized View（确有必要）
```

禁止：

```text
修改 Billing/Clinical/Inventory 交易表业务结构
```

---

# 3. 页面

新增分析域：

```text
/analytics/dashboard
/analytics/revenue
/analytics/customers
/analytics/clinical
/analytics/inventory
```

不要继续塞进：

```text
operations/reports
```

---

# 4. Dashboard

第一版 KPI：

```text
今日收入
本月收入
今日门诊
本月新增客户
平均客单价
退款金额
住院收入
寄养收入
会员贡献
低库存
近效期
```

---

# 5. Revenue

维度：

```text
日期
门店
支付渠道
Catalog Type
医生（如能可靠归因）
```

指标：

```text
Gross Revenue
Refund
Net Revenue
Invoice Count
Average Ticket
```

---

# 6. Customer

指标：

```text
新增客户
活跃客户
复诊客户
复诊率
客户消费分层
会员客户贡献
```

复诊率定义必须写在页面 Tooltip 和文档里。

不能：

```text
开发者自己猜一个算法
```

---

# 7. Clinical

第一版：

```text
预约数
到店率
No-show
接诊数
完成病历
检验单量
影像单量
住院量
```

不做：

```text
医疗质量评分
医生诊疗优劣排名
```

避免错误激励。

---

# 8. Inventory

指标：

```text
库存 SKU
库存价值
低库存
近效期
报损
采购金额
库存异动
```

如果当前无法可靠计算：

```text
库存周转
```

不要先显示假的数字。

---

# 9. API

```http
GET /api/analytics/dashboard
GET /api/analytics/revenue
GET /api/analytics/customers
GET /api/analytics/clinical
GET /api/analytics/inventory
```

统一 Query：

```text
tenantId
storeId
startAt
endAt
groupBy
```

---

# 10. Authorization vs Context

默认：

```text
Current Store
```

如果用户拥有 Tenant Scope，并主动切换：

```text
全院
```

才可汇总全部门店。

不得：

```text
因为用户能看全 Tenant
→ 默认 Dashboard 就混所有门店
```

---

# 11. 时区

日期切片必须：

```text
Store Timezone
↓
Tenant Timezone
```

尤其：

```text
today
daily revenue
closing
```

不能用 Server UTC 直接切天。

---

# 12. 性能

第一版优先：

```text
SQL Aggregation
+
合适 Index
```

不要引入：

```text
ClickHouse
BigQuery
Elastic
OLAP Engine
```

只有 Explain / Runtime 明确慢才加 Materialized View。

---

# 13. 图表

允许：

```text
折线
柱状
堆叠
Donut（少量）
```

必须保留：

```text
数值表
```

不能只给 Chart 不给明细。

---

# 14. 数据准确性

每个 KPI 必须有：

```text
Definition
Source Table
Filter
Aggregation
Timezone
Exclusions
```

生成：

```text
document/analytics/KPI-DEFINITIONS.md
```

---

# 15. Permission

建议：

```text
analytics.view.store
analytics.view.tenant
analytics.export
```

不要把所有人都默认开放收入数据。

---

# 16. 导出

第一版支持：

```text
CSV
```

Excel 可后续。

Export 必须：

```text
Permission
Audit
```

---

# 17. 不做

```text
AI 总结
AI 预测
复杂同比预测
财务会计报表
利润表
现金流量表
```

---

# 18. 验收

```text
[ ] Dashboard
[ ] Revenue
[ ] Customer
[ ] Clinical
[ ] Inventory
[ ] Store Scope
[ ] Tenant Scope
[ ] Timezone
[ ] KPI Definition
[ ] CSV
[ ] Permission
[ ] Audit Export
[ ] 1280/1440/1920
[ ] Typecheck
[ ] Build
```

---

# 19. Handoff

```text
document/s32-handoff/S32-B-HANDOFF.md
```

重点：

```text
KPI Definitions
Required Indexes
Permission
Route Registration
```
