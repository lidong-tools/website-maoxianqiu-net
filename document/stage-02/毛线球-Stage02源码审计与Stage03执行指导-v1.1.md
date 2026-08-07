# 【毛线球】Stage 02 源码审计与 Stage 03 执行指导

> 版本：v1.1  
> 日期：2026-08-07  
> 审计对象：`website-maoxianqiu-net-main(3).zip`  
> ZIP SHA-256：`6963895186ad1f91763ef391b5003cfd2d640349345941a0043f6f5652283ebd`  
> 当前结论：**Stage 02 主体代码建设取得明显进展，但“所有工作完成”的结论不成立；必须先完成 S3.0 审计收口，再进入 Stage 03 功能扩展。**

---

## 1. 本次审计目的

本次审计不再回答“代码写了多少”，而回答三个问题：

1. Stage 02 原定 P0 工作是否真正完成；
2. DS 制定的 Stage 03 方向是否与真实源码一致；
3. 下一步应该继续补 Stage 02，还是可以直接进入新功能开发。

审计原则：

- 源码事实优先于交付说明；
- 自动化脚本存在不等于测试通过；
- UI 页面存在不等于业务闭环完成；
- service role 路由必须证明数据作用域，而不是只证明“有权限码”；
- 法规要求与行业最佳实践分开标记；
- Stage 03 不能建立在错误的“Stage 02 已完全结束”假设上。

---

# 2. 最新源码盘点

静态确认：

```text
数据库 migration：25 个
RLS 测试 SQL：10 组
Playwright spec：6 个
Hono route 文件：15 个
业务 Vue 页面：约 125 个
公共业务组件：23 个
```

最新源码相较上一轮已有明显改进：

- `/api/health` 已包含 commitSha / buildTime / environment / appVersion；
- 旧 `/api/upload` 和旧文件接口已从 API 总入口下线；
- EmployeePicker / DoctorPicker / StorePicker / AdmissionPicker 等组件已出现；
- 闭环 A/B/C E2E 文件均已出现；
- migration 25 增加库存预留有效期、FEFO 确认扣减和过期释放；
- GitHub Actions 已配置 Chromium 与 Playwright 产物上传；
- 根 AGENTS 已改为毛线球真实技术栈规范。

这些说明 Stage 02 并非失败，核心问题已经从“代码缺失”转向：

```text
授权正确性
业务 UI 完整性
事务边界
E2E 真实性
文档真实性
运行验证
```

---

# 3. Stage 02 任务重新评级

状态定义：

```text
PASS                静态实现符合要求，仍可能需要 staging 运行验证
PARTIAL             有主体实现，但存在明确未完成项
FAIL                源码存在与目标直接冲突的缺陷
INTEGRATION_PENDING 代码形态可接受，但必须在 staging 执行后才能通过
```

| 任务 | DS 当前声明 | 审计评级 | 结论 |
|---|---|---|---|
| DEV-000 基线对齐 | 完成 | PARTIAL | health 已增强，但 ZIP 无 `.git`，无法证明 ZIP / GitHub / 线上 commit 一致 |
| P0-01 scoped permission | 完成 | **FAIL** | tenant-only 权限解析会吞入 store-specific role |
| P0-02 service role 收口 | 完成 | **FAIL** | 大多数路由已改 scoped，但报表存在明确门店数据越权风险 |
| P0-03 旧文件接口下线 | 完成 | PASS | API 总入口仅保留 files-v2 |
| P0-04 Picker 补齐 | 完成 | **FAIL** | 仍存在多个正式表单手填业务 ID/UUID，且宠物新增 UI 缺失 |
| P0-05 打印真实数据 | 完成 | PARTIAL | print-data 已绑定真实 DTO，但部分类型仍要求手填 entity ID |
| P0-06 报表统一 | 完成 | **FAIL** | 已迁移 Hono 聚合，但 storeId 未进入数据过滤 |
| P0-07 消息策略 | 完成 | PASS | 退出 MVP / 未配置 Provider 禁止真实 sent 的方向正确 |
| P0-08 库存一致性 | 完成 | **FAIL / INTEGRATION_PENDING** | migration 25 方向正确，但静态发现过期预留确认逻辑缺陷 |
| P0-09 闭环 E2E | 代码完成 | PARTIAL | A/B/C 已存在且有 DB 断言，但仍允许关键 seed 缺失时 skip；主闭环顺序与产品场景不完全一致 |
| P0-10 文档/命令 | 完成 | PARTIAL | 工具和规则已补，但 IMPLEMENTATION_STATUS 与源码实际不一致 |
| 前端 lint/typecheck | P1 缺口 | **S3.0 BLOCKER** | 当前文档承认 vue-tsc 约 20 个错误；发布门禁却要求 typecheck 通过 |

