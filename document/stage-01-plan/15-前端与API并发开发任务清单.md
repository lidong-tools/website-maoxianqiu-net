# 【毛线球】前端与 API 并发执行规范

> 版本：v0.4  
> 任务编号以 `10-DS并发任务清单.md` 为唯一来源。

## 1. 任务卡模板

```text
任务 ID：
标题：
目标：
前置任务：
允许修改目录：
禁止修改目录：
数据表/视图：
API：
UI 路由：
权限码：
状态转换：
输入类型：
输出类型：
错误码：
测试：
验收截图：
Preview URL：
已知限制：
```

## 2. UI Agent 边界

允许：

- 自己领域的 views/components/composables；
- 已确认的 API client；
- 页面状态和交互；
- 单元组件测试。

禁止：

- 修改 migration；
- 绕过 API 直接完成库存/支付事务；
- 自行改变接口字段；
- 新建重复基础组件；
- 修改公共 router 总入口，除非被明确分配。

## 3. API Agent 边界

允许：

- 自己领域 Hono route/schema/service；
- Query/Command 契约；
- 调用已确认 RPC；
- API 测试。

禁止：

- 自行改变产品状态机；
- 返回 `any`；
- 所有错误都返回 200；
- 在 route 文件中堆积完整业务；
- 使用 service role 绕过未经审计的权限边界。

## 4. DB/RLS Agent 边界

允许：

- migration；
- function/RPC；
- RLS；
- seed/test fixture；
- generated type 更新。

禁止：

- 直接改历史 migration（除非尚未应用并由 DS确认）；
- 仅建表不建 RLS；
- 用 service role 测试代替 anon/authenticated RLS 测试；
- 未定义幂等约束即实现过账。

## 5. 公共文件所有权

以下文件默认只由 Foundation Agent 修改：

```text
apps/maoxianqiu/src/settings.ts
apps/maoxianqiu/src/router/index.ts
apps/maoxianqiu/src/api/index.ts
api/index.ts
api/middlewares/*
apps/maoxianqiu/src/components/business/*
```

领域 Agent 需要修改时先提交契约请求。

## 6. 并发组合

安全组合：

```text
UI Foundation + API Foundation + DB Tenant
CRM UI + CRM API（契约已冻结）
Catalog UI + Catalog API
Billing UI + Inventory RPC（接口已冻结）
```

不安全组合：

```text
两个 Agent 同时修改同一个 migration
两个 Agent 同时重构 packages/components
UI 与 API 各自发明字段
多个 Agent 同时清理 router modules
```

## 7. 契约冻结

领域开工前先合并契约 PR，至少包含：

- TypeScript input/output；
- endpoint；
- HTTP 状态；
- 错误码；
- 权限码；
- 状态转换；
- 表/RPC 名称。

契约变化必须同时更新 UI、API 和文档。

## 8. 联调检查

- tenant/store header/context 一致；
- URL 参数和 Query 参数一致；
- 时间统一 ISO 8601；
- 金额不用浮点；
- enum 与状态 map 一致；
- 409 可被 UI 正确展示；
- 422 fieldErrors 可映射表单；
- request ID 可复制；
- idempotency key 可重试。

## 9. DS 合并顺序

```text
契约
→ migration/RLS
→ generated types
→ API
→ UI
→ integration tests
→ Preview
```

## 10. 子 Agent 回报格式

```text
完成：
未完成：
修改文件：
migration：
API：
UI：
测试：
风险：
需要 DS 决策：
```

只报告“已完成页面”但没有真实 API、权限和测试，不得验收。
