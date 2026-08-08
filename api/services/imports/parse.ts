/**
 * S32-A 导入中心 V2 —— 表格 → 结构化行 / 默认字段映射
 */
import type { FieldDef, ImportJobType, ImportTypeMeta } from './fields'
import { normalizeKey } from './fields'

export interface ImportRow {
  /** 数据在源表格中的行号（1 基，表头为第 1 行） */
  rowNumber: number
  /** 源表头 → 原始值 */
  cells: Record<string, string>
}

export interface ParsedFile {
  headers: string[]
  rows: ImportRow[]
}

function isBlankCell(v: string): boolean {
  return v == null || v.trim() === ''
}

/** 判断一行是否应跳过（整行空白 或 以 # 开头被视为注释/图例行） */
function isSkippableRow(cells: string[]): boolean {
  const trimmed = cells.map(c => c.trim())
  if (trimmed.every(c => c === '')) {
    return true
  }
  return trimmed[0].startsWith('#')
}

/** 归一化表头：去 *、去空白、空表头给占位名 */
function normalizeHeader(raw: string, index: number): string {
  const t = raw.trim().replace(/\*+/g, '').trim()
  return t === '' ? `列${index + 1}` : t
}

/**
 * 将解析后的二维表转为 { headers, rows }
 * - 首个非空/非注释行为表头
 * - # 行与整行空白行跳过
 * - 重复表头自动加后缀 _2/_3
 */
export function parseImportRows(table: string[][]): ParsedFile {
  let headerIndex = -1
  for (let i = 0; i < table.length; i++) {
    if (!isSkippableRow(table[i])) {
      headerIndex = i
      break
    }
  }
  if (headerIndex === -1) {
    return { headers: [], rows: [] }
  }

  const rawHeaders = table[headerIndex]
  const seen = new Map<string, number>()
  const headers: string[] = rawHeaders.map((raw, idx) => {
    let name = normalizeHeader(raw, idx)
    const count = seen.get(name) ?? 0
    if (count > 0) {
      name = `${name}_${count + 1}`
    }
    seen.set(name, count + 1)
    return name
  })

  const rows: ImportRow[] = []
  for (let i = headerIndex + 1; i < table.length; i++) {
    const cells = table[i]
    if (isSkippableRow(cells)) {
      continue
    }
    const record: Record<string, string> = {}
    for (let h = 0; h < headers.length; h++) {
      record[headers[h]] = h < cells.length ? cells[h] : ''
    }
    rows.push({ rowNumber: i + 1, cells: record })
  }

  return { headers, rows }
}

/**
 * 根据表头构建默认字段映射：字段 label/别名 与表头归一化后精确匹配
 * 返回 { [fieldKey]: sourceHeader }
 */
export function buildDefaultMapping(meta: ImportTypeMeta, headers: string[]): Record<string, string> {
  const mapping: Record<string, string> = {}
  const headerByNorm = new Map<string, string>()
  for (const h of headers) {
    headerByNorm.set(normalizeKey(h), h)
  }
  for (const field of meta.fields) {
    const candidates = [field.label, ...(field.aliases ?? [])].map(normalizeKey)
    for (const c of candidates) {
      const hit = headerByNorm.get(c)
      if (hit) {
        mapping[field.key] = hit
        break
      }
    }
  }
  return mapping
}

/** 应用映射：row.cells → { [fieldKey]: 值 } */
export function applyMapping(row: ImportRow, mapping: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, header] of Object.entries(mapping)) {
    if (!header) {
      continue
    }
    const v = row.cells[header]
    if (v !== undefined) {
      out[key] = v
    }
  }
  return out
}

/** 按字段定义取归一化值（去首尾空白） */
export function fieldValue(fields: FieldDef[], key: string, mapped: Record<string, string>): string {
  void fields
  const v = mapped[key]
  return v == null ? '' : v.trim()
}

/** 布尔值归一化：是/否、true/false、1/0、Y/N */
export function toBoolean(v: string): boolean | null {
  const s = v.trim().toLowerCase()
  if (['是', 'true', '1', 'y', 'yes'].includes(s)) {
    return true
  }
  if (['否', 'false', '0', 'n', 'no'].includes(s)) {
    return false
  }
  return null
}

/** 数字归一化：去千分位逗号、支持负号 */
export function toNumber(v: string): number | null {
  const s = v.trim().replace(/,/g, '')
  if (s === '') {
    return null
  }
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/** 日期归一化：YYYY-MM-DD / YYYY/M/D / Date 字符串 → YYYY-MM-DD */
export function toDate(v: string): string | null {
  const s = v.trim()
  if (s === '') {
    return null
  }
  const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s)
  if (m) {
    const y = m[1]
    const mo = m[2].padStart(2, '0')
    const d = m[3].padStart(2, '0')
    return `${y}-${mo}-${d}`
  }
  // Excel 序列日期（1900 体系，仅当纯数字且范围合理）
  const num = Number(s)
  if (Number.isFinite(num) && num > 25569 && num < 80000) {
    const ms = Math.round((num - 25569) * 86400 * 1000)
    return new Date(ms).toISOString().slice(0, 10)
  }
  const date = new Date(s)
  if (Number.isNaN(date.getTime())) {
    return null
  }
  const y = date.getFullYear()
  const mo = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${mo}-${d}`
}

/** 逗号分隔 → 数组（去空、去重） */
export function toArray(v: string): string[] {
  return [...new Set(v.split(/[,，;；]/).map(s => s.trim()).filter(Boolean))]
}

export function isValidType(type: string): type is ImportJobType {
  return ['customer', 'pet', 'catalog-item', 'employee', 'opening-stock'].includes(type)
}
