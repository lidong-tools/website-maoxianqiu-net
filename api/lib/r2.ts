import type { _Object } from '@aws-sdk/client-s3'
import { Buffer } from 'node:buffer'
import process from 'node:process'
import {

  DeleteObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'

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