因此：

> **Stage 02 不应标记为“全部完成”。最准确状态是：主体代码基本铺开，S3.0 审计收口未完成。**

---

# 4. P0 安全缺陷：scoped permission 仍存在作用域串用

文件：

```text
api/lib/permission.ts
```

关键代码约在 304～310 行：

```ts
const matched = assignments.filter((a) => {
  if (!requirement.storeId) {
    return true
  }
  return a.store_id === requirement.storeId || a.store_id === null
})
```

## 4.1 问题

当调用方只传 `tenantId`、没有传 `storeId` 时：

```text
return true
```

会把该员工在目标租户下**所有门店级 role assignment** 全部视为匹配角色。

这意味着：

```text
员工只在门店 A 是 store_manager
↓
某 tenant-level endpoint 不传 storeId
↓
A 店的 store_manager 权限被当成 tenant-wide 权限
```

这与 v0.5 要求的：

```text
user
+ tenant
+ store
+ role assignment
+ permission
```

不一致。

## 4.2 正确模型

角色分配必须明确区分：

```text
tenant-wide role
store-scoped role
```

建议：

```ts
if (!storeId) {
  // tenant 级命令只能使用明确 tenant-wide assignment
  matched = assignments.filter(a => a.store_id === null)
}
else {
  matched = assignments.filter(
    a => a.store_id === storeId || a.store_id === null,
  )
}
```

但这仍不够。

还必须验证 `store_id = null` 对应的角色本身确实允许 tenant-wide scope，而不是某个错误创建的 store role。

建议 roles 增加/严格使用：

```text
scope = system | tenant | store
is_system
```

最终匹配逻辑应同时验证：

```text
assignment.store_id
+
role.scope
+
target tenant/store
```

## 4.3 platform admin 加固

当前平台管理员主要按：

```ts
r.code === 'system_admin'
```

判断。

数据库当前 `roles.code` 全局唯一，降低了伪造风险，但服务端仍建议显式要求：

```text
code = system_admin
AND is_system = true
AND scope = system
```

做纵深防御。

---

# 5. P0 数据泄漏风险：报表 storeId 只用于授权，没有用于查询

文件：

```text
api/routes/report-data.ts
```

路由会读取：

```text
tenantId
storeId
```

并调用：

```ts
requireScopedPermission({
  code: 'reports.view',
  tenantId,
  storeId,
})
```

但后续实际数据聚合调用是：

```ts
buildRevenueRows(service, scope.tenantId, ...)
buildRefundRows(service, scope.tenantId, ...)
buildInventoryRows(service, scope.tenantId)
buildCustomerRows(service, scope.tenantId)
buildMedicalRows(service, scope.tenantId, ...)
```

没有把 `storeId` 或“允许访问的 storeIds”传入查询。

例如库存直接：

```ts
inventory_balances.eq('tenant_id', tenantId)
catalog_items.eq('tenant_id', tenantId)
warehouses.eq('tenant_id', tenantId)
```

## 5.1 后果

即使调用者只拥有门店 A 的 `reports.view`：

```text
GET report-data?...&storeId=A
```

服务端可以通过权限检查，但实际返回的是整个 tenant 的数据。

如果调用者干脆省略 `storeId`，又会叠加第 4 章的 tenant-only 角色匹配问题。

这是明确的 P0 数据隔离缺陷。

## 5.2 修复方案

提供两种模式：

