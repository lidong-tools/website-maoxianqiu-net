/**
 * S32-A 导入中心 V2 —— 每类数据的执行
 *
 * 边界（S32-A §8/§9）：
 *   - customers / pets / catalog-item：直接写业务表（本域内）。
 *   - opening-stock：只生成"期初入账命令"（opening_stock_import_requests），
 *     不直接 update inventory_balances / inventory_batches。
 *   - employee：只生成"待邀请"（employee_invite_imports），不创建 auth 用户、
 *     不发送邀请（交由 IAM，见 S32-A-HANDOFF）。
 *
 * 去重按类型各自定义：客户(手机号/编号)、宠物(主人+名/芯片)、
 * 商品(编码)、员工(邮箱)、期初(商品+仓库+批次)。
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { DuplicateStrategy, FieldDef, ImportTypeMeta } from './fields.js'
import type { ImportRow } from './parse.js'
import { toArray, toBoolean, toDate, toNumber } from './parse.js'
import type { LookupContext } from './lookup.js'
import type { Scope } from './validate.js'
import { enumKey, resolveOwnerId, resolveWarehouseId } from './validate.js'

export interface ExecuteResult {
  status: 'success' | 'skipped' | 'failed'
  error?: string
  entityId?: string
}

function getField(meta: ImportTypeMeta, key: string): FieldDef | undefined {
  return meta.fields.find(f => f.key === key)
}

function fieldVal(meta: ImportTypeMeta, mapped: Record<string, string>, key: string): string {
  const f = getField(meta, key)
  const v = mapped[key]
  return f && v != null ? v.trim() : ''
}

/** 生成兜底业务编号（导入专用前缀） */
function genCode(prefix: string): string {
  const d = new Date()
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  const rand = Math.random().toString(36).slice(2, 8)
  return `IMP-${prefix}-${ymd}-${rand}`.toUpperCase()
}

function dbErr(e: unknown): string {
  const msg = (e as { message?: string })?.message ?? String(e)
  return msg
}

// ============================================================
// 各类型专属执行
// ============================================================

async function executeCustomer(
  service: SupabaseClient,
  opts: ExecCtx,
): Promise<ExecuteResult> {
  const { ctx, scope, strategy, mapped } = opts
  const phone = fieldVal(opts.meta, mapped, 'phone')
  const customerNo = fieldVal(opts.meta, mapped, 'customerNo')

  // 去重：手机号优先，其次客户编号
  const dupId = (phone && ctx.customersByPhone.get(phone)) || (customerNo && ctx.customersByNo.get(customerNo)) || null
  if (dupId) {
    if (strategy === 'skip') {
      return { status: 'skipped' }
    }
    if (strategy === 'update') {
      const patch: Record<string, unknown> = {}
      const name = fieldVal(opts.meta, mapped, 'name')
      const gender = enumKey(getField(opts.meta, 'gender')?.enum ?? {}, fieldVal(opts.meta, mapped, 'gender'))
      const email = fieldVal(opts.meta, mapped, 'email')
      const address = fieldVal(opts.meta, mapped, 'address')
      const birthday = toDate(fieldVal(opts.meta, mapped, 'birthday'))
      const memberLevel = enumKey(getField(opts.meta, 'memberLevel')?.enum ?? {}, fieldVal(opts.meta, mapped, 'memberLevel'))
      const remark = fieldVal(opts.meta, mapped, 'remark')
      if (name) patch.name = name
      if (gender) patch.gender = gender
      if (email) patch.email = email
      if (address) patch.address = address
      if (birthday) patch.birthday = birthday
      if (memberLevel) patch.member_level = memberLevel
      if (remark) patch.remark = remark
      if (phone) patch.phone = phone
      if (Object.keys(patch).length === 0) {
        return { status: 'skipped' }
      }
      const { error } = await service.from('customers').update(patch).eq('id', dupId)
      if (error) {
        return { status: 'failed', error: dbErr(error) }
      }
      return { status: 'success', entityId: dupId }
    }
    // create_duplicate → 继续插入
  }

  const name = fieldVal(opts.meta, mapped, 'name')
  const gender = enumKey(getField(opts.meta, 'gender')?.enum ?? {}, fieldVal(opts.meta, mapped, 'gender'))
  const memberLevel = enumKey(getField(opts.meta, 'memberLevel')?.enum ?? {}, fieldVal(opts.meta, mapped, 'memberLevel')) ?? 'normal'
  const { data, error } = await service.from('customers').insert({
    tenant_id: scope.tenantId,
    store_id: scope.storeId ?? null,
    customer_no: customerNo || genCode('CUST'),
    name,
    gender,
    phone: phone || null,
    email: fieldVal(opts.meta, mapped, 'email') || null,
    address: fieldVal(opts.meta, mapped, 'address') || null,
    birthday: toDate(fieldVal(opts.meta, mapped, 'birthday')),
    source: 'import',
    member_level: memberLevel,
    remark: fieldVal(opts.meta, mapped, 'remark') || null,
    status: 'active',
  }).select('id').single()
  if (error) {
    return { status: 'failed', error: dbErr(error) }
  }
  const id = (data as { id: string }).id
  if (phone) ctx.customersByPhone.set(phone, id)
  if (customerNo) ctx.customersByNo.set(customerNo, id)
  return { status: 'success', entityId: id }
}

