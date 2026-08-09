<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import apiClinical from '@/api/modules/clinical'
import apiInsurance from '@/api/modules/insurance'
import apiStore from '@/api/modules/store'
import { supabase } from '@/lib/supabase'
import { useAppTenantStore } from '@/store/modules/app/tenant'
import type {
  InsurancePack,
  InsurancePackItem,
  InsurancePackWithItems,
} from '@/types/insurance'
import { INSURANCE_PACK_STATUS_LABELS, INSURANCE_SOURCE_LABELS } from '@/types/insurance'

defineOptions({
  name: 'OperationsInsurance',
})

const tenantStore = useAppTenantStore()

// ===== 门店过滤 =====
const storeOptions = ref<Array<{ label: string, value: string }>>([])
const search = ref({ storeId: '' })

/** 加载门店选项 */
async function loadStoreOptions() {
  try {
    const res: any = await apiStore.list()
    const stores = res.data.list ?? []
    storeOptions.value = [
      { label: '全部门店', value: '' },
      ...stores.map((s: any) => ({ label: s.name, value: s.id })),
    ]
  }
  catch {
    storeOptions.value = [{ label: '全部门店', value: '' }]
  }
}

// ===== 理赔包列表(supabase 直连只读,RLS 兜底) =====
const packs = ref<InsurancePack[]>([])
const packsLoading = ref(false)

/** 加载当前租户的理赔包列表 */
async function loadPacks() {
  if (!tenantStore.currentTenantId) {
    packs.value = []
    return
  }
  packsLoading.value = true
  try {
    let query = supabase
      .from('insurance_claim_packs')
      .select('*')
      .eq('tenant_id', tenantStore.currentTenantId)
    if (search.value.storeId) {
      query = query.eq('store_id', search.value.storeId)
    }
    const { data, error } = await query.order('created_at', { ascending: false }).limit(100)
    if (error) {
      throw new Error(error.message)
    }
    packs.value = (data ?? []) as InsurancePack[]
  }
  catch (e: any) {
    useFaToast().error(e?.message ?? '加载理赔包失败')
  }
  finally {
    packsLoading.value = false
  }
}

// ===== 新建理赔包(选择就诊 → 自动聚合材料) =====
const createVisible = ref(false)
const createSubmitting = ref(false)
const encounterOptions = ref<Array<{ label: string, value: string }>>([])
const encounterLoading = ref(false)
const selectedEncounterId = ref('')

/** 加载已完成/已签署的就诊记录作为候选(带宠物/客户名) */
async function loadEncounters() {
  if (!tenantStore.currentTenantId) {
    return
  }
  encounterLoading.value = true
  try {
    let query = supabase
      .from('encounters')
      .select('id, started_at, status, pets(name), customers(name)')
      .eq('tenant_id', tenantStore.currentTenantId)
      .in('status', ['completed', 'signed'])
    if (search.value.storeId) {
      query = query.eq('store_id', search.value.storeId)
    }
    const { data, error } = await query.order('started_at', { ascending: false }).limit(100)
    if (error) {
      throw new Error(error.message)
    }
    encounterOptions.value = ((data ?? []) as Array<{
      id: string
      started_at: string | null
      status: string
      pets: { name: string } | null
      customers: { name: string } | null
    }>).map(enc => ({
      label: `${enc.pets?.name ?? ''} · ${enc.customers?.name ?? ''} · ${enc.started_at?.slice(0, 10) ?? ''} · ${enc.status}`,
      value: enc.id,
    }))
  }
  catch (e: any) {
    useFaToast().error(e?.message ?? '加载就诊记录失败')
  }
  finally {
    encounterLoading.value = false
  }
}

function openCreate() {
  selectedEncounterId.value = ''
  createVisible.value = true
  loadEncounters()
}

/** 根据所选就诊记录创建理赔包 */
async function onCreate() {
  if (!tenantStore.currentTenantId) {
    useFaToast().warning('请先选择租户')
    return
  }
  if (!selectedEncounterId.value) {
    useFaToast().warning('请选择就诊记录')
    return
  }
  createSubmitting.value = true
  try {
    // 从就诊记录取客户/宠物
    const encRes: any = await apiClinical.getEncounter(selectedEncounterId.value)
    const encounter = encRes.data.encounter
    const res = await apiInsurance.createPack({
      tenantId: tenantStore.currentTenantId,
      storeId: search.value.storeId || tenantStore.currentStoreId || undefined,
      customerId: encounter.customer_id,
      petId: encounter.pet_id,
      encounterId: encounter.id,
    })
    useFaToast().success('理赔包已创建')
    createVisible.value = false
    loadPacks()
    // 打开详情
    const data = res.data as InsurancePackWithItems
    openDetail(data.pack.id)
  }
  catch (e: any) {
    useFaToast().error(e?.message ?? '创建理赔包失败')
  }
  finally {
    createSubmitting.value = false
  }
}

