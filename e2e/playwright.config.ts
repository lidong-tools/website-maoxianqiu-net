import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { defineConfig, devices } from '@playwright/test'

// 当前文件所在目录(e2e/),仓库根目录为其上一级
const e2eDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(e2eDir, '..')
// 前端应用目录(毛线球宠物医院 SaaS)
const appDir = path.resolve(repoRoot, 'apps/maoxianqiu')
// Vite 开发服务器端口(与 apps/maoxianqiu/vite.config.ts 中 server.port 保持一致)
const DEV_SERVER_PORT = 9000

/**
 * 解析 .env.development 文件(极简 KV 解析,避免引入 dotenv 依赖)。
 * 支持注释行(# 开头)与 `KEY = value` 格式,将解析结果注入 process.env,
 * 供 baseURL 及测试用例读取 Supabase 等前端环境变量。
 * @param envFile .env 文件绝对路径
 * @returns 解析出的键值对
 */
function parseEnvFile(envFile: string): Record<string, string> {
  const result: Record<string, string> = {}
  if (!fs.existsSync(envFile)) {
    return result
  }
  const lines = fs.readFileSync(envFile, 'utf-8').split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    // 跳过空行与注释
    if (!trimmed || trimmed.startsWith('#')) {
      continue
    }
    const eqIndex = trimmed.indexOf('=')
    if (eqIndex === -1) {
      continue
    }
    const key = trimmed.slice(0, eqIndex).trim()
    const value = trimmed.slice(eqIndex + 1).trim()
    // 仅注入当前环境中不存在的变量,避免覆盖真实环境变量
    if (key && process.env[key] === undefined) {
      process.env[key] = value
    }
    result[key] = value
  }
  return result
}

// 加载前端开发环境变量(VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY 等)
const env = parseEnvFile(path.resolve(appDir, '.env.development'))

// baseURL 读取顺序:环境变量 E2E_BASE_URL > .env.development 中的 E2E_BASE_URL > 本地默认端口
const baseURL = process.env.E2E_BASE_URL ?? env.E2E_BASE_URL ?? `http://localhost:${DEV_SERVER_PORT}`

/**
 * Playwright E2E 测试配置
 * - 通过 webServer 自动拉起前端 Vite 开发服务器(可复用已启动的实例)
 * - baseURL 默认读取 apps/maoxianqiu/.env.development 所在环境
 * - 项目采用 hash 路由(#/login),测试断言时需注意带 # 前缀的 URL
 */
export default defineConfig({
  // 测试脚本目录
  testDir: './tests',
  // 单 worker 串行执行,避免同一 Supabase 账号并发登录触发风控
  workers: 1,
  fullyParallel: false,
  // 全局超时:每个测试 60s;断言超时放宽到 15s(登录等网络操作较慢)
  timeout: 60_000,
  expect: {
    timeout: 15_000,
  },
  // 失败时保留现场截图,便于排查
  reporter: [
    ['list'],
    ['html', { open: 'never' }],
    ['junit', { outputFile: 'test-results/junit.xml' }],
  ],
  // 测试产物输出目录
  outputDir: 'test-results',

  use: {
    // 测试基地址(登录页 / 各业务页面均基于此拼接)
    baseURL,
    // 简体中文环境
    locale: 'zh-CN',
    // 桌面端视口(管理后台按 PC 设计)
    viewport: { width: 1440, height: 900 },
    // 会话过期或接口 4xx 时不自动重试(保持测试语义清晰)
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    // 使用 Chromium 内核
    ...devices['Desktop Chrome'],
    trace: 'retain-on-failure',
  },

  // 前端开发服务器配置:执行 pnpm --filter 启动 maoxianqiu 应用的 vite dev server
  webServer: {
    command: `pnpm --filter @fantastic-admin/maoxianqiu dev -- --port ${DEV_SERVER_PORT} --strictPort`,
    // 在仓库根目录执行命令(与 .npmrc / pnpm-workspace.yaml 对齐)
    cwd: repoRoot,
    // 以访问首页作为服务就绪探活(应用为 hash 路由,首页同样会渲染登录页)
    url: `http://localhost:${DEV_SERVER_PORT}`,
    // 本地开发允许复用已启动的 dev server,CI 环境则强制重建
    reuseExistingServer: !process.env.CI,
    // vite 冷启动(含依赖预构建)可能较慢,放宽等待时间
    timeout: 180_000,
    // 环境变量透传给 dev server 所在进程
    env: {
      ...process.env,
    },
  },
})