async function executePet(
  service: SupabaseClient,
  opts: ExecCtx,
): Promise<ExecuteResult> {
  const { ctx, scope, strategy, mapped } = opts
  const ownerId = resolveOwnerId(ctx, fieldVal(opts.meta, mapped, 'ownerNo'), fieldVal(opts.meta, mapped, 'ownerPhone'))
  if (!ownerId) {
    return { status: 'failed', error: '未找到匹配的主人' }
  }
  const name = fieldVal(opts.meta, mapped, 'name')
  const microchip = fieldVal(opts.meta, mapped, 'microchip')

  const dupKey = microchip ? ctx.petsByChip.get(microchip) : ctx.petsByOwnerName.get(`${ownerId}:${name.toLowerCase()}`)
  if (dupKey) {
    if (strategy === 'skip') {
      return { status: 'skipped' }
    }
    if (strategy === 'update') {
      const patch: Record<string, unknown> = {}
      const species = fieldVal(opts.meta, mapped, 'species')
      const breed = fieldVal(opts.meta, mapped, 'breed')
      const gender = enumKey(getField(opts.meta, 'gender')?.enum ?? {}, fieldVal(opts.meta, mapped, 'gender'))
      const birthDate = toDate(fieldVal(opts.meta, mapped, 'birthDate'))
      const weight = toNumber(fieldVal(opts.meta, mapped, 'weight'))
      const isNeutered = toBoolean(fieldVal(opts.meta, mapped, 'isNeutered'))
      const color = fieldVal(opts.meta, mapped, 'color')
      const riskTags = toArray(fieldVal(opts.meta, mapped, 'riskTags'))
      const remark = fieldVal(opts.meta, mapped, 'remark')
      if (species) patch.species = species
      if (breed) patch.breed = breed
      if (gender) patch.gender = gender
      if (birthDate) patch.birth_date = birthDate
      if (weight !== null) patch.weight = weight
      if (isNeutered !== null) patch.is_neutered = isNeutered
      if (color) patch.color = color
      if (riskTags.length > 0) patch.risk_tags = riskTags
      if (remark) patch.medical_notes = remark
      if (microchip) patch.microchip = microchip
      if (Object.keys(patch).length === 0) {
        return { status: 'skipped' }
      }
      const { error } = await service.from('pets').update(patch).eq('id', dupKey)
      if (error) {
        return { status: 'failed', error: dbErr(error) }
      }
      return { status: 'success', entityId: dupKey }
    }
  }

  const { data, error } = await service.from('pets').insert({
    tenant_id: scope.tenantId,
    customer_id: ownerId,
    name,
    species: fieldVal(opts.meta, mapped, 'species') || null,
    breed: fieldVal(opts.meta, mapped, 'breed') || null,
    gender: enumKey(getField(opts.meta, 'gender')?.enum ?? {}, fieldVal(opts.meta, mapped, 'gender')),
    birth_date: toDate(fieldVal(opts.meta, mapped, 'birthDate')),
    weight: toNumber(fieldVal(opts.meta, mapped, 'weight')),
    is_neutered: toBoolean(fieldVal(opts.meta, mapped, 'isNeutered')) ?? false,
    microchip: microchip || null,
    color: fieldVal(opts.meta, mapped, 'color') || null,
    risk_tags: toArray(fieldVal(opts.meta, mapped, 'riskTags')),
    medical_notes: fieldVal(opts.meta, mapped, 'remark') || null,
    status: 'active',
  }).select('id').single()
  if (error) {
    return { status: 'failed', error: dbErr(error) }
  }
  const id = (data as { id: string }).id
  ctx.petsByOwnerName.set(`${ownerId}:${name.toLowerCase()}`, id)
  if (microchip) ctx.petsByChip.set(microchip, id)
  return { status: 'success', entityId: id }
}

