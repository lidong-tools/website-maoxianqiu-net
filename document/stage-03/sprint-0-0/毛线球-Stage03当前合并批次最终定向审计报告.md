# 毛线球 Stage-03 当前合并批次最终定向审计报告

> 审计日期：2026-08-07  
> 审计对象：`website-maoxianqiu-net-main (5).zip`  
> ZIP SHA-256：`07c71174824e35ee0766d3a84dd3e718e6b90410442bbeb68c66b9c235291e1a`  
> 源码包：完整源码，约 3458 个 ZIP 条目  
> Migration：33 个 SQL 文件，最新编号 34（历史上无 migration 30）  
> SQL tests：16 个  
> 审计范围：`S31-MERGE-FINAL` FINAL-01～04 + S3.0 安全边界回归  
> 审计性质：静态源码验收；未在本环境执行 PostgreSQL/Supabase migration、RLS、SQL tests、Playwright、pnpm lint/typecheck/build。  
>
> **最终结论：仍需一次极小返工。FINAL-02 / FINAL-03 已通过，FINAL-01 只剩 migration 34 的 `save_epidemic_event()` 一个参数漏修；FINAL-04 文档状态也因此写早了。当前不能签整个合并批次 `code_complete`。**

---

# 1. 结论概览

本轮大部分收尾工作已经完成。

当前静态确认：

```text
api/routes service.rpc() 调用：72 处
Hono unique RPC：67 个
service-role-only manifest：72 个
missing route RPC：0
frontend direct .rpc()：0
```

因此 S3.0 的核心安全边界继续成立：

```text
Browser
→ Hono
→ scoped permission
→ service role
→ PostgreSQL Command RPC
```

没有发现这次收尾重新打开浏览器直调 Command RPC 的路径。

FINAL-02（annual report veterinarian count）已经按要求补齐时间和门店分配边界。

FINAL-03（can_access_store store↔tenant 自校验）已经按要求完成，并补了回归测试。

真正剩余的 blocker 已经收敛为：

> **migration 34 的 `save_epidemic_event()` 仍然保留了 PostgreSQL 非法参数定义。**

---

# 2. FINAL-01：migration 32 / 34 函数签名

## 评级

> **FAIL，但只剩 1 个函数 1 行。**

---

## 2.1 migration 32 已正确修复

当前：

```sql
save_institution_license(
  ...
  p_license_id uuid default null,
  p_license_no text default null,
  ...
)
```

正确。

```sql
save_epidemic_event(
  ...
  p_encounter_id uuid default null,
  p_suspected_disease text default null,
  ...
)
```

正确。

```sql
save_waste_record(
  ...
  p_record_id uuid default null,
  p_waste_type text default null,
  ...
)
```

正确。

因此 fresh migration 执行到 migration 32 时，上一轮发现的 3 个“DEFAULT 后接无 DEFAULT 参数”问题已经全部关闭。

---

## 2.2 migration 34：license 已正确

`save_institution_license()`：

```sql
p_license_id uuid default null,
p_license_no text default null,
```

正确。

---

## 2.3 migration 34：waste 已正确

`save_waste_record()`：

```sql
p_record_id uuid default null,
p_waste_type text default null,
```

正确。

---

## 2.4 migration 34：epidemic 仍然错误【P0】

当前实际源码：

```sql
create or replace function public.save_epidemic_event(
  p_tenant_id uuid,
  p_store_id uuid,
  p_event_id uuid default null,
  p_customer_id uuid default null,
  p_pet_id uuid default null,
  p_encounter_id uuid default null,
  p_suspected_disease text,
  p_detected_at timestamptz default null,
  ...
)
```

这里仍然是：

```text
p_encounter_id = DEFAULT
↓
p_suspected_disease = 无 DEFAULT
```

PostgreSQL 不允许这种 input parameter 排列。

因此 migration 34 在执行：

```text
CREATE OR REPLACE FUNCTION save_epidemic_event(...)
```

时仍会失败。

必须改成：

```sql
p_suspected_disease text default null,
```

并继续保留函数内部：

```text
SUSPECTED_DISEASE_REQUIRED
```

业务校验。

---

## 2.5 migration 32 / 34 当前签名不一致

独立比较：

### migration 32

```text
p_suspected_disease text default null
```

### migration 34

```text
p_suspected_disease text
```

因此 current docs 中：

```text
migration 32 与 34 最终函数签名一致
```

这一条目前不成立。

---

# 3. FINAL-02：annual report veterinarian count

## 评级

> **PASS（静态） / runtime integration_pending**

migration 32 与 migration 34 的最终统计逻辑已经加入：

