import type { Context } from 'hono'
import type { AppEnv } from '../lib/types'
import { Buffer } from 'node:buffer'
import { Hono } from 'hono'
import { generateR2Key, getDataFromDataUrl, serverUploadFile } from '../lib/r2'
import { createServiceClient } from '../lib/supabase'
import { authMiddleware, loadCaller } from '../middlewares/auth'

const MAX_UPLOAD_SIZE = 10 * 1024 * 1024 // 10MB

const uploadRoutes = new Hono<AppEnv>()

uploadRoutes.use('*', authMiddleware(), loadCaller())

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
      return c.json({ status: 1, error: '缺少文件', data: null })
    }
    const buffer = Buffer.from(await file.arrayBuffer())
    if (buffer.length > MAX_UPLOAD_SIZE) {
      return c.json({ status: 1, error: '文件过大,最大 10MB', data: null })
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
    return c.json({ status: 1, error: '', data: { url, key: finalKey } })
  }

  const json = await c.req.json<{ data: string, contentType?: string, filename?: string, path?: string }>()
  const parsed = getDataFromDataUrl(json.data)
  if (!parsed) {
    return c.json({ status: 1, error: '无效的 dataURL', data: null })
  }
  if (parsed.buffer.length > MAX_UPLOAD_SIZE) {
    return c.json({ status: 1, error: '文件过大,最大 10MB', data: null })
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
  return c.json({ status: 1, error: '', data: { url, key: finalKey } })
})

export default uploadRoutes
