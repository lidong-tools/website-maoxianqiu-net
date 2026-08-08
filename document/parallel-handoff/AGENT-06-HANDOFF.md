> 项目：毛线球宠物医院 SaaS
> Agent-06：Inpatient + 寄养（Boarding）
> 阶段：Stage-03 / S3.1 并发加速开发

# AGENT-06-HANDOFF

## 基本信息

```text
Base Commit : d32e862a(main 起始 HEAD);开发期间 main 已被其他 Agent 提交推进(当前 HEAD c8ffa3a5)
Branch      : 无独立分支。所有 Agent 共享同一工作区,直接在 main 工作区开发(按 Owner 约定隔离文件)
Commits     : 未提交(本批按"减少 commit"原则计划一次性提交本 Agent 改动)
状态        : FE / API / DB / RLS / Permission / Audit / 状态机 完成
```

## 修改文件

```text
api/lib/service-rpc-manifest.ts                          # 追加 9 个 boarding RPC 名(共享 manifest,增量)
api/routes/inpatient.ts                                  # 追加 boarding 命令/查询端点 + mapRpcError 错误码

apps/maoxianqiu/src/router/modules/inpatient.ts          # 追加 /inpatient/boarding 路由(auth: boarding.view)

apps/maoxianqiu/src/types/inpatient-boarding.ts          # 新增:Boarding 领域类型 + 状态机 + 标签映射
apps/maoxianqiu/src/api/modules/inpatient-boarding.ts    # 新增:Boarding API 模块(查询 + Hono Command)
apps/maoxianqiu/src/views/inpatient/boarding/index.vue   # 新增:寄养页面(房态/当前寄养/预约入住/历史 + 入住/详情 Drawer)
```

## Migration

```text
supabase/migrations/20260810000070_boarding_cage_type_and_permissions.sql
supabase/migrations/20260810000071_boarding_stays.sql
supabase/migrations/20260810000072_boarding_daily_records.sql
supabase/migrations/20260810000073_boarding_service_charges.sql
```

### 70 — 房型/笼位/权限

```text
- rooms.room_type 扩展加入 'boarding'(drop + recreate check constraint)
- cages 新增 current_boarding_stay_id + 单占用约束 cages_single_occupancy_check
  (禁止 current_admission_id 与 current_boarding_stay_id 同时非空)
- 新增权限码 boarding.view / manage / care / checkout
- 角色授权:system_admin / tenant_owner / store_manager 全部;
  nurse = view + care;doctor = view;cashier = view + checkout
- 同步 roles.permissions 数组(兼容旧代码读取)
```

### 71 — boarding_stays + 生命周期 RPC

```text
- boarding_stays 表(含状态机 check 约束 + RLS + updated_at 触发器)
- 状态机:planned → checked_in → in_service → checkout_pending → checked_out;
          planned → cancelled
- RPC(security definer,仅 service_role):
  boarding_generate_no / boarding_book_stay / boarding_check_in /
  boarding_cancel / boarding_change_cage
- 房位锁:check_in / change_cage SELECT FOR UPDATE 锁 cages 行,
  校验 status='available',与住院共用 cages 占用事实来源,禁止双占
- 幂等:check_in / change_cage / checkout 走 idempotency_records
```

### 72 — 每日照护记录

```text
- boarding_daily_records 表(同 stay+date 唯一,upsert)+ RLS
- RPC:boarding_record_daily(权限 boarding.care)
- 寄养记录不是医疗病程,不写入 inpatient_progress_notes
```

### 73 — 额外服务费 + 离店 RPC + 房态视图

```text
- boarding_service_charges 表 + RLS
- RPC:boarding_add_charge / boarding_prepare_checkout / boarding_checkout
- prepare_checkout:计算应收(笼位日费×天数 + 服务费)→ checkout_pending(不释放笼位)
- checkout:→ checked_out,释放笼位,写 total_charge(幂等)
- 视图 boarding_cage_status(共享 cages/rooms,关联当前寄养单)
```

## 新增权限

```text
boarding.view      查看寄养
boarding.manage    管理寄养(预约/入住/换笼位/加服务费)
boarding.care      寄养照护(每日记录)
boarding.checkout  寄养离店
```

与医疗住院权限( inpatient.admit 等 )完全分离。

