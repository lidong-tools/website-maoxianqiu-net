> 项目：毛线球宠物医院 SaaS  
> 阶段：Stage-03 / S3.2 并发功能开发  
> 基线：在 S3.1 Fix Pipeline 仍独立执行的前提下，从当前稳定 Main/Base Commit 创建本批 Feature 分支。  
> 核心原则：**S3.2 Agent 不得修改 S3.1 Fix 正在修复的 IAM、Billing 核心、Clinical 核心、Inventory 核心安全边界。**  
> E2E：继续独立运行。本批 Agent 不修改 `e2e/**`。  
> 文件 Ownership：一个生产文件只能有一个写入 Owner；跨域需求只能写 Handoff，不得直接修改其他 Agent 所属文件。  

# S32-A — 数据导入中心 V2

## 1. 目标

把当前 Import Center 从“上传任务入口”升级成真实数据迁移工具。

首批支持：

```text
客户
宠物
商品/药品
员工
库存期初
```

---

# 2. Ownership

```text
api/routes/imports.ts
api/services/imports/**
apps/maoxianqiu/src/views/operations/imports/**
apps/maoxianqiu/src/api/modules/imports*
apps/maoxianqiu/src/types/imports*
apps/maoxianqiu/src/components/imports/**
```

Migration：

```text
100–103
```

禁止修改：

```text
inventory.ts
billing.ts
clinical.ts
permission helpers
e2e/**
```

---

# 3. 产品流程

```text
1 选择数据类型
2 下载模板
3 上传 CSV / XLSX
4 字段映射
5 数据预览
6 数据校验
7 重复数据策略
8 执行导入
9 查看结果
```

---

# 4. 数据模型

优先复用现有 import task。

如果现有表不足，允许新增：

```text
import_jobs
import_job_errors
```

建议：

### import_jobs

```text
id
tenant_id
store_id nullable
type
file_id
status
mapping jsonb
duplicate_strategy
total_rows
valid_rows
invalid_rows
success_rows
failed_rows
created_by
created_at
started_at
finished_at
error_summary
```

状态：

```text
uploaded
mapped
validated
queued
processing
completed
failed
cancelled
```

### import_job_errors

```text
id
import_job_id
row_number
field
code
message
raw_data jsonb
created_at
```

---

# 5. 模板

首批模板：

```text
customers.xlsx
pets.xlsx
catalog-items.xlsx
employees.xlsx
opening-stock.xlsx
```

模板必须：

- 中文表头；
- 示例值；
- 必填标识；
- 字段说明；
- 枚举说明。

---

# 6. Preview

上传后不能直接写数据库。

必须：

```text
Parse
↓
Preview
↓
Validate
↓
User Confirm
↓
Execute
```

Preview 至少展示：

```text
前 20 行
字段映射
错误数量
重复数量
```

---

# 7. Duplicate Strategy

至少：

```text
skip
update
create_duplicate
```

但不同数据类型策略不同。

客户：

```text
手机号
客户编号
```

宠物：

```text
主人 + 宠物名
芯片号
```

商品：

```text
SKU
编码
```

员工：

```text
邮箱
员工编号
```

库存：

```text
SKU + Warehouse + Batch
```

禁止 Generic 逻辑一套套全部。

---

# 8. 库存导入边界

库存期初不能：

```text
Import Agent 直接 update stock balance
```

正确：

```text
Import Validation
↓
形成 Opening Stock Command
↓
最终调用既有 Inventory Command / RPC
```

如果需要跨域调用：

```text
写 S32-A-HANDOFF
```

由 Integrator 接。

---

# 9. 员工导入边界

员工导入涉及：

```text
Auth
Invitation
Role
Store Assignment
```

本 Agent 不修改 IAM。

MVP 允许：

```text
解析 + 校验 + 生成待邀请员工
```

最终邀请动作通过 Handoff 接 IAM API。

---

# 10. API

```http
GET  /api/imports/templates/:type
POST /api/imports/upload
POST /api/imports/:id/mapping
POST /api/imports/:id/validate
POST /api/imports/:id/start
GET  /api/imports/:id
GET  /api/imports/:id/errors
POST /api/imports/:id/cancel
```

---

# 11. UI

```text
Import Center
├ 新建导入
├ 进行中
├ 历史
└ 失败任务
```

新建导入使用：

```text
Stepper
```

不要大量 Modal 套 Modal。

---

# 12. 文件处理

上传复用现有：

```text
R2 / files
```

不要存：

```text
base64
```

Excel/CSV 解析尽量在后端执行。

---

# 13. 权限

建议：

```text
imports.view
imports.create
imports.execute
imports.cancel
```

不要复用：

```text
system.manage
```

作为万能权限。

---

# 14. 审计

至少：

```text
upload
validate
start
complete
cancel
```

对于真正写入业务数据：

```text
各 Domain Command 继续产生自己的 Audit
```

---

# 15. 验收

```text
[ ] 5 类模板
[ ] 上传
[ ] Mapping
[ ] Preview
[ ] Validate
[ ] Duplicate Strategy
[ ] Execute
[ ] Error Detail
[ ] Result Summary
[ ] 文件下载
[ ] Tenant Scope
[ ] Permission
[ ] Audit
[ ] Inventory 不直接写余额
[ ] Employee 不绕过 IAM
[ ] Typecheck
[ ] Build
```

---

# 16. Handoff

```text
document/s32-handoff/S32-A-HANDOFF.md
```

必须说明：

```text
Opening Stock Hook
Employee Invitation Hook
Permission Codes
新增 Migration
```
