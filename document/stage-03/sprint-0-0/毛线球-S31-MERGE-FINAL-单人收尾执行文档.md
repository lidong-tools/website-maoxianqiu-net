# 毛线球 Stage-03 合并收尾任务
## S31-MERGE-FINAL 单人执行文档

> 适用阶段：Stage-03 / S3.1 当前合并批次最终收尾  
> 当前状态：
>
> ```text
> S3.0 security regression = PASS
> S3.1 Sprint 1 主线 = code_complete / runtime integration_pending
> S31-MERGE-A = 主体完成
> S31-MERGE-B = 主体完成，但仍有 migration/P1 收尾
> Stage-03 当前合并批次 = in_development
> ```
>
> 本任务目标：
>
> **只完成最后的合并收尾，不扩功能，不进入下一 Sprint。**
>
> 完成后应达到：
>
> ```text
> S3.1 Sprint 1 = code_complete
> S3.1-PARALLEL-01 = code_complete
> Stage-03 当前合并批次 = code_complete
> runtime = integration_pending
> ```

---

# 一、严格执行边界

本次只处理：

```text
FINAL-01 PostgreSQL 函数签名
FINAL-02 annual report veterinarian count 边界
FINAL-03 can_access_store store↔tenant 自校验
FINAL-04 current docs + 静态/构建证据
```

禁止新增：

- tenant initialization
- 日结
- 对账
- 新监管模块
- C 端
- 会员
- 营销
- AI
- 新医疗功能
- 新供应链功能

禁止无必要重构：

```text
clinical
inventory
prescription
archive
platform auth
permission architecture
regulatory UI architecture
```

本轮是收尾，不是继续开发。

---

# 二、FINAL-01【P0】
# 修 migration 32 / 34 PostgreSQL 函数签名

当前存在 3 个确定的 PostgreSQL 函数定义错误。

PostgreSQL 不允许：

```text
一个 input 参数出现 DEFAULT
之后又出现没有 DEFAULT 的 input 参数
```

当前受影响函数：

```text
save_institution_license
save_epidemic_event
save_waste_record
```

---

## 2.1 save_institution_license

当前类似：

```sql
p_tenant_id uuid,
p_store_id uuid,
p_license_id uuid default null,
p_license_no text,
...
```

必须修复。

推荐保持参数顺序不变，将：

```sql
p_license_no text
```

改为：

```sql
p_license_no text default null
```

函数内部继续保留：

```text
LICENSE_NO_REQUIRED
```

业务校验。

---

## 2.2 save_epidemic_event

当前存在：

```sql
p_event_id uuid default null,
p_customer_id uuid default null,
p_pet_id uuid default null,
p_encounter_id uuid default null,
p_suspected_disease text,
...
```

必须将：

```sql
p_suspected_disease text
```

改为：

```sql
p_suspected_disease text default null
```

继续保留函数内部：

```text
SUSPECTED_DISEASE_REQUIRED
```

校验。

---

## 2.3 save_waste_record

当前存在：

```sql
p_record_id uuid default null,
p_waste_type text,
...
```

必须改为：

```sql
p_waste_type text default null
```

继续保留：

```text
WASTE_TYPE_REQUIRED
```

业务校验。

---

## 2.4 必须同时修 migration 32 和 34

重点：

```text
不能只新增 migration 35 修这个问题。
```

原因：

fresh database 会执行：

```text
01
...
31
32
```

并在 migration 32 创建函数时直接失败。

后面的 migration 根本执行不到。

因此必须同时修：

```text
supabase/migrations/20260808000032_regulatory_rpc.sql
supabase/migrations/20260808000034_regulatory_fix.sql
```

保证两份中最终函数定义签名一致。

---

## 2.5 migration 历史说明

交付文档中必须明确写：

```text
migration 31 / 32 尚未应用于任何共享开发数据库、
staging 或 production。
```

只有在这个前提成立时，允许当前直接修正尚未发布的 migration 32。

如果事实不成立：

立即停止修改历史 migration，并报告真实数据库状态，
不要自行猜测 fix-forward 方案。

---

# 三、FINAL-02【P1】
# 修 annual report veterinarian count 边界

当前年度报告的执业兽医数量已经改成 store-scoped，这是正确方向。

但仍需要补时间有效性条件。

至少增加：

```sql
vr.valid_from <= (now() at time zone 'Asia/Shanghai')::date
```

以及门店员工分配：

