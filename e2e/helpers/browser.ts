import fs from 'node:fs'
import process from 'node:process'
import { chromium } from '@playwright/test'

// 浏览器可用性检测结果缓存,避免每个用例重复做文件系统检查
let cachedAvailable: boolean | null = null

// 是否在 E2E_OPTIONAL 模式下(显式设置才允许跳过,默认必须失败)
function isOptional(): boolean {
  return process.env.E2E_OPTIONAL === 'true'
}

/**
 * 检测 Chromium 浏览器内核是否已安装(playwright install chromium)。
 * @returns 浏览器可用返回 true
 */
export function isChromiumAvailable(): boolean {
  if (cachedAvailable !== null) {
    return cachedAvailable
  }
  try {
    cachedAvailable = fs.existsSync(chromium.executablePath())
  }
  catch {
    cachedAvailable = false
  }
  return cachedAvailable
}

/**
 * 确保 Chromium 浏览器可用。未设置 E2E_OPTIONAL=true 时直接抛出错误,
 * 仅 E2E_OPTIONAL=true 时返回 false 允许调用方 skip。
 * @returns 浏览器可用返回 true;E2E_OPTIONAL 模式且不可用时返回 false
 */
export function ensureChromium(): boolean {
  if (isChromiumAvailable()) {
    return true
  }
  if (isOptional()) {
    return false
  }
  throw new Error(
    'Chromium 浏览器未安装,核心 E2E 测试必须执行。'
    + '请运行 "pnpm exec playwright install chromium" 安装浏览器,'
    + '或设置 E2E_OPTIONAL=true 显式跳过浏览器相关测试。',
  )
}
