import type { AppEnv } from '../lib/types'
import { Hono } from 'hono'
import { deleteFile } from '../lib/r2'
import { createServiceClient } from '../lib/supabase'
import { authMiddleware, hasRole, loadCaller } from '../middlewares/auth'

const fileRoutes = new Hono<AppEnv>()

fileRoutes.use('*', authMiddleware(), loadCaller())

// 删除文件:校验归属后删 R2 + 删 r2_files 记录(超管可删任意)
fileRoutes.post('/delete', async (c) => {
  const body = await c.req.json<{ key: string }>()
  const service = createServiceClient()
  const user = c.get('user')
  const isAdmin = hasRole(c, 'system_admin')

  let query = service.from('r2_files').select('id').eq('key', body.key)
  if (!isAdmin) {
    query = query.eq('user_id', user.id)
  }
  const { data: record } = await query.maybeSingle()

  if (!record) {
    return c.json({ status: 1, error: '文件不存在或无权操作', data: null })
  }

  try {
    await deleteFile(body.key)
  }
  catch {
    return c.json({ status: 1, error: '删除存储对象失败', data: null })
  }

  await service.from('r2_files').delete().eq('id', record.id)
  return c.json({ status: 1, error: '', data: { isSuccess: true } })
})

export default fileRoutes
