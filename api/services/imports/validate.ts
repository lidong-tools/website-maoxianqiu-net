/**
 * S32-A 导入中心 V2 —— 每类数据的行校验
 *
 * 校验是"每类独立"的：必填项、枚举、数值/日期/布尔类型、以及跨表引用
 * （主人 / 商品 / 仓库 / 类目）都按类型各自定义，禁止 Generic 一套逻辑。
 */
import type { ImportRow } from './parse.js'
import { fieldValue, toArray, toBoolean, toDate, toNumber } from './parse.js'
import type { FieldDef, ImportTypeMeta } from './fields.js'
import type { LookupContext } from './lookup.js'

export interface RowError {
  rowNumber: number
  field?: string
  code: string
  message: string
  rawData?: Record<string, string>
}

export interface Scope {
  tenantId: string
  storeId?: string | null
}

/** 枚举值 → 键：输入可能是键(male)或中文标签(公) */
export function enumKey(enumObj: Record<string, string>, value: string): string | null {
  const v = value.trim()
  if (!v) {
    return null
  }
  if (v in enumObj) {
    return v
  }
  const found = Object.entries(enumObj).find(([, label]) => label === v)
  return found ? found[0] : null
}

/** 按主人编号/手机号解析 customer_id */
export function resolveOwnerId(ctx: LookupContext, ownerNo: string, ownerPhone: string): string | null {
  if (ownerNo) {
    const byNo = ctx.customersByNo.get(ownerNo.trim())
    if (byNo) {
      return byNo
    }
  }
  if (ownerPhone) {
    const byPhone = ctx.customersByPhone.get(ownerPhone.trim())
    if (byPhone) {
      return byPhone
    }
  }
  return null
}

function checkFieldType(
  errors: RowError[],
  rowNumber: number,
  field: FieldDef,
  value: string,
): void {
  if (value === '') {
    return
  }
  switch (field.type) {
    case 'number':
    case 'int': {
      const n = toNumber(value)
      if (n === null) {
        errors.push({ rowNumber, field: field.key, code: 'INVALID_NUMBER', message: `${field.label}不是有效数字` })
      }
      break
    }
    case 'date': {
      if (toDate(value) === null) {
        errors.push({ rowNumber, field: field.key, code: 'INVALID_DATE', message: `${field.label}日期格式无效(应为 YYYY-MM-DD)` })
      }
      break
    }
    case 'boolean': {
      if (toBoolean(value) === null) {
        errors.push({ rowNumber, field: field.key, code: 'INVALID_BOOLEAN', message: `${field.label}应为 是/否/true/false/1/0` })
      }
      break
    }
    default:
      break
  }
}

/** 校验一行（mapped 已按映射抽取）。返回错误列表，空数组 = 合法 */
export function validateRow(
  meta: ImportTypeMeta,
  row: ImportRow,
  mapped: Record<string, string>,
  ctx: LookupContext,
  scope: Scope,
): RowError[] {
  const errors: RowError[] = []
  const push = (field: string | undefined, code: string, message: string) => {
    errors.push({ rowNumber: row.rowNumber, field, code, message, rawData: row.cells })
  }

  // 通用字段校验
  for (const field of meta.fields) {
    const value = fieldValue(meta.fields, field.key, mapped)
    if (field.required && value === '') {
      push(field.key, 'REQUIRED', `${field.label}必填`)
      continue
    }
    if (value !== '' && field.enum) {
      if (enumKey(field.enum, value) === null) {
        push(field.key, 'INVALID_ENUM', `${field.label}取值无效: ${value}`)
      }
    }
    if (field.type === 'string[]') {
      // 数组字段不做强校验
    }
    checkFieldType(errors, row.rowNumber, field, value)
  }

  // ===== 类型专属规则 =====
  const v = (k: string) => fieldValue(meta.fields, k, mapped)

  switch (meta.type) {
    case 'customer': {
      // 手机号若提供，去掉空格后必须合法(11 位数字可选)
      const phone = v('phone')
      if (phone && !/^[0-9+\-\s]{5,20}$/.test(phone)) {
        push('phone', 'INVALID_PHONE', '手机号格式疑似不正确')
      }
      break
    }
    case 'pet': {
      const ownerNo = v('ownerNo')
      const ownerPhone = v('ownerPhone')
      if (!ownerNo && !ownerPhone) {
        push('ownerPhone', 'REQUIRED_OWNER', '主人手机号 / 主人客户编号 至少填写一项')
      }
      else if (!resolveOwnerId(ctx, ownerNo, ownerPhone)) {
        push('ownerPhone', 'OWNER_NOT_FOUND', '未找到匹配的主人（请核对手机号/客户编号）')
      }
      break
    }
    case 'catalog-item': {
      const catCode = v('categoryCode')
      if (catCode && !ctx.categoriesByCode.get(catCode.trim())) {
        push('categoryCode', 'CATEGORY_NOT_FOUND', `类目编码不存在: ${catCode}`)
      }
      break
    }
    case 'employee': {
      const email = v('email').trim()
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        push('email', 'INVALID_EMAIL', '邮箱格式无效')
      }
      break
    }
    case 'opening-stock': {
      const catalogCode = v('catalogCode')
      const warehouseCode = v('warehouseCode')
      const qty = toNumber(v('quantity'))
      if (catalogCode && !ctx.catalogByCode.get(catalogCode.trim())) {
        push('catalogCode', 'CATALOG_NOT_FOUND', `商品编码不存在: ${catalogCode}`)
      }
      if (warehouseCode) {
        const wid = resolveWarehouseId(ctx, scope, warehouseCode)
        if (!wid) {
          push('warehouseCode', 'WAREHOUSE_NOT_FOUND', `仓库编码不存在: ${warehouseCode}`)
        }
      }
      if (qty !== null && qty <= 0) {
        push('quantity', 'INVALID_QUANTITY', '期初数量必须大于 0')
      }
      if (v('quantity') && qty === null) {
        push('quantity', 'INVALID_NUMBER', '数量不是有效数字')
      }
      break
    }
    default:
      break
  }

  return errors
}

/** 按作用域解析仓库 id（门店优先，再租户级） */
export function resolveWarehouseId(ctx: LookupContext, scope: Scope, code: string): string | null {
  const c = code.trim()
  if (!c) {
    return null
  }
  if (scope.storeId) {
    const hit = ctx.warehousesByCode.get(`${scope.tenantId}:${scope.storeId}:${c}`)
    if (hit) {
      return hit
    }
  }
  return ctx.warehousesByCode.get(`${scope.tenantId}::${c}`) ?? null
}

/** 校验整批，返回错误列表（含 rowNumber） */
export function validateRows(
  meta: ImportTypeMeta,
  rows: ImportRow[],
  mapping: Record<string, string>,
  ctx: LookupContext,
  scope: Scope,
): RowError[] {
  const all: RowError[] = []
  for (const row of rows) {
    const mapped = applyMapped(row, mapping)
    const errs = validateRow(meta, row, mapped, ctx, scope)
    for (const e of errs) {
      all.push(e)
    }
  }
  return all
}

/** 应用映射（供 validate/execute 共用） */
export function applyMapped(row: ImportRow, mapping: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, header] of Object.entries(mapping)) {
    if (!header) {
      continue
    }
    const val = row.cells[header]
    out[key] = val === undefined ? '' : val.trim()
  }
  return out
}
