# Agent-02 — Production Deployment & Release Guard 深度执行指导

## 0. 重要前提

用户已确认：

```text
Vercel Node ESM /api/health ERR_MODULE_NOT_FOUND
已经修复
```

Source13 中仍能看到旧状态：

```text
package.json: type=module
api/tsconfig.json: moduleResolution=bundler
```

因此你必须遵守：

```text
当前 main > Source13
```

**先读当前 main 的 ESM 修复，再做防回归。禁止把 Source13 配置恢复回去。**

---

# 1. 你的目标

不是新增业务，也不是“再修一次 ESM”。

你要建立：

```text
每次发布前自动发现：
- ESM import 回归
- Vercel function 打包问题
- 环境变量缺失
- /api/health 启动失败
- protected route 500
- preview 与 production 配置漂移
```

---

# 2. Source13 调研锚点

阅读：

```text
package.json
api/index.ts
api/[[...route]].ts（当前 main）
api/tsconfig.json（当前 main）
vercel.json
api/lib/supabase.ts
api/lib/r2.ts
api/services/messaging/config.ts
gate-api-tsc.log
gate-vue-tsc.log
gate-vite-build.log
```

`api/index.ts` 的 `/api/health` 已包含：

```text
uptime
commitSha
buildTime
environment
appVersion
```

不要创建第二个 Health API。

---

# 3. Ownership

你独占：

```text
api/tsconfig.json
api/[[...route]].ts
vercel.json
scripts/check-api-esm.ts
scripts/release-preflight.ts
scripts/release-smoke.ts
document/deployment/**
```

对 `api/**/*.ts`：

```text
只允许机械式 import specifier 修复/检查
```

禁止顺手重构：

```text
billing
clinical
inventory
messaging business logic
```

---

# 4. ESM Regression Checker

建立：

```text
scripts/check-api-esm.ts
```

扫描：

```text
api/**/*.ts
```

规则：

### Relative import

在 NodeNext 运行策略下必须符合当前 main 已验证方式，例如：

```ts
from './x.js'
from '../x.js'
```

禁止重新出现生产 Node 无法解析的：

```ts
from './x'
```

### 忽略

```text
type package import
node:*
npm package
alias 若 runtime 已明确支持
```

输出必须包含：

```text
file
line
specifier
reason
```

有一个失败：

```text
exit 1
```

---

# 5. TypeScript Gate

读取当前 main `api/tsconfig.json`。

如果现在已经是：

```text
NodeNext
```

必须保持。

不得因为：

```text
bundler 更容易 typecheck
```

就恢复。

执行：

```bash
pnpm exec tsc --noEmit -p api/tsconfig.json
```

---

# 6. Vercel Function Packaging Gate

用官方 Vercel build/dev 实际验证。

至少：

```text
vercel build
```

或项目当前 CI 对应命令。

检查产物：

```text
api/[[...route]]
api/index
api/lib/*
api/routes/*
api/services/*
```

确认不是只有入口 JS，而依赖 TS/JS 未被 bundle/copy。

---

# 7. Smoke Test

Preview 环境至少：

```text
GET /api/health
→ 200

GET 受保护 API
→ 401（无 token）
而不是 500

OPTIONS
→ 正常

带错误 tenant
→ 4xx
而不是函数启动失败
```

把：

```text
HTTP status
request id
response body 摘要
deployment URL
commit SHA
```

保存。

---

# 8. Environment Preflight

建立环境变量清单，不记录值。

分类：

## API Core

```text
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
```

## R2

```text
R2_ACCOUNT_ID
R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY
R2_BUCKET_NAME
```

## Messaging

按当前 Provider：

```text
SENDGRID_API_KEY / provider-specific
from address
```

## App/Deploy

```text
VERCEL_ENV
VERCEL_GIT_COMMIT_SHA
```

Stage04 后新增：

```text
PDF renderer
signature provider
SMS/Wechat
```

必须由对应 Agent Handoff 声明，你负责加入 Release Check。

禁止：

```text
把 Secret 写进 repo
把 server secret 变成 VITE_*
```

---

# 9. Fail Fast

生产启动时关键 Server Env 缺失，应在实际调用前明确报配置错误。

但：

```text
/api/health
```

是否需要所有外部 Provider 都可用，应区分：

```text
liveness
readiness
```

建议：

```text
/api/health = process alive
/api/health/readiness 或 health detail = dependencies
```

若不增加新 API，也可以 health 输出：

```text
dependencies: configured/not_configured
```

但不返回 secret。

---

# 10. Release Gate 文档

输出：

```text
document/deployment/STAGE04-RELEASE-PREFLIGHT.md
document/deployment/VERCEL-PREVIEW-SMOKE.md
document/deployment/ENVIRONMENT-MATRIX.md
document/deployment/ROLLBACK-RUNBOOK.md
```

Rollback 至少写：

```text
上一 Deployment
DB migration 是否 backward compatible
是否可只回滚 app
Provider 配置回滚
```

---

# 11. 禁止项

```text
重新改业务数据模型
为部署方便关闭 strict typecheck
使用 experimental flag 掩盖 ESM import
把所有代码打成一个巨大单文件绕过架构
在 Health 中泄露 key
```

---

# 12. Agent Handoff

必须记录：

```text
CURRENT_MAIN_ESM_STRATEGY
SOURCE13_DIFFERENCE
VERCEL_RUNTIME
NODE_VERSION
CHECK_SCRIPT
TYPECHECK_RESULT
BUILD_RESULT
PREVIEW_HEALTH
PROTECTED_ROUTE_SMOKE
ENV_REQUIRED
KNOWN_GAPS
```

---

# 13. 完成条件

```text
API Typecheck PASS
ESM Checker PASS
Vercel Build PASS
Preview /api/health 200
Protected route 不 500
Release preflight 可自动失败
```

完成后：

```text
STATUS = code_complete
```

Runtime production smoke 由发布流程继续验证。

---

# 14. Commit

```text
chore(stage04-02): harden production release and api runtime guard
```