### tenant-wide

仅明确拥有 tenant-wide `reports.view` 的员工可以：

```text
allowedStoreIds = all tenant stores
```

### store scoped

普通店长/财务：

```text
allowedStoreIds = scope.allowedStoreIds
```

所有 builder 必须接：

```ts
{
  tenantId,
  allowedStoreIds,
  period,
}
```

并在 SQL / Supabase query 中强制：

```text
store_id IN allowedStoreIds
```

仓库类表需要：

```text
warehouse.store_id IN allowedStoreIds
```

不得只过滤 tenant。

---

# 6. P0-04 实际仍未完成：正式页面存在大量手填 ID

源码中已经有多种 Picker，但并未真正替换完正式业务交互。

静态发现的明确输入/提示包括：

```text
inventory/transfer/index.vue
  请输入商品 ID

inventory/receipt/index.vue
  请输入商品 ID

operations/print/index.vue
  输入实体 ID
  实体 ID
  门店 ID

billing/cashier/index.vue
  宠物 ID

clinical/encounter/detail.vue
  请输入医生 ID
  医生 ID

clinical/nurse-tasks/index.vue
  请填写宠物 ID
  宠物 ID

diagnostics/lab/index.vue
  请填写客户 ID 与宠物 ID
  宠物 ID

diagnostics/vaccination/index.vue
  请填写客户 ID 与宠物 ID
  宠物 ID

inpatient/admission/index.vue
  请填写客户 ID、宠物 ID 与笼位
  宠物 ID
  主治医生 ID

inpatient/nursing/index.vue
  住院 ID
  宠物 UUID
```

列表列显示 ID 本身不是全部都属于问题，但：

> **正式业务表单要求医院员工手工输入 UUID/ID，是不可接受的产品交互。**

## 6.1 更关键的问题：没有宠物新增 UI

当前：

```text
apps/maoxianqiu/src/views/crm/
├── customer/index.vue
├── customer/detail.vue
└── pet/detail.vue
```

没有：

```text
pet/new.vue
PetFormModal
PetCreateDrawer
```

E2E A 自己也注明：

```text
宠物：API 创建（前端暂无宠物新增 UI）
```

这意味着“客户 → 宠物建档”作为医院主闭环，前端实际上没有完整实现。

## 6.2 S3.0 必修

至少实现：

```text
PetForm
PetCreateDrawer/Modal
CustomerPicker
PetPicker
CatalogItemPicker
DoctorPicker
EmployeePicker
AdmissionPicker
DiagnosticOrderPicker
StorePicker
WarehousePicker
```

所有业务表单禁止要求员工复制 UUID。

---

# 7. P0-05 打印：后端真实 DTO 已完成，但交互未完全产品化

值得肯定：

```text
GET /api/operations/print-data/:entityType/:entityId
```

已经按真实：

- invoice
- medical_record
- prescription
- lab_report
- vaccine_certificate

聚合数据，并进行 scoped authorization 与审计。

这部分方向是正确的。

但打印页面目前仍存在：

```text
lab_report / vaccine_certificate → 手填 entity ID
```

因此 P0-05 应改为：

```text
backend: PASS
frontend UX: PARTIAL
overall: PARTIAL
```

S3.0 补齐业务选择器即可，不需要推翻打印架构。

---

# 8. P0-08 库存 migration 25：发现新的静态并发/过期缺陷

文件：

```text
supabase/migrations/20260807000025_inventory_reserve_consistency.sql
```

方向正确：

- reserve 有 `reserved_until`；
- confirm 使用 FEFO；
- batch 行锁；
- reserve 流水只能 confirm/release 一次；
- 有过期批量释放。

但 `confirm_inventory_reservation()` 中存在一个重要边界。

## 8.1 当前逻辑

函数先锁当前 reserve：

```text
v_reserve
```

确认其尚未 confirm/release。

然后在同仓库、同商品中查全部过期 reserve：

```sql
movement_type = 'reserve'
reserved_until < now()
没有 confirm/release
```

这个查询**没有排除当前正在确认的 `v_reserve.id`**。

