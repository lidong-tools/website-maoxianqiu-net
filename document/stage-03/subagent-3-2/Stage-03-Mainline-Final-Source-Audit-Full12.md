# 毛线球 SaaS — Stage-03 Mainline Final Source Audit（全量包 12）

> 审计对象：`website-maoxianqiu-net-main (12).zip`  
> 本次是第一次能够用完整最新 Tree 对此前所有增量修复做最终验证。

---

# 1. Gate 总结

| Gate | 结论 |
|---|---|
| Migration Version Unique | ✅ PASS |
| Historical Migration Immutable | ✅ PASS |
| S3.1 Source Gate | ✅ PASS |
| Documents Source Gate | ✅ PASS |
| Import Core Source Gate | ✅ PASS |
| Messaging Source Gate | 🔴 FAIL |
| Analytics Source Gate | 🔴 FAIL |
| Repository Secret Hygiene | 🔴 FAIL |
| Full Build Independent Reproduction | ⏳ 未在审计环境复现 |
| Runtime DB Gate | ⛔ 尚不建议开始 |
| E2E | 尚未作为本轮 Gate |
| Pilot Ready | ❌ |

---

# 2. 最重要的好消息

此前多轮反复确认的问题，这次终于能用全量仓库正式关闭：

```text
旧 115 Migration 已删除
97 Migration Version 唯一
历史 Migration 21 未再被修改
S3.1 Source Fix 未回归
Documents P0 未回归
Import Core 并发/状态修复未回归
```

因此 Stage-03 已经不再处于“大规模架构返工”阶段。

---

# 3. 🔴 Mainline Security Blocker — 仓库包含明文凭据

全量源码中发现多份临时 E2E/Debug 文件包含：

```text
测试账号邮箱
测试账号明文密码
Supabase client key / URL
用户/租户/门店 UUID
```

并且：

```text
scripts/e2e-setup.sh
```

包含硬编码：

```text
测试账号密码
数据库 PGPASSWORD
```

本报告不展示任何实际凭据值。

### 相关文件包括

```text
e2e/tests/tmp-debug-header.spec.ts
e2e/tmp-debug-pets.spec.ts
e2e/tmp-check-auth.mjs
e2e/tmp-check-data.mjs
e2e/tmp-check-latest.mjs
e2e/tmp-check-role-perms.mjs
e2e/tmp-restore-auth.mjs
scripts/e2e-setup.sh
```

其中：

```text
e2e/tests/tmp-debug-header.spec.ts
```

位于 Playwright：

```text
testDir = ./tests
```

内，正常 E2E 还可能自动收集它。

---

# 4. 必须处理凭据问题

### 删除临时 Debug 文件

```text
e2e/tmp-*
e2e/tests/tmp-debug-*
```

并加入：

```gitignore
e2e/tmp-*
e2e/tests/tmp-*
```

### e2e-setup.sh 改环境变量

例如：

```text
E2E_ACCOUNT_EMAIL
E2E_ACCOUNT_PASSWORD
DATABASE_URL
```

禁止仓库中出现：

```text
literal password
literal database password
```

### 凭据轮换

如果这些密码：

```text
曾经有效
曾经 commit
曾经上传/分享
```

应立即轮换：

```text
E2E Account Password
Database Password
```

Supabase public anon/client key 本身属于客户端配置，

但也不应和账号/数据库密码混在 Debug 凭据脚本里。

---

# 5. 🔴 Messaging Blockers

## 5.1 DB Schema 与代码不一致

Backend 使用：

```text
message_deliveries.updated_at
```

但 Migration Tree 没有该列。

## 5.2 Initial Send 与 Retry 可并发发送

Initial Provider Send 期间：

```text
Delivery 仍 queued
```

Retry 可 Claim queued，

可能产生重复 Provider 副作用。

## 5.3 Frontend 缺 `sending`

DB/Backend 已有：

```text
sending
```

Frontend Union 没有。

Retry UI 也允许 queued。

### 建议一次性修

```text
显式 sending_claimed_at
Initial Send CAS claim
Retry only failed/retry
Frontend sending state
recordAttempt expected-attempt update
```

---

# 6. 🔴 Analytics Blockers

## 6.1 Refund Relation Shape

many-to-one：

```text
refund → invoice
refund → payment
```

被代码手工断言成 Array，

导致退款门店/支付渠道可能静默错误归因。

## 6.2 Catalog Revenue Reconciliation

Catalog 用：

```text
SUM(invoice_items.amount)
```

但 Invoice Total 还包含：

```text
invoice-level discount
tax
```

所以分类维度目前无法在这些场景与 Overall Revenue 对账。

---

# 7. Import Pilot 决策

当前：

```text
Customer
Pet
Catalog
```

可以继续作为 Import Core。

```text
Employee
Opening Stock
```

仍是：

```text
awaiting_domain_apply
```

并且入口目前可见。

Pilot 前：

```text
实现 Consumer
```

或：

```text
暂时隐藏两个入口
```

二选一。

---

# 8. check:rpc-manifest 仍不可作为 Security Gate

当前脚本仍可能因为：

```text
RPC 名称只是出现在 SQL 字符串里
```

就认为其 ACL 已覆盖。

本次源码直接检查结果本身不错，

但 Runtime Gate 必须真正查询：

```text
pg_proc
has_function_privilege
```

---

# 9. 状态文档需要重写

当前：

```text
document/current/IMPLEMENTATION_STATUS.md
document/current/KNOWN_GAPS.md
```

包含多轮追加信息，

部分旧结论已经与最终代码冲突。

进入 Runtime Gate 前建议：

```text
重写为“当前事实状态”
```

不要继续 Append 历史状态。

尤其补入：

```text
Messaging remaining blockers
Analytics data-quality blockers
Import deferred consumers
Secret hygiene
```

---

# 10. Build 证据

仓库最终报告记录：

```text
API tsc       PASS
Vue typecheck PASS
Vite build    PASS
```

本次审计环境没有：

```text
node_modules
pnpm project dependencies
```

因此没有独立完整复现。

所以当前表述必须是：

```text
Delivery Build Evidence: PASS
Independent Audit Build: Not Reproduced
```

---

# 11. 当前不要马上开始 DB Runtime Gate

建议先做一个很小的 Final Source Fix：

```text
A. Secret Cleanup
B. Messaging State/Claim Fix
C. Analytics Refund Shape Fix
D. Analytics Catalog Reconciliation Fix
E. Import Consumer / Feature Flag 决策
```

完成后：

```text
提交一次新的全量代码包
```

再做一次短 Final Recheck。

如果通过：

```text
Source Gate = PASS
↓
DB Runtime Gate
↓
E2E
↓
Pilot Ready
```

---

# 12. 最终评价

项目当前状态已经非常接近 Runtime 阶段。

不是：

```text
需要重新开发
```

而是：

```text
最后几处生产级边界必须收紧
```

当前最重要的是不要为了赶进入 Runtime Gate 而忽略：

```text
明文凭据
外部消息重复发送
经营报表静默错归因
```

这些问题在 Pilot 中的风险远高于再补一个页面功能。

---

## Final Mainline Verdict

```text
S3.1                       PASS
S3.2 Documents             PASS
S3.2 Import Core           PASS
S3.2 Messaging             FAIL
S3.2 Analytics             FAIL
Migration Tree             PASS
Repository Secret Hygiene  FAIL

FINAL SOURCE GATE           FAIL
Runtime DB Gate             HOLD
```

> 修复范围已经很小。完成上述定点修复后，再提交一次全量包即可进行最后一次 Source Gate Recheck。

**Stage-03 Mainline Final Source Audit 结束。**
