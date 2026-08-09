# 回滚 Runbook（ROLLBACK-RUNBOOK）

> Agent-02 交付。Stage-04 并发开发期间与生产发布后的回滚预案。

## 1. 回滚类型判定

| 场景 | 可只回滚 App | 需同时回滚 DB |
|---|---|---|
| ESM / 打包 / 运行时 500 | ✅ 是 | 否 |
| 前端页面/路由问题 | ✅ 是 | 否 |
| 新 Migration 不向后兼容（删列/改约束） | ❌ 否 | ✅ 必须 |
| Provider 配置（Messaging/R2）错配 | ✅ 是（改配置即可） | 否 |

## 2. 回滚 App（Vercel）

```text
1. Vercel Dashboard → Deployments → 选择"上一个已知良好 Deployment"
2. 打开其右侧菜单 → Redeploy（勾选"使用相同的构建/环境变量"）
3. 等待构建完成，执行 scripts/release-smoke.ts --base <URL> 验证
4. 确认 /api/health 200、protected route 401（而非 500）
```

注意：

- 上一个 Deployment 的代码必须是**同一 main 分支、且其依赖的 Migration 仍存在于数据库**。
- 若目标 Deployment 早于本次 DB Migration，回滚 App 后新表/新列查询会 4xx（缺表/缺列），属预期，需按 §4 决定是否回滚 DB。

## 3. 回滚 Database Migration

### 前置判断：是否 backward compatible

```text
- 本次 Migration 是否只新增表/列/索引/函数（无破坏性变更）？
  → 是：可只回滚 App，DB 保留新结构（推荐，避免数据丢失）
  → 否：按下方"破坏性变更"处理
```

### 破坏性变更（删表/删列/改类型/收紧约束）

```text
1. 保留现场：pg_dump 受影响表数据（临时表）
2. 反向迁移：编写 rollback SQL（撤销本次 Migration 的 DDL）
   - 严禁修改/删除已执行的迁移文件；rollback SQL 单独执行
3. 执行后核对：缺失对象清单 = 本次 Migration 新增对象清单
4. 同步恢复：受影响数据从临时表恢复
```

### 非破坏性变更（推荐做法）

```text
- 保留新表/新列（避免数据丢失）
- 只回滚 App 代码到旧版本（旧代码不读新结构即可）
- 若旧代码与新结构冲突（如 NOT NULL 无默认值的新列），
  需先给新列补默认值再回滚 App
```

## 4. Provider 配置回滚

```text
- Messaging：还原 MESSAGING_PROVIDER / MESSAGING_API_KEY / MESSAGING_SENDER 为上一版本配置
  → 立即生效（config.ts 每次调用读取）
- R2：还原 R2_* 为上一版本（错误桶/密钥会导致 files-v2 上传下载失败）
- 改配置后重新部署一次 App（Vercel Env 变更需 Redeploy 生效）
```

## 5. 回滚验证清单

```text
- GET /api/health → 200，commitSha 显示回滚后的提交
- GET /api/me/context（无 token）→ 401（不是 500）
- 业务冒烟：Agent-01 Runtime Gate / E2E 通过
- DB 关键表存在性抽查（特别是新 Migration 涉及的领域）
- release-preflight --strict 通过
```

## 6. 纪律

```text
- 禁止在回滚时 reset --hard / rebase 篡改历史
- 回滚后仍保留本次 commit（便于修复后重新发布）
- 回滚动作全部记录到本 runbook 的"回滚记录"小节（日期、deployment、原因）
```
