import type { AppEnv } from '../lib/types'
import { Hono } from 'hono'
import { z } from 'zod'
import { writeAudit } from '../lib/audit'
import { err } from '../lib/errors'
import { deleteFile } from '../lib/r2'
import { loadContext } from '../lib/request-context'
import { ok } from '../lib/result'
import { createServiceClient } from '../lib/supabase'
import { parseJsonBody } from '../lib/validation'
import { authMiddleware, hasRole, loadCaller } from '../middlewares/auth'

const fileRoutes = new Hono<AppEnv>()

fileRoutes.use('*', authMiddleware(), loadCaller(), loadContext())

const deleteSchema = z.object({
  key: z.string().min(1, '缺少文件 key'),
})

// 删除文件:校验归属后删 R2 + 删 r2_files 记录(超管可删任意)
fileRoutes.post('/delete', async (c) => {
  const input = await parseJsonBody(c, deleteSchema)
  const service = createServiceClient()
  const user = c.get('user')
  const isAdmin = hasRole(c, 'system_admin')

  let query = service.from('r2_files').select('id').eq('key', input.key)
  if (!isAdmin) {
    query = query.eq('user_id', user.id)
  }
  const { data: record } = await query.maybeSingle()

  if (!record) {
    throw err.notFound('文件不存在或无权操作')
  }

  try {
    await deleteFile(input.key)
  }
  catch {
    throw err.internal('删除存储对象失败')
  }

  await service.from('r2_files').delete().eq('id', record.id)

  await writeAudit(c, {
    action: 'file.delete',
    entityType: 'file',
    entityId: record.id,
    metadata: { key: input.key },
  })

  return ok(c, { isSuccess: true })
})

export default fileRoutes
