/**
 * S32-B CSV 导出构建器
 *
 * 不引入额外依赖,手工转义:字段含逗号/引号/换行时加引号包裹,内部引号翻倍。
 */

export interface CsvColumn {
  label: string
  key: string
}

function escapeCell(value: unknown): string {
  const s = value == null ? '' : String(value)
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

/** 生成 CSV 文本(UTF-8 BOM 前缀,便于 Excel 直接打开中文) */
export function toCsv(columns: CsvColumn[], rows: Array<Record<string, unknown>>): string {
  const header = columns.map(c => escapeCell(c.label)).join(',')
  const body = rows.map(row =>
    columns.map(c => escapeCell(row[c.key])).join(','),
  ).join('\r\n')
  return `﻿${header}\r\n${body}\r\n`
}

/** 文件名安全化(替换非法字符) */
export function safeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '-').slice(0, 80)
}