// ===== 详情(材料清单 + 生成 + 历史) =====
const detailVisible = ref(false)
const detail = ref<InsurancePackWithItems | null>(null)
const detailLoading = ref(false)
const exportsList = ref<Array<Record<string, unknown>>>([])
const editingItems = ref<InsurancePackItem[]>([])
const generating = ref(false)
const savingItems = ref(false)

/** 打开理赔包详情 */
function openDetail(packId: string) {
  detailVisible.value = true
  refreshDetail(packId)
}

/** 刷新详情(包 + 清单 + 导出历史) */
async function refreshDetail(packId: string) {
  detailLoading.value = true
  try {
    const res = await apiInsurance.getPack(packId)
    detail.value = res.data
    editingItems.value = (res.data.items ?? []).map(it => ({ ...it }))
    await loadExports(packId)
  }
  catch (e: any) {
    useFaToast().error(e?.message ?? '加载详情失败')
  }
  finally {
    detailLoading.value = false
  }
}

/** 加载导出历史 */
async function loadExports(packId: string) {
  try {
    const res: any = await apiInsurance.listExports(packId)
    exportsList.value = res.data?.exports ?? []
  }
  catch {
    exportsList.value = []
  }
}

/** 保存材料清单(仅 draft) */
async function onSaveItems() {
  if (!detail.value) {
    return
  }
  savingItems.value = true
  try {
    const res = await apiInsurance.updatePackItems(detail.value.pack.id, editingItems.value)
    detail.value = res.data
    editingItems.value = (res.data.items ?? []).map(it => ({ ...it }))
    useFaToast().success('材料清单已更新')
  }
  catch (e: any) {
    useFaToast().error(e?.message ?? '保存清单失败')
  }
  finally {
    savingItems.value = false
  }
}

/** 生成理赔材料 PDF(幂等) */
async function onGenerate() {
  if (!detail.value) {
    return
  }
  generating.value = true
  try {
    const res = await apiInsurance.generatePack(detail.value.pack.id)
    const data = res.data
    useFaToast().success(`理赔材料已生成(v${data.pack.version})`)
    await refreshDetail(detail.value.pack.id)
  }
  catch (e: any) {
    useFaToast().error(e?.message ?? '生成失败')
  }
  finally {
    generating.value = false
  }
}

/** 状态转换(归档/取消/重新起草) */
async function onTransition(status: 'archived' | 'cancelled' | 'draft') {
  if (!detail.value) {
    return
  }
  try {
    await apiInsurance.transitionPack(detail.value.pack.id, status)
    useFaToast().success('状态已更新')
    await refreshDetail(detail.value.pack.id)
    loadPacks()
  }
  catch (e: any) {
    useFaToast().error(e?.message ?? '状态转换失败')
  }
}

/** 下载导出 PDF */
async function onDownload(exportRow: Record<string, unknown>) {
  const archive = exportRow.document_archives as { id?: string } | null
  if (!archive?.id) {
    useFaToast().warning('该导出缺少归档文件')
    return
  }
  try {
    const apiArtifacts = (await import('@/api/modules/document-artifacts')).default
    const res: any = await apiArtifacts.getDownloadUrl(archive.id)
    window.open(res.data.downloadUrl, '_blank')
  }
  catch (e: any) {
    useFaToast().error(e?.message ?? '获取下载链接失败')
  }
}

// ===== 列表列 =====
const packColumns: TableColumn[] = [
  { label: '理赔单号', prop: 'pack_no', minWidth: 180 },
  { label: '状态', prop: 'status', width: 100, formatter: (row: InsurancePack) => INSURANCE_PACK_STATUS_LABELS[row.status] ?? row.status },
  { label: '版本', prop: 'version', width: 80 },
  { label: '创建时间', prop: 'created_at', width: 170 },
]

const itemColumns: TableColumn[] = [
  { label: '材料类型', prop: 'source_type', width: 130, formatter: (row: InsurancePackItem) => INSURANCE_SOURCE_LABELS[row.source_type] ?? row.source_type },
  { label: '来源摘要', prop: 'summary', minWidth: 220 },
  { label: '必填', prop: 'required', width: 70, formatter: (row: InsurancePackItem) => (row.required ? '是' : '否') },
  { label: '包含', prop: 'included', width: 80, formatter: (row: InsurancePackItem) => (row.included ? '是' : '否') },
  { label: '排序', prop: 'display_order', width: 70 },
]

