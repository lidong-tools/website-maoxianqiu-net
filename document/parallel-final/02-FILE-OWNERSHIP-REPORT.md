# 02 — FILE OWNERSHIP REPORT

> S3.1 并发文件 Owner 审计(Agent-07)
> 原则:一个文件只能有一个写入 Owner;跨域修改必须通过 Handoff,由最终 Integrator 处理。

## 1. 审计结论

各 Agent 文件写入基本符合 Owner 约定。发现并处理的越权/共享文件:

| 文件 | 处理 |
| --- | --- |
| `api/lib/service-rpc-manifest.ts` | 共享 manifest,Agent-01/02/03/05/06 增量追加各自 RPC 名(允许);Integrator 补 9 个缺失登记 |
| `api/index.ts` | Agent-07 专属。已注册 `me`/`search`/`stores`/`tenants`/`user` 等全部路由,无需再改 |
| `api/lib/permission.ts` | Agent-01 收口域(未显式列出但属 P0 IAM 工作);Integrator 复核未越权 |
| `api/lib/followup.ts` | Integrator 新增(跨域内部 Command) |
| `apps/maoxianqiu/src/views/system/permissions.ts` | 共享权限清单,各 Agent 应增量追加;Integrator 补齐缺失码 |
| `e2e/**` | 独立 E2E 线,本批不改(见 07-E2E-HANDOFF) |

## 2. 各 Agent 实际写入域(与 Handoff 一致)

- **Agent-01**:`api/routes/{user,tenants,stores}.ts`、`api/lib/{me-context,permission}.ts`、`api/routes/me.ts`、`store/modules/app/{account,tenant}.ts`、`views/auth/**`、`views/system/{tenants,store}/**`、`router/modules/system.ts`、`migration 54`
- **Agent-02**:`api/routes/{billing,settings,approvals,operations}.ts`、`views/billing/**`、`views/system/settings/**`、`views/operations/{approvals,memberships}/**`、`router/modules/{billing,operations}.ts`、`migration 56/57`、P0 迁移 09054-56
- **Agent-03**:`api/routes/{clinical,diagnostics}.ts`、`views/clinical/**`、`views/diagnostics/**`、`router/modules/{clinical,diagnostics}.ts`、`types/*`、`migration 59~61`
- **Agent-04**:`api/routes/{customers,pets}.ts`、`api/routes/search.ts`、`views/crm/**`、`views/crm/followups/**`、`components/followups/**`、`router/modules/crm.ts`、`migration 62/63`、`migration 09057(search 权限)`
- **Agent-05**:`api/routes/inventory.ts`、`views/inventory/**`、`router/modules/inventory.ts`、`types/inventory*`、`components/purchasing/**`、`migration 65~69`
- **Agent-06**:`api/routes/inpatient.ts`、`views/inpatient/**`(含 boarding)、`router/modules/inpatient.ts`、`types/inpatient-boarding*`、`api/modules/inpatient-boarding*`、`migration 70~73`

## 3. 越权检查

未发现某 Agent 越权修改他人独占业务文件的情况。跨域集成(寄养→计费、病历/出院→回访)由 Integrator 在既定集成点完成,未触碰各域既有 RPC 状态机。
