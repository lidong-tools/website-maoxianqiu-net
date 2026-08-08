> 项目：毛线球宠物医院 SaaS  
> 基线代码：`website-maoxianqiu-net-main (9)`  
> 阶段：Stage-03 / S3.1 并发加速开发  
> 原则：**一个文件只能有一个写入 Owner；跨域修改必须通过 Handoff，由最终 Integrator 处理。**  
> E2E：当前独立执行，本批任务不得修改 `e2e/**`，也不以 E2E 完成作为本批开发验收条件。  

# 00 — 多 Agent 并发开发总编排 v2

## 1. 本轮目标

在不破坏当前 Stage-03 收口工作的前提下，同时推进：

1. 上一轮源码审计中的 P0 真实性修复；
2. 六个后续产品模块；
3. 各业务域 UI / API / DB 的完整闭环；
4. 最终由一个独立 Agent 做集成、冲突处理、源码复审和收尾。

本轮新增模块：

| Agent | 当前收口域 | 新需求 |
|---|---|---|
| Agent-01 | IAM / Tenant-Store Context | 平台租户管理 + 门店详情 |
| Agent-02 | Billing / Settings / Approval | 会员等级 + 折扣规则 + 积分产品化 |
| Agent-03 | Clinical / Diagnostics | 影像工作流 |
| Agent-04 | CRM | 客户回访任务 |
| Agent-05 | Inventory | 供应商 + 采购订单 |
| Agent-06 | Inpatient | 寄养 |
| Agent-07 | 不开发新业务 | 最终集成与收尾审计 |

**同时写生产代码的 Agent 最多 6 个。Agent-07 最后启动。**

---

# 2. 并发拓扑

```text
                 BASE_COMMIT
                     │
 ┌────────┬────────┬────────┬────────┬────────┬────────┐
 │        │        │        │        │        │
 A01      A02      A03      A04      A05      A06
 IAM      财务     医疗     CRM      库存     住院
 +平台    +会员    +影像    +回访    +采购    +寄养
 │        │        │        │        │        │
 └────────┴────────┴────────┴────────┴────────┴────────┘
                     │
                     ▼
            Agent-07 Integrator
                     │
              Build / Typecheck
                     │
               Source Review
                     │
             Integration Release
```

E2E 继续作为外部独立线：

```text
E2E Agent
   │
   └── 只跟随集成分支，不参与本批业务代码所有权
```

---

# 3. 分支约定

所有 Agent 必须从**完全相同 BASE_COMMIT**创建分支：

```text
parallel-v2/01-platform-context
parallel-v2/02-finance-membership
parallel-v2/03-clinical-imaging
parallel-v2/04-crm-followups
parallel-v2/05-inventory-purchasing
parallel-v2/06-inpatient-boarding
parallel-v2/07-final-integration
```

禁止：

```text
Agent A 从 Agent B 未合并分支继续开发
```

否则失去并发隔离意义。

---

# 4. 文件所有权总表

## Agent-01

```text
api/routes/user.ts
api/routes/tenants.ts
api/routes/stores.ts

apps/maoxianqiu/src/store/modules/app/account.ts
apps/maoxianqiu/src/store/modules/app/tenant.ts
apps/maoxianqiu/src/components/*Context*
apps/maoxianqiu/src/components/AppAccountButton/**
apps/maoxianqiu/src/components/AppAccountForm/**
apps/maoxianqiu/src/views/auth/**
apps/maoxianqiu/src/views/system/tenants/**
apps/maoxianqiu/src/views/system/store/**
apps/maoxianqiu/src/router/modules/system.ts
```

## Agent-02

```text
api/routes/billing.ts
api/routes/settings.ts
api/routes/approvals.ts
api/routes/operations.ts       # 仅会员/积分段

apps/maoxianqiu/src/views/billing/**
apps/maoxianqiu/src/views/system/settings/**
apps/maoxianqiu/src/views/operations/approvals/**
apps/maoxianqiu/src/views/operations/memberships/**
apps/maoxianqiu/src/router/modules/billing.ts
apps/maoxianqiu/src/router/modules/operations.ts
apps/maoxianqiu/src/api/modules/operations.ts
apps/maoxianqiu/src/types/operations.ts
```

