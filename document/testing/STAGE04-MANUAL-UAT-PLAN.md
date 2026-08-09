# Stage-04 Manual UAT 计划(Agent-01)

> 维护者:Agent-01  
> 状态:计划就绪;执行结果 Wave 3 回填至 `STAGE04-MANUAL-UAT-RESULT.md`

## 1. 原则

角色驱动验收,不是"页面点一遍"。每条 Case 必须包含 Expected UI / Expected DB / Expected Audit 三层断言,
并至少覆盖四类:**Happy Path / Validation Failure / Permission Failure / Retry-Double Click**。

## 2. Case 模板(执行时逐条填写)

```text
Case ID       : S4-UAT-xxx
Requirement   : (对应需求)
Role          : (角色)
Tenant/Store  : (租户/门店)
Preconditions : (前置)
Data Setup    : (数据准备)
Steps         : 1. ... 2. ...
Expected UI   : (页面表现)
Expected DB   : (数据库最终状态:表/行/余额/状态)
Expected Audit: (audit_logs 应出现的行为与字段)
Actual        : (实测)
Result        : PASS / FAIL / BLOCKED
Severity      : P0 / P1 / P2
Evidence      : (截图/日志/SQL)
Issue         : (Owner Agent,若有)
```

## 3. 角色与验收重点

### 3.1 管理员(platform_admin / tenant_owner)

| ID | 场景 | 断言要点 |
|---|---|---|
| S4-UAT-001 | Tenant/Store 切换后页面数据随门店刷新 | UI:数据区变化;DB:查询 store_id 收敛 |
| S4-UAT-002 | 角色/权限调整即时生效 | 改角色后旧权限操作被拒 |
| S4-UAT-003 | 会员/积分/储值设置 | DB:customer_memberships / point_transactions 为真源 |
| S4-UAT-004 | 营销发布(券/套餐/人群) | DB:发布状态;Audit:marketing.publish |
| S4-UAT-005 | Provider/渠道配置 | Secret 不落库/不落日志 |
| S4-UAT-006 | 停用租户后业务立即不可用 | DB:is_tenant_business_active=false |

### 3.2 前台/收银(cashier / store_manager)

| ID | 场景 | 断言要点 |
|---|---|---|
| S4-UAT-010 | 客户建档 + 宠物建档 | DB:customers/pets 行;customer_no 规则 |
| S4-UAT-011 | 预约 → 到店 | 状态流转(appointment) |
| S4-UAT-012 | 收银收款(含储值支付) | DB:payments + 余额;Audit:payment.process |
| S4-UAT-013 | 储值充值/退款 | 幂等:重复提交不重复扣/返 |
| S4-UAT-014 | 优惠券核销 | quota 不超发;Audit:coupon.redemption |
| S4-UAT-015 | 套餐核销 | 不重复核销 |

### 3.3 医生(doctor)

| ID | 场景 | 断言要点 |
|---|---|---|
| S4-UAT-020 | 接诊 → 病历 → 处方 | save_prescription 流转;签署人=当前登录用户 |
| S4-UAT-021 | 用药安全 Blocking 处方 | 被阻止,无法保存;Override 需权限+原因 |
| S4-UAT-022 | 用药安全 Warning | 可继续并记录 |
| S4-UAT-023 | 报告/文书生成 | 真实 DTO;PDF hash 稳定 |
| S4-UAT-024 | 保险理赔材料 | 材料可下载;跨租户不可读 |

### 3.4 库存(inventory / store_manager)

| ID | 场景 | 断言要点 |
|---|---|---|
| S4-UAT-030 | 采购申请 → 审批 | 状态机 draft→approved |
| S4-UAT-031 | 收货 → 过账 | inventory_movements 语义;余额快照不被直接改 |
| S4-UAT-032 | 采购退货两次过账 | 库存不重复减少(幂等) |
| S4-UAT-033 | Opening Stock Import | consumer 重试不重复入库 |

### 3.5 客户 C 端(portal)

| ID | 场景 | 断言要点 |
|---|---|---|
| S4-UAT-040 | 身份登录 + 宠物访问 | 未授权家庭成员看不到宠物 |
| S4-UAT-041 | 预约 + 报告可见性 | 未发布报告不可见 |
| S4-UAT-042 | 通知订阅/取消 | Consent 记录;Audit:portal.consent |

## 4. 执行环境要求

- Staging 数据库(禁止生产库)
- 独立多角色账号(platform_admin / tenant_owner / store_manager / doctor / nurse / cashier / 普通员工 / C 端)
- 每 Case 执行前记录前置 DB 状态,执行后核对 DB 与 Audit

## 5. 执行记录(待回填)

见 `STAGE04-MANUAL-UAT-RESULT.md`(Wave 3 产出,含逐条 Actual / Result / Evidence)。