如果当前 reserve 自己已经过期：

1. 它会在 stale loop 中被写入一条 `release`；
2. quantity_reserved 被减一次；
3. 函数继续往下执行；
4. FEFO 扣批次；
5. 再执行正式 confirm；
6. quantity_reserved 再减一次；
7. 同一 reservation 可能同时出现 release + confirm，或者触发非预期负数/check error。

这是必须修复的 P0 边界。

## 8.2 正确行为

二选一：

### 推荐：过期即拒绝确认

在 confirm 一开始：

```sql
if v_reserve.reserved_until is not null
   and v_reserve.reserved_until < now()
then
  -- 原子 release 当前 reserve
  -- 返回/抛出 RESERVATION_EXPIRED
end if;
```

并且 stale query：

```sql
and m.id <> v_reserve.id
```

### 或

先全量过期释放，再重新读取当前 reservation 状态，如果已释放则禁止 confirm。

第一种更清晰。

必须增加并发测试：

```text
reserve → 到期 → confirm
reserve → 到期 → release worker 与 confirm 并发
同 reservation 双 confirm
同 reservation confirm/release 并发
两 prescription 抢最后库存
```

---

# 9. P0-09 E2E：结构已明显进步，但还不能叫“真实闭环完成”

## 9.1 已有进步

闭环 A：

- 客户；
- 宠物；
- 预约；
- 候诊；
- 就诊；
- 病历；
- 处方；
- 发药；
- 收费；
- 病历签署；
- 数据库断言。

闭环 B：

- 入库；
- 盘点；
- 调拨；
- 库存流水。

闭环 C：

- 入院；
- 护理任务；
- 换房；
- 自动计费；
- 出院。

并且大量步骤有数据库状态断言，已经不是单纯“页面能打开”的 smoke test。

## 9.2 仍有四个问题

### 问题 A：关键 seed 缺失时仍可 skip

闭环 A：

```text
没有 drug → skip
```

闭环 B：

```text
没有 drug → skip
```

闭环 C：

```text
少于 2 个可用笼位 → skip
```

对于“核心闭环”CI：

> staging seed 不完整应该是 FAIL，而不是绿色 SKIP。

正确方式：

```text
smoke tests 可以 optional
closed-loop A/B/C 不允许 optional
```

CI 预先运行固定 fixture/seed。

### 问题 B：宠物不是通过 UI 创建

A 明确写：

```text
前端暂无宠物新增 UI
```

因此 E2E 证明了数据库/API 能创建宠物，却没有证明“前台可以完成宠物建档”。

应在 S3.0 先实现宠物新增 UI，再让闭环 A 用 UI 创建宠物。

### 问题 C：主链路顺序需重新确认

当前 A：

```text
处方
→ 发药
→ 收费
```

而原产品闭环要求更接近：

```text
处方
→ 收费/支付
→ 发药
```

如果医院允许“先发药后结算”，需要明确业务规则和权限：

```text
dispense_before_payment = true/false
```

默认建议：

```text
收费项目需要支付确认后才允许正式发药
```

急诊/住院等特殊场景可由权限绕过并写审计。

E2E 应验证产品正式规则，而不是让测试本身定义业务流程。

### 问题 D：E2E 仍未实际执行

当前只有：

```text
tsc
playwright --list
```

没有 staging 的真实 PASS 证据。

因此状态只能是：

```text
code_complete
integration_pending
```

---

# 10. P0-10 文档真实性：当前实施状态文件需要回滚“全部完成”声明

`document/current/IMPLEMENTATION_STATUS.md` 目前把：

```text
DEV-000
P0-01
P0-02
P0-04
P0-06
P0-08
```

标为完成。

但本次源码审计已经证明：

- scoped permission 有作用域错误；
- report-data 有门店数据范围错误；
- 多个正式表单仍手填 ID；
- 宠物新增 UI 缺失；
- migration 25 有过期 reservation 边界；
- baseline commit 无法由 ZIP 自证。

因此 `IMPLEMENTATION_STATUS.md` 本身已经与代码不一致。

建议状态立即改为：

