> 项目：毛线球宠物医院 SaaS  
> 基线代码：`website-maoxianqiu-net-main (9)`  
> 阶段：Stage-03 / S3.1 并发加速开发  
> 原则：**一个文件只能有一个写入 Owner；跨域修改必须通过 Handoff，由最终 Integrator 处理。**  
> E2E：当前独立执行，本批任务不得修改 `e2e/**`，也不以 E2E 完成作为本批开发验收条件。  

# Agent-06 — Inpatient + 新需求：寄养

## 1. 目标

在现有住院系统之外新增“寄养”，但遵守 PRD：

```text
寄养与住院共享房态能力
医疗住院记录与普通寄养权限必须区分
```

因此：

```text
共享 rooms / cages
```

但：

```text
不复用 admissions 伪装寄养
```

推荐建立独立 Boarding Domain。

---

# 2. Ownership

```text
api/routes/inpatient.ts

apps/maoxianqiu/src/views/inpatient/**
apps/maoxianqiu/src/router/modules/inpatient.ts
apps/maoxianqiu/src/api/modules/inpatient*
apps/maoxianqiu/src/types/inpatient*
apps/maoxianqiu/src/components/boarding/**
```

Migration：

```text
20260810000070_*
20260810000071_*
20260810000072_*
20260810000073_*
```

---

# 3. 禁止

```text
api/index.ts
router/routes.ts

billing/**
settings/**
crm/**
clinical/**
diagnostics/**
inventory/**
e2e/**
```

---

# 4. 先修房间类型

现有 `rooms.room_type`：

```text
ward
icu
isolation
standard
```

PRD 需要：

```text
boarding
```

Agent-06 可在 Migration 70：

```text
扩展 room_type check
```

禁止重建 rooms 表。

---

# 5. Boarding 数据模型

建议：

```text
boarding_stays
boarding_daily_records
boarding_service_charges
```

---

# 6. boarding_stays

字段：

```text
id
tenant_id
store_id
boarding_no
customer_id
pet_id
cage_id

check_in_at
expected_check_out_at
checked_out_at

status

diet_notes
walking_notes
medication_notes
vaccine_verified
risk_acknowledged
emergency_contact

created_by
created_at
updated_at
```

状态：

```text
planned
→ checked_in
→ in_service
→ checkout_pending
→ checked_out

planned
→ cancelled
```

---

# 7. 房位锁

寄养入住必须与住院使用**同一个 cages.status/current occupation 事实来源**。

不能：

```text
住院认为 A03 空闲
寄养认为 A03 也空闲
```

必须使用：

```text
SELECT FOR UPDATE
```

与现有入院 RPC 相同的并发原则。

---

# 8. current_admission_id 问题

当前 cages 只有：

```text
current_admission_id
```

寄养不能硬塞 boarding_stay_id 到这个字段。

推荐升级：

```text
occupancy_type
occupancy_id
```

或者新增统一：

```text
cage_occupancies
```

## 推荐方案

考虑当前住院代码已经大量依赖：

```text
current_admission_id
```

本轮为了降低回归：

新增：

```text
current_boarding_stay_id
```

并增加约束：

```text
不能 admission + boarding 同时占用
```

后续再统一 Occupancy Model。

---

# 9. 每日记录

`boarding_daily_records`：

```text
boarding_stay_id
record_date
feeding
walking
medication
condition
note
recorded_by
created_at
```

寄养记录不是医疗病程。

不要写到：

```text
inpatient_progress_notes
```

---

# 10. 额外服务

`boarding_service_charges`：

```text
boarding_stay_id
catalog_item_id
description
quantity
unit_price
amount
created_at
```

Catalog 使用：

```text
type=boarding
```

本 Agent 不修改 Catalog 模型。

如果需要新服务：

```text
管理员先在 Catalog 创建 boarding item
```

---

# 11. Billing 跨域

本 Agent 只负责：

```text
计算/记录寄养应收明细
```

不直接修改 Billing。

Checkout 时需要生成 Invoice：

```text
写 Handoff 给 Agent-07
```

集成策略：

```text
Boarding Checkout
→ Billing 创建 Invoice
→ 成功
→ Boarding checked_out
```

具体事务边界由最终 Integrator 复核。

---

# 12. UI

新增：

```text
/inpatient/boarding
```

内部：

```text
房态
当前寄养
预约入住
历史
```

入住 Drawer：

```text
宠物/主人
时间
笼位
饮食
遛宠
用药
疫苗
风险确认
紧急联系人
```

---

# 13. 当前寄养详情

```text
Summary Header
宠物
主人
笼位
入住时长
预计离店
风险

Tabs
每日记录
服务消费
入住要求
时间线
```

---

# 14. Permission

必须与医疗住院分开：

```text
boarding.view
boarding.manage
boarding.care
boarding.checkout
```

只有拥有寄养权限的员工可操作。

不要复用：

```text
inpatient.admit
```

作为寄养权限。

---

# 15. Audit

必须：

```text
check-in
change cage
record
add charge
checkout
cancel
```

---

# 16. 不做

```text
C 端预约
宠物主人在线查看视频
自动动态定价
套餐次卡
智能房位推荐
```

---

# 17. 验收

```text
[ ] boarding room type
[ ] 入住
[ ] 房位锁
[ ] 住院/寄养不能双占
[ ] 日常记录
[ ] 饮食/遛宠/用药要求
[ ] 额外服务
[ ] 离店
[ ] Permission 与医疗住院分离
[ ] Audit
[ ] 原住院流程不回归
[ ] Typecheck
[ ] Build
```

---

# 18. Handoff

```text
document/parallel-handoff/AGENT-06-HANDOFF.md
```

必须注明：

```text
Cage Occupancy 兼容策略
Billing Checkout Hook
Catalog Boarding Item Contract
```
