<script setup lang="ts">
import type { CageStatusView } from '@/types/inpatient'
import apiInpatient from '@/api/modules/inpatient'
import { useAppTenantStore } from '@/store/modules/app/tenant'
import { CAGE_STATUS_COLORS, CAGE_STATUS_LABELS, CAGE_TYPE_LABELS, ROOM_TYPE_LABELS } from '@/types/inpatient'

defineOptions({
  name: 'InpatientDashboard',
})

const tenantStore = useAppTenantStore()
const loading = ref(false)
const cageStatusList = ref<CageStatusView[]>([])

/** 按房间分组的笼位状态 */
interface RoomGroup {
  room_id: string
  room_name: string
  room_code: string | null
  room_floor: string | null
  room_type: CageStatusView['room_type']
  cages: CageStatusView[]
  available_count: number
  occupied_count: number
  total_count: number
}

/** 按房间分组并统计房态 */
const groupedByRoom = computed<RoomGroup[]>(() => {
  const map = new Map<string, RoomGroup>()
  for (const cage of cageStatusList.value) {
    const key = cage.room_id
    if (!map.has(key)) {
      map.set(key, {
        room_id: cage.room_id,
        room_name: cage.room_name ?? '未分配房间',
        room_code: cage.room_code,
        room_floor: cage.room_floor,
        room_type: cage.room_type,
        cages: [],
        available_count: 0,
        occupied_count: 0,
        total_count: 0,
      })
    }
    const group = map.get(key)!
    group.cages.push(cage)
    group.total_count += 1
    if (cage.cage_status === 'available') {
      group.available_count += 1
    }
    else if (cage.cage_status === 'occupied') {
      group.occupied_count += 1
    }
  }
  return Array.from(map.values())
})

/** 整体房态统计 */
const summary = computed(() => {
  const total = cageStatusList.value.length
  const available = cageStatusList.value.filter(c => c.cage_status === 'available').length
  const occupied = cageStatusList.value.filter(c => c.cage_status === 'occupied').length
  const maintenance = cageStatusList.value.filter(c => c.cage_status === 'maintenance').length
  const cleaning = cageStatusList.value.filter(c => c.cage_status === 'cleaning').length
  return { total, available, occupied, maintenance, cleaning }
})

/** 加载房态看板(直连视图,RLS 按门店过滤) */
async function loadCageStatus() {
  loading.value = true
  try {
    cageStatusList.value = await apiInpatient.listCageStatus(tenantStore.currentStoreId || undefined)
  }
  catch (e: any) {
    useFaToast().error(e?.message || '加载房态看板失败')
  }
  finally {
    loading.value = false
  }
}

/** 房态状态对应的 Tag 变体 */
function statusTagVariant(status: CageStatusView['cage_status']) {
  const color = CAGE_STATUS_COLORS[status]
  if (color === 'success') {
    return 'default'
  }
  if (color === 'destructive') {
    return 'destructive'
  }
  if (color === 'warning') {
    return 'outline'
  }
  return 'secondary'
}

onMounted(loadCageStatus)
</script>

