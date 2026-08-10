<script setup lang="ts">
import type { GlobalSearchResult } from '@/api/modules/search'
import { serverGlobalSearch } from '@/api/modules/search'
import { useHotkeyBindings } from '@/hotkeys'
import { useAppTenantStore } from '@/store/modules/app/tenant'

defineOptions({
  name: 'BusinessGlobalSearch',
})

const isShow = defineModel<boolean>({
  default: false,
})

const router = useRouter()
const appSettingsStore = useAppSettingsStore()
const tenantStore = useAppTenantStore()
const { auth } = useAppAuth()

const searchInput = ref('')
const loading = ref(false)
const actived = ref(0)
let searchTimer: ReturnType<typeof setTimeout> | null = null
// P0-29:请求序号 + AbortController,防止旧查询覆盖新查询
let searchSeq = 0
let searchAbort: AbortController | null = null

interface SearchItem {
  key: string
  group: '客户' | '宠物' | '就诊' | '收费' | '商品' | '功能'
  title: string
  subtitle: string
  to: string
  icon: string
}

const resultItems = ref<GlobalSearchResult>({ customers: [], pets: [], encounters: [], invoices: [], catalogItems: [] })

const searchResultRef = useTemplateRef('searchResultRef')
const searchResultItemRef = useTemplateRef<HTMLElement[]>('searchResultItemRef')

// P0-29:空输入时的常用功能入口,按权限过滤
const quickActions: Array<SearchItem & { perm: string }> = [
  { key: 'fa-customer', group: '功能', title: '客户管理', subtitle: '查看所有客户', to: '/crm/customer', icon: 'i-mdi:account-group', perm: 'customer.view' },
  { key: 'fa-cashier', group: '功能', title: '快速收银', subtitle: '新建收费单', to: '/billing/cashier', icon: 'i-mdi:wallet', perm: 'invoice.create' },
  { key: 'fa-catalog', group: '功能', title: '目录管理', subtitle: '药品/商品/服务目录', to: '/catalog', icon: 'i-mdi:package-variant', perm: 'catalog.view' },
  { key: 'fa-workbench', group: '功能', title: '医生工作台', subtitle: '候诊与接诊', to: '/clinical/workbench', icon: 'i-mdi:stethoscope', perm: 'encounter.view' },
]

function buildItems(): SearchItem[] {
  const items: SearchItem[] = []
  const payload = resultItems.value
  for (const c of payload.customers) {
    items.push({ key: `c-${c.id}`, group: '客户', title: c.name, subtitle: [c.phone, c.customerNo].filter(Boolean).join(' · '), to: `/crm/customer/${c.id}`, icon: 'i-mdi:account' })
  }
  for (const p of payload.pets) {
    items.push({ key: `p-${p.id}`, group: '宠物', title: p.name, subtitle: [p.species, p.ownerName ? `主人：${p.ownerName}` : '', p.microchip].filter(Boolean).join(' · '), to: `/crm/pet/${p.id}`, icon: 'i-mdi:dog' })
  }
  for (const e of payload.encounters) {
    items.push({ key: `e-${e.id}`, group: '就诊', title: `就诊 · ${e.petName ?? '-'}`, subtitle: `${e.status} · ${e.startedAt ?? ''}`, to: `/clinical/encounter/${e.id}`, icon: 'i-mdi:stethoscope' })
  }
  for (const i of payload.invoices) {
    items.push({ key: `i-${i.id}`, group: '收费', title: i.invoiceNo, subtitle: `¥${i.total.toFixed(2)} · ${i.status}`, to: '/billing/invoices', icon: 'i-mdi:receipt' })
  }
  for (const it of payload.catalogItems) {
    items.push({ key: `g-${it.id}`, group: '商品', title: it.name, subtitle: [it.code, it.billingType].filter(Boolean).join(' · '), to: '/catalog', icon: 'i-mdi:package-variant' })
  }
  return items
}

const displayItems = computed<SearchItem[]>(() => {
  if (!searchInput.value.trim()) {
    // P0-29:快捷入口按权限过滤,无权功能不出现
    return quickActions.filter(item => auth(item.perm))
  }
  return buildItems()
})