```sql
vr.status = 'active'
```

以及：

```sql
vr.valid_from
<= (now() at time zone 'Asia/Shanghai')::date
```

```sql
vr.valid_until is null
or vr.valid_until >= (now() at time zone 'Asia/Shanghai')::date
```

门店 employee assignment 也加入：

```sql
esa.store_id = p_store_id
```

```sql
esa.starts_at is null
or esa.starts_at <= now()
```

```sql
esa.ends_at is null
or esa.ends_at > now()
```

并使用：

```text
veterinarian_registrations
JOIN employee_store_assignments
```

收敛到目标 store。

因此上一轮指出的：

- 尚未生效备案被统计；
- 已结束门店分配仍被统计；

已静态关闭。

---

## 3.1 统计口径仍应保持准确

当前实现表达的是：

> **报告生成时点，该门店当前有效执业兽医数量。**

它不是严格意义上的：

> 报告年度全年曾在岗/执业人数。

如果以后监管口径要求年度历史人数，需要基于历史 assignment/registration 时间区间重新计算。

当前 Pilot 版本可以接受，但文档不要夸大为完整历史口径。

---

# 4. FINAL-03：can_access_store store↔tenant 自校验

## 评级

> **PASS**

migration 33 当前先执行：

```sql
exists (
  select 1
  from public.stores s
  where s.id = p_store_id
    and s.tenant_id = p_tenant_id
)
```

只有 store 真实属于 tenant 后才继续判断：

```text
platform admin
OR tenant-wide role
OR store assignment
```

这关闭了：

```text
tenant A 权限
+ tenant B storeId
+ 伪造 tenant A 参数
```

这一类 helper 参数组合问题。

同时 tenant-wide role 仍严格要求：

```text
era.tenant_id = target tenant
era.store_id IS NULL
role.scope = tenant
employee.user_id = auth.uid()
employee.status = active
```

没有重新把 store role 放大成 tenant-wide。

---

# 5. FINAL-03 权限测试

## 评级

> **静态 PASS / runtime pending**

`permission_integration_s3_1.sql` 已增加：

```text
tenant A owner + tenant A Store A → PASS
tenant A owner + tenant A Store B → PASS
tenant A owner + tenant B store → FAIL
不存在 store → FAIL

Store A manager → Store A PASS
Store A manager → Store B FAIL
Store A manager + tenant B store → FAIL
```

同时保留：

```text
tenant_owner regulatory permission matrix
store_manager generate/submit negative
doctor submit negative
veterinarian registration tenant-level matrix
institution_licenses RLS
```

测试设计与当前权限模型一致。

---

# 6. FINAL-04：current docs

## 评级

> **PARTIAL / 状态写早了**

`IMPLEMENTATION_STATUS.md` 已新增当前合并批次内容，并写入最新静态 RPC 数量：

```text
72 calls
67 unique
72 manifest
missing = 0
```

这一组数据与本次独立静态扫描一致。

但文档同时写：

```text
S31-MERGE-FINAL = code_complete
FINAL-01 = ✅ 完成
migration 32 与 34 最终函数签名一致
```

因为 migration 34 的 `p_suspected_disease` 仍未补 `default null`，这些状态目前不成立。

当前正确状态仍应是：

```text
S31-MERGE-FINAL = in_development
Stage-03 当前合并批次 = in_development
```

修完这一行并复核后才可以升级为：

```text
code_complete
runtime = integration_pending
```

---

# 7. KNOWN_GAPS / RELEASE_CHECKLIST 仍残留旧 RPC 数量

`IMPLEMENTATION_STATUS.md` 的新章节已经使用：

```text
72 / 67 / 72 / missing 0
```

但：

```text
KNOWN_GAPS.md
RELEASE_CHECKLIST.md
```

仍有历史条目写：

```text
59 calls
52 unique
55 manifest
```

这些数字是 S3.0 时点的历史数据。

如果条目明确标注为：

```text
“S3.0 当时的基线”
```

可以保留。

但当前写法容易被理解成“当前系统 RPC 数量”。

建议最终统一为：

```text
当前合并源码：
72 calls
67 route unique RPC
72 manifest
missing 0
```

历史 S3.0 数字如要保留，应加：

```text
historical S3.0 baseline
```

标签。

---

# 8. 文档中的构建结果仍属于提交方自报

`IMPLEMENTATION_STATUS.md` 写有：

```text
pnpm check:rpc-manifest PASS
lint PASS
typecheck PASS
build PASS
vite build ✓ 31.07s
```

但本完整源码包中没有发现对应原始日志/CI artifact。

当前审计环境：

