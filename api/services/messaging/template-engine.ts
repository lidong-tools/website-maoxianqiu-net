import { err } from '../../lib/errors.js'

/**
 * 模板变量白名单引擎(S32-D)
 *
 * 安全原则(见 S32-D §9):
 *   - 变量必须来自白名单,禁止任意对象路径 / 函数调用 / 任意表达式
 *   - 渲染仅做精确字符串替换 `{{whitelist_key}}`,不执行任何代码
 *   - 模板 body 中出现的占位符必须全部命中白名单,否则校验失败
 */

/** 白名单变量定义 */
export interface WhitelistVariable {
  key: string
  label: string
}

/** 全局变量白名单(业务无关,跨租户共享;S32-D §8) */
export const VARIABLE_WHITELIST: readonly WhitelistVariable[] = [
  { key: 'customer.name', label: '客户姓名' },
  { key: 'customer.phone', label: '客户电话' },
  { key: 'pet.name', label: '宠物姓名' },
  { key: 'pet.species', label: '宠物种类' },
  { key: 'appointment.time', label: '预约时间' },
  { key: 'appointment.type', label: '预约类型' },
  { key: 'store.name', label: '门店名称' },
  { key: 'store.phone', label: '门店电话' },
  { key: 'store.address', label: '门店地址' },
  { key: 'doctor.name', label: '医生姓名' },
  { key: 'hospital.name', label: '医院名称' },
  { key: 'hospital.phone', label: '医院电话' },
  { key: 'hospital.address', label: '医院地址' },
  { key: 'order.total', label: '订单金额' },
] as const

const WHITELIST_KEYS = new Set(VARIABLE_WHITELIST.map(v => v.key))

/** 占位符匹配:{{ key }} 或 {{key}},key 仅允许字母/数字/点/下划线 */
const PLACEHOLDER_RE = /\{\{\s*([\w.]+)\s*\}\}/g

export interface RenderContext {
  [key: string]: string | number | boolean | null | undefined
}

/** 校验 body 中所有占位符均命中白名单;返回命中 key 集合 */
export function validateTemplatePlaceholders(body: string): string[] {
  const used = new Set<string>()
  const invalid: string[] = []
  for (const match of body.matchAll(PLACEHOLDER_RE)) {
    const key = match[1]
    if (!WHITELIST_KEYS.has(key)) {
      invalid.push(key)
    }
    else {
      used.add(key)
    }
  }
  if (invalid.length > 0) {
    throw err.unprocessable(
      `模板包含非白名单变量: ${[...new Set(invalid)].join(', ')}。可用变量: ${VARIABLE_WHITELIST.map(v => v.key).join(', ')}`,
    )
  }
  return [...used]
}

/**
 * 用白名单变量渲染模板 body/subject。
 * 仅替换白名单 key;缺失的变量渲染为空字符串(不抛错,发送前已校验必填)。
 */
export function renderTemplateText(text: string, context: RenderContext): string {
  return text.replace(PLACEHOLDER_RE, (raw, key: string) => {
    const value = context[key]
    return value === null || value === undefined ? '' : String(value)
  })
}

/** 校验发送变量:只接受白名单 key;返回可用于渲染的规范化 context */
export function normalizeVariables(raw: Record<string, unknown>): RenderContext {
  const result: RenderContext = {}
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (!WHITELIST_KEYS.has(key)) {
      throw err.unprocessable(`发送变量含非白名单 key: ${key}`)
    }
    if (value === null || value === undefined) {
      continue
    }
    if (typeof value === 'object') {
      throw err.unprocessable(`发送变量 ${key} 不允许对象/数组值(仅基础类型)`)
    }
    result[key] = String(value)
  }
  return result
}

/** 前端可用的变量白名单(不含任何逻辑,仅 key+label) */
export function listWhitelistVariables(): WhitelistVariable[] {
  return VARIABLE_WHITELIST.map(v => ({ ...v }))
}