```text
DEV-000  integration_pending
P0-01    in_development
P0-02    in_development
P0-03    code_complete
P0-04    in_development
P0-05    in_development
P0-06    in_development
P0-07    code_complete
P0-08    in_development
P0-09    integration_pending
P0-10    in_development
```

修复并静态复审后，再转：

```text
code_complete
```

真实 staging 通过后才转：

```text
verified
```

---

# 11. 前端 typecheck 必须从 P1 提升为 S3.0 阻塞项

`KNOWN_GAPS.md` 自己记录：

```text
vue-tsc 约 20 个类型错误
pnpm lint 无法全绿
```

但 `RELEASE_CHECKLIST` 又要求：

```text
pnpm lint / typecheck / build 通过
```

这两者逻辑冲突。

如果 Stage 03 继续新增功能，只会把类型债继续放大。

因此：

> **所有当前前端 TypeScript / Vue typecheck 错误必须在 S3.0 清零。**

允许框架层经过说明的特殊类型，但 CI 必须最终绿色。

---

# 12. 基线审计限制

本 ZIP 没有 `.git`，因此本次无法确认：

```text
ZIP HEAD
GitHub main HEAD
maoxianqiu.app deployment commit
```

是否完全相同。

源码已经支持 `/api/health` 输出 commit，这是正确方向。

S3.0 必须取得以下证据之一：

```text
GitHub commit SHA + 对应 archive
git bundle
带 .git 的源码
```

并将线上 `/api/health` 的 `commitSha` 与之对齐。

---

# 13. 对 DS Stage-03 规划的总体评价

现有：

```text
document/stage-03/03-第三阶段需求方向-三案合并-v1.0.md
```

总体方向**可以继续使用**：

- 先合规/试点，再商业化；
- P0/P1/P2 分层合理；
- C 端在 P1，不阻塞当前收口；
- AI 放 P2；
- 日结对账 P0；
- 客户经营 P1；
- 真实消息渠道 P1；
- 明确不做 AI 自动诊断/开方、设备直控等。

但存在两个结构问题：

1. 错误假设 Stage 02 已经完成“基线对齐”；
2. 部分法规映射需要修正。

因此 Stage 03 v1.0 不应该废弃，而应该升级为 v1.1。

---

# 14. Stage 03 必须增加 S3.0：Stage 02 审计收口

原文：

```text
Stage 02 完成代码铺开与基线对齐
```

改为：

```text
Stage 02 已完成大规模代码铺开；
基线、安全、交互、事务和运行验证仍需通过 S3.0 收口。
```

里程碑改为：

```text
S3.0 Stage 02 Audit Closure
↓
S3.1 Pilot Ready
↓
S3.2 V1 Commercial
↓
S3.3 Scale & Differentiation
```

在 S3.0 结束前：

- 可以做 Stage 03 的数据模型/页面原型设计；
- 不建议并行大规模实施 P1 商业功能；
- 不允许把 P0 合规 migration 与尚未稳定的基础权限 migration 混在一个巨大变更中。

---

# 15. Stage 03 合规规划审计

本次对照农业农村部正式文件进行复核。

## 15.1 确认属于国家层面硬要求

### 病历

官方《动物诊疗病历管理规范》明确：

- 门（急）诊病历就诊结束后 24 小时内归档；
- 住院病历出院后 3 日内归档；
- 电子病历应保存操作人、操作时间，支持创建/修改/归档追溯；
- 病历归档后原则上不得修改，特殊修改需机构负责人批准并保留痕迹；
- 病历保存不少于 3 年。

因此这些保持 P0。

### 处方

官方《兽医处方格式及应用规范》明确：

- 执业兽医在备案单位完成签名留样/专用签章/电子签名备案后方可开方；
- 计算机开方应同时打印纸质处方；可靠电子签名可以满足相应身份认证要求；
- 处方当日有效，特殊延长最长 3 天；
- 处方一式三联；
- 麻醉药单独处方，每张不超过一日量；
- 精神药、毒性药单独处方；
- 普通处方保存 3 年以上；
- 麻醉/精神/毒性药品处方保存 5 年以上。