## 新增 API(均在 /inpatient 下,已有路由挂载,无需改 api/index.ts)

```text
GET  /inpatient/boarding                    列表(storeId/status 过滤)   boarding.view
GET  /inpatient/boarding/cages/status       寄养房态视图                 boarding.view
GET  /inpatient/boarding/:id                详情                         boarding.view
GET  /inpatient/boarding/:id/daily-records  每日记录                     boarding.view
GET  /inpatient/boarding/:id/service-charges 服务费                      boarding.view
POST /inpatient/boarding/book               预约(planned,不锁笼位)       boarding.manage
POST /inpatient/boarding/check-in           入住(锁笼位;支持直接入住/确认预约) boarding.manage
POST /inpatient/boarding/:id/cancel         取消预约                     boarding.manage
POST /inpatient/boarding/:id/change-cage    换笼位                       boarding.manage
POST /inpatient/boarding/:id/daily-records  记录每日照护                 boarding.care
POST /inpatient/boarding/:id/service-charges 追加服务费                  boarding.manage
POST /inpatient/boarding/:id/checkout/prepare 准备离店                  boarding.checkout
POST /inpatient/boarding/:id/checkout       完成离店(释放笼位)           boarding.checkout
```

## 新增 Route

```text
/inpatient/boarding  →  views/inpatient/boarding/index.vue
(meta.auth = boarding.view,图标 i-ri:paw-print-line)
```

## 跨域 Hook(需 Agent-07 / Owner 处理)

### 1. Billing Invoice(Agent-07 集成)

```text
source = boarding_checkout
trigger = boarding_prepare_checkout 成功(状态 → checkout_pending)
desired = 在 boarding_prepare_checkout 与 boarding_checkout 之间创建 Billing Invoice
payload = stayId / boardingNo / totalCharge / stayDays / dailyAmount / serviceAmount /
          customerId / petId / storeId / tenantId / serviceCharges 明细
事务边界建议:
  Boarding Checkout → Billing create_invoice → 成功 → boarding_checkout(checked_out + 释放笼位)
当前实现:boarding_checkout 直接汇总应收并释放笼位,未调用 billing.create_invoice;
Agent-07 可在此处接入(勿改现有 inpatient.admit 等住院 RPC)。
```

### 2. Catalog Boarding Item 契约

```text
boarding_service_charges.catalog_item_id 引用 catalog type=boarding 的目录项(管理员先在 Catalog 创建)。
本 Agent 未修改 Catalog 模型 / billing 收费折扣接入。
```

### 3. Cage Occupancy 兼容策略

```text
本轮为降低住院回归,新增 cages.current_boarding_stay_id 而非统一 Occupancy Model;
新增 cages_single_occupancy_check 约束禁止双占。
住院侧 RPC(admit_patient/transfer_cage/discharge_patient)未改动:
它们已要求 cages.status='available',寄养占用后 status='occupied' 即被拦截,足够防双占。
后续可统一迁移到 cage_occupancies。
```

## 未完成项

```text
[ ] Billing Invoice 生成(Agent-07,见跨域 Hook 1)
[ ] E2E(本批约定:不要求 Agent 自测 E2E,也不修改 e2e/**)
[ ] boarding 房态页与住院房态看板合并展示(可选,当前分离)
```

## 风险

```text
1. 其他 Agent 在途未提交文件导致全量 typecheck / rpc-manifest 暂时性红
   (如 Agent-04 followups 2 处、Agent-05 purchase_order manifest),非本 Agent 引起;
   本 Agent 文件均已通过。
2. migration 70~73 尚未在真实 DB 应用验证,SQL 经人工复核与既有模式对齐;
   建议集成时以 supabase db push / reset 实测一遍。
3. 共享 main 工作区:其他 Agent 提交不会覆盖未提交改动,但需注意提交前 `git add` 只加自己的文件。
```

## 验证证据

```text
[OK] api typecheck:api/routes/inpatient.ts / service-rpc-manifest.ts 0 错误
[OK] frontend vue-tsc:inpatient-boarding.ts / inpatient-boarding.ts / boarding/index.vue 0 错误
[OK] check:rpc-manifest:boarding 全部 RPC 纳入 manifest 且命中 migrations revoke 清单
[OK] 前端 vite build(见集成时复跑)
```
