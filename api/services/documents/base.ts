import type { DocumentBase, Service } from './types.js'
import { toNum } from './format.js'
import { createPresignedDownloadUrl } from '../../lib/r2.js'

/**
 * S32-C 业务文档 —— 通用信息抓取(医院/门店/客户/宠物/医生/操作员)
 * 只读取 Settings/Tenant/Store 与基础业务对象;不修改其它 Domain。
 */

export interface FetchBaseOpts {
  tenantId: string
  storeId?: string | null
  customerId?: string | null
  petId?: string | null
  doctorUserId?: string | null
  operatorUserId?: string | null
}

/**
 * 并行加载文档通用信息
 * @param service supabase service client
 */
export async function fetchDocumentBase(
  service: Service,
  opts: FetchBaseOpts,
): Promise<DocumentBase> {
  const [tenantRes, storeRes, customerRes, petRes, doctorRes, operatorRes] = await Promise.all([
    service.from('tenants').select('name, short_name, logo_file_id').eq('id', opts.tenantId).maybeSingle(),
    opts.storeId
      ? service.from('stores').select('name, code, address, phone').eq('id', opts.storeId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    opts.customerId
      ? service.from('customers').select('name, phone, gender').eq('id', opts.customerId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    opts.petId
      ? service.from('pets').select('name, species, breed, gender, weight').eq('id', opts.petId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    opts.doctorUserId
      ? service.from('employees').select('name, title').eq('tenant_id', opts.tenantId).eq('user_id', opts.doctorUserId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    opts.operatorUserId
      ? service.from('employees').select('name').eq('tenant_id', opts.tenantId).eq('user_id', opts.operatorUserId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ])

  const t = tenantRes.data
  const s = storeRes.data
  const c = customerRes.data
  const p = petRes.data
  const d = doctorRes.data
  const o = operatorRes.data

  // R-C6(3.4.2.3-05):读取 tenants.logo_file_id → files.object_key → 预签名下载 URL
  // 失败静默(不阻塞文档渲染),未配置 Logo 时 hospital.logo 为空。
  let hospitalLogo: string | undefined
  if (t?.logo_file_id) {
    try {
      const { data: f, error: fErr } = await service
        .from('files')
        .select('object_key')
        .eq('id', t.logo_file_id)
        .maybeSingle()
      if (!fErr && f?.object_key) {
        hospitalLogo = await createPresignedDownloadUrl(f.object_key)
      }
    }
    catch {
      hospitalLogo = undefined
    }
  }

  return {
    hospital: { name: t?.name ?? '毛线球宠物医院', shortName: t?.short_name ?? undefined, logo: hospitalLogo },
    store: s ? { name: s.name, code: s.code ?? undefined, address: s.address ?? undefined, phone: s.phone ?? undefined } : null,
    customer: c ? { name: c.name, phone: c.phone ?? undefined, gender: c.gender ?? undefined } : null,
    pet: p
      ? {
          name: p.name,
          species: p.species ?? undefined,
          breed: p.breed ?? undefined,
          gender: p.gender ?? undefined,
          weight: p.weight ? toNum(p.weight) : undefined,
        }
      : null,
    doctor: d ? { name: d.name, title: d.title ?? undefined } : null,
    operator: o ? { name: o.name } : null,
    createdAt: new Date().toISOString(),
  }
}
