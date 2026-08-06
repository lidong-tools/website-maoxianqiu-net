import dayjs from '@/utils/dayjs'

/**
 * 金额格式化。金额一律以 numeric(18,2) 分单位存储服务端契约,
 * 前端展示按元格式化;禁止使用浮点参与业务计算。
 */
export function formatMoney(value?: number | string | null, currency = '¥'): string {
  if (value === null || value === undefined || value === '') {
    return '-'
  }
  const num = Number(value)
  if (Number.isNaN(num)) {
    return '-'
  }
  return `${currency}${num.toFixed(2)}`
}

/** 日期格式化,空值返回占位符 */
export function formatDate(value?: string | number | Date | null, placeholder = '-'): string {
  if (!value) {
    return placeholder
  }
  const d = dayjs(value)
  return d.isValid() ? d.format('YYYY-MM-DD') : placeholder
}

/** 日期时间格式化,空值返回占位符 */
export function formatDateTime(value?: string | number | Date | null, placeholder = '-'): string {
  if (!value) {
    return placeholder
  }
  const d = dayjs(value)
  return d.isValid() ? d.format('YYYY-MM-DD HH:mm') : placeholder
}

/** 相对时间,空值返回占位符 */
export function formatRelative(value?: string | number | Date | null, placeholder = '-'): string {
  if (!value) {
    return placeholder
  }
  const d = dayjs(value)
  if (!d.isValid()) {
    return placeholder
  }
  const now = dayjs()
  const diffMin = now.diff(d, 'minute')
  if (diffMin < 1) {
    return '刚刚'
  }
  if (diffMin < 60) {
    return `${diffMin} 分钟前`
  }
  const diffHour = now.diff(d, 'hour')
  if (diffHour < 24) {
    return `${diffHour} 小时前`
  }
  return d.format('YYYY-MM-DD')
}