```sql
(esa.starts_at is null or esa.starts_at <= now())
and
(esa.ends_at is null or esa.ends_at > now())
```

同时保留：

```sql
vr.status = 'active'
```

和：

```sql
vr.valid_until is null
or
vr.valid_until >= (now() at time zone 'Asia/Shanghai')::date
```

---

## 3.1 年报统计口径

不要把：

```text
当前有效门店执业兽医数量
```

写成：

```text
报告年度历史执业兽医人数
```

当前模型如果不能精确还原全年历史人员变化：

文档必须明确统计口径。

例如：

```text
veterinarian_count：
报告生成时点，当前门店仍有效的执业兽医人数
```

如果产品后续需要：

```text
全年曾执业人数
```

应该依赖历史有效期 / store assignment history 重新设计，不在本次扩展。

---

# 四、FINAL-03【P1】
# can_access_store 增加 store↔tenant 自校验

当前 migration 33 已经实现：

```text
platform admin
OR
tenant-wide role
OR
store assignment
```

整体语义正确。

现在再补一个最外层的安全前提：

```text
目标 store 必须真实属于目标 tenant
```

例如：

```sql
exists (
  select 1
  from public.stores s
  where s.id = p_store_id
    and s.tenant_id = p_tenant_id
)
```

如果：

```text
store 不存在
```

或：

```text
store 属于其他 tenant
```

则：

```text
can_access_store = false
```

---

## 4.1 不允许破坏已有作用域模型

仍必须保证：

### tenant_owner

```text
role.scope = tenant
era.store_id IS NULL
```

可以访问：

```text
本 tenant 所有合法 store
```

无需逐店 assignment。

### store_manager

仍只能访问：

```text
employee_store_assignments
```

明确授权的门店。

不得因为这次修改重新出现：

```text
store role → tenant-wide
```

权限提升。

---

## 4.2 补回归测试

至少新增：

```text
tenant A owner + tenant A store → PASS

tenant A owner + tenant B store
但传 p_tenant_id = tenant A
→ FAIL

store manager Store A → Store A PASS

store manager Store A → Store B FAIL
```

---

# 五、FINAL-04【P1】
# current docs 与证据统一

这是本轮最后一个交付项。

更新：

```text
document/current/IMPLEMENTATION_STATUS.md
document/current/KNOWN_GAPS.md
document/current/RELEASE_CHECKLIST.md
```

---

## 5.1 状态必须准确

本轮完成后写：

```text
S3.1 Sprint 1
= code_complete
= runtime integration_pending

S3.1-PARALLEL-01
= code_complete
= runtime integration_pending

Stage-03 当前合并批次
= code_complete
= runtime integration_pending
```

禁止写：

```text
verified
production_ready
```

除非后续 staging 真实执行：

```text
migration
RLS
SQL tests
E2E
```

并通过。

---

## 5.2 RPC 数量必须重新实际运行

不要从旧文档复制：

```text
59 / 52 / 55
65
72
```

任何历史数字。

必须在当前最终源码上实际执行：

```bash
pnpm check:rpc-manifest
```

以真实输出为准更新：

```text
api/routes RPC 调用数
Hono unique RPC 数
service-role-only manifest 数
missing RPC 数
```

要求：

```text
missing = 0
```

---

## 5.3 构建校验

实际执行并保留原始输出：

```bash
pnpm check:rpc-manifest
pnpm lint
pnpm typecheck
pnpm build
```

如果 monorepo 没有 root `typecheck`：

按当前项目真实 script 执行：

```text
frontend vue-tsc
api tsc
e2e tsc
```

不得只在文档中写：

```text
PASS
```

必须保留命令和原始结果。

---

# 六、SQL 测试要求

本轮不要求扩展新的业务测试体系，只需要保证已有测试与最终修改一致。

重点检查：

```text
permission_integration_s3_1.sql
regulatory_s3_1.sql
compliance_s3_1.sql
rpc_security.sql
```

至少静态确认：

```text
合法 UUID
正确 auth.user / employee ID 语义
函数签名一致
无旧 RPC 参数
无旧状态机断言
```

如果有可用 PostgreSQL / Supabase staging：

执行并保存实际日志。

如果没有：

如实标注：

```text
runtime = integration_pending
```

不要制造测试通过记录。

---

# 七、不得回退的已通过安全规则

修复时必须保证以下继续成立：

```text
frontend direct .rpc() = 0
```

所有 Command：

```text
Browser
→ Hono
→ scoped permission
→ service role
→ PostgreSQL RPC
```

