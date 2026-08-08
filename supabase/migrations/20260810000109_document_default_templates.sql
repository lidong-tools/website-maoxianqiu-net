-- ============================================================
-- S32-C 业务文档与打印中心 V2
-- migration 109: 系统默认模板种子(tenant_id is null)
-- ------------------------------------------------------------
-- 8 类业务文档默认模板,使用安全变量语法:
--   {{path}}          标量插值(HTML 转义)
--   {{#each path}}    遍历数组(块内 {{this}} 取标量项,{{field}} 相对当前项)
--   {{/each}}
-- 禁止:任意 JS 表达式 / eval / script / {{{ }}} 原样输出
-- 服务端渲染器只做白名单路径字符串替换,绝不执行代码。
-- ============================================================

-- 通用样式片段(各模板内联,保证单文件可打印)
-- 注:为可读性每个模板保留完整 <style>,字段由文档中心预览按纸型缩放。

-- 收费单(80mm 小票默认)
insert into public.document_templates
  (tenant_id, store_id, document_type, name, version, template_html, template_json, paper_size, is_default, is_active, created_by)
values
  (null, null, 'invoice', '收费单(系统默认)', 1, $DOC$
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>收费单</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: "SimSun", "Microsoft YaHei", serif; font-size: 12px; color: #333; padding: 8px; }
  .doc-header { text-align: center; margin-bottom: 10px; }
  .doc-header h1 { font-size: 16px; margin-bottom: 2px; }
  .doc-header .sub { font-size: 11px; color: #666; }
  .doc-meta { width: 100%; border-collapse: collapse; margin: 8px 0; }
  .doc-meta td { border: 1px solid #333; padding: 4px 6px; font-size: 11px; }
  .doc-table { width: 100%; border-collapse: collapse; margin: 8px 0; }
  .doc-table th, .doc-table td { border: 1px solid #333; padding: 3px 5px; font-size: 11px; }
  .doc-table th { background: #f5f5f5; }
  .num { text-align: right; }
  .doc-total { width: 100%; border-collapse: collapse; margin: 6px 0; }
  .doc-total td { border: 1px solid #333; padding: 4px 6px; font-size: 11px; }
  .doc-total .label { background: #f5f5f5; }
  .doc-footer { margin-top: 12px; font-size: 10px; color: #666; text-align: center; }
</style>
</head>
<body>
<div class="doc-header">
  <h1>{{hospital.name}}收费单</h1>
  <p class="sub">单号: {{invoice.invoiceNo}} | 状态: {{invoice.status}}</p>
</div>
<table class="doc-meta">
  <tr><td>客户: {{customer.name}} {{customer.phone}}</td></tr>
  <tr><td>宠物: {{pet.name}} {{pet.species}} {{pet.breed}} | 医生: {{doctor.name}}</td></tr>
  <tr><td>门店: {{store.name}}</td></tr>
</table>
<table class="doc-table">
  <tr><th>项目</th><th>单价</th><th>数量</th><th>金额</th></tr>
  {{#each invoice.items}}
  <tr><td>{{name}}</td><td class="num">{{unitPrice}}</td><td class="num">{{quantity}}</td><td class="num">{{amount}}</td></tr>
  {{/each}}
</table>
<table class="doc-total">
  <tr><td class="label">应收合计</td><td>{{invoice.total}}</td></tr>
  <tr><td class="label">已付</td><td>{{invoice.paidAmount}}</td></tr>
  <tr><td class="label">支付方式</td><td>{{invoice.paymentMethod}}</td></tr>
</table>
<p class="doc-footer">打印时间: {{meta.printedAt}} | 操作员: {{operator.name}}</p>
</body>
</html>
$DOC$, '{}'::jsonb, '80mm', true, true, null)
on conflict (id) do nothing;

-- 处方(A4)
insert into public.document_templates
  (tenant_id, store_id, document_type, name, version, template_html, template_json, paper_size, is_default, is_active, created_by)
values
  (null, null, 'prescription', '处方笺(系统默认)', 1, $DOC$
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>处方笺</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: "SimSun", "Microsoft YaHei", serif; font-size: 13px; color: #333; padding: 16px; }
  .doc-header { text-align: center; margin-bottom: 14px; }
  .doc-header h1 { font-size: 20px; }
  .doc-meta { width: 100%; border-collapse: collapse; margin: 10px 0; }
  .doc-meta th, .doc-meta td { border: 1px solid #333; padding: 5px 8px; font-size: 12px; }
  .doc-meta th { background: #f5f5f5; text-align: center; width: 15%; }
  .doc-table { width: 100%; border-collapse: collapse; margin: 10px 0; }
  .doc-table th, .doc-table td { border: 1px solid #333; padding: 5px 8px; font-size: 12px; }
  .doc-table th { background: #f5f5f5; }
  .doc-footer { margin-top: 20px; font-size: 12px; }
  .doc-footer .line { display: inline-block; border-bottom: 1px solid #333; padding: 0 60px; margin-left: 8px; }
</style>
</head>
<body>
<div class="doc-header"><h1>处方笺</h1></div>
<table class="doc-meta">
  <tr><th>医院</th><td>{{hospital.name}}</td><th>门店</th><td>{{store.name}}</td></tr>
  <tr><th>客户</th><td>{{customer.name}} {{customer.phone}}</td><th>宠物</th><td>{{pet.name}} {{pet.species}} {{pet.breed}} {{pet.gender}}</td></tr>
</table>
<table class="doc-table">
  <tr><th>药品</th><th>剂量</th><th>频次</th><th>天数</th><th>数量</th><th>用法</th></tr>
  {{#each prescription.items}}
  <tr><td>{{drugName}}</td><td>{{dosage}}</td><td>{{frequency}}</td><td>{{durationDays}}</td><td>{{quantity}}{{unit}}</td><td>{{instructions}}</td></tr>
  {{/each}}
</table>
<p class="doc-footer">医师: <span class="line">{{doctor.name}}</span> &nbsp;&nbsp; 日期: <span class="line">{{medicalRecord.startedAt}}</span></p>
</body>
</html>
$DOC$, '{}'::jsonb, 'A4', true, true, null)
on conflict (id) do nothing;

-- 病历摘要(A4)
insert into public.document_templates
  (tenant_id, store_id, document_type, name, version, template_html, template_json, paper_size, is_default, is_active, created_by)
values
  (null, null, 'medical_record_summary', '病历摘要(系统默认)', 1, $DOC$
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>病历摘要</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: "SimSun", "Microsoft YaHei", serif; font-size: 13px; color: #333; padding: 16px; }
  .doc-header { text-align: center; margin-bottom: 14px; }
  .doc-header h1 { font-size: 20px; }
  .doc-header .sub { font-size: 12px; color: #666; }
  .doc-meta { width: 100%; border-collapse: collapse; margin: 10px 0; }
  .doc-meta th, .doc-meta td { border: 1px solid #333; padding: 5px 8px; font-size: 12px; }
  .doc-meta th { background: #f5f5f5; text-align: center; width: 15%; }
  .doc-section { margin: 8px 0; }
  .doc-section h3 { font-size: 13px; border-bottom: 1px solid #333; padding-bottom: 2px; margin-bottom: 6px; }
  .doc-section p { font-size: 12px; line-height: 1.6; }
</style>
</head>
<body>
<div class="doc-header">
  <h1>宠物病历摘要</h1>
  <p class="sub">就诊时间: {{medicalRecord.startedAt}} | 状态: {{medicalRecord.status}}</p>
</div>
<table class="doc-meta">
  <tr><th>医院</th><td>{{hospital.name}}</td><th>门店</th><td>{{store.name}}</td></tr>
  <tr><th>客户</th><td>{{customer.name}} {{customer.phone}}</td><th>宠物</th><td>{{pet.name}} {{pet.species}} {{pet.breed}} {{pet.gender}}</td></tr>
</table>
<div class="doc-section"><h3>主诉</h3><p>{{medicalRecord.chiefComplaint}}</p></div>
<div class="doc-section"><h3>病史</h3><p>{{medicalRecord.historyPresent}}</p></div>
<div class="doc-section"><h3>检查发现</h3><p>{{medicalRecord.examFindings}}</p></div>
<div class="doc-section"><h3>诊断</h3><p>{{medicalRecord.diagnosisCodesText}}</p></div>
<div class="doc-section"><h3>治疗方案</h3><p>{{medicalRecord.treatmentPlan}}</p></div>
<div class="doc-section"><h3>复诊日期</h3><p>{{medicalRecord.followUpDate}}</p></div>
<p class="doc-footer" style="margin-top:20px;font-size:12px;">医生签署: {{doctor.name}} {{medicalRecord.signedAt}}</p>
</body>
</html>
$DOC$, '{}'::jsonb, 'A4', true, true, null)
on conflict (id) do nothing;

-- 检验报告(A4)
insert into public.document_templates
  (tenant_id, store_id, document_type, name, version, template_html, template_json, paper_size, is_default, is_active, created_by)
values
  (null, null, 'lab_report', '检验报告(系统默认)', 1, $DOC$
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>检验报告</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: "SimSun", "Microsoft YaHei", serif; font-size: 13px; color: #333; padding: 16px; }
  .doc-header { text-align: center; margin-bottom: 14px; }
  .doc-header h1 { font-size: 20px; }
  .doc-header .sub { font-size: 12px; color: #666; }
  .doc-meta { width: 100%; border-collapse: collapse; margin: 10px 0; }
  .doc-meta th, .doc-meta td { border: 1px solid #333; padding: 5px 8px; font-size: 12px; }
  .doc-meta th { background: #f5f5f5; text-align: center; width: 15%; }
  .doc-table { width: 100%; border-collapse: collapse; margin: 10px 0; }
  .doc-table th, .doc-table td { border: 1px solid #333; padding: 5px 8px; font-size: 12px; }
  .doc-table th { background: #f5f5f5; }
  .num { text-align: center; }
  .abnormal { color: #c00; font-weight: bold; }
  .doc-footer { margin-top: 16px; font-size: 12px; color: #666; }
</style>
</head>
<body>
<div class="doc-header">
  <h1>检验报告</h1>
  <p class="sub">申请单号: {{labReport.orderNo}} | 状态: {{labReport.status}}</p>
</div>
<table class="doc-meta">
  <tr><th>医院</th><td>{{hospital.name}}</td><th>门店</th><td>{{store.name}}</td></tr>
  <tr><th>客户</th><td>{{customer.name}} {{customer.phone}}</td><th>宠物</th><td>{{pet.name}} {{pet.species}} {{pet.breed}} {{pet.gender}}</td></tr>
</table>
<table class="doc-table">
  <tr><th>检验项目</th><th>结果</th><th>单位</th><th>参考范围</th></tr>
  {{#each labReport.analytes}}
  <tr><td>{{name}}</td><td class="num {{resultClass}}">{{resultDisplay}}</td><td class="num">{{unit}}</td><td class="num">{{refRange}}</td></tr>
  {{/each}}
</table>
<p class="doc-footer">申请时间: {{labReport.requestedAt}} | 完成时间: {{labReport.completedAt}}</p>
</body>
</html>
$DOC$, '{}'::jsonb, 'A4', true, true, null)
on conflict (id) do nothing;

-- 影像报告(A4)
insert into public.document_templates
  (tenant_id, store_id, document_type, name, version, template_html, template_json, paper_size, is_default, is_active, created_by)
values
  (null, null, 'imaging_report', '影像报告(系统默认)', 1, $DOC$
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>影像报告</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: "SimSun", "Microsoft YaHei", serif; font-size: 13px; color: #333; padding: 16px; }
  .doc-header { text-align: center; margin-bottom: 14px; }
  .doc-header h1 { font-size: 20px; }
  .doc-header .sub { font-size: 12px; color: #666; }
  .doc-meta { width: 100%; border-collapse: collapse; margin: 10px 0; }
  .doc-meta th, .doc-meta td { border: 1px solid #333; padding: 5px 8px; font-size: 12px; }
  .doc-meta th { background: #f5f5f5; text-align: center; width: 15%; }
  .doc-section { margin: 8px 0; }
  .doc-section h3 { font-size: 13px; border-bottom: 1px solid #333; padding-bottom: 2px; margin-bottom: 6px; }
  .doc-section p { font-size: 12px; line-height: 1.6; white-space: pre-wrap; }
</style>
</head>
<body>
<div class="doc-header">
  <h1>影像学检查报告</h1>
  <p class="sub">检查单号: {{imagingReport.orderNo}} | 类型: {{imagingReport.imagingType}} | 状态: {{imagingReport.status}}</p>
</div>
<table class="doc-meta">
  <tr><th>医院</th><td>{{hospital.name}}</td><th>门店</th><td>{{store.name}}</td></tr>
  <tr><th>客户</th><td>{{customer.name}} {{customer.phone}}</td><th>宠物</th><td>{{pet.name}} {{pet.species}} {{pet.breed}} {{pet.gender}}</td></tr>
</table>
<div class="doc-section"><h3>临床问题</h3><p>{{imagingReport.clinicalQuestion}}</p></div>
<div class="doc-section"><h3>影像所见</h3><p>{{imagingReport.findings}}</p></div>
<div class="doc-section"><h3>影像诊断意见</h3><p>{{imagingReport.impression}}</p></div>
<div class="doc-section"><h3>建议</h3><p>{{imagingReport.recommendation}}</p></div>
<p class="doc-footer" style="margin-top:20px;font-size:12px;">报告医师: {{imagingReport.authorName}} | 审核医师: {{imagingReport.reviewerName}} | 报告时间: {{imagingReport.reportStatus}}</p>
</body>
</html>
$DOC$, '{}'::jsonb, 'A4', true, true, null)
on conflict (id) do nothing;

-- 住院出院记录(A4)
insert into public.document_templates
  (tenant_id, store_id, document_type, name, version, template_html, template_json, paper_size, is_default, is_active, created_by)
values
  (null, null, 'discharge_summary', '住院出院记录(系统默认)', 1, $DOC$
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>住院出院记录</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: "SimSun", "Microsoft YaHei", serif; font-size: 13px; color: #333; padding: 16px; }
  .doc-header { text-align: center; margin-bottom: 14px; }
  .doc-header h1 { font-size: 20px; }
  .doc-header .sub { font-size: 12px; color: #666; }
  .doc-meta { width: 100%; border-collapse: collapse; margin: 10px 0; }
  .doc-meta th, .doc-meta td { border: 1px solid #333; padding: 5px 8px; font-size: 12px; }
  .doc-meta th { background: #f5f5f5; text-align: center; width: 15%; }
  .doc-section { margin: 8px 0; }
  .doc-section h3 { font-size: 13px; border-bottom: 1px solid #333; padding-bottom: 2px; margin-bottom: 6px; }
  .doc-section p { font-size: 12px; line-height: 1.6; white-space: pre-wrap; }
</style>
</head>
<body>
<div class="doc-header">
  <h1>住院出院记录</h1>
  <p class="sub">状态: {{dischargeSummary.status}}</p>
</div>
<table class="doc-meta">
  <tr><th>医院</th><td>{{hospital.name}}</td><th>门店</th><td>{{store.name}}</td></tr>
  <tr><th>客户</th><td>{{customer.name}} {{customer.phone}}</td><th>宠物</th><td>{{pet.name}} {{pet.species}} {{pet.breed}} {{pet.gender}}</td></tr>
  <tr><th>入院时间</th><td>{{dischargeSummary.admittedAt}}</td><th>出院时间</th><td>{{dischargeSummary.dischargedAt}}</td></tr>
  <tr><th>入院原因</th><td colspan="3">{{dischargeSummary.admissionReason}}</td></tr>
</table>
<div class="doc-section"><h3>出院医嘱/备注</h3><p>{{dischargeSummary.dischargeNotes}}</p></div>
<div class="doc-section"><h3>出院原因</h3><p>{{dischargeSummary.dischargeReason}}</p></div>
<table class="doc-meta">
  <tr><th>住院总费用</th><td>{{dischargeSummary.totalCharge}}</td><th>主治医生</th><td>{{dischargeSummary.doctorName}}</td></tr>
</table>
<p class="doc-footer" style="margin-top:20px;font-size:12px;">打印时间: {{meta.printedAt}} | 操作员: {{operator.name}}</p>
</body>
</html>
$DOC$, '{}'::jsonb, 'A4', true, true, null)
on conflict (id) do nothing;

-- 疫苗免疫证明(A4)
insert into public.document_templates
  (tenant_id, store_id, document_type, name, version, template_html, template_json, paper_size, is_default, is_active, created_by)
values
  (null, null, 'vaccination_certificate', '疫苗免疫证明(系统默认)', 1, $DOC$
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>疫苗免疫证明</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: "SimSun", "Microsoft YaHei", serif; font-size: 13px; color: #333; padding: 16px; }
  .doc-header { text-align: center; margin-bottom: 14px; }
  .doc-header h1 { font-size: 20px; }
  .doc-header .sub { font-size: 12px; color: #666; }
  .doc-meta { width: 100%; border-collapse: collapse; margin: 10px 0; }
  .doc-meta th, .doc-meta td { border: 1px solid #333; padding: 5px 8px; font-size: 12px; }
  .doc-meta th { background: #f5f5f5; text-align: center; width: 15%; }
  .doc-table { width: 100%; border-collapse: collapse; margin: 10px 0; }
  .doc-table th, .doc-table td { border: 1px solid #333; padding: 5px 8px; font-size: 12px; }
  .doc-table th { background: #f5f5f5; }
  .doc-footer { margin-top: 20px; font-size: 12px; color: #666; }
</style>
</head>
<body>
<div class="doc-header">
  <h1>疫苗免疫证明</h1>
  <p class="sub">证书编号: {{vaccinationCertificate.certificateNo}} | 签发时间: {{vaccinationCertificate.issuedDate}}</p>
</div>
<table class="doc-meta">
  <tr><th>医院</th><td>{{hospital.name}}</td><th>门店</th><td>{{store.name}}</td></tr>
  <tr><th>客户</th><td>{{customer.name}} {{customer.phone}}</td><th>宠物</th><td>{{pet.name}} {{pet.species}} {{pet.breed}} {{pet.gender}}</td></tr>
</table>
<table class="doc-table">
  <tr><th>疫苗名称</th><th>剂次</th><th>接种日期</th><th>批号</th><th>生产厂家</th><th>下次接种</th></tr>
  {{#each vaccinationCertificate.vaccinations}}
  <tr><td>{{vaccineName}}</td><td>{{doseNo}}</td><td>{{administeredDate}}</td><td>{{batchNo}}</td><td>{{manufacturer}}</td><td>{{nextDueDate}}</td></tr>
  {{/each}}
</table>
<p class="doc-footer">本证明仅用于免疫记录展示,请以门诊系统为准。</p>
</body>
</html>
$DOC$, '{}'::jsonb, 'A4', true, true, null)
on conflict (id) do nothing;

-- 寄养交接单(A4)
insert into public.document_templates
  (tenant_id, store_id, document_type, name, version, template_html, template_json, paper_size, is_default, is_active, created_by)
values
  (null, null, 'boarding_handover', '寄养交接单(系统默认)', 1, $DOC$
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>寄养交接单</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: "SimSun", "Microsoft YaHei", serif; font-size: 13px; color: #333; padding: 16px; }
  .doc-header { text-align: center; margin-bottom: 14px; }
  .doc-header h1 { font-size: 20px; }
  .doc-header .sub { font-size: 12px; color: #666; }
  .doc-meta { width: 100%; border-collapse: collapse; margin: 10px 0; }
  .doc-meta th, .doc-meta td { border: 1px solid #333; padding: 5px 8px; font-size: 12px; }
  .doc-meta th { background: #f5f5f5; text-align: center; width: 15%; }
  .doc-section { margin: 8px 0; }
  .doc-section h3 { font-size: 13px; border-bottom: 1px solid #333; padding-bottom: 2px; margin-bottom: 6px; }
  .doc-section p { font-size: 12px; line-height: 1.6; white-space: pre-wrap; }
  .doc-table { width: 100%; border-collapse: collapse; margin: 8px 0; }
  .doc-table th, .doc-table td { border: 1px solid #333; padding: 4px 6px; font-size: 12px; }
  .doc-table th { background: #f5f5f5; }
</style>
</head>
<body>
<div class="doc-header">
  <h1>寄养交接单</h1>
  <p class="sub">寄养单号: {{boardingHandover.boardingNo}} | 状态: {{boardingHandover.status}}</p>
</div>
<table class="doc-meta">
  <tr><th>医院</th><td>{{hospital.name}}</td><th>门店</th><td>{{store.name}}</td></tr>
  <tr><th>客户</th><td>{{customer.name}} {{customer.phone}}</td><th>宠物</th><td>{{pet.name}} {{pet.species}} {{pet.breed}} {{pet.gender}}</td></tr>
  <tr><th>入住时间</th><td>{{boardingHandover.checkInAt}}</td><th>预计离店</th><td>{{boardingHandover.expectedCheckOutAt}}</td></tr>
  <tr><th>紧急联系人</th><td>{{boardingHandover.emergencyContact.name}} {{boardingHandover.emergencyContact.phone}}</td><th>关系</th><td>{{boardingHandover.emergencyContact.relation}}</td></tr>
</table>
<div class="doc-section"><h3>饮食要求</h3><p>{{boardingHandover.dietNotes}}</p></div>
<div class="doc-section"><h3>遛放要求</h3><p>{{boardingHandover.walkingNotes}}</p></div>
<div class="doc-section"><h3>用药要求</h3><p>{{boardingHandover.medicationNotes}}</p></div>
<div class="doc-section"><h3>日常护理记录</h3>
<table class="doc-table">
  <tr><th>日期</th><th>喂食</th><th>遛放</th><th>用药</th><th>状态</th><th>备注</th></tr>
  {{#each boardingHandover.dailyRecords}}
  <tr><td>{{recordDate}}</td><td>{{feeding}}</td><td>{{walking}}</td><td>{{medication}}</td><td>{{condition}}</td><td>{{note}}</td></tr>
  {{/each}}
</table>
</div>
<table class="doc-meta">
  <tr><th>寄养费用</th><td>{{boardingHandover.totalCharge}}</td><th>疫苗已核验</th><td>{{boardingHandover.vaccineVerified}}</td></tr>
</table>
<p class="doc-footer" style="margin-top:20px;font-size:12px;">打印时间: {{meta.printedAt}} | 操作员: {{operator.name}}</p>
</body>
</html>
$DOC$, '{}'::jsonb, 'A4', true, true, null)
on conflict (id) do nothing;