async function executeCatalog(
  service: SupabaseClient,
  opts: ExecCtx,
): Promise<ExecuteResult> {
  const { ctx, scope, strategy, mapped } = opts
  const code = fieldVal(opts.meta, mapped, 'code')
  const dupId = ctx.catalogByCode.get(code) ?? null
  if (dupId) {
    if (strategy === 'skip') {
      return { status: 'skipped' }
    }
    if (strategy === 'update') {
      const patch: Record<string, unknown> = {}
      const name = fieldVal(opts.meta, mapped, 'name')
      const unit = fieldVal(opts.meta, mapped, 'unit')
      const defaultPrice = toNumber(fieldVal(opts.meta, mapped, 'defaultPrice'))
      const costPrice = toNumber(fieldVal(opts.meta, mapped, 'costPrice'))
      const isActive = toBoolean(fieldVal(opts.meta, mapped, 'isActive'))
      const tags = toArray(fieldVal(opts.meta, mapped, 'tags'))
      const catCode = fieldVal(opts.meta, mapped, 'categoryCode')
      const billingType = enumKey(getField(opts.meta, 'billingType')?.enum ?? {}, fieldVal(opts.meta, mapped, 'billingType'))
      if (name) patch.name = name
      if (unit) patch.unit = unit
      if (defaultPrice !== null) patch.default_price = defaultPrice
      if (costPrice !== null) patch.cost_price = costPrice
      if (isActive !== null) patch.is_active = isActive
      if (tags.length > 0) patch.tags = tags
      if (catCode) {
        const catId = ctx.categoriesByCode.get(catCode.trim())
        if (catId) patch.category_id = catId
      }
      if (billingType) patch.billing_type = billingType
      if (Object.keys(patch).length === 0) {
        return { status: 'skipped' }
      }
      const { error } = await service.from('catalog_items').update(patch).eq('id', dupId)
      if (error) {
        return { status: 'failed', error: dbErr(error) }
      }
      return { status: 'success', entityId: dupId }
    }
  }

  const catCode = fieldVal(opts.meta, mapped, 'categoryCode')
  const categoryId = catCode ? ctx.categoriesByCode.get(catCode.trim()) ?? null : null
  const billingType = enumKey(getField(opts.meta, 'billingType')?.enum ?? {}, fieldVal(opts.meta, mapped, 'billingType'))
  const { data, error } = await service.from('catalog_items').insert({
    tenant_id: scope.tenantId,
    code,
    name: fieldVal(opts.meta, mapped, 'name'),
    category_id: categoryId,
    unit: fieldVal(opts.meta, mapped, 'unit') || null,
    default_price: toNumber(fieldVal(opts.meta, mapped, 'defaultPrice')) ?? 0,
    cost_price: toNumber(fieldVal(opts.meta, mapped, 'costPrice')) ?? 0,
    billing_type: billingType ?? 'service',
    is_active: toBoolean(fieldVal(opts.meta, mapped, 'isActive')) ?? true,
    tags: toArray(fieldVal(opts.meta, mapped, 'tags')),
    description: null,
  }).select('id').single()
  if (error) {
    return { status: 'failed', error: dbErr(error) }
  }
  const id = (data as { id: string }).id
  ctx.catalogByCode.set(code, id)
  return { status: 'success', entityId: id }
}

