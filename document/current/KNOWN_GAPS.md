# 已知缺口（KNOWN_GAPS）

> 本文件记录当前已知的技术债、未验证项与后续待办，随交付持续更新。缺口按严重程度分级：P0（阻断发布）、P1（发布后尽快修复）、P2（优化）。

## P1 — 发布后尽快修复

### P1-01 前端 vue-tsc 遗留类型错误（reports/index.vue 等）
- 现象：`npx vue-tsc -b` 报约 20 个 TS2307 相关错误（受增量缓存影响，改用 `--noEmit -p apps/maoxianqiu/tsconfig.app.json` 验证）。
- 说明：`views/operations/reports/index.vue` 存在既有类型错误，属 P0-06 之前的存量问题，非报表统一改造引入。
- 影响：前端 `pnpm lint`（vue-tsc -b）无法全绿。
- 建议：单独任务修复 reports/index.vue 及关联类型定义。

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
| RLS / RPC 全量验证 | supabase/tests 未在 staging 执行 | DEV-000 |
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