<template>
  <div>
    <FaPageHeader title="房态看板" class="mb-0">
      <template #description>
        按房间分组展示笼位状态,实时反映在院情况;颜色区分空闲/占用/维护/清洁
      </template>
    </FaPageHeader>
    <FaPageMain>
      <!-- 整体房态统计卡片 -->
      <div class="mb-4 gap-3 grid grid-cols-2 md:grid-cols-5">
        <div class="p-3 text-center border rounded-lg">
          <div class="text-2xl font-bold">
            {{ summary.total }}
          </div>
          <div class="text-xs text-muted-foreground">
            笼位总数
          </div>
        </div>
        <div class="text-success p-3 text-center border rounded-lg">
          <div class="text-2xl font-bold">
            {{ summary.available }}
          </div>
          <div class="text-xs">
            空闲
          </div>
        </div>
        <div class="text-destructive p-3 text-center border rounded-lg">
          <div class="text-2xl font-bold">
            {{ summary.occupied }}
          </div>
          <div class="text-xs">
            占用
          </div>
        </div>
        <div class="text-warning p-3 text-center border rounded-lg">
          <div class="text-2xl font-bold">
            {{ summary.maintenance }}
          </div>
          <div class="text-xs">
            维护中
          </div>
        </div>
        <div class="text-info p-3 text-center border rounded-lg">
          <div class="text-2xl font-bold">
            {{ summary.cleaning }}
          </div>
          <div class="text-xs">
            清洁中
          </div>
        </div>
      </div>

      <FaSearchBar :show-toggle="false">
        <template #default>
          <div class="flex justify-end">
            <FaButton type="primary" @click="loadCageStatus">
              <FaIcon name="i-ri:refresh-line" />
              刷新
            </FaButton>
          </div>
        </template>
      </FaSearchBar>
      <div class="mx--4 my-3 border-t border-t-dashed" />

      <!-- 按房间分组的笼位卡片 -->
      <div v-loading="loading" class="space-y-4">
        <div
          v-for="room in groupedByRoom"
          :key="room.room_id"
          class="p-4 border rounded-lg"
        >
          <div class="mb-3 flex items-center justify-between">
            <div class="flex gap-2 items-center">
              <FaIcon name="i-ri:door-line" class="text-lg" />
              <span class="text-base font-bold">{{ room.room_name }}</span>
              <FaTag variant="outline" size="sm">
                {{ room.room_type ? ROOM_TYPE_LABELS[room.room_type] : '普通房' }}
              </FaTag>
              <span v-if="room.room_floor" class="text-xs text-muted-foreground">
                {{ room.room_floor }} 楼
              </span>
            </div>
            <div class="text-xs flex gap-2">
              <FaTag variant="default" size="sm">
                空闲 {{ room.available_count }}
              </FaTag>
              <FaTag variant="destructive" size="sm">
                占用 {{ room.occupied_count }}
              </FaTag>
              <FaTag variant="outline" size="sm">
                总数 {{ room.total_count }}
              </FaTag>
            </div>
          </div>
          <div class="gap-2 grid grid-cols-2 lg:grid-cols-6 md:grid-cols-4">
            <div
              v-for="cage in room.cages"
              :key="cage.cage_id"
              class="p-2 border rounded cursor-pointer transition hover:shadow"
              :class="{
                'border-success bg-success-50': cage.cage_status === 'available',
                'border-destructive bg-destructive-50': cage.cage_status === 'occupied',
                'border-warning bg-warning-50': cage.cage_status === 'maintenance',
                'border-info bg-info-50': cage.cage_status === 'cleaning',
              }"
            >
              <div class="text-sm font-bold truncate">
                {{ cage.cage_name }}
              </div>
              <div class="text-xs text-muted-foreground">
                {{ CAGE_TYPE_LABELS[cage.cage_type] }}
              </div>
              <div class="mt-1">
                <FaTag :variant="statusTagVariant(cage.cage_status)" size="sm">
                  {{ CAGE_STATUS_LABELS[cage.cage_status] }}
                </FaTag>
              </div>
              <div v-if="cage.cage_status === 'occupied' && cage.admitted_at" class="text-xs text-muted-foreground mt-1">
                入院: {{ new Date(cage.admitted_at).toLocaleDateString('zh-CN') }}
              </div>
              <div v-if="cage.daily_rate > 0" class="text-xs mt-1">
                ¥{{ cage.daily_rate }}/日
              </div>
            </div>
          </div>
        </div>
        <div v-if="!loading && cageStatusList.length === 0" class="text-muted-foreground py-8 text-center">
          当前门店暂无笼位数据,请先在「住院管理 → 入院登记」中维护房间与笼位
        </div>
      </div>
    </FaPageMain>
  </div>
</template>
