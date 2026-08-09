# Stage-04 发布前预检（Release Preflight）

> Agent-02（Production Deployment & Release Guard）交付。
> 目标：每次发布前自动发现 ESM import 回归、Vercel 函数打包问题、环境变量缺失、`/api/health` 启动失败、protected route 500、preview 与 production 配置漂移。

## 1. 预检流水线

```text
1. ESM 回归检查        pnpm exec tsx scripts/check-api-esm.ts
2. API TypeScript Gate pnpm exec tsc --noEmit -p api/tsconfig.json
3. Vercel 打包         vercel build
4. 环境变量预检        pnpm exec tsx scripts/release-preflight.ts --strict --env-file api/.env.local
5. 冒烟测试            pnpm exec tsx scripts/release-smoke.ts --base <PREVIEW_URL>
```

任何一步失败即**停止发布**（Fail Fast）。

## 2. ESM 回归检查（check-api-esm）

当前 main 的 ESM 策略（Source13 之后已修复，禁止回退）：

```text
根 package.json : "type": "module"
api/tsconfig.json: module = moduleResolution = NodeNext
```

- 扫描 `api/**/*.ts`（`--include-scripts` 追加 `scripts/*.ts`）。
- 规则：相对导入（`./`、`../` 开头）必须带显式 `.js` 扩展名；禁止引用 `.ts` 源文件。
- 忽略：`node:*`、npm 包、框架子路径（`hono/vercel` 等）。
- 任一失败 → exit 1。
- `--fix` 可对缺扩展名的相对导入做机械修复（不处理 `.ts` 引用，需人工）。

## 3. TypeScript Gate

`api/tsconfig.json` 必须保持 NodeNext + strict。**禁止**因"bundler 更容易 typecheck"而恢复旧配置。

## 4. Vercel Function Packaging

- 当前 main 采用固定函数入口 `api/index.ts`，`vercel.json` 将 `/api/:path*` rewrite 到 `/api?path=:path*`。
- `api/health.ts` 是独立轻量 liveness（不加载 DB/存储/业务路由）。
- 构建后确认产物包含 `api/lib/*`、`api/routes/*`、`api/services/*`，而不是只有入口 JS。

## 5. 环境变量预检（release-preflight）

- 只检查"是否已配置"，不打印值（防 Secret 泄漏）。
- 必填缺失在 `--strict` 下直接失败。
- 详见 `ENVIRONMENT-MATRIX.md`。

## 6. 冒烟测试（release-smoke）

对部署 URL 验证：

```text
GET  /api/health                     → 200（函数存活）
GET  /api/me/context（无 token）      → 401 UNAUTHORIZED（而非 500）
OPTIONS /api/me/context              → 非 5xx
GET  /api/me/context（错误 tenant）   → 4xx（而非函数启动失败）
GET  /api/not-exist-route            → 404 NOT_FOUND
```

结果（HTTP status / request id / body 摘要 / deployment URL / commit SHA）保存至
`document/deployment/smoke-results/<timestamp>.json`。

## 7. 环境差异（Preview vs Production）

| 维度 | Preview | Production |
|---|---|---|
| `VERCEL_ENV` | `preview` | `production` |
| `VERCEL_GIT_COMMIT_SHA` | 预览提交 SHA | 发布提交 SHA |
| 外部 Provider（Messaging/R2） | 可用沙箱/测试凭据 | 生产凭据 |

在 Preview 验证通过后，Production 部署后仍需执行一次完整 preflight + smoke。

## 8. 禁止项

```text
- 重新修改业务数据模型
- 为部署方便关闭 strict typecheck
- 用 experimental flag 掩盖 ESM import
- 把所有代码打成一个巨大单文件绕过架构
- 在 Health / 日志 / 文档中泄露 key
```