## Agent-03

```text
api/routes/clinical.ts
api/routes/diagnostics.ts
api/routes/compliance.ts       # 仅病历冲突/医疗修订

apps/maoxianqiu/src/views/clinical/**
apps/maoxianqiu/src/views/diagnostics/**
apps/maoxianqiu/src/router/modules/clinical.ts
apps/maoxianqiu/src/router/modules/diagnostics.ts
apps/maoxianqiu/src/api/modules/clinical.ts
apps/maoxianqiu/src/api/modules/diagnostics.ts
apps/maoxianqiu/src/types/clinical.ts
apps/maoxianqiu/src/types/diagnostics.ts
```

## Agent-04

```text
api/routes/customers.ts
api/routes/pets.ts

apps/maoxianqiu/src/views/crm/**
apps/maoxianqiu/src/router/modules/crm.ts
apps/maoxianqiu/src/api/modules/customer*
apps/maoxianqiu/src/types/customer*
apps/maoxianqiu/src/components/followups/**
```

## Agent-05

```text
api/routes/inventory.ts

apps/maoxianqiu/src/views/inventory/**
apps/maoxianqiu/src/router/modules/inventory.ts
apps/maoxianqiu/src/api/modules/inventory*
apps/maoxianqiu/src/types/inventory*
apps/maoxianqiu/src/components/purchasing/**
```

## Agent-06

```text
api/routes/inpatient.ts

apps/maoxianqiu/src/views/inpatient/**
apps/maoxianqiu/src/router/modules/inpatient.ts
apps/maoxianqiu/src/api/modules/inpatient*
apps/maoxianqiu/src/types/inpatient*
apps/maoxianqiu/src/components/boarding/**
```

## Agent-07 独占共享文件

```text
api/index.ts
apps/maoxianqiu/src/router/routes.ts

document/current/IMPLEMENTATION_STATUS.md
document/current/KNOWN_GAPS.md

共享 generated types / 全局 manifests / 最终文档
```

---

# 5. 严禁多人同时修改的文件

开发 Agent 01–06 默认**禁止修改**：

```text
api/index.ts
apps/maoxianqiu/src/router/routes.ts
document/current/IMPLEMENTATION_STATUS.md
document/current/KNOWN_GAPS.md
e2e/**
```

如果新业务必须修改这些文件：

```text
不要直接改
↓
写入自己的 HANDOFF 文档
↓
Agent-07 最终统一修改
```

---

# 6. Migration 编号锁

当前代码最新 Migration：

```text
20260809000053_encounter_version_lock.sql
```

本批固定预留：

| Agent | 允许使用 |
|---|---|
| Agent-01 | `20260810000054` – `20260810000055` |
| Agent-02 | `20260810000056` – `20260810000058` |
| Agent-03 | `20260810000059` – `20260810000061` |
| Agent-04 | `20260810000062` – `20260810000064` |
| Agent-05 | `20260810000065` – `20260810000069` |
| Agent-06 | `20260810000070` – `20260810000073` |
| Agent-07 | `20260810000090` – `20260810000099`（仅集成修复） |

禁止使用他人编号。

禁止编辑历史 Migration。

---

# 7. 跨域依赖处理规则

## 7.1 禁止直接跨域改代码

例如 Agent-04 回访希望：

```text
住院出院自动生成回访
```

Agent-04 不得修改：

```text
api/routes/inpatient.ts
```

而是提交：

```text
HANDOFF:
source = discharge
trigger = finalized
desired command = create followup
payload = ...
```

由 Agent-07 或对应 Owner 集成。

---

# 8. 本轮跨域 Hook 清单

预计存在：

```text
会员 → Cashier 价格计算
影像 → Clinical Workbench 快捷申请
回访 → Encounter / Discharge 生成任务
采购 → Inventory Posted
寄养 → Billing / Catalog Boarding Item
平台租户 → Global Context
```

其中同 Agent 域内可以自己实现。

跨 Agent 的部分必须用 Handoff。

---

# 9. 数据模型设计要求

所有新表必须：

