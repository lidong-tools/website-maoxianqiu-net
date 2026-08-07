# 毛线球 Stage-03 合并返工任务 A
## 权限与主线集成包（S31-MERGE-A）

> 目标：只修合并后暴露出的权限模型、tenant-wide store access 与 RLS 一致性问题。  
> 不修改监管业务页面，不修改 regulatory.ts 主业务逻辑，不扩展新功能。  
> 当前状态：S3.1 Sprint 1 主体已 code_complete；本任务属于合并集成收口。

---

## 一、任务边界

你只负责：

1. tenant_owner 的监管权限补齐；
2. can_access_store 与 tenant-wide role 的语义一致；
3. 权限/RLS SQL 回归测试；
4. 两条线最终合并后，统一更新 current docs。

不要修改：

- api/routes/regulatory.ts
- 监管页面
- annual report SQL 业务逻辑
- epidemic / waste / license 业务 RPC
- FileUploader
- clinical / inventory / prescription / archive 主线逻辑
- platform_user_roles 核心架构

除非为权限测试/权限 reconciliation 做最小必要修改。

---

## 二、A01 — migration 33：tenant_owner 监管权限 reconciliation【P0】

当前问题：

主线已经创建：

```text
tenant_owner
scope = tenant
```

但它目前主要只有：

```text
veterinarian_registration.read
veterinarian_registration.manage
```

并发监管 migration 没有给 tenant_owner 完整监管权限。

导致普通医院 tenant owner 无法自行：

- 管理本医院许可证；
- 生成年度活动报告；
- 提交年度活动报告；
- 管理疫情事件；
- 管理医疗废弃物。

### 修复要求

新增：

```text
migration 33
```

从现在开始不要直接修改：

```text
28 / 29 / 31 / 32
```

给 tenant_owner 至少补：

```text
license.read
license.manage

regulatory_report.read
regulatory_report.generate
regulatory_report.submit

epidemic.read
epidemic.report
epidemic.resolve

waste.read
waste.manage

veterinarian_registration.read
veterinarian_registration.manage
```

要求：

```text
tenant_owner role.scope = tenant
employee_role_assignments.store_id = NULL
```

不要把 tenant-level 能力重新塞进 store_manager。

---

## 三、A02 — 修 can_access_store tenant-wide semantics【P0】

当前问题：

Hono scoped permission 的语义是：

```text
tenant-wide role
→ 可以访问本 tenant 下全部 store
```

但数据库 `can_access_store()` 当前主要依赖：

```text
employee_store_assignments
```

导致可能出现：

```text
Hono Command 可以操作
但 Supabase Query + RLS 看不到
```

### 必须统一

重定义：

```text
can_access_store(tenant_id, store_id)
```

至少满足：

```text
platform admin
OR
当前用户在该 tenant 有合法 tenant-wide role
OR
当前用户有目标 store assignment
```

### tenant-wide role 判断必须安全

只能接受：

```text
role.scope = tenant
AND employee_role_assignments.store_id IS NULL
```

不得重新放大：

```text
store role
```

成为 tenant-wide。

继续保持：

```text
tenant A role
≠ tenant B access
```

---

## 四、A03 — 权限 / RLS SQL 测试【P0】

新增或扩展测试。

至少覆盖：

### tenant_owner

```text
tenant A owner
→ tenant A Store A PASS

tenant A owner
→ tenant A Store B PASS

tenant A owner
→ tenant B Store FAIL
```

注意：

tenant_owner 即使没有：

```text
employee_store_assignment
```

也应访问本 tenant 下全部门店。

### store_manager

```text
Store A manager
→ Store A PASS

Store A manager
→ Store B FAIL
```

### annual regulatory report

```text
tenant_owner
→ regulatory_report.read PASS
→ regulatory_report.generate PASS
→ regulatory_report.submit PASS

store_manager
→ regulatory_report.read PASS
→ generate FAIL
→ submit FAIL

doctor
→ submit FAIL
```

### veterinarian registration

保持：

```text
tenant_owner manage PASS
store_manager tenant-level manage FAIL
doctor manage FAIL
tenant A owner → tenant B FAIL
```

---

## 五、A04 — 最终 current docs 统一【P1】

等员工 B 代码 merge 后再做。

更新：

```text
IMPLEMENTATION_STATUS.md
KNOWN_GAPS.md
RELEASE_CHECKLIST.md
```

不要提前写死统计数字。

最终重新实际执行：

```text
pnpm check:rpc-manifest
```

以命令输出为准记录：

```text
api/routes RPC 调用数
unique RPC
manifest 数量
missing RPC
```

文档必须区分：

```text
code_complete
integration_pending
verified
```

当前不得写：

```text
production_ready
```

---

## 六、migration 规则

你独占：

```text
migration 33
```

不要抢：

```text
migration 34
```

34 由员工 B 使用。

如最终 merge 后还有纯 reconciliation：

```text
migration 35
```

必须两人沟通后再使用。

---

## 七、共享文件冲突控制

你可以修改：

```text
permission/RLS helper migration
role/permission seed
permission SQL tests
current docs
```

尽量不要修改：

```text
api/routes/regulatory.ts
regulatory Vue pages
regulatory_s3_1.sql
```

如果需要修改：

先与员工 B 对齐，避免双改。

---

## 八、验收标准

完成后至少满足：

```text
tenant_owner 可以管理本 tenant 监管事项
tenant_owner 无需逐店 employee_store_assignment
store_manager 仍只能访问被授权门店
tenant A 无法访问 tenant B
Hono 与 RLS 的 store scope 语义一致
```

---

## 九、交付要求

完成后提交：

```text
1. branch 名
2. HEAD commit SHA
3. commit 列表
4. migration 33
5. 修改文件清单
6. 权限变化
7. RLS/helper 变化
8. SQL tests
9. pnpm check:rpc-manifest 原始输出
10. lint 原始输出
11. typecheck 原始输出
12. build 原始输出
13. 已知问题
14. CONFLICT_PRONE_FILES
```

不要继续开发下一阶段。

完成后等待与员工 B 合并。