const groupedItems = computed(() => {
  const groups: Array<{ label: string, flatStart: number, items: SearchItem[] }> = []
  const order: SearchItem['group'][] = ['客户', '宠物', '就诊', '收费', '商品', '功能']
  let cursor = 0
  for (const group of order) {
    const list = displayItems.value.filter(item => item.group === group)
    if (list.length > 0) {
      groups.push({ label: group, flatStart: cursor, items: list })
      cursor += list.length
    }
  }
  return groups
})

// 键盘导航基于扁平列表
function keyUp() {
  if (displayItems.value.length) {
    actived.value -= 1
    if (actived.value < 0) {
      actived.value = displayItems.value.length - 1
    }
    handleScroll()
  }
}

function keyDown() {
  if (displayItems.value.length) {
    actived.value += 1
    if (actived.value > displayItems.value.length - 1) {
      actived.value = 0
    }
    handleScroll()
  }
}

function keyEnter() {
  const item = displayItems.value[actived.value]
  if (item) {
    jump(item)
  }
}

function handleScroll() {
  if (searchResultRef.value?.ref?.el?.viewportElement) {
    const contentDom = searchResultRef.value.ref.el.viewportElement
    const target = searchResultItemRef.value?.find(el => Number.parseInt(el.dataset.index!) === actived.value)
    if (!target) {
      return
    }
    const scrollTop = contentDom.scrollTop
    const clientHeight = contentDom.clientHeight
    const offsetTop = target.offsetTop
    const offsetHeight = target.clientHeight
    if (offsetTop + offsetHeight > scrollTop + clientHeight) {
      contentDom.scrollTo({ top: offsetTop + offsetHeight - clientHeight })
    }
    else if (offsetTop <= scrollTop) {
      contentDom.scrollTo({ top: offsetTop - 16 })
    }
  }
}

function jump(item: SearchItem) {
  router.push(item.to)
  isShow.value = false
}

async function doSearch() {
  // P0-29:序号 + 取消旧请求,慢查询不再覆盖新结果
  const seq = ++searchSeq
  searchAbort?.abort()
  const controller = new AbortController()
  searchAbort = controller
  loading.value = true
  try {
    const payload = await serverGlobalSearch({
      q: searchInput.value,
      tenantId: tenantStore.currentTenantId || undefined,
      storeId: tenantStore.currentStoreId || undefined,
    }, controller.signal)
    if (seq !== searchSeq) {
      return
    }
    resultItems.value = payload
    actived.value = 0
  }
  catch {
    if (seq === searchSeq) {
      resultItems.value = { customers: [], pets: [], encounters: [], invoices: [], catalogItems: [] }
    }
  }
  finally {
    if (seq === searchSeq) {
      loading.value = false
    }
  }
}

function onChange() {
  if (searchTimer) {
    clearTimeout(searchTimer)
  }
  searchTimer = setTimeout(() => {
    if (searchInput.value.trim()) {
      doSearch()
    }
    else {
      resultItems.value = { customers: [], pets: [], encounters: [], invoices: [], catalogItems: [] }
      actived.value = 0
    }
  }, 250)
}

useHotkeyBindings({
  'global.search.moveUp': keyUp,
  'global.search.moveDown': keyDown,
  'global.search.confirm': keyEnter,
  'global.search.close': () => {
    isShow.value = false
  },
}, () => isShow.value)

watch(() => isShow.value, (val) => {
  if (val) {
    searchInput.value = ''
    resultItems.value = { customers: [], pets: [], encounters: [], invoices: [], catalogItems: [] }
    actived.value = 0
    setTimeout(() => {
      document.querySelector<HTMLInputElement>('.global-search-input')?.focus()
    })
  }
})

onBeforeUnmount(() => {
  if (searchTimer) {
    clearTimeout(searchTimer)
  }
  searchAbort?.abort()
})
</script>

