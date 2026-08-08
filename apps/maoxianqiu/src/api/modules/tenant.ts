import { supabase } from '@/lib/supabase'
import api from '../index'

/**
 * 租户 API 模块(S3.1 并发任务 A:租户初始化)
 * 初始化是租户级状态转换,必须走 Hono Command + service-role-only RPC。
 */
export default {
  /**
   * 执行租户初始化(S3.1-A)
   * @param data 初始化参数
   * @param data.tenantId 已存在租户 id(与 tenantSlug/tenantName 二选一)
   * @param data.tenantSlug 新建租户 slug(仅平台管理员,需配合 tenantName)
   * @param data.tenantName 新建租户名称
   * @param data.storeName 首店名称
   * @param data.storeCode 首店编码
   * @param data.ownerUserId 租户所有者用户 id
   * @param data.ownerName 租户所有者姓名
   * @param data.ownerPhone 租户所有者电话(可选)
   * @param data.timezone 时区(默认 Asia/Shanghai)
   * @param data.idempotencyKey 幂等键(重复请求返回首次结果)
   */
  initialize(data: {
    tenantId?: string
    tenantSlug?: string
    tenantName?: string
    storeName: string
    storeCode: string
    ownerUserId: string
    ownerName: string
    ownerPhone?: string
    timezone?: string
    idempotencyKey?: string
  }) {
    return api.post('tenants/initialize', data)
  },

  /**
   * 查询租户初始化状态(S3.1-A)
   * @param tenantId 租户 id
   */
  getInitialization(tenantId: string) {
    return api.get(`tenants/${tenantId}/initialization`)
  },

  /**
   * 平台租户列表(仅平台管理员)
   * 返回租户 + 门店数/员工数 + 试用信息,含已停用租户
   */
  listPlatform() {
    return api.get('tenants')
  },

  /**
   * 平台租户概览(详情页)
   * @param tenantId 租户 id
   */
  platformOverview(tenantId: string) {
    return api.get(`tenants/${tenantId}/overview`)
  },

  /**
   * 平台租户下门店列表
   * @param tenantId 租户 id
   */
  platformStores(tenantId: string) {
    return api.get(`tenants/${tenantId}/stores`)
  },

  /**
   * 平台租户下人员列表(含角色码与归属门店)
   * @param tenantId 租户 id
   */
  platformEmployees(tenantId: string) {
    return api.get(`tenants/${tenantId}/employees`)
  },

  /**
   * 停用租户(仅平台管理员,必须带原因)
   * @param tenantId 租户 id
   * @param reason 停用原因
   */
  suspend(tenantId: string, reason: string) {
    return api.post(`tenants/${tenantId}/suspend`, { reason })
  },

  /**
   * 恢复租户(仅平台管理员,必须带原因)
   * @param tenantId 租户 id
   * @param reason 恢复原因
   */
  resume(tenantId: string, reason: string) {
    return api.post(`tenants/${tenantId}/resume`, { reason })
  },

  /**
   * 我的租户列表(浏览器直连,聚合员工档案租户;平台管理员/租户成员均可见)
   */
  async listMyTenants() {
    const { data: userData } = await supabase.auth.getUser()
    const userId = userData.user?.id
    if (!userId) {
      return { status: 1, error: '', data: { list: [] } }
    }
    // 平台管理员:读取全部租户
    const { data: platformRows } = await supabase
      .from('platform_user_roles')
      .select('role')
      .eq('user_id', userId)
    if ((platformRows ?? []).some((r: any) => r.role === 'platform_admin')) {
      const { data: allTenants } = await supabase
        .from('tenants')
        .select('id, slug, name, status')
        .order('created_at', { ascending: true })
      return { status: 1, error: '', data: { list: allTenants ?? [] } }
    }
    // 普通成员:员工档案归属租户
    const { data: employees } = await supabase
      .from('employees')
      .select('tenant_id, tenants(id, slug, name, status)')
      .eq('user_id', userId)
      .eq('status', 'active')
    const list: any[] = []
    for (const emp of employees ?? []) {
      const t: any = Array.isArray(emp.tenants) ? emp.tenants[0] : emp.tenants
      if (t && !list.some(item => item.id === t.id)) {
        list.push(t)
      }
    }
    return { status: 1, error: '', data: { list } }
  },
}
