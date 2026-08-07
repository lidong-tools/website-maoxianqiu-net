import type { _Object } from '@aws-sdk/client-s3'
import { Buffer } from 'node:buffer'
import process from 'node:process'
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
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

export interface UploadOptions {
  data: Buffer | string
  contentType: string
  path?: string
  key: string
}

export interface UploadResult {
  url: string
  key: string
}

// 服务端上传(buffer 或 base64 dataURL),返回 { url, key }
export async function serverUploadFile({ data, contentType, path = '', key }: UploadOptions): Promise<UploadResult> {
  if (!process.env.R2_BUCKET_NAME || !process.env.R2_PUBLIC_URL) {
    throw new Error('R2 configuration is missing')
  }

  const fileBuffer = Buffer.isBuffer(data)
    ? data
    : Buffer.from(data.replace(/^data:.*?;base64,/, ''), 'base64')

  const finalKey = path ? (path.endsWith('/') ? `${path}${key}` : `${path}/${key}`) : key

  const client = createR2Client()
  await client.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: finalKey,
    Body: fileBuffer,
    ContentType: contentType,
  }))

  return { url: `${process.env.R2_PUBLIC_URL}/${finalKey}`, key: finalKey }
}

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

export interface ListedObject {
  key: string
  url: string
  lastModified?: Date
  size?: number
}

export interface ListR2ObjectsResult {
  objects: ListedObject[]
  nextContinuationToken?: string
  error?: string
}

export async function listR2Objects(params: {
  prefix?: string
  continuationToken?: string
  pageSize?: number
}): Promise<ListR2ObjectsResult> {
  const bucket = process.env.R2_BUCKET_NAME
  const publicUrl = process.env.R2_PUBLIC_URL
  if (!bucket || !publicUrl) {
    return { objects: [], error: 'Server configuration error: R2 not set' }
  }

  const client = createR2Client()
  const response = await client.send(new ListObjectsV2Command({
    Bucket: bucket,
    Prefix: params.prefix,
    MaxKeys: params.pageSize,
    ContinuationToken: params.continuationToken,
  }))

  const objects: ListedObject[] = (response.Contents ?? []).map((obj: _Object) => ({
    key: obj.Key ?? '',
    url: `${publicUrl}/${obj.Key}`,
    size: obj.Size ?? 0,
    lastModified: obj.LastModified ?? new Date(0),
  }))

  return { objects, nextContinuationToken: response.NextContinuationToken }
}

// 生成 R2 key:{path}/{prefix-}{Date.now}-{random}.{ext}
export function generateR2Key({
  fileName,
  path = '',
  prefix,
}: {
  fileName: string
  path?: string
  prefix?: string
}): string {
  const extension = fileName.split('.').pop()
  const randomPart = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}${extension ? `.${extension}` : ''}`
  const finalFileName = prefix ? `${prefix}-${randomPart}` : randomPart
  const cleanedPath = path.replace(/^\/+|\/+$/g, '')
  return cleanedPath ? `${cleanedPath}/${finalFileName}` : finalFileName
}

// 解析 base64 dataURL → { buffer, contentType }
export function getDataFromDataUrl(dataUrl: string): { buffer: Buffer, contentType: string } | null {
  const match = dataUrl.match(/^data:(.*?);base64,(.*)$/)
  if (!match) {
    return null
  }
  return { buffer: Buffer.from(match[2], 'base64'), contentType: match[1] }
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