<template>
  <FaModal v-model="isShow" :footer="appSettingsStore.mode === 'pc'" :closable="false" open-auto-focus border class="w-full lg-max-w-2xl" content-class="flex flex-col p-0 min-h-auto" header-class="p-0" footer-class="p-0">
    <template #header>
      <div class="flex flex-shrink-0 h-12 items-center">
        <div class="flex-center h-full w-14">
          <FaIcon name="i-ri:search-line" class="text-foreground/30 size-4" />
        </div>
        <input v-model="searchInput" placeholder="搜索客户、宠物、就诊、收费单、商品或功能" class="global-search-input text-base text-foreground border-0 rounded-md bg-transparent h-full w-full focus-outline-none placeholder-foreground/30" @input="onChange" @keydown.esc.prevent="isShow = false" @keydown.up.prevent="keyUp" @keydown.down.prevent="keyDown" @keydown.enter.prevent="keyEnter">
        <div v-if="appSettingsStore.mode === 'mobile'" class="border-s flex-center h-full w-14">
          <FaIcon name="i-carbon:close" class="size-4" @click="isShow = false" />
        </div>
      </div>
    </template>
    <template #footer>
      <div class="px-4 py-3 flex w-full justify-between">
        <div class="flex gap-8">
          <div class="text-xs inline-flex gap-1 items-center">
            <FaKbd>⏎</FaKbd>
            <span>访问</span>
          </div>
          <div class="text-xs inline-flex gap-1 items-center">
            <FaKbd>
              <FaIcon name="i-ant-design:caret-up-filled" />
            </FaKbd>
            <FaKbd>
              <FaIcon name="i-ant-design:caret-down-filled" />
            </FaKbd>
            <span>切换</span>
          </div>
          <div class="text-xs inline-flex gap-1 items-center">
            <FaKbd>Esc</FaKbd>
            <span>退出</span>
          </div>
        </div>
        <div class="text-xs text-secondary-foreground/50 inline-flex gap-1 items-center">
          <FaIcon name="i-mdi:shield-lock-outline" class="size-3.5" />
          <span>仅展示你有权限的数据</span>
        </div>
      </div>
    </template>
    <FaScrollArea ref="searchResultRef" class="max-h-100">
      <div v-loading="loading" class="min-h-20">
        <template v-if="displayItems.length > 0">
          <div v-for="group in groupedItems" :key="group.label">
            <div class="text-xs text-secondary-foreground/50 font-medium px-4 pb-1 pt-3">
              {{ group.label }}
            </div>
            <div
              v-for="(item, index) in group.items"
              :key="item.key"
              ref="searchResultItemRef"
              class="px-4 py-2"
              :data-index="group.flatStart + index"
              @click="jump(item)"
              @mouseover="actived = group.flatStart + index"
            >
              <a class="px-3 py-2.5 border rounded-lg flex cursor-pointer items-center" :class="{ 'bg-accent border-primary shadow-[0_0_0_1px_oklch(var(--primary))]': actived === group.flatStart + index, 'op-60': actived !== group.flatStart + index }">
                <FaIcon :name="item.icon" class="text-primary me-3 flex-shrink-0 size-5" />
                <div class="flex-1 min-w-0">
                  <div class="text-base font-medium text-start truncate">
                    {{ item.title }}
                  </div>
                  <div class="text-xs text-muted-foreground truncate">
                    {{ item.subtitle || ' ' }}
                  </div>
                </div>
              </a>
            </div>
          </div>
        </template>
        <template v-else-if="searchInput === ''">
          <div class="text-secondary-foreground/50 py-8 flex-col-center h-full">
            <FaIcon name="i-tabler:mood-search" class="size-10" />
            <p class="text-base m-2">
              输入关键词搜索客户、宠物、就诊、收费单或商品
            </p>
            <p class="text-xs">
              快捷键 Ctrl / ⌘ + Shift + K
            </p>
          </div>
        </template>
        <template v-else-if="!loading">
          <div class="text-secondary-foreground/50 py-8 flex-col-center h-full">
            <FaIcon name="i-tabler:mood-empty" class="size-10" />
            <p class="text-base m-2">
              没有找到匹配的结果
            </p>
          </div>
        </template>
      </div>
    </FaScrollArea>
  </FaModal>
</template>