```text
Node v22.16.0
pnpm 未安装
node_modules 不存在
```

因此本轮无法独立复现这些命令。

可以独立验证的只有静态 RPC 集合：

```text
routes calls = 72
unique = 67
manifest = 72
missing = 0
frontend direct RPC = 0
```

所以构建状态应视为：

```text
self-reported
```

而不是本轮独立机器验证。

这不是当前代码 P0，但最终 staging/CI gate 必须补机器证据。

---

# 9. migration provenance

`IMPLEMENTATION_STATUS.md` 当前明确声明：

```text
migration 31 / 32 / 33 / 34
尚未应用于任何共享开发数据库、
staging 或 production。
```

在此声明成立的前提下：

> 本轮允许直接修尚未发布的 migration 34。

因此不需要为这一行错误额外创建 migration 35。

直接修：

```text
20260808000034_regulatory_fix.sql
```

即可。

如果这个声明并不真实，则必须停止回改历史 migration，并重新制定 fix-forward 方案。

---

# 10. S3.0 安全回归

本轮重新独立扫描：

```text
api/routes service.rpc() 调用 = 72
unique RPC                  = 67
SERVICE_ROLE_ONLY_RPC       = 72
route RPC missing manifest  = 0
frontend direct .rpc()      = 0
```

结论：

> **S3.0 RPC 安全架构回归 PASS。**

没有发现本次收尾造成：

```text
Browser → direct Command RPC
```

回退。

---

# 11. 本轮验收矩阵

| 项目 | 结果 |
|---|---|
| migration 32 function signatures | 🟢 PASS |
| migration 34 license signature | 🟢 PASS |
| migration 34 waste signature | 🟢 PASS |
| migration 34 epidemic signature | 🔴 FAIL |
| annual report vet valid_from | 🟢 PASS |
| annual report vet valid_until | 🟢 PASS |
| assignment starts_at / ends_at | 🟢 PASS |
| can_access_store store↔tenant | 🟢 PASS |
| permission integration test design | 🟢 PASS / runtime pending |
| RPC manifest regression | 🟢 PASS |
| frontend direct RPC | 🟢 0 |
| IMPLEMENTATION_STATUS numbers | 🟢 基本正确 |
| docs status truthfulness | 🟡 需同步 |
| raw lint/typecheck/build evidence | 🟡 未附 |
| **S31-MERGE-FINAL** | **🔴 暂不通过** |
| **Stage-03 当前合并批次** | **🔴 暂不签 code_complete** |

---

# 12. 最后返工只剩 2 件事

这次不要再新增任务，不要扩业务。

## FINAL-X01【P0，一行代码】

文件：

```text
supabase/migrations/20260808000034_regulatory_fix.sql
```

将：

```sql
p_suspected_disease text,
```

改为：

```sql
p_suspected_disease text default null,
```

保持：

```text
SUSPECTED_DISEASE_REQUIRED
```

内部业务校验。

然后静态比较 migration 32/34 的 3 个函数参数定义，必须完全一致：

```text
save_institution_license
save_epidemic_event
save_waste_record
```

---

## FINAL-X02【文档】

修完 X01 后：

```text
IMPLEMENTATION_STATUS
KNOWN_GAPS
RELEASE_CHECKLIST
```

统一状态：

```text
S31-MERGE-FINAL = code_complete
Stage-03 当前合并批次 = code_complete
runtime = integration_pending
```

同时：

- 当前 RPC 口径统一成 `72 calls / 67 unique / 72 manifest / missing 0`；
- 如保留 `59/52/55`，必须明确标成 historical S3.0 baseline；
- 不得写 verified；
- 不得写 production_ready。

---

# 13. 下一次需要提交什么

不需要再发整个大范围返工说明。

修完这一行后建议提交：

```text
1. 最终完整源码 ZIP
2. commit SHA
3. migration 34 diff
4. 最新 3 个 current docs
5. check:rpc-manifest 原始输出
6. lint/typecheck/build 原始输出（如果方便）
```

如果没有 staging，不要求为了签静态 code_complete 强行搭库。

---

# 14. 下一轮签字规则

下一次只检查：

```text
migration 34 p_suspected_disease = default null
migration 32 / 34 三个函数签名一致
current docs 状态一致
manifest missing = 0
```

如果没有出现新的回退，则直接批准：

```text
S3.1 Sprint 1 = code_complete
S3.1-PARALLEL-01 = code_complete
S31-MERGE-FINAL = code_complete

Stage-03 当前合并批次
= code_complete

runtime
= integration_pending
```

然后可以进入下一批：

```text
tenant initialization
daily closing
reconciliation
```
