# 05 — CROSS-DOMAIN HOOKS

> S3.1 跨域 Hook 集成说明(Agent-07)

## 1. 寄养 Checkout → Billing Invoice(已集成,原子)

- **需求**:Boarding 离店生成 Billing Invoice;发票失败不得标 checked_out,禁止部分成功账务丢失。
- **实现**:`migration 91` `create or replace boarding_checkout`,在**同一事务内**先调用 `create_invoice`(draft 收款,金额=日费+服务费明细行),成功后置 checked_out + 释放笼位。
  - 发票失败 → 异常 → 整体回滚,寄养单保持未离店、笼位不释放、无孤儿发票。
  - 幂等:`idempotency_records` 检查位于发票创建之前,重试不重复计费。
  - 返回体新增 `invoiceId`。
- **边界**:寄养不套会员折扣(`p_apply_membership_discount=false`)、不触发大额审批阈值(自动计费非手动折扣);支付仍在 Cashier 另行处理。
- **事务失败策略**:`BOARDING_INVOICE_FAILED`(发票返回无 invoiceId)→ 409,前端提示重试。

## 2. Encounter 随访日期 → 自动回访(已集成,best-effort)

- **需求**:`encounters.follow_up_date` 被填 → 生成 `source_type=encounter` 的 `post_visit` 回访。
- **实现**:`api/routes/clinical.ts` 病历更新 handler 在 `followUpDate` 有值时调用 `api/lib/followup.ts::autoCreateFollowup`。
- **去重**:同 (tenant, source_type, source_id, task_type) 存在 pending/in_progress 回访则跳过。
- **失败策略**:回访为二级动作,失败仅 `console.warn`,不阻断病历保存。

## 3. Discharge Finalized → 出院回访(已集成,best-effort)

- **需求**:出院 → 生成 `source_type=discharge` 的 `post_discharge` 回访。
- **实现**:`api/routes/inpatient.ts` discharge handler 在 `discharge_patient` 成功后调用同一 helper,默认排程 +7 天。
- **去重 + 失败策略**:同 §2。出院为医疗主流程,不受回访失败影响。

## 4. 会员 → Cashier 价格计算(域内闭环,无需集成)

Agent-02 在 billing.ts(其域内)实现 `create_invoice(p_apply_membership_discount)` 服务端权威重算 + 快照落库;现金柜台选客户后预览并透传。Integrator 无需挂接。

## 5. 采购 → 库存过账(域内闭环,无需集成)

Agent-05 `post_purchase_order` 复用既有 `post_goods_receipt`(同一事务),生成批次/余额/流水,不复制库存算法;幂等 + PO 行锁。Integrator 无需挂接。

## 6. 影像 → Clinical Workbench 快捷申请(域内闭环,无需集成)

Agent-03 医生工作台「申请影像」跳转 `/diagnostics/imaging?encounterId=&petId=&customerId=` 自动预填。

## 7. 平台租户 → Global Context(域内闭环,无需集成)

Agent-01 `/api/me/context` 为唯一事实来源;平台管理员 context 列出全部租户,管理页用 service-role `GET /tenants` 看到含停用租户。