这些保持 P0。

### 年度活动报告

`动物诊疗机构管理办法`：

> 年度活动报告是**第三十条**，不是第二十七条。

要求：

```text
每年三月底前
向县级人民政府农业农村主管部门
报告上年度动物诊疗活动情况
```

Stage-03 §17.15 和 §17.9 必须把：

```text
管理办法 §27
```

修正为：

```text
管理办法 §30
```

### 疫情报告、隔离与废弃物

管理办法明确要求：

- 疑似/染疫时按规定报告、隔离、消毒；
- 某些依法应扑杀的疫病不得擅自治疗；
- 诊疗废弃物需要按规定处理。

作为 P0 留痕与任务能力是合理的。

### 许可证与人员备案

国家实行诊疗许可制度，且 2025 年又进一步强化：

- 2025-09-01 起全面启用新的动物诊疗许可证标准；
- 强调执业兽医应备尽备；
- 强调信息公示、处方、用药、废弃物、年度报告。

Stage 03 做许可证/备案信息管理是合理的。

---

# 16. Stage 03 合规规划中需要降级或重新表述的内容

## 16.1 “检验同人录入 + 审核必须禁止”不是已核实的全国法律硬要求

Stage-03 §17.16 依据本身写的是：

```text
行业实践
蘑菇宠医
```

这就不应该和 24h 归档、3 年保存等一起列为“P0 法规七项”。

建议：

```text
检验双人审核
→ P1 Clinical Quality
→ 租户可配置
```

可以对：

- 危急值；
- 特殊检验；
- 高风险门店；

强制双人审核。

普通检验是否要求录入人≠审核人应由医院质控政策决定。

## 16.2 “毒麻双人双锁”不能直接归因于公告 734

734 能直接支持的要求包括：

```text
麻醉药单独处方
每张不超过一日量
精神/毒性药单独处方
保存至少 5 年
```

当前查到的全国规范并没有直接证明：

```text
所有宠物医院必须用系统实现双人双锁/双签
```

因此 Stage-03 §17.13 应拆为：

### 全国法规 P0

- controlled_class；
- 独立处方；
- 麻醉药一日量限制；
- 处方保存 5 年；
- 权限、审计。

### 风险控制 / 地方合规待确认

- 双人双锁；
- 双人发药核对；
- 空瓶/安瓿回收；
- 特殊采购保管流程。

如果目标地区法规或医院 SOP 要求，再切换为强制规则。

## 16.3 疫情状态机命名需要修正

当前：

```text
detected
→ reported
→ isolated
→ resolved / customed

customed_blocked
```

`customed` 语义不清，容易直接进入数据库成为长期技术债。

建议：

```text
detected
reported
isolated
resolved
```

治疗是否禁止使用独立字段：

```text
treatment_restricted
restriction_reason
culling_required
```

不要混进主状态。

## 16.4 许可证“到期”不应在未核实证照字段时被写成唯一法规逻辑

可以建：

```text
license_no
issuing_authority
scope
issued_at
valid_from
valid_until nullable
certificate_qr
status
```

如果证书或地方规则有明确有效期，就启用到期提醒；否则不应虚构全国统一期限。

---

# 17. 修订后的 Stage 03 里程碑

## S3.0 — Stage 02 Audit Closure

目标：

> 把“代码很多”变成“基础层可信”。

必须完成：

1. 交付 commit 可证明；
2. scoped permission 修复；
3. report-data 门店作用域修复；
4. 宠物新增 UI；
5. 清理剩余手填 ID；
6. 打印选择器收尾；
7. inventory expired reservation 修复；
8. A/B/C E2E 不允许关键 fixture 缺失时 skip；
9. 闭环 A 顺序按正式业务规则重写；
10. vue-tsc/lint/build 全绿；
11. current 状态文档与源码重新对齐。

退出状态：

```text
P0-01 ~ P0-10 至少达到 code_complete
```

---

## S3.1 — Pilot Ready

目标：

> 能在 staging 真正跑通并满足首批医院试点基本合规。

优先顺序：