const exportColumns: TableColumn[] = [
  { label: '版本', prop: 'pack_version', width: 80 },
  { label: '生成时间', prop: 'generated_at', width: 170 },
  { label: '数据哈希', prop: 'data_hash', minWidth: 260 },
  { label: '操作', prop: '_actions', width: 120 },
]

loadStoreOptions()
loadPacks()
</script>

<template>
  <div class="p-4">
    <FaSearchBar :show-toggle="false">
      <FaSearchItem label="门店">
        <FaSelect
          v-model="search.storeId"
          placeholder="全部门店"
          clearable
          class="w-52"
          :options="storeOptions"
          @change="loadPacks"
        />
      </FaSearchItem>
      <FaButton type="primary" @click="openCreate">
        新建理赔包
      </FaButton>
      <FaButton variant="outline" @click="loadPacks">
        刷新
      </FaButton>
    </FaSearchBar>

    <FaCard>
      <FaTable
        row-key="id"
        :loading="packsLoading"
        :columns="packColumns"
        :data="packs"
        :pagination="false"
      >
        <template #actions="{ row }">
          <FaButton type="link" @click="openDetail(row.id)">
            详情
          </FaButton>
        </template>
      </FaTable>
    </FaCard>

    <!-- 新建理赔包 -->
    <FaModal v-model="createVisible" title="新建理赔包" width="560px" :footer="false" :close-on-click-overlay="false">
      <div class="py-2 space-y-4">
        <FaLabel label="就诊记录" class="block">
          <FaSelect
            v-model="selectedEncounterId"
            placeholder="选择已完成/已签署的就诊记录"
            filterable
            :loading="encounterLoading"
            class="w-full"
            :options="encounterOptions"
          />
        </FaLabel>
        <p class="text-xs text-muted-foreground">
          创建后服务端将自动按合规白名单聚合已发布的材料(未发布检验/影像、草稿处方会被排除)。
        </p>
      </div>
      <div class="flex justify-end gap-2 pt-4">
        <FaButton @click="createVisible = false">
          取消
        </FaButton>
        <FaButton type="primary" :loading="createSubmitting" @click="onCreate">
          创建
        </FaButton>
      </div>
    </FaModal>

    <!-- 理赔包详情 -->
    <FaModal v-model="detailVisible" title="理赔包详情" width="860px" :footer="false">
      <div v-if="detail" v-loading="detailLoading" class="py-2 space-y-4">
        <div class="flex items-center gap-3">
          <span class="font-semibold">{{ detail.pack.pack_no }}</span>
          <FaTag :color="detail.pack.status === 'draft' ? 'warning' : (detail.pack.status === 'generated' ? 'success' : 'info')">
            {{ INSURANCE_PACK_STATUS_LABELS[detail.pack.status] }}
          </FaTag>
          <span class="text-xs text-muted-foreground">版本 v{{ detail.pack.version }}</span>
        </div>

        <div class="flex items-center justify-between">
          <span class="text-sm font-medium">材料清单</span>
          <FaButton v-if="detail.pack.status === 'draft'" variant="outline" size="small" :loading="savingItems" @click="onSaveItems">
            保存清单
          </FaButton>
        </div>
        <FaTable
          row-key="source_id"
          :columns="itemColumns"
          :data="editingItems"
          :pagination="false"
          size="small"
        >
          <template #included="{ row }">
            <FaSwitch
              v-if="detail.pack.status === 'draft'"
              v-model="row.included"
              size="small"
            />
            <span v-else>{{ row.included ? '是' : '否' }}</span>
          </template>
        </FaTable>

        <div class="flex gap-2">
          <FaButton
            type="primary"
            :loading="generating"
            :disabled="detail.pack.status === 'archived' || detail.pack.status === 'cancelled'"
            @click="onGenerate"
          >
            生成理赔材料 PDF
          </FaButton>
          <FaButton
            v-if="detail.pack.status === 'generated'"
            variant="outline"
            @click="onTransition('draft')"
          >
            重新起草
          </FaButton>
          <FaButton
            v-if="detail.pack.status !== 'archived' && detail.pack.status !== 'cancelled'"
            variant="outline"
            @click="onTransition('archived')"
          >
            归档
          </FaButton>
          <FaButton
            v-if="detail.pack.status !== 'archived' && detail.pack.status !== 'cancelled'"
            variant="outline"
            @click="onTransition('cancelled')"
          >
            取消
          </FaButton>
        </div>

        <div class="text-sm font-medium">
          导出历史
        </div>
        <FaTable
          row-key="id"
          :columns="exportColumns"
          :data="exportsList"
          :pagination="false"
          size="small"
        >
          <template #actions="{ row }">
            <FaButton type="link" @click="onDownload(row)">
              下载
            </FaButton>
          </template>
        </FaTable>
      </div>
    </FaModal>
  </div>
</template>
