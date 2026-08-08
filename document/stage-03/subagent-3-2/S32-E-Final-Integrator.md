> 项目：毛线球宠物医院 SaaS  
> 阶段：Stage-03 / S3.2 并发功能开发  
> 基线：在 S3.1 Fix Pipeline 仍独立执行的前提下，从当前稳定 Main/Base Commit 创建本批 Feature 分支。  
> 核心原则：**S3.2 Agent 不得修改 S3.1 Fix 正在修复的 IAM、Billing 核心、Clinical 核心、Inventory 核心安全边界。**  
> E2E：继续独立运行。本批 Agent 不修改 `e2e/**`。  
> 文件 Ownership：一个生产文件只能有一个写入 Owner；跨域需求只能写 Handoff，不得直接修改其他 Agent 所属文件。  

# S32-E — S3.2 最终 Integrator

> 本 Agent 最后启动。  
> 不新增业务需求。  
> 不替代 S3.1 Final Integrator。

# 1. 输入

```text
S32-A-HANDOFF.md
S32-B-HANDOFF.md
S32-C-HANDOFF.md
S32-D-HANDOFF.md
```

以及四个 Feature Branch。

---

# 2. 第一阶段：Ownership 审计

检查：

```text
是否越权修改 S3.1 Fix 文件
是否修改 e2e
是否修改 permission helper
是否修改 billing/clinical/inventory core
```

越权修改必须逐项解释。

---

# 3. Migration

检查：

```text
100–103 Import
104–107 Analytics
108–111 Documents
112–115 Messaging
```

要求：

```text
顺序唯一
无历史 migration 修改
RLS 完整
索引合理
无重复 table/domain
```

---

# 4. 路由集成

只有本 Agent 修改：

```text
api/index.ts
router shared registration
operations module route
analytics module route
```

保持：

```text
Import → Operations
Documents → Operations
Messaging → Operations
Analytics → 独立 Analytics 二级/一级域（按现有导航规则）
```

不要新增大量一级导航。

---

# 5. Permission 集成

汇总：

```text
imports.*
analytics.*
documents.*
messaging.*
```

检查：

```text
前端显示
后端授权
RLS
```

三层一致。

---

# 6. Cross-domain Hook

## Import

```text
Opening Stock
Employee Invitation
```

与 S3.1 Integrated Branch 合并后再接。

不要在 S3.2 单独实现 IAM/Inventory 核心。

---

## Documents

各 Adapter 缺失业务 DTO：

```text
记录
```

只在最终 Mainline Integration 时补。

---

## Messaging

业务 Trigger：

```text
appointment reminder
vaccination reminder
followup reminder
lab report
```

先接稳定且已完成的 Domain。

若 S3.1 Fix 仍未结束：

```text
保留 Handoff
```

不要抢先改其文件。

---

# 7. Analytics

确认：

```text
只读
```

如发现 Analytics Migration：

```text
修改业务数据
```

必须退回。

---

# 8. Import 安全

确认：

```text
Preview/Validate 不写生产表
Execute 才写
Opening Stock 不绕过 Inventory
Employee 不绕过 IAM
```

---

# 9. Document 安全

确认：

```text
Template 无任意 JS
医疗文档权限
打印审计
Template Scope
```

---

# 10. Messaging 安全

确认：

```text
Secret 不在前端
Provider Webhook 验签
Retry 幂等
Template Variable 白名单
```

---

# 11. Build / Typecheck

完整 S3.2 合并：

```text
API typecheck
Frontend typecheck
Build
```

全部通过。

---

# 12. 与 S3.1 的最终主线合并

必须等：

```text
S3.1 Fix Integrated Branch
```

完成后：

```text
S3.1 Integrated
+
S3.2 Integrated
↓
Mainline Integration
```

最终合并顺序建议：

```text
先 S3.1
再 S3.2
```

因为：

```text
S3.1 修的是系统地基
S3.2 依赖这些地基
```

---

# 13. 冲突处理原则

如果 S3.1 和 S3.2 冲突：

```text
优先保留 S3.1 安全/权限/事务逻辑
```

然后让 S3.2 适配。

禁止：

```text
为了保留新功能
→ 回退 S3.1 Security Fix
```

---

# 14. Final Security Check

主线合并后至少检查：

```text
RPC ACL
RLS
Tenant/Store Context
Import 写边界
Document 医疗权限
Messaging Secret
Analytics Scope
```

---

# 15. 状态文档

只有最终 Mainline Integrator 才更新：

```text
IMPLEMENTATION_STATUS.md
KNOWN_GAPS.md
```

S32-E 只生成：

```text
document/s32-final/S32-INTEGRATION-REPORT.md
document/s32-final/S32-REMAINING-GAPS.md
document/s32-final/S32-MAINLINE-HANDOFF.md
```

---

# 16. 完成状态

S3.2 没有 Runtime/E2E 时只能：

```text
code_complete
integration_complete
runtime_verification_pending
```

不能：

```text
production_ready
```

---

# 17. 最终 Checklist

## Import

```text
[ ] 5 类数据
[ ] Mapping
[ ] Validate
[ ] Execute
[ ] Error
[ ] Domain Hook 安全
```

## Analytics

```text
[ ] Dashboard
[ ] Revenue
[ ] Customer
[ ] Clinical
[ ] Inventory
[ ] Scope
[ ] Timezone
```

## Documents

```text
[ ] Template
[ ] Preview
[ ] Print
[ ] Medical Permission
[ ] Audit
```

## Messaging

```text
[ ] Real Provider
[ ] Template
[ ] Delivery
[ ] Retry
[ ] Secret
[ ] Audit
```

---

# 18. 最终停止条件

发现以下任一问题：

```text
S3.2 回退 S3.1 ACL
Import 直接改库存余额
员工导入绕过 IAM
Analytics 跨 Tenant
医疗文档无权限读取
Messaging Secret 暴露
Webhook 无签名验证
```

立即停止合并，先修。

---

**你的职责是保证 S3.2 新功能进入系统时，不破坏 S3.1 已经修好的地基。**
