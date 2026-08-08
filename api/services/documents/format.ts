/**
 * S32-C 业务文档 —— 格式化工具
 * Adapter 把业务字段预格式化为展示友好字符串,渲染器只负责转义输出。
 */

/** 数值兼容(numeric 可能是字符串) */
export function toNum(v: unknown): number {
  return typeof v === 'number' ? v : Number(v ?? 0) || 0
}

/** 金额保留 2 位小数 */
export function fmtMoney(v: unknown): string {
  return toNum(v).toFixed(2)
}

/** 日期时间 YYYY-MM-DD HH:mm */
export function fmtDateTime(v?: string | null): string {
  if (!v) {
    return '-'
  }
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) {
    return String(v)
  }
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 日期 YYYY-MM-DD */
export function fmtDate(v?: string | null): string {
  if (!v) {
    return '-'
  }
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) {
    return String(v)
  }
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 布尔 → 是/否 */
export function fmtBool(v: unknown): string {
  return v ? '是' : '否'
}
