import fs from 'node:fs'
import { chromium } from '@playwright/test'

// 浏览器可用性检测结果缓存,避免每个用例重复做文件系统检查
let cachedAvailable: boolean | null = null

/**
 * 检测 Chromium 浏览器内核是否已安装(playwright install chromium)。
 * 浏览器未安装时 executablePath() 指向的路径不存在或直接抛错,
 * 测试可据此 test.skip,保证 CI 等无浏览器环境下用例可被收集但不执行。
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
