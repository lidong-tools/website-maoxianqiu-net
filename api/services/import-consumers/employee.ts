import type { SupabaseClient } from '@supabase/supabase-js'
/**
 * Stage-04 Agent-07: Employee Import Consumer
 *
 * 消费 employee_invite_imports(pending) 并调用既有 IAM 领域(EMPLOYEE_CONSUMER_DOMAIN_CALL):
 *   1) CAS claim: pending → processing(processing_at),防止并发双消费
 *   2) 解析 role_code → role_id(租户内角色),store_codes → 主门店 id
 *   3) service.auth.admin.createUser(随机初始密码,email_confirm:true)
 *   4) invite_employee RPC(事务化建成员/员工/门店分配/角色分配)
 *   5) 成功: status=applied(employee_id/invited_user_id/applied_at)
 *      失败: 补偿删除刚建的 auth 用户(避免孤立账号),status=failed(error_code/error_message)
 *
 * 边界:不直接写 auth.users(须经 IAM 域),多门店/多角色分配留待后续阶段(DEFERRED)。
 */
import { randomBytes } from 'node:crypto'

export interface InviteRow {
  id: string
  tenant_id: string
  store_id: string | null
  email: string
  name: string
  phone: string | null
  employee_no: string | null
  title: string | null
  role_code: string | null
  store_codes: string[]
}

export interface ConsumeResult {
  processed: number
  applied: number
  failed: number
  skipped: number
  /** 仍处于 pending/processing 未消费的行数(数据量超过单次 limit 时存在) */
  remaining: number
  failedSamples: { id: string, email: string, code: string, message: string }[]
}

/** 生成随机初始密码(导入场景无密码字段,员工通过忘记密码流程重置) */
function genTempPassword(): string {
  return randomBytes(12).toString('base64url')
}

/**
 * 消费待邀请队列(按租户;可限定单个 import job)
 * @param opts.limit 单次最大消费条数(默认 50,同步消费避免请求超时)
 */
export async function consumeEmployeeInvites(
  service: SupabaseClient,
  opts: { tenantId: string, jobId?: string, limit?: number, operatorId?: string | null },
): Promise<ConsumeResult> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500)
  const result: ConsumeResult = { processed: 0, applied: 0, failed: 0, skipped: 0, remaining: 0, failedSamples: [] }

  // 预载租户内角色与门店映射(避免 N+1)
  const [rolesRes, storesRes] = await Promise.all([
    service.from('roles').select('id, code').eq('tenant_id', opts.tenantId).limit(1000),
    service.from('stores').select('id, code').eq('tenant_id', opts.tenantId).is('archived_at', null).limit(5000),
  ])
  const roleByCode = new Map((rolesRes.data ?? []).map(r => [r.code, r.id as string]))
  const storeByCode = new Map((storesRes.data ?? []).map(s => [s.code, s.id as string]))

  let q = service
    .from('employee_invite_imports')
    .select('id, tenant_id, store_id, email, name, phone, employee_no, title, role_code, store_codes')
    .eq('tenant_id', opts.tenantId)
    .eq('status', 'pending')
  if (opts.jobId) {
    q = q.eq('import_job_id', opts.jobId)
  }
  const { data: rows, error } = await q.limit(limit)
  if (error) {
    throw new Error(`查询待邀请队列失败: ${error.message}`)
  }
  result.remaining = Math.max(rows?.length ?? 0, 0)

  for (const row of (rows ?? []) as InviteRow[]) {
    // 1) CAS claim:pending → processing,抢不到说明已被其他消费方处理
    const { data: claimed } = await service
      .from('employee_invite_imports')
      .update({ status: 'processing', processing_at: new Date().toISOString() })
      .eq('id', row.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle()
    if (!claimed) {
      result.skipped++
      continue
    }
    result.processed++

    // 2) 解析角色与主门店
    let roleId: string | null = null
    if (row.role_code) {
      roleId = roleByCode.get(row.role_code) ?? null
      if (!roleId) {
        await markEmployeeInviteFailed(service, row.id, 'ROLE_NOT_FOUND', `角色码不存在于该租户: ${row.role_code}`)
        result.failed++
        result.failedSamples.push({ id: row.id, email: row.email, code: 'ROLE_NOT_FOUND', message: `角色码不存在: ${row.role_code}` })
        continue
      }
    }
    // 主门店:导入作用域门店优先,否则取模板首个门店编码
    let storeId = row.store_id ?? null
    if (!storeId && row.store_codes.length > 0) {
      storeId = storeByCode.get(row.store_codes[0]) ?? null
    }

    // 3) 建 auth 用户(随机初始密码)
    const { data: authData, error: authError } = await service.auth.admin.createUser({
      email: row.email,
      password: genTempPassword(),
      email_confirm: true,
      user_metadata: {
        account: row.email,
        real_name: row.name,
        phone: row.phone ?? '',
      },
    })
    if (authError) {
      await markEmployeeInviteFailed(service, row.id, 'AUTH_USER_CREATE_FAILED', authError.message)
      result.failed++
      result.failedSamples.push({ id: row.id, email: row.email, code: 'AUTH_USER_CREATE_FAILED', message: authError.message })
      continue
    }
    const userId = authData.user.id

    // 4) 调 invite_employee RPC(IAM 域,事务化建组织数据)
    const { data: employee, error: rpcError } = await service.rpc('invite_employee', {
      p_tenant_id: opts.tenantId,
      p_user_id: userId,
      p_employee_no: row.employee_no,
      p_name: row.name,
      p_phone: row.phone ?? null,
      p_email: row.email,
      p_title: row.title ?? null,
      p_store_id: storeId,
      p_role_id: roleId,
      p_is_primary: true,
      p_invited_by: opts.operatorId ?? null,
    })

    if (rpcError) {
      // 补偿:删除刚建的 auth 用户,避免孤立账号
      await service.auth.admin.deleteUser(userId)
      const isDup = rpcError.message.includes('duplicate key') || rpcError.message.includes('unique')
      const code = isDup ? 'EMPLOYEE_NO_DUPLICATE' : 'INVITE_FAILED'
      await markEmployeeInviteFailed(service, row.id, code, rpcError.message)
      result.failed++
      result.failedSamples.push({ id: row.id, email: row.email, code, message: rpcError.message })
      continue
    }

    // 5) 成功:标记 applied
    await service.from('employee_invite_imports').update({
      status: 'applied',
      applied_at: new Date().toISOString(),
      employee_id: (employee as { id?: string })?.id ?? null,
      invited_user_id: userId,
      error_code: null,
      error_message: null,
    }).eq('id', row.id)
    result.applied++
  }

  return result
}

/** 标记邀请失败(供 claim 后各失败分支复用) */
async function markEmployeeInviteFailed(
  service: SupabaseClient,
  id: string,
  code: string,
  message: string,
): Promise<void> {
  await service.from('employee_invite_imports').update({
    status: 'failed',
    error_code: code,
    error_message: message.slice(0, 1000),
  }).eq('id', id)
}

/**
 * 重试单条失败邀请:failed → pending,由下一次消费重新处理
 */
export async function retryEmployeeInvite(service: SupabaseClient, id: string): Promise<boolean> {
  const { data } = await service
    .from('employee_invite_imports')
    .update({ status: 'pending', error_code: null, error_message: null, processing_at: null })
    .eq('id', id)
    .eq('status', 'failed')
    .select('id')
    .maybeSingle()
  return Boolean(data)
}
