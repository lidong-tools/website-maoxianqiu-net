import type { InsuranceSnapshot } from './types.js'

/**
 * Stage-04 Agent-06 — 理赔包 PDF 安全 HTML 渲染
 *
 * 约束(文档 §7 SSRF 防护):
 *   - 输出为自包含 HTML(内联 CSS),不引用任何外部资源/URL;
 *   - 所有业务值经 escapeHtml 转义,阻断注入;
 *   - 不加载 http/https/file 资源,配合 PdfProvider 默认禁止网络资源,双重防护。
 */

/** HTML 转义(阻断业务数据注入) */
function esc(v: unknown): string {
  if (v === null || v === undefined) {
    return ''
  }
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 日期展示(截取日期部分) */
function fmtDate(v?: string): string {
  if (!v) {
    return '-'
  }
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) {
    return v.slice(0, 10)
  }
  return d.toLocaleDateString('zh-CN')
}

/** 每份文档的摘要行(必要字段) */
function documentSummary(doc: { sourceType: string, title: string, content: Record<string, unknown> }): Array<{ label: string, value: string }> {
  const c = doc.content
  switch (doc.sourceType) {
    case 'prescription':
      return [{ label: '状态', value: esc(c.status) }, { label: '时间', value: fmtDate(c.createdAt as string | undefined) }]
    case 'invoice':
      return [
        { label: '单号', value: esc(c.invoiceNo) },
        { label: '金额', value: `¥${esc(c.total)}` },
        { label: '状态', value: esc(c.status) },
      ]
    case 'lab_report':
      return [{ label: '单号', value: esc(c.orderNo) }, { label: '状态', value: esc(c.status) }]
    case 'imaging_report':
      return [
        { label: '单号', value: esc(c.orderNo) },
        { label: '类型', value: esc(c.imagingType) },
        { label: '状态', value: esc(c.status) },
      ]
    case 'discharge_summary':
      return [
        { label: '状态', value: esc(c.status) },
        { label: '出院时间', value: fmtDate(c.dischargedAt as string | undefined) },
      ]
    case 'vaccination_certificate':
      return [{ label: '证书号', value: esc(c.certificateNo) }, { label: '状态', value: esc(c.status) }]
    default:
      return [{ label: '状态', value: esc(c.status) }]
  }
}

/**
 * 将理赔快照渲染为自包含 HTML(供 PdfProvider 生成 PDF)
 */
export function renderInsuranceClaimHtml(snapshot: InsuranceSnapshot): string {
  const store = snapshot.store
  const customer = snapshot.customer
  const pet = snapshot.pet
  const enc = snapshot.encounter

  const docRows = snapshot.documents
    .map((doc) => {
      const summaries = documentSummary(doc)
        .map(s => `<span class="kv"><em>${s.label}</em>${s.value}</span>`)
        .join('')
      return `
        <div class="doc-row">
          <div class="doc-title">${esc(doc.title)}</div>
          <div class="doc-meta">${summaries}</div>
        </div>`
    })
    .join('\n')

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<title>保险理赔材料-${esc(snapshot.pack.packNo)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: "Microsoft YaHei", "PingFang SC", Arial, sans-serif; color: #1f2937; font-size: 13px; line-height: 1.6; padding: 32px; }
  h1 { font-size: 20px; text-align: center; margin-bottom: 4px; }
  .sub { text-align: center; color: #6b7280; font-size: 12px; margin-bottom: 20px; }
  .block { border: 1px solid #e5e7eb; border-radius: 6px; padding: 14px 16px; margin-bottom: 16px; }
  .block h2 { font-size: 14px; margin-bottom: 10px; border-left: 3px solid #2563eb; padding-left: 8px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 24px; }
  .grid .full { grid-column: 1 / -1; }
  .kv { margin-right: 16px; }
  .kv em { font-style: normal; color: #6b7280; margin-right: 4px; }
  .doc-row { border-bottom: 1px dashed #e5e7eb; padding: 8px 0; }
  .doc-row:last-child { border-bottom: 0; }
  .doc-title { font-weight: 600; }
  .doc-meta { color: #4b5563; margin-top: 2px; }
  .footer { text-align: center; color: #9ca3af; font-size: 11px; margin-top: 24px; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th, td { border: 1px solid #e5e7eb; padding: 6px 8px; text-align: left; font-size: 12px; }
  th { background: #f9fafb; }
</style>
</head>
<body>
  <h1>宠物医疗保险理赔材料</h1>
  <div class="sub">单号: ${esc(snapshot.pack.packNo)} · 版本: v${esc(snapshot.pack.version)} · 生成时间: ${fmtDate(snapshot.pack.generatedAt)}</div>

  <div class="block">
    <h2>医院与门店</h2>
    <div class="grid">
      <div class="kv"><em>医院</em>${esc(snapshot.hospital.name)}</div>
      <div class="kv"><em>门店</em>${store ? esc(store.name) : '-'}</div>
      ${store?.code ? `<div class="kv"><em>门店编码</em>${esc(store.code)}</div>` : ''}
      ${store?.address ? `<div class="kv full"><em>地址</em>${esc(store.address)}</div>` : ''}
      ${store?.phone ? `<div class="kv"><em>电话</em>${esc(store.phone)}</div>` : ''}
    </div>
  </div>

  <div class="block">
    <h2>客户与宠物</h2>
    <div class="grid">
      <div class="kv"><em>客户</em>${customer ? esc(customer.name) : '-'}</div>
      <div class="kv"><em>联系电话</em>${customer?.phone ? esc(customer.phone) : '-'}</div>
      <div class="kv"><em>宠物</em>${pet ? esc(pet.name) : '-'}</div>
      <div class="kv"><em>品种</em>${pet?.species ? `${esc(pet.species)} ${pet.breed ? esc(pet.breed) : ''}` : '-'}</div>
    </div>
  </div>

  ${enc ? `
  <div class="block">
    <h2>就诊信息</h2>
    <div class="grid">
      <div class="kv"><em>就诊时间</em>${fmtDate(enc.startedAt)}</div>
      <div class="kv"><em>接诊医生</em>${enc.doctorName ? esc(enc.doctorName) : '-'}</div>
      <div class="kv full"><em>主诉</em>${esc(enc.chiefComplaint ?? '-')}</div>
      <div class="kv full"><em>诊断</em>${esc(enc.diagnosisText ?? '-')}</div>
    </div>
  </div>` : ''}

  <div class="block">
    <h2>材料清单(${snapshot.documents.length} 项)</h2>
    ${docRows || '<div class="kv">暂无已发布材料</div>'}
  </div>

  <div class="footer">本材料由门店系统自动生成,仅供保险理赔申请使用。</div>
</body>
</html>`
}