```text
tenant_id
store_id（门店级业务时）
created_at
必要 updated_at
业务状态
合理索引
RLS
```

敏感 Command：

```text
Frontend
↓
Hono
↓
RPC / Transaction
↓
DB
↓
Audit
```

禁止为了开发快重新采用：

```text
浏览器直接 update 高风险业务表
```

---

# 10. 新模块产品边界

## 平台租户

做：

```text
租户列表
详情
试用信息
停用/恢复
门店钻取
```

不做：

```text
SaaS 套餐计费
自动续费
复杂订阅
```

## 会员

做：

```text
等级
折扣规则
客户会员
积分
收费折扣接入
```

暂不做：

```text
完整储值钱包
复杂套餐/次卡
优惠券
```

## 影像

做：

```text
申请
执行
附件
报告
审核
发布
```

不做：

```text
DICOM PACS
影像阅片工作站
设备协议集成
```

## 回访

做：

```text
任务
负责人
计划时间
状态
结果
下一次回访
```

不做：

```text
AI 外呼
自动营销
复杂流失预测
```

## 采购

做：

```text
供应商
采购单
提交
审核
收货/过账
库存联动
```

暂不做：

```text
复杂采购申请预算
应付账款
供应商结算
```

## 寄养

做：

```text
入住
房位
饮食/遛宠/用药要求
每日记录
额外服务
离店
```

不做：

```text
C 端寄养预订
复杂动态定价
```

---

# 11. 每个 Agent 必须提供 HANDOFF

路径：

```text
document/parallel-handoff/
```

命名：

```text
AGENT-01-HANDOFF.md
...
AGENT-06-HANDOFF.md
```

内容：

```text
Base Commit
Branch
Commits
修改文件
Migration
新增权限
新增 API
新增 Route
跨域 Hook
未完成项
风险
验证证据
```

---

# 12. Agent 完成定义

每个 Agent 完成不等于“页面做出来”。

必须：

```text
[ ] FE 完成
[ ] API 完成
[ ] DB 完成（需要时）
[ ] RLS / Permission 完成
[ ] Command 有审计
[ ] 状态机合法
[ ] 空态/失败态完成
[ ] 1280/1440 桌面可用
[ ] Dark Mode 不明显破损
[ ] Typecheck
[ ] Build
[ ] Handoff 完成
```

本轮**不要求 Agent 自己完成 E2E**。

---

# 13. 合并顺序

Agent-07 按以下顺序集成：

```text
01 IAM / Platform
↓
02 Finance / Membership
↓
04 CRM / Followup
↓
05 Inventory / Purchasing
↓
06 Inpatient / Boarding
↓
03 Clinical / Imaging
```

Clinical 最后合并的原因：

```text
医疗域改动面最大
```

可减少其它分支处理共享 UI/类型时的冲突。

---

# 14. 冲突原则

遇到冲突：

```text
不按“谁最后提交”决定
```

Agent-07 必须：

1. 理解两个功能目的；
2. 保留两边正确业务行为；
3. 不因 merge 简单删除逻辑；
4. 重新跑 typecheck/build；
5. 把决策写入 `FINAL-INTEGRATION-REPORT.md`。

---

# 15. 禁止事项

1. 不得改 `e2e/**` 让测试“适配”新代码；
2. 不得删除现有 P0 安全检查；
3. 不得恢复 service_role 浏览器访问；
4. 不得跨 Agent 修改他人业务文件；
5. 不得新建重复 Customer/Pet/Tenant 模型；
6. 不得为新模块复制一套权限解析；
7. 不得编辑历史 Migration；
8. 不得直接在 `IMPLEMENTATION_STATUS` 宣称完成；
9. 不得引入 PACS、AI、营销自动化扩大范围；
10. 不得因为并发速度牺牲审计和租户隔离。

---

# 16. 最终目标

本批结束后，系统应该从：

```text
核心医疗 SaaS + 若干模块底座
```

推进为：

```text
核心医疗 SaaS
+
平台管理
+
会员运营
+
影像
+
回访
+
采购
+
寄养
```

同时保持上一轮 UI / 权限 / 合规方向不回退。
