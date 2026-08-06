import type { Context } from 'hono'
import type { AppEnv } from '../lib/types'
import { Buffer } from 'node:buffer'
import { Hono } from 'hono'
import { z } from 'zod'
import { err } from '../lib/errors'
import { generateR2Key, getDataFromDataUrl, serverUploadFile } from '../lib/r2'
import { loadContext } from '../lib/request-context'
import { ok } from '../lib/result'
import { createServiceClient } from '../lib/supabase'
import { parseJsonBody } from '../lib/validation'
import { authMiddleware, loadCaller } from '../middlewares/auth'

const MAX_UPLOAD_SIZE = 10 * 1024 * 1024 // 10MB
const ALLOWED_MIME = /^(?:image\/|application\/pdf|application\/msword|application\/vnd\.openxmlformats-officedocument\.)/

const uploadRoutes = new Hono<AppEnv>()

uploadRoutes.use('*', authMiddleware(), loadCaller(), loadContext())

const base64Schema = z.object({
  data: z.string().startsWith('data:', '必须为 dataURL'),
  contentType: z.string().regex(ALLOWED_MIME, '文件类型不允许').optional(),
  filename: z.string().max(200).optional(),
  path: z.string().max(200).optional(),
})

async function recordR2File(c: Context<AppEnv>, file: { key: string, url: string, contentType: string, size: number }) {
  const service = createServiceClient()
  const user = c.get('user')
  await service.from('r2_files').insert({
    key: file.key,
    url: file.url,
    content_type: file.contentType,
    size: file.size,
    user_id: user?.id ?? null,
    user_email: user?.email ?? null,
  })
}

// 上传:支持 multipart(file 字段)或 base64 JSON
uploadRoutes.post('/', async (c) => {
  const contentType = c.req.header('content-type') ?? ''

  if (contentType.includes('multipart/form-data')) {
    const form = await c.req.formData()
    const file = form.get('file')
    if (!(file instanceof File)) {
      throw err.badRequest('缺少文件')
    }
    if (!ALLOWED_MIME.test(file.type)) {
      throw err.badRequest('文件类型不允许')
    }
    const buffer = Buffer.from(await file.arrayBuffer())
    if (buffer.length > MAX_UPLOAD_SIZE) {
      throw err.badRequest('文件过大,最大 10MB')
    }
    const key = generateR2Key({ fileName: file.name, path: c.req.query('path') ?? '' })
    const { url, key: finalKey } = await serverUploadFile({
      data: buffer,
      contentType: file.type,
      key,
    })
    await recordR2File(c, {
      key: finalKey,
      url,
      contentType: file.type,
      size: buffer.length,
    })
    return ok(c, { url, key: finalKey })
  }

  const json = await parseJsonBody(c, base64Schema)
  const parsed = getDataFromDataUrl(json.data)
  if (!parsed) {
    throw err.badRequest('无效的 dataURL')
  }
  if (parsed.buffer.length > MAX_UPLOAD_SIZE) {
    throw err.badRequest('文件过大,最大 10MB')
  }
  const key = generateR2Key({ fileName: json.filename ?? 'file', path: json.path ?? '' })
  const fileType = json.contentType ?? parsed.contentType
  const { url, key: finalKey } = await serverUploadFile({
    data: parsed.buffer,
    contentType: fileType,
    key,
  })
  await recordR2File(c, {
    key: finalKey,
    url,
    contentType: fileType,
    size: parsed.buffer.length,
  })
  return ok(c, { url, key: finalKey })
})

export default uploadRoutes
