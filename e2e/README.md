# 毛线球宠物医院 SaaS — E2E 测试

基于 [Playwright](https://playwright.dev/) 的端到端测试,覆盖**登录流程**、**核心业务页面冒烟**与**核心业务流程(工作台 / CRM / Billing / 创建客户闭环)**。

## 目录结构

```text
e2e/
├── playwright.config.ts   # Playwright 配置(webServer 自动启动前端,baseURL 读取 .env.development)
├── tsconfig.json          # 测试脚本专用 TS 配置(独立于应用自身 tsconfig)
├── helpers/
│   ├── auth.ts            # 登录辅助工具(凭据读取 / UI 登录)
│   └── browser.ts         # Chromium 浏览器可用性检测(缺失时 skip)
└── tests/
    ├── login.spec.ts      # 登录页渲染 + 真实 Supabase 登录流程
    ├── smoke.spec.ts      # 主导航菜单渲染 + 客户宠物/目录价目/收费收银冒烟
    └── core-flow.spec.ts  # 核心业务流程(工作台/CRM 数据行/Billing/创建客户闭环)
```

## 前置条件

1. **Node.js ≥ 22** 与 pnpm(仓库使用 pnpm workspace,`packageManager: pnpm@11.18.0`)
2. 已安装依赖(仓库根目录执行 `pnpm install`,`@playwright/test` 已加入根 `package.json` devDependencies)
3. **Supabase 环境可用**:前端通过浏览器 anon key 直连 Supabase(配置在 `apps/maoxianqiu/.env.development`),
   登录与业务数据接口均依赖 Supabase。请确保 Supabase 项目在线且已执行过 `supabase/seed.sql` 初始化数据。

## 浏览器安装

首次运行需安装 Chromium 浏览器内核(约 190 MiB)。

```bash
# 方式一:官方源(国内网络可能超时/失败)
pnpm exec playwright install chromium

# 方式二:国内镜像源(推荐,官方源失败时使用)
# PowerShell
$env:PLAYWRIGHT_DOWNLOAD_HOST='https://npmmirror.com/mirrors/playwright/'
pnpm exec playwright install chromium
```

> **已知网络限制**:`cdn.playwright.dev` 官方下载源在本机网络环境不可达(下载长时间停滞在 0% 后失败)。
> 使用 npmmirror 镜像可正常完成下载。若两种方式均失败,测试用例会自动跳过
> (见下方「降级策略」),不影响 `--list` 收集与 CI 通过。

## 环境变量配置

测试通过环境变量读取真实登录凭据,未配置时**登录流程与冒烟/核心流程测试自动跳过**(登录页渲染测试仍会执行)。

| 变量名 | 必填 | 说明 |
| --- | --- | --- |
| `E2E_USERNAME` | 登录流程/冒烟/核心流程必填 | Supabase Auth 登录邮箱(建议使用管理员账号,以拥有各业务模块权限) |
| `E2E_PASSWORD` | 登录流程/冒烟/核心流程必填 | 对应密码 |
| `E2E_BASE_URL` | 可选 | 覆盖前端基地址,默认读取 `apps/maoxianqiu/.env.development` 后回退到 `http://localhost:9000` |

配置方式(任选):

```bash
# PowerShell
$env:E2E_USERNAME = "admin@example.com"
$env:E2E_PASSWORD = "your-password"

# 或复制 .env 文件
# 仓库根目录创建 .env.local(已被 .gitignore 忽略),内容:
# E2E_USERNAME=admin@example.com
# E2E_PASSWORD=your-password
```

> 注意:playwright.config.ts 已把 `apps/maoxianqiu/.env.development` 中的 `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`
> 等注入 `process.env`,测试运行前无需手动复制 Supabase 配置。

## 运行测试

```bash
# 在 e2e/ 目录下执行(推荐)
cd e2e
pnpm exec playwright test

# 或从仓库根目录执行
pnpm --dir e2e exec playwright test

# 只运行某个测试文件
pnpm exec playwright test tests/smoke.spec.ts

# 列出全部用例(不启动浏览器与 dev server,可用于 CI 快速校验)
pnpm exec playwright test --list

# 打开 HTML 报告(失败用例截图/追踪)
pnpm exec playwright show-report
```

> 注:若 pnpm 提示 `ERR_PNPM_VERIFY_DEPS_BEFORE_RUN`(enableGlobalVirtualStore 等 pnpm 设置校验),多为本地 pnpm 环境配置与 node_modules 记录不一致所致,先运行 `pnpm install` 重新校验;仍失败时可临时用
> `node ../node_modules/@playwright/test/cli.js test ...` 绕过 pnpm 直接运行。
> 另:本机环境变量 `CI=true` 时 `reuseExistingServer` 会关闭,端口 9000 已有 dev server 将导致报错,可临时 `$env:CI=''` 后运行。

## 工作原理

- **webServer 自动启停**:`playwright.config.ts` 中的 `webServer` 会执行
  `pnpm --filter @fantastic-admin/maoxianqiu dev -- --port 9000 --strictPort` 拉起 Vite 开发服务器,
  测试结束后自动关闭;本地开发时若 9000 端口已有 dev server,默认复用(`reuseExistingServer: true`)。
- **hash 路由**:应用默认 `routeMode: 'hash'`,页面地址形如 `http://localhost:9000/#/crm/customer`,
  测试断言与导航均使用 `/#/xxx` 形式。
- **登录态**:冒烟/核心流程测试依赖真实登录态。每个用例独立浏览器上下文,通过 UI 表单登录
  (Supabase `signInWithPassword`),未配置凭据时整组 `test.skip`。
- **降级策略**:`helpers/browser.ts` 检测 Chromium 内核是否安装,缺失时整组 `test.skip`;
  凭据缺失时同样 `test.skip`。两条保护保证用例可被 `--list` 识别,且在无浏览器/无凭据的
  CI 环境中不会失败。

## 用例说明

| 文件 | 用例 | 依赖 |
| --- | --- | --- |
| `login.spec.ts` | 登录页渲染(欢迎语/表单/按钮) | 无 |
| `login.spec.ts` | 登录流程并进入工作台 | `E2E_USERNAME` / `E2E_PASSWORD` |
| `smoke.spec.ts` | 主导航九大模块菜单渲染 | 登录凭据(管理员账号) |
| `smoke.spec.ts` | CRM 客户列表页可达(`/#/crm/customer`) | 登录凭据 + `customer.view` 权限 |
| `smoke.spec.ts` | Catalog 目录管理页可达(`/#/catalog`) | 登录凭据 + `catalog.view` 权限 |
| `smoke.spec.ts` | Billing 发票列表页可达(`/#/billing/invoices`) | 登录凭据 + `invoice.view` 权限 |
| `smoke.spec.ts` | Billing 收银工作台可达(`/#/billing/cashier`) | 登录凭据 + `invoice.create` 权限 |
| `core-flow.spec.ts` | 登录后工作台关键元素(标题/欢迎语/指标卡片) | 登录凭据 |
| `core-flow.spec.ts` | CRM 客户列表表格渲染出数据行 | 登录凭据 + 测试租户存在客户数据(seed) |
| `core-flow.spec.ts` | Billing 发票列表页冒烟(标题/表头/表格容器) | 登录凭据 + `invoice.view` 权限 |
| `core-flow.spec.ts` | 端到端:创建客户 → 列表出现该客户 | 登录凭据 + 远程 Supabase 测试租户可写(`customer.create`) |

## 注意事项

- 本项目为纯新增测试,未改动 `apps/maoxianqiu/src`、`apps/api` 与 `supabase/tests/*.sql`。
- 测试账号需具备对应模块权限码,否则页面会渲染「无权访问」导致断言失败。
- 「创建客户」用例会在测试租户中写入一条 `E2E客户-<时间戳>` 数据(每次运行新增一条,供后续运行搜索断言)。
- 运行结果产物输出到 `e2e/test-results/` 与 `e2e/playwright-report/`(均已忽略)。
