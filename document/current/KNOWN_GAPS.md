# 已知缺口（KNOWN_GAPS）

> 本文件记录当前已知的技术债、未验证项与后续待办，随交付持续更新。缺口按严重程度分级：P0（阻断发布）、P1（发布后尽快修复）、P2（优化）。

## P1 — 发布后尽快修复

### P1-04 打印能力项未补齐
依据 v0.5 第 1088-1094 行，以下打印项仍为待办：
- Puppeteer/Chromium 生成 PDF；
- PDF 存档到 R2；
- 电子签名；
- 打印模板版本号；
- 打印模板编辑器。

### P1-05 example 源码隔离
- example 路由未注册，方向正确；但演示代码仍与应用同仓。
- 建议：将演示代码移动到独立 app，或 production build 排除，避免业务 Agent 搜索时误用演示页面。

## P2 — 优化项

- **E2E 本地降级**：Playwright Chromium 官方源在本机网络不可达，需使用 npmmirror 镜像安装（见 `e2e/README.md`）。
- **e2e 无独立 package.json**：e2e 直接复用根目录 `@playwright/test`，运行须从仓库根目录或 `pnpm --dir e2e exec`（README 已说明）。

## 未验证项（须 staging 环境验证）

| 项目 | 说明 | 关联 |
| --- | --- | --- |
| migration 空库/旧库升级 | 仅本地开发库验证，未做空库从 0 到 25 及旧库升级演练 | P0-08 migration 25 |
| RLS / RPC 全量验证 | supabase/tests 未在 staging 执行（含新增 rls_inventory_reserve.sql） | DEV-000 / AUD-007 |
| 并发 / 幂等 / 回滚 | reserve/confirm、admit/transfer/discharge 等并发场景未实测 | P0-08 / inpatient |
| 闭环 A/B/C 真实执行 | 代码与 tsc 通过，未在真实环境跑通 | P0-09 |
| 多角色授权矩阵 | 仅 system_admin 实测，store_manager / doctor / nurse 未逐角色验证 | P0-01/P0-02 |
| R2 文件签名下载 | 新文件模型仅在开发环境验证 | P0-03 |
| 报表口径核对 | report-data 聚合结果与账目核对未做 | P0-06 |

## 已关闭缺口

| 缺口 | 状态 | 关闭说明 |
| --- | --- | --- |
| 浏览器跨表聚合报表 | ✅ 已关闭 | P0-06 统一到 Hono report-data |
| 库存 confirm 不扣批次 / 无过期释放 | ✅ 已关闭 | P0-08 migration 25 |
| 处方发药只转状态不扣库存 | ✅ 已关闭 | P0-08 clinical.ts |
| 发票/处方取消不释放预留 | ✅ 已关闭 | P0-08 billing.ts |
| 根 package.json 缺 test:e2e 脚本 | ✅ 已关闭 | P0-10 |
| AGENTS.md 技术栈过时 | ✅ 已关闭 | P0-10 重写为毛线球规则 |
| 前端 vue-tsc 遗留类型错误 | ✅ 已关闭 | S3.0 AUD-010：`vue-tsc -b` 全绿 |
| scoped permission 作用域串用 | ✅ 已关闭 | S3.0 AUD-002：区分 tenant-wide / store-scoped 分配，`allowedStoreIds` 收敛 |
| report-data 报表数据越权 | ✅ 已关闭 | S3.0 AUD-003：5 类报表按门店集合查询层强制过滤 |
| 过期预留确认缺陷（自身过期不拒 + stale loop 自释放） | ✅ 已关闭 | S3.0 AUD-007：RESERVATION_EXPIRED + 排除当前 id，附回归测试 |
| 正式表单手填 UUID / 误导性「XX ID」标签 | ✅ 已关闭 | S3.0 AUD-005：业务 Picker 全覆盖 |
| 打印实体 ID 手填（lab_report/vaccine_certificate） | ✅ 已关闭 | S3.0 AUD-006：DiagnosticOrderPicker 收口 |
| 核心 E2E 缺 seed 静默 skip | ✅ 已关闭 | S3.0 AUD-008：缺 seed = FAIL |
| 闭环 A 先发药后收费（测试擅自决定） | ✅ 已关闭 | S3.0 AUD-009：按默认建议 prescription → invoice → payment → dispense |