async function executeEmployee(
  service: SupabaseClient,
  opts: ExecCtx,
): Promise<ExecuteResult> {
  const { ctx, scope, strategy, mapped, jobId, row } = opts
  const email = fieldVal(opts.meta, mapped, 'email').toLowerCase()
  const dupId = ctx.employeeEmails.has(email) ? 'existing' : (ctx.employeeInviteByEmail.get(`${scope.tenantId}:${scope.storeId ?? ''}:${email}`) ?? null)
  if (dupId && strategy === 'skip') {
    return { status: 'skipped' }
  }
  // update 对员工邀请无意义：一律插入待邀请（skip 时已跳过，create_duplicate 允许重复待邀请）
  const { data, error } = await service.from('employee_invite_imports').insert({
    tenant_id: scope.tenantId,
    store_id: scope.storeId ?? null,
    import_job_id: jobId,
    row_number: row.rowNumber,
    email,
    name: fieldVal(opts.meta, mapped, 'name'),
    phone: fieldVal(opts.meta, mapped, 'phone') || null,
    employee_no: fieldVal(opts.meta, mapped, 'employeeNo') || genCode('EMP'),
    title: fieldVal(opts.meta, mapped, 'title') || null,
    role_code: fieldVal(opts.meta, mapped, 'roleCode') || null,
    store_codes: toArray(fieldVal(opts.meta, mapped, 'storeCodes')),
    status: 'pending',
  }).select('id').single()
  if (error) {
    return { status: 'failed', error: dbErr(error) }
  }
  const id = (data as { id: string }).id
  ctx.employeeInviteByEmail.set(`${scope.tenantId}:${scope.storeId ?? ''}:${email}`, id)
  return { status: 'success', entityId: id }
}

async function executeOpeningStock(
  service: SupabaseClient,
  opts: ExecCtx,
): Promise<ExecuteResult> {
  const { ctx, scope, strategy, mapped, jobId, row } = opts
  const catalogCode = fieldVal(opts.meta, mapped, 'catalogCode')
  const warehouseCode = fieldVal(opts.meta, mapped, 'warehouseCode')
  const batchNo = fieldVal(opts.meta, mapped, 'batchNo')
  const catalogId = ctx.catalogByCode.get(catalogCode)
  const warehouseId = resolveWarehouseId(ctx, scope, warehouseCode)
  if (!catalogId || !warehouseId) {
    return { status: 'failed', error: '商品或仓库不存在' }
  }
  const dupKey = `${scope.tenantId}:${scope.storeId ?? ''}:${catalogId}:${warehouseId}:${batchNo}`
  const existingId = ctx.openingPendingKey.get(dupKey)
  const qty = toNumber(fieldVal(opts.meta, mapped, 'quantity'))
  const unitCost = toNumber(fieldVal(opts.meta, mapped, 'unitCost'))
  const expiry = toDate(fieldVal(opts.meta, mapped, 'expiryDate'))

  if (existingId) {
    if (strategy === 'skip') {
      return { status: 'skipped' }
    }
    if (strategy === 'update') {
      const { error } = await service.from('opening_stock_import_requests').update({
        quantity: qty ?? 0,
        unit_cost: unitCost ?? 0,
        expiry_date: expiry ?? null,
      }).eq('id', existingId)
      if (error) {
        return { status: 'failed', error: dbErr(error) }
      }
      return { status: 'success', entityId: existingId }
    }
  }

  const { data, error } = await service.from('opening_stock_import_requests').insert({
    tenant_id: scope.tenantId,
    store_id: scope.storeId ?? null,
    import_job_id: jobId,
    row_number: row.rowNumber,
    catalog_code: catalogCode,
    catalog_item_id: catalogId,
    warehouse_code: warehouseCode,
    warehouse_id: warehouseId,
    batch_no: batchNo || null,
    quantity: qty ?? 0,
    unit_cost: unitCost ?? 0,
    expiry_date: expiry ?? null,
    status: 'pending',
  }).select('id').single()
  if (error) {
    return { status: 'failed', error: dbErr(error) }
  }
  const id = (data as { id: string }).id
  ctx.openingPendingKey.set(dupKey, id)
  return { status: 'success', entityId: id }
}

// ============================================================
// 统一执行入口
// ============================================================

export interface ExecCtx {
  meta: ImportTypeMeta
  row: ImportRow
  mapped: Record<string, string>
  strategy: DuplicateStrategy
  ctx: LookupContext
  scope: Scope
  jobId: string
  userId: string
  service: SupabaseClient
}

export async function executeRow(opts: ExecCtx): Promise<ExecuteResult> {
  try {
    switch (opts.meta.type) {
      case 'customer':
        return await executeCustomer(opts.service, opts)
      case 'pet':
        return await executePet(opts.service, opts)
      case 'catalog-item':
        return await executeCatalog(opts.service, opts)
      case 'employee':
        return await executeEmployee(opts.service, opts)
      case 'opening-stock':
        return await executeOpeningStock(opts.service, opts)
      default:
        return { status: 'failed', error: '不支持的导入类型' }
    }
  }
  catch (e) {
    return { status: 'failed', error: dbErr(e) }
  }
}
