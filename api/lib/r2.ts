import process from 'node:process'
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

// 复刻自 LTX-Dev lib/cloudflare/r2.ts
export function createR2Client() {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
  })
}

/**
 * 物理删除 R2 对象(MXQ-4006)
 * 仅由 files-v2 的延迟清理任务(超管)调用。
 */
export async function deleteFile(key: string): Promise<void> {
  if (!process.env.R2_BUCKET_NAME) {
    throw new Error('R2 configuration is missing')
  }
  const cleanKey = key.startsWith('/') ? key.slice(1) : key
  const client = createR2Client()
  await client.send(new DeleteObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: cleanKey,
  }))
}

/**
 * 生成预签名上传 URL(MXQ-4003)
 * 前端直传 R2,后端不中转,适合大文件。
 * @param objectKey R2 对象 key(含分段)
 * @param contentType MIME
 * @param expiresIn 有效期(秒),默认 15 分钟
 */
export async function createPresignedUploadUrl(
  objectKey: string,
  contentType: string,
  expiresIn = 900,
): Promise<string> {
  if (!process.env.R2_BUCKET_NAME) {
    throw new Error('R2 configuration is missing')
  }
  const cleanKey = objectKey.startsWith('/') ? objectKey.slice(1) : objectKey
  const client = createR2Client()
  const command = new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: cleanKey,
    ContentType: contentType,
  })
  return getSignedUrl(client, command, { expiresIn })
}

/**
 * 生成预签名下载 URL(MXQ-4005)
 * 私有桶文件只能通过此 URL 访问,默认 10 分钟有效。
 * @param objectKey R2 对象 key
 * @param expiresIn 有效期(秒),默认 10 分钟
 */
export async function createPresignedDownloadUrl(
  objectKey: string,
  expiresIn = 600,
): Promise<string> {
  if (!process.env.R2_BUCKET_NAME) {
    throw new Error('R2 configuration is missing')
  }
  const cleanKey = objectKey.startsWith('/') ? objectKey.slice(1) : objectKey
  const client = createR2Client()
  const command = new GetObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: cleanKey,
  })
  return getSignedUrl(client, command, { expiresIn })
}

/**
 * HEAD 校验对象是否已上传(MXQ-4004)
 * 服务端在 complete 步骤校验对象确实存在,获取 size 和 etag。
 */
export async function headObject(
  objectKey: string,
): Promise<{ size: number, etag?: string } | null> {
  if (!process.env.R2_BUCKET_NAME) {
    throw new Error('R2 configuration is missing')
  }
  const cleanKey = objectKey.startsWith('/') ? objectKey.slice(1) : objectKey
  const client = createR2Client()
  try {
    const output = await client.send(new HeadObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: cleanKey,
    }))
    return {
      size: output.ContentLength ?? 0,
      etag: output.ETag?.replace(/"/g, ''),
    }
  }
  catch {
    return null
  }
}

/**
 * 生成标准化 object_key(MXQ-4002)
 * 格式:{env}/tenant/{tenantId}/store/{storeId}/{domain}/{yyyy}/{mm}/{uuid}.{ext}
 * storeId 为空时省略 store 段;env 默认 prod。
 */
export function generatePrivateObjectKey(params: {
  tenantId: string
  storeId?: string
  domain: string
  fileName?: string
  env?: string
}): string {
  const env = params.env ?? process.env.R2_KEY_ENV ?? 'prod'
  const now = new Date()
  const yyyy = now.getUTCFullYear()
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0')
  const uuid = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  const ext = params.fileName?.split('.').pop()
  const extSuffix = ext && ext !== params.fileName ? `.${ext}` : ''
  const segments = [
    env,
    'tenant',
    params.tenantId,
  ]
  if (params.storeId) {
    segments.push('store', params.storeId)
  }
  segments.push(params.domain, String(yyyy), mm, `${uuid}${extSuffix}`)
  return segments.join('/')
}
