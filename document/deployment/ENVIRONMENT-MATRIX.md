# 环境变量矩阵（ENVIRONMENT-MATRIX）

> Agent-02 交付。记录变量名、用途、必填性、适用环境，**不记录任何值**。
> 来源：当前 main 源码实际读取的 `process.env`（`api/lib/supabase.ts`、`api/lib/r2.ts`、`api/services/messaging/config.ts`、`api/index.ts`）。

## 1. API Core

| 变量 | 必填 | 用途 | 来源 |
|---|---|---|---|
| `SUPABASE_URL` | 是 | Supabase 项目 URL | `api/lib/supabase.ts` |
| `SUPABASE_ANON_KEY` | 是 | 用户客户端（服务端透传） | `api/lib/supabase.ts` |
| `SUPABASE_SERVICE_ROLE_KEY` | 是 | 服务端 service role，**禁止 VITE_\* 暴露** | `api/lib/supabase.ts` |

## 2. Cloudflare R2

| 变量 | 必填 | 用途 | 来源 |
|---|---|---|---|
| `R2_ACCOUNT_ID` | 是 | R2 账户 ID（endpoint 拼接） | `api/lib/r2.ts` |
| `R2_ACCESS_KEY_ID` | 是 | R2 API 令牌 | `api/lib/r2.ts` |
| `R2_SECRET_ACCESS_KEY` | 是 | R2 密钥，**禁止 VITE_\* 暴露** | `api/lib/r2.ts` |
| `R2_BUCKET_NAME` | 是 | 私有桶名（上传/下载/归档/删除） | `api/lib/r2.ts` |
| `R2_PUBLIC_URL` | 否 | 公开访问前缀（可选） | `api/lib/r2.ts` |
| `R2_KEY_ENV` | 否 | object key 环境段，默认 `prod` | `api/lib/r2.ts` |

## 3. Messaging

| 变量 | 必填 | 用途 | 来源 |
|---|---|---|---|
| `MESSAGING_PROVIDER` | 否 | `email`/`mock`，未配置回退 mock | `api/services/messaging/config.ts` |
| `MESSAGING_API_KEY` | 否* | Email Provider API Key（仅服务端） | 同上 |
| `MESSAGING_SENDER` | 否* | Email 发件人 | 同上 |
| `MESSAGING_API_URL` | 否 | 默认 SendGrid v3 | 同上 |

\* 生产环境若需要真实邮件发送，`MESSAGING_API_KEY` + `MESSAGING_SENDER` 必须同时配置。

## 4. Deploy / App

| 变量 | 必填 | 用途 | 来源 |
|---|---|---|---|
| `VERCEL_ENV` | Vercel 自动 | `preview`/`production` | `api/index.ts` |
| `VERCEL_GIT_COMMIT_SHA` | Vercel 自动 | `/api/health` 的 commitSha | `api/index.ts` |
| `NODE_ENV` | 否 | 本地运行时环境兜底 | `api/index.ts` |

## 5. Stage04 待声明（PENDING）

以下类别的具体变量**尚未声明**，待对应业务 Agent Handoff 确认后由 Agent-02 纳入
`release-preflight` 必填清单与 `RELEASE_CHECKLIST`。

| 类别 | 占位 | 负责 Agent | 状态 |
|---|---|---|---|
| PDF 渲染 | `PDF_RENDERER_*` | Agent-06 | PENDING |
| 电子签名 | `SIGNATURE_PROVIDER_*` | Agent-06 | PENDING |
| 短信渠道 | `SMS_*` | Agent-08 | PENDING |
| 微信渠道 | `WECHAT_*` | Agent-08 | PENDING |
| 其他（储值/营销/采购） | 待 Handoff | Agent-03/05/07 | PENDING |

## 6. 安全规则

```text
- 不在 repo 提交任何 Secret（.env.local 已被 .gitignore 忽略）
- Server 端 Secret 绝不使用 VITE_* 前缀（否则会打进浏览器 bundle）
- 预检脚本只输出"是否已配置"，不打印值
- /api/health 只输出 dependencies 配置状态，不返回任何 Secret
```
