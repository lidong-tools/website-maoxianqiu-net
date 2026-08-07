# 毛线球 Stage-03 合并返工任务 B
## 监管模块修复包（S31-MERGE-B）

> 目标：只修监管运营包本身的 SQL、跨租户关联校验、附件上下文、测试和状态机问题。  
> 不修改权限核心模型，不修改 can_access_store，不创建 tenant_owner。  
> 当前状态：S3.1-PARALLEL-01 = in_development。

---

## 一、任务边界

你只负责：

1. 年度活动报告 SQL 修复；
2. 监管 Command 的跨租户关联对象校验；
3. FileUploader tenant/store context；
4. regulatory_s3_1.sql 修复；
5. 许可证/疫情状态机与 audit 修复。

不要修改：

- can_access_store
- api/lib/permission.ts 核心模型
- tenant_owner 创建/权限 reconciliation
- platform_user_roles
- clinical / inventory / prescription / archive 主线逻辑

权限 reconciliation 由员工 A 负责。

---

## 二、B01 — migration 34：修年度活动报告 SQL【P0】

从现在开始不要修改：

```text
28 / 29 / 31 / 32
```

新增：

```text
migration 34
```

修复 annual regulatory report RPC。

### 问题 1：jsonb_each alias 错误

当前类似：

```sql
from jsonb_each(...) as t(k, v)
where v.value is null
```

错误。

`v` 本身就是 jsonb。

按实际逻辑改成正确 JSON null 判断，例如：

```sql
where v = 'null'::jsonb
```

并确认：

```text
JSON null
≠
SQL NULL
```

### 问题 2：species alias 错误

当前外层错误引用：

```sql
p.species
```

应使用子查询 alias，例如：

```sql
t.species
```

不要再用：

```text
exception when others
```

掩盖明确编码 bug。

### 问题 3：veterinarian count 必须 store-scoped

当前 annual report 是：

```text
tenant + store + year
```

但有效执业兽医数量当前按整个 tenant 统计。

修成：

```text
veterinarian_registrations
+ employees
+ employee_store_assignments
```

只统计目标 store 的有效备案兽医。

如果现有模型无法可靠计算：

明确输出：

```text
unavailable / null
```

不要把 tenant-level 数字伪装成 store-level 数字。

---

## 三、B02 — 关联对象跨租户校验【P0】

SECURITY DEFINER RPC 不能依赖 FK 或前端 Picker 保证 tenant 一致。

### epidemic

`save_epidemic_event()` 对以下字段逐一校验：

```text
customer_id
pet_id
encounter_id
```

必须确认：

```text
customer 属于 p_tenant_id
pet 属于 p_tenant_id
encounter 属于 p_tenant_id
encounter.store_id 与目标 store 一致
```

如同时传：

```text
customer + pet
```

还应确认：

```text
pet.customer_id == customer_id
```

如传 encounter：

应检查与 customer/pet 是否一致，至少不能跨 tenant/store。

错误建议：

```text
CUSTOMER_SCOPE_MISMATCH
PET_SCOPE_MISMATCH
ENCOUNTER_SCOPE_MISMATCH
RELATED_ENTITY_MISMATCH
```

### license file

`p_certificate_file_id` 必须验证：

```text
file.tenant_id == target tenant
file.store_id 与 target store 一致或符合允许规则
file.status 可用
```

错误：

```text
FILE_SCOPE_MISMATCH
```

### waste file

`p_attachment_file_id` 同样做 tenant/store ownership 校验。

### 必须补负向测试

```text
Tenant A epidemic + Tenant B customer → FAIL
Tenant A epidemic + Tenant B pet → FAIL
Tenant A epidemic + Tenant B encounter → FAIL

Tenant A license + Tenant B file → FAIL
Tenant A waste + Tenant B file → FAIL
```

---

## 四、B03 — FileUploader tenant/store context【P0】

当前 regulatory 页面主要通过：

```text
profile()
→ memberships[0].tenant_id
```

得到页面 tenant。

但 FileUploader 没显式传：

```text
tenantId
storeId
```

组件内部又可能读取：

```text
appTenant.currentTenantId
```

导致页面 tenant 与上传 tenant 不一致。

### 必须修

许可证：

```vue
<BusinessFileUploader
  :tenant-id="currentTenantId"
  :store-id="form.storeId"
/>
```

医疗废弃物：

同样显式传：

```text
tenantId
storeId
```

不要依赖 localStorage 里残留 tenant。

### tenant context

本任务先保证：

```text
页面 API
Picker
FileUploader
```

使用同一个显式 tenant/store。

平台管理员跨 tenant UI：