新/修改的 Command RPC 继续：

```text
SECURITY DEFINER
SET search_path
REVOKE public
REVOKE anon
REVOKE authenticated
GRANT service_role
```

并纳入：

```text
api/lib/service-rpc-manifest.ts
```

---

# 八、不得破坏的已通过业务规则

不要回退：

```text
tenant admin ≠ platform admin

tenant_owner = tenant scope

store_manager = store scope

draft prescription 不可发药

处方发药单事务

无仓库库存商品不可假发药

处方有效期：
validUntil > issuedAt
validUntil <= issuedAt + 3 days

病历：
draft → signed → archived

actor employee 由当前 auth user + target tenant 服务端解析

监管关联对象必须 tenant/store 一致

FileUploader 必须使用页面明确 tenant/store
```

---

# 九、建议执行顺序

严格按：

```text
1. 确认 migration 31/32 是否从未进入共享环境
2. 修 migration 32
3. 修 migration 34
4. 修 annual report vet count
5. 修 can_access_store
6. 补/更新 SQL tests
7. 跑 check:rpc-manifest
8. 跑 lint
9. 跑 typecheck
10. 跑 build
11. 更新 current docs
12. git diff 最终自审
13. 停止开发
```

不要中途开始下一 Sprint。

---

# 十、最终自查

提交前逐项回答：

```text
[ ] migration 32 的 3 个函数参数定义已合法
[ ] migration 34 使用完全一致的最终函数签名
[ ] LICENSE_NO_REQUIRED 仍存在
[ ] SUSPECTED_DISEASE_REQUIRED 仍存在
[ ] WASTE_TYPE_REQUIRED 仍存在

[ ] veterinarian count 检查 valid_from
[ ] veterinarian count 检查 valid_until
[ ] store assignment 检查 starts_at
[ ] store assignment 检查 ends_at

[ ] can_access_store 校验 store 属于 tenant
[ ] tenant_owner 不需要逐店 assignment
[ ] store_manager 不获得 tenant-wide 权限

[ ] frontend direct RPC 仍为 0
[ ] check:rpc-manifest missing = 0

[ ] IMPLEMENTATION_STATUS 已更新
[ ] KNOWN_GAPS 已更新
[ ] RELEASE_CHECKLIST 已更新

[ ] 未写 verified
[ ] 未写 production_ready
```

---

# 十一、最终交付给审计方

只提交最终合并后的材料，不需要再给员工 A/B 分包。

必须提供：

```text
1. 最终完整源码 ZIP

2. 最终 commit SHA

3. git rev-parse HEAD

4. git log -1 --oneline

5. git status --short

6. S31-MERGE-FINAL 修复说明
   - FINAL-01
   - FINAL-02
   - FINAL-03
   - FINAL-04

7. migration 32 diff

8. migration 34 diff

9. permission_integration_s3_1.sql

10. regulatory_s3_1.sql

11. compliance_s3_1.sql（如有变化）

12. pnpm check:rpc-manifest 原始输出

13. lint 原始输出

14. typecheck 原始输出

15. build 原始输出

16. 最新 IMPLEMENTATION_STATUS.md

17. 最新 KNOWN_GAPS.md

18. 最新 RELEASE_CHECKLIST.md
```

如果已有 staging：

额外提交：

```text
migration 01 → latest 执行日志
permission integration SQL log
regulatory SQL log
compliance SQL log
rpc_security SQL log
E2E report
/api/health
```

如果没有 staging：

明确：

```text
runtime integration_pending
```

即可。

---

# 十二、完成后必须停止

完成 FINAL-01～04 后：

```text
不要开始 tenant initialization
不要开始 daily closing
不要开始 reconciliation
不要进入下一 Sprint
```

等待最终合并审计。

---

# 十三、验收目标

下一轮审计只检查：

```text
1. PostgreSQL 函数签名合法
2. migration 32 fresh install 不被阻塞
3. migration 34 final function 正确
4. annual report veterinarian count 边界正确
5. can_access_store store↔tenant 自校验正确
6. SQL tests 与最终实现一致
7. manifest missing = 0
8. current docs 与源码一致
9. lint/typecheck/build 无新增阻塞
```

通过后将批准：

```text
S3.1 Sprint 1 = code_complete
S3.1-PARALLEL-01 = code_complete

Stage-03 当前合并批次
= code_complete

runtime
= integration_pending
```

并允许正式进入下一阶段：

```text
tenant initialization
daily closing
reconciliation
```