### S3.1-A 合规数据模型

- medical record archive/retention/amendment；
- prescription validity/retention；
- veterinarian registration/signature specimen；
- prescription triple-copy output；
- controlled drug legal minimum rules；
- institution license/personnel filing；
- epidemic report；
- waste record；
- annual report（Article 30）。

### S3.1-B 经营底线

- tenant initialization；
- daily closing；
- reconciliation；
- audit query UI；
- minimum follow-up task。

### S3.1-C 医疗闭环补强

- nurse task auto generation；
- inpatient daily progress；
- lab result → medical record reference；
- critical value confirmation；
- print templates required by pilot.

### S3.1-D Staging Gate

- migration 0→latest；
- upgrade rehearsal；
- RLS；
- role matrix；
- inventory concurrency；
- payment/refund idempotency；
- A/B/C E2E；
- compliance E2E；
- Preview。

S3.1 完成后才允许：

```text
pilot_ready
```

---

## S3.2 — V1 Commercial

保留 DS v1.0 的主方向：

- customer 360；
- merge；
- segmentation；
- churn prediction based on explainable rules；
- membership/stored value/package/points；
- coupon/referral/birthday marketing；
- C-end mini program；
- at least one real message provider；
- purchasing/supplier；
- insurance material export；
- advanced reports；
- boarding；
- medication safety rule engine。

这里的用药安全规则是：

```text
rule engine
```

不是 AI。

---

## S3.3 — Scale & Differentiation

- AI SOAP drafting；
- reliable e-signature provider；
- regulator integration；
- multi-channel messaging；
- LIS/PACS adapters；
- teleconsultation data reservation；
- data warehouse / precomputed reports；
- PDF archive/local print agent；
- supply-chain integration fields。

AI 必须：

```text
draft only
human confirm
no automatic sign
no automatic prescribe
```

---

# 18. S3.0 具体任务清单

## AUD-001 基线证明

交付：

```text
git rev-parse HEAD
GitHub commit permalink
/api/health response
ZIP SHA-256
```

四者关联。

## AUD-002 scoped permission 修复

修改：

```text
api/lib/permission.ts
supabase/tests/rls_tenant_store.sql
API permission tests
```

新增用例：

```text
A 店店长不能获取 tenant-wide reports
A 租户 admin + B 租户普通员工不能串权限
store role 不能作为 tenant-wide role
tenant-wide role 可以访问本租户允许门店
system_admin 必须为 system role
```

## AUD-003 report-data 数据范围

所有 builder 接受：

```text
allowedStoreIds
```

数据库查询层过滤。

## AUD-004 CRM 宠物建档

实现：

```text
PetForm
PetCreateDrawer/Modal
customer detail -> 新增宠物
```

E2E A 改为 UI 新建宠物。

## AUD-005 全局 Picker 清场

扫描：

```text
请输入*ID
UUID
实体 ID
商品 ID
宠物 ID
医生 ID
```

正式表单全部替换。

列表如必须显示技术 ID，应放在开发/审计详情，不作为主业务信息。

## AUD-006 打印交互收口

为：

```text
invoice
medical_record
prescription
lab_report
vaccine_certificate
```

提供业务选择器，不允许正常用户手填 entityId。

## AUD-007 inventory expiry 修复

修复：

```text
expired current reservation
release vs confirm race
double confirm
double release
```

补数据库并发测试。

## AUD-008 E2E 硬化

closed-loop A/B/C：

```text
缺 seed = FAIL
缺 warehouse = FAIL
缺 cage = FAIL
缺 drug = FAIL
```

由 staging fixture 保证环境。

不允许核心 E2E 使用 `test.skip()` 掩盖环境不完整。

## AUD-009 闭环 A 顺序确认

业务负责人二选一：

### 默认建议

```text
prescription
→ invoice
→ payment
→ dispense
```

### 允许先发药

必须增加：

```text
dispense_before_payment
permission
reason
audit
```

不能由测试代码擅自决定。

## AUD-010 类型与 CI

必须达到：

```text
pnpm lint
typecheck
build
```

全绿。