如果尚未设计完成，明确：

```text
platform regulatory UI = deferred
```

不要用：

```text
memberships[0]
```

假装平台场景已经支持。

---

## 五、B04 — 修 regulatory_s3_1.sql【P0】

当前测试声称可独立执行，但 fixture 有错误。

### 非法 UUID

不要使用：

```text
...m1
...m2
...o1
...o2
```

UUID 只能是：

```text
0-9
a-f
```

统一换合法 hex UUID。

### encounter.doctor_id

当前 clinical schema：

```text
encounters.doctor_id
→ auth.users.id
```

测试中不要填：

```text
employee.id
```

必须填对应：

```text
auth user id
```

### 增测试

至少覆盖：

```text
annual report generate PASS
snapshot 固化
unauthorized submit FAIL

cross-tenant epidemic relation FAIL
cross-tenant file relation FAIL

license state transition
epidemic state transition

audit before/after
audit user identity
```

测试文件必须真的可以：

```bash
psql "$DATABASE_URL" -f supabase/tests/regulatory_s3_1.sql
```

独立运行。

---

## 六、B05 — 许可证状态机【P1】

当前不能允许任意状态互转。

建议：

```text
draft → active
active → suspended / revoked / expired
suspended → active / revoked / expired
revoked → terminal
expired → terminal
```

禁止普通 RPC：

```text
revoked → active
expired → active
```

如未来需要纠错：

单独设计：

```text
correction RPC
+ high permission
+ reason
+ audit
```

不要藏在普通 status change。

---

## 七、B06 — 疫情状态机【P1】

禁止：

```text
reported → detected
isolated → detected
resolved → anything
```

建议允许：

```text
detected → reported
detected → isolated
reported → isolated
isolated → resolved
```

按产品实际流程实现 transition matrix。

audit action 不要全部写：

```text
epidemic.report
```

区分：

```text
epidemic.detect
epidemic.update
epidemic.report
epidemic.isolate
epidemic.resolve
```

---

## 八、B07 — audit 修复【P1】

### License before/after

当前 update 后：

```text
before == after
```

因为只保存了 UPDATE RETURNING 后的新行。

必须：

```text
SELECT old row → v_before
UPDATE ... RETURNING → v_after
```

audit：

```text
before = v_before
after = v_after
```

### audit user_id

当前多个监管 RPC：

```text
audit_logs.user_id = null
```

既然已经能通过 employee 解析到：

```text
employee.user_id
```

就同时写：

```text
audit_logs.user_id
```

保留：

```text
auth identity
employee identity
```

两层追溯。

---

## 九、RPC 安全规则

新改 RPC 必须继续：

```text
SECURITY DEFINER
SET search_path
revoke public
revoke anon
revoke authenticated
grant service_role
```

如新增 RPC：

必须同步：

```text
api/lib/service-rpc-manifest.ts
```

并保证：

```text
pnpm check:rpc-manifest
```

通过。

不要让前端直接 `.rpc()`。

---

## 十、migration 规则

你独占：

```text
migration 34
```

不要使用：

```text
migration 33
```

33 由员工 A 使用。

如确实需要第二个 migration：

先与员工 A 协调，优先：

```text
35
```

但避免不必要拆分。

---

## 十一、冲突控制

你可以修改：

```text
api/routes/regulatory.ts
views/regulatory/*
regulatory_s3_1.sql
migration 34
监管 domain model/helper
```

尽量不要修改：

```text
permission helper
can_access_store
tenant_owner migration
current docs
```

current docs 最终由员工 A 在 merge 后统一更新。

---

## 十二、验收标准

至少满足：

```text
annual report RPC 不再有确定 SQL 错误
annual report store 数据不伪装 tenant 数据
跨租户 customer/pet/encounter/file 全部被拒绝
FileUploader 与页面 tenant/store 一致
regulatory_s3_1.sql 静态可独立执行
license 终态不可普通复活
epidemic 状态不可逆向回退
audit before/after 真实
audit user_id 可追溯
```

---

## 十三、交付要求

完成后提交：

```text
1. branch 名
2. HEAD commit SHA
3. commit 列表
4. migration 34
5. 修改文件清单
6. annual report 修复说明
7. cross-tenant validation matrix
8. regulatory_s3_1.sql
9. API route 变化
10. UI 变化
11. audit event 变化
12. pnpm check:rpc-manifest 原始输出
13. lint 原始输出
14. typecheck 原始输出
15. build 原始输出
16. 已知问题
17. CONFLICT_PRONE_FILES
```

不要继续下一阶段。

完成后等待与员工 A 合并。
