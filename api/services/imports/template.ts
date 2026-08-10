/**
 * S32-A 导入中心 V2 —— 模板生成
 *
 * 模板内容要求（S32-A §5）：中文表头、示例值、必填标识、字段说明、枚举说明。
 * 结构：
 *   第 1 行：表头（必填项带 *）
 *   后续：# 开头的图例行（示例 / 字段说明 / 枚举说明）
 *   # 行在解析时会被跳过，用户只需在表头下填入数据即可。
 */
import type { ImportTypeMeta } from './fields.js'
import { buildXlsx } from './codec.js'

const EXAMPLES: Record<string, string[]> = {
  'customer': ['C-20260808-001', '张三', '13800000000', '男', 'zhangsan@example.com', '北京市朝阳区', '1990-01-01', '银卡', '老客户'],
  'pet': ['13800000000', '', '旺财', 'dog', '金毛', '公', '2020-05-01', '12.5', 'CHIP0001', '金色', '是', 'allergy', '注意饮食'],
  'catalog-item': ['D0001', '阿莫西林胶囊', '药品', 'MED', '盒', '25.00', '15.00', '是', '抗生素'],
  'employee': ['zhang@hospital.com', '张医生', '13800000000', 'E001', '主治医师', 'veterinarian', '主院'],
  'opening-stock': ['D0001', 'WH-01', 'B20260808', '100', '15.00', '2026-12-31'],
}

/** 生成模板二维表（首行为表头，后续为 # 图例行） */
export function buildTemplateRows(meta: ImportTypeMeta): string[][] {
  const headers = meta.fields.map(f => (f.required ? `${f.label}*` : f.label))
  const rows: string[][] = [headers]

  const example = EXAMPLES[meta.type]
  if (example) {
    rows.push([`#示例: ${example.join(' | ')}`])
  }

  for (const f of meta.fields) {
    const req = f.required ? '（必填）' : ''
    rows.push([`#字段: ${f.label}${req}（${f.key}）${f.description ? `，${f.description}` : ''}`])
    if (f.enum) {
      const items = Object.entries(f.enum).map(([k, l]) => `${l}=${k}`)
      rows.push([`#枚举(${f.label}): ${items.join('，')}`])
    }
  }
  return rows
}

/** 生成 .xlsx 模板字节 */
export function buildTemplateXlsx(meta: ImportTypeMeta): Buffer {
  return buildXlsx(buildTemplateRows(meta), `${meta.label}导入模板`)
}

/** 生成 .csv 模板字节（UTF-8 BOM，Excel 可直接打开） */
export function buildTemplateCsv(meta: ImportTypeMeta): Buffer {
  const lines: string[] = []
  const rows = buildTemplateRows(meta)
  for (const r of rows) {
    if (r[0].startsWith('#')) {
      // 图例行：单单元格，避免逗号分隔被误读为多列
      lines.push(r[0])
    }
    else {
      lines.push(r.join(','))
    }
  }
  const bom = '﻿'
  return Buffer.from(`${bom + lines.join('\r\n')}\r\n`, 'utf8')
}
