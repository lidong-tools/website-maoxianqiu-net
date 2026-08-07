# 毛线球 — 宠物医院 SaaS 管理系统

## 项目概述

毛线球（Maoxianqiu）是一套面向宠物医院的 SaaS 管理系统，覆盖客户、宠物、预约候诊、诊疗核心（病历/处方/发药）、收费收银、库存、住院、疫苗检验、运营报表的完整业务闭环。

## 技术栈（必须严格遵守）

- **前端框架**: Vue 3.5.40 + TypeScript + Vite 8
- **UI 体系**: Fantastic Admin + Reka UI + UnoCSS（原子化 CSS）
  - **不得新增 Element Plus 依赖**；表格/表单优先使用内建组件与 vxe-table/vxe-pc-ui
- **状态管理**: Pinia + pinia-plugin-persistedstate
- **路由**: Vue Router 5（应用采用 hash 路由，页面地址形如 `/#/xxx`）
- **后端 API**: Hono 4（Edge-first TypeScript 框架），业务 Command 必须走 Hono + PostgreSQL RPC
- **数据库 / 认证**: Supabase（PostgreSQL + RLS + RPC）
  - service role 路由必须做 scoped authorization（`requireScopedPermission` 按租户+门店解析作用域）
- **文件存储**: Cloudflare R2（私有签名 URL）
- **包管理器**: pnpm（必须使用 pnpm，禁止使用 npm/yarn）
- **HTTP**: Axios
- **E2E 测试**: Playwright（e2e/ 目录，真实闭环断言数据库状态）

## 目录结构

采用 pnpm monorepo 架构：

```text
├── apps/
│   └── maoxianqiu/           # 毛线球前端应用
│       └── src/
│           ├── api/          # API 请求模块（查询可浏览器直连 Supabase；命令走 Hono）
│           ├── components/   # 全局业务组件
│           ├── composables/  # 组合式函数
│           ├── layouts/      # 布局组件
│           ├── router/       # 路由配置
│           ├── store/        # Pinia store
│           ├── types/        # TypeScript 类型定义
│           ├── utils/        # 工具函数
│           └── views/        # 页面视图（按业务模块组织）
├── api/                      # Hono 后端 API（lib/ 工具、middlewares/、routes/ 领域路由）
├── supabase/                 # migration / seed / tests
├── e2e/                      # Playwright E2E（helpers/ 辅助、tests/ 用例）
├── document/                 # 需求 / 设计 / 实施状态文档
├── scripts/                  # 工程脚本
└── pnpm-workspace.yaml       # monorepo workspace 配置
```

## 常用命令

```bash
pnpm install            # 安装依赖
pnpm dev                # 启动开发服务器
pnpm build              # 构建生产版本
pnpm lint               # 运行全量 lint（tsc + eslint + stylelint）
pnpm test:e2e           # 运行 Playwright 端到端测试
pnpm test:e2e:ui        # 打开 Playwright UI 模式
pnpm test:e2e:report    # 打开 Playwright HTML 报告
pnpm db:push            # 推送 Supabase migration
pnpm db:new-migration   # 新建 migration 文件
pnpm db:reset           # 重置本地 Supabase 数据库
```

## 开发规范（硬性要求）

- 使用 `<script setup lang="ts">` 语法
- 样式优先使用 UnoCSS 原子类，复杂样式用 SCSS
- 组件命名使用 PascalCase，文件名与组件名一致
- 代码添加函数级注释（业务意图清晰，禁止"后续补"字样）
- 业务 Command（创建/更新/过账/状态流转）必须走 Hono + PostgreSQL RPC
  - 禁止前端直连 Supabase 修改余额/状态等关键数据（查询读取除外，由 RLS 兜底）
- 关键写操作必须带幂等键（`idempotency-key` Header 或 body.idempotencyKey），RPC 内 SELECT FOR UPDATE 防并发
- service role 路由必须 `requireScopedPermission` 做 scoped authorization，禁止裸 service client 直查
- 浏览器不得负责大规模跨表聚合（报表统一走 Hono `/operations/report-data`）
- **不可把 example / 演示页面视为产品功能**；页面与接口须对应真实业务数据
- E2E 采用真实闭环（UI + Hono API + Supabase REST 断言），而非仅页面出现冒烟

## 注意事项

- 框架内建组件在 `packages/components/` 子包中，优先使用内建组件而非第三方组件或自定义实现
- 在任何情况下都请勿直接修改内建组件，确定修改前需要和用户进行确认
- Mock 数据使用 `vite-plugin-fake-server`，文件放在 `apps/maoxianqiu/src/api/modules/` 对应模块旁
- 代码提交前会自动运行 lint-staged，确保代码符合规范
- Node.js 版本要求以根目录下 `package.json` 中定义的为准

## 反复修改检测

在使用任何 fa-* 系列技能时，如果用户针对同一功能点已经要求修改 3 次及以上仍未达到预期（例如连续说"不对"、"再改改"、"还是不行"），必须触发 fa-feedback 技能，询问用户是否将问题反馈给框架作者。