## AUD-011 文档真实性

更新：

```text
IMPLEMENTATION_STATUS
KNOWN_GAPS
RELEASE_CHECKLIST
Stage-03 v1.1
```

禁止：

```text
文件存在 = 完成
tsc 通过 = E2E 通过
```

---

# 19. Stage 03 文档修订任务

需要修改现有：

```text
document/stage-03/03-第三阶段需求方向-三案合并-v1.0.md
document/stage-03/01-产品需求说明书-PRD-v0.5-增补修订版.md
```

修订：

1. 增加 S3.0；
2. Stage 02 不再写“已完成基线对齐”；
3. 年度活动报告 `§27` 改 `§30`；
4. §17.16 从全国法规 P0 中移出；
5. 毒麻“双人双锁”标记为“地方法规/医院 SOP 待确认”；
6. 疫情状态机去掉 `customed`；
7. 许可证补 2025 新证照标准的字段预留；
8. Stage 03 P0 与 S3.0 未完成项建立依赖关系。

---

# 20. DS 下一步执行指令

```text
本轮源码审计结果不接受“Stage 02 所有任务已完成”的状态。

Stage 03 方向总体通过，但必须先增加 S3.0 — Stage 02 Audit Closure。

立即停止新增 P1/P2 商业功能，先执行：

AUD-001 基线证明
AUD-002 scoped permission
AUD-003 report-data store scope
AUD-004 宠物新增 UI
AUD-005 全局 Picker 清场
AUD-006 打印交互收口
AUD-007 inventory expiry/concurrency
AUD-008 E2E 禁止核心 skip
AUD-009 闭环 A 流程顺序确认
AUD-010 typecheck/lint/build 全绿
AUD-011 current 文档真实性修正

同时修订 Stage-03：

- 新增 S3.0；
- 年度报告法规编号修正为《动物诊疗机构管理办法》第三十条；
- 检验双人审核从全国法规硬 P0 改为可配置临床质控；
- 毒麻双人双锁标记为地方法规/医院 SOP 待确认，不得直接归因于 734 号公告；
- 疫情状态机移除 customed/customed_blocked；
- 增加 2025 新版动物诊疗许可证字段预留。

S3.0 完成后提交：
1. 最新 commit SHA；
2. diff；
3. lint/typecheck/build；
4. 更新后的 IMPLEMENTATION_STATUS；
5. Stage-03 v1.1；
6. 无手填 ID grep 结果；
7. scoped permission 单测；
8. inventory reservation 边界测试代码。

审计通过后进入 S3.1。

S3.1 先做：
合规 + tenant 初始化 + 日结对账 + 审计后台 + 最小回访，
随后进入 staging migration/RLS/E2E 门禁。

未经 staging 验证不得标记 verified/production_ready。
```

---

# 21. 最终审计结论

### Stage 02

不是失败，也不是完成。

最准确结论：

> **主体实现约 进入“代码收口”状态，但仍有至少 6 个可以仅靠源码确认的 P0 缺陷；运行验证尚未完成。**

### Stage 03

方向基本正确，但必须修改为：

```text
S3.0 修 Stage 02
→ S3.1 合规试点
→ S3.2 商业化
→ S3.3 差异化
```

而不是：

```text
直接假设 Stage 02 已结束
→ 继续铺更多功能
```

这是下一轮开发最关键的管理调整。

---

# 22. 官方合规参考

1. 农业农村部令 2022 年第 5 号《动物诊疗机构管理办法》  
   https://xmsyj.moa.gov.cn/gzdt/202209/t20220909_6408940.htm

2. 农业农村部公告第 734 号  
   https://xmsyj.moa.gov.cn/gzdt/202312/t20231214_6442774.htm

3. 农业农村部公报（公告第 734 号附件全文）  
   https://www.moa.gov.cn/nybgb/2024/202401/202401/P020240124558272374948.pdf

4. 农业农村部办公厅关于加强动物诊疗管理工作的通知（农办牧〔2025〕20号）  
   https://www.moa.gov.cn/nybgb/2025/202507/202507/P020250723554436056478.pdf
