# 07 — E2E HANDOFF

> S3.1 并行批次 → 独立 E2E Agent 的交接说明(Agent-07)

## 原则

- 本批开发按约定**不修改 `e2e/**` 断言来迁就生产代码**;E2E 独立执行。
- 本 Integrator 未改任何 `e2e/**` 文件。

## 生产行为变更(可能影响既有/新增 E2E 断言)

| 变更 | 影响 |
| --- | --- |
| 平台租户管理(`/system/tenants`,仅 platform_admin) | 新页面;需 platform_admin 会话 seed 才能进入。租户列表含停用租户 |
| 租户停用/恢复(`POST /tenants/:id/suspend|resume`) | 停用后该租户所有业务 Command 返回 403;浏览器直连路径被 RLS 拦截。若 E2E 需构造「停用租户」场景,建议直接在 seed/测试前置中以 service_role 调用 RPC |
| 门店详情页(`/system/store/:id`) | 新页面;从门店列表「查看」进入 |
| 病历随访日期 → 自动生成回访 | 填 followUpDate 后 followup_tasks 出现 post_visit 任务(去重)。E2E 若断言回访列表需注意 |
| 出院 → 自动生成回访 | discharge 成功后生成 post_discharge 任务 |
| 寄养离店 → Billing Invoice | boarding_checkout 现在会创建 invoice;若 E2E 断言寄养离店后发票数,应计入此发票 |
| 全局搜索(`/search`,P0-29) | 新聚合入口,search.global 权限 |

## 建议新增 E2E(Loop 级)

- Loop D(平台租户):platform_admin 登录 → 租户列表/详情 → 停用/恢复。
- Loop G(寄养闭环):book → check-in → 每日记录 → prepare_checkout → checkout(断言发票生成 + 笼位释放)。
- Loop H(回访):病历填随访日期 → followup 列表出现 post_visit;出院 → 出现 post_discharge。
- Loop I(采购闭环):supplier → PO draft → submit → approve → receive → post(断言库存余额/流水)。

## 既有 E2E 变更状态

工作区中 `e2e/tests/closed-loop-{a,b,c}.spec.ts` 存在未提交改动(独立 E2E 线在途)。本 Integrator **不评价、不提交**这些改动,交由 E2E Agent 决定。
