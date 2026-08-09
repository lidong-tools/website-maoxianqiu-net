# Vercel Preview 冒烟流程（VERCEL-PREVIEW-SMOKE）

> Agent-02 交付。每次部署到 Preview 后执行，验证 Vercel 函数在真实 HTTP 层的启动与错误映射。

## 1. 前置条件

```text
- 已完成 vercel build（打包通过）
- Preview 部署 URL 可用（vercel 输出中获取，形如 https://<project>-<hash>.vercel.app）
- 本地 Node >= 22（脚本依赖全局 fetch）
```

## 2. 执行

```bash
pnpm exec tsx scripts/release-smoke.ts --base https://<PREVIEW_URL>
```

可选参数：

```bash
--base <url>   目标 URL（也可用环境变量 VERIFY_BASE_URL）
--out <path>   指定结果文件；默认保存到 document/deployment/smoke-results/<时间戳>.json
```

## 3. 断言明细

| # | 请求 | 期望 | 含义 |
|---|---|---|---|
| 1 | `GET /api/health` | 200 | 函数启动、liveness 存活 |
| 2 | `GET /api/me/context`（无 token） | 401 | 鉴权中间件生效，而非 500/崩溃 |
| 3 | `OPTIONS /api/me/context` | 非 5xx | 预检不导致函数失败 |
| 4 | `GET /api/me/context`（错误 `X-Tenant-Id`） | 4xx | 错误上下文被正确拒绝，而非函数启动失败 |
| 5 | `GET /api/not-exist-route` | 404 | 统一错误映射生效 |

## 4. 结果记录

每个 case 记录：

```text
HTTP status
x-request-id（响应头）
response body 摘要（截断 200 字符，防敏感信息）
```

报告整体记录：

```text
deployment URL
commit SHA（来自 /api/health data.commitSha）
开始/结束时间
通过数 / 总数
```

示例输出文件：`document/deployment/smoke-results/<时间戳>.json`

## 5. 失败时的排查路径

| 现象 | 排查方向 |
|---|---|
| case 1 非 200 | ESM import 回归 → `check-api-esm`；函数打包缺依赖 → `vercel build` 产物检查 |
| case 2/4 返回 500 | 鉴权链路异常；`api/[[...route]]` 迁移残留；环境变量缺失导致 service client 初始化失败 |
| case 3 返回 5xx | CORS/OPTIONS 处理异常；中间件顺序问题 |
| case 5 非 404 | notFound 处理被覆盖；rewrite 规则漂移 |

## 6. Production 部署后

Production 部署完成后必须重复执行一次本冒烟（`--base <PROD_URL>`），并核对：
`VERCEL_ENV=production`、commit SHA 与发布提交一致、外部 Provider 为生产凭据。
