/**
 * Vercel 函数路由入口:api/[[...route]].ts 匹配 /api/* 全部子路径(含精确 /api)。
 *
 * 说明:Vercel 的 api 目录约定里,api/index.ts 只会挂到精确路径 /api,
 * /api/me/context 等子路径必须由 catch-all 文件承接。Hono 使用 basePath('/api'),
 * 请求原路径会被 basePath 正确剥离后路由到各业务模块。
 */
export { GET, POST, PUT, PATCH, DELETE, OPTIONS } from './index'

export const runtime = 'nodejs'
