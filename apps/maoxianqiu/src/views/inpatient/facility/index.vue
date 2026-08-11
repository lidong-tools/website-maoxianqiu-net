<script setup lang="ts">
import type { TableColumn } from '@fantastic-admin/components'
import type { StatusVariant } from '@/utils/status'
import type { Cage, CageStatus, Room, RoomType } from '@/types/inpatient'
import apiInpatient from '@/api/modules/inpatient'
import EntityStatusTag from '@/components/business/EntityStatusTag/index.vue'
import { useAppTenantStore } from '@/store/modules/app/tenant'
import { CAGE_STATUS_LABELS, CAGE_STATUS_COLORS, CAGE_TYPE_LABELS, ROOM_TYPE_LABELS } from '@/types/inpatient'

defineOptions({
  name: 'InpatientFacility',
})

const tenantStore = useAppTenantStore()
const loading = ref(false)
const submitting = ref(false)

// 房间与笼位数据
const rooms = ref<Room[]>([])
const cages = ref<Cage[]>([])
const selectedRoomId = ref('')

// ==================== 房间表单 ====================
const roomModalVisible = ref(false)
const editingRoom = ref(false)
const roomForm = reactive({
  id: '',
  name: '',
  code: '',
  floor: '',
  roomType: 'standard' as RoomType,
  capacity: 1,
  isActive: true,
})

// ==================== 笼位表单 ====================
const cageModalVisible = ref(false)
const editingCage = ref(false)
const cageForm = reactive({
  id: '',
  name: '',
  code: '',
  cageType: 'cage' as Cage['cage_type'],
  dailyRate: 0,
  status: 'available' as CageStatus,
})

/**
 * 加载房间列表(切店/新增后自动选中第一个房间并联动加载笼位)
 * 注意:加载全部房间(含停用),否则停用后的房间从列表消失无法再编辑/启用
 */
async function loadRooms() {
  loading.value = true
  try {
    const res = await apiInpatient.listRooms(tenantStore.currentStoreId || undefined, false)
    rooms.value = res.data.list
    if (!rooms.value.find(r => r.id === selectedRoomId.value)) {
      selectedRoomId.value = rooms.value[0]?.id ?? ''
    }
    await loadCages()
  }
  catch (e: unknown) {
    useFaToast().error(e instanceof Error ? e.message : '加载房间失败')
  }
  finally {
    loading.value = false
  }
}

/**
 * 加载所选房间的笼位列表
 */
async function loadCages() {
  if (!selectedRoomId.value) {
    cages.value = []
    return
  }
  try {
    const res = await apiInpatient.listCages(tenantStore.currentStoreId || undefined, selectedRoomId.value)
    cages.value = res.data.list
  }
  catch (e: unknown) {
    useFaToast().error(e instanceof Error ? e.message : '加载笼位失败')
  }
}

/**
 * 打开新增/编辑房间弹窗
 * @param row 待编辑房间(为空表示新增)
 */
function openRoomModal(row?: Room) {
  editingRoom.value = !!row
  roomForm.id = row?.id ?? ''
  roomForm.name = row?.name ?? ''
  roomForm.code = row?.code ?? ''
  roomForm.floor = row?.floor ?? ''
  roomForm.roomType = row?.room_type ?? 'standard'
  roomForm.capacity = row?.capacity ?? 1
  roomForm.isActive = row?.is_active ?? true
  roomModalVisible.value = true
}

/**
 * 提交房间表单(新增或编辑,不做删除只做停用)
 */
async function onSaveRoom() {
  if (!tenantStore.currentTenantId || !tenantStore.currentStoreId) {
    useFaToast().warning('请先选择工作门店')
    return
  }
  if (!roomForm.name.trim() || !roomForm.code.trim()) {
    useFaToast().warning('请填写房间名称与编码')
    return
  }
  submitting.value = true
  try {
    if (editingRoom.value && roomForm.id) {
      await apiInpatient.updateRoom(roomForm.id, {
        name: roomForm.name.trim(),
        code: roomForm.code.trim(),
        floor: roomForm.floor.trim() || undefined,
        roomType: roomForm.roomType,
        capacity: roomForm.capacity,
        isActive: roomForm.isActive,
      })
      useFaToast().success('房间已更新')
    }
    else {
      await apiInpatient.createRoom({
        tenantId: tenantStore.currentTenantId,
        storeId: tenantStore.currentStoreId,
        name: roomForm.name.trim(),
        code: roomForm.code.trim(),
        floor: roomForm.floor.trim() || undefined,
        roomType: roomForm.roomType,
        capacity: roomForm.capacity,
        isActive: true,
      })
      useFaToast().success('房间已创建')
    }
    roomModalVisible.value = false
    await loadRooms()
  }
  catch {
    // 错误已由全局拦截器提示
  }
  finally {
    submitting.value = false
  }
}

/**
 * 切换房间启用/停用状态(停用后新入院不再展示该房间)
 * @param row 房间
 */
async function onToggleRoomActive(row: Room) {
  submitting.value = true
  try {
    await apiInpatient.updateRoom(row.id, { isActive: !row.is_active })
    useFaToast().success(row.is_active ? '房间已停用' : '房间已启用')
    await loadRooms()
  }
  catch {
    // 错误已由全局拦截器提示
  }
  finally {
    submitting.value = false
  }
}

/**
 * 打开新增/编辑笼位弹窗
 * @param row 待编辑笼位(为空表示新增)
 */
function openCageModal(row?: Cage) {
  if (!selectedRoomId.value) {
    useFaToast().warning('请先选择房间')
    return
  }
  editingCage.value = !!row
  cageForm.id = row?.id ?? ''
  cageForm.name = row?.name ?? ''
  cageForm.code = row?.code ?? ''
  cageForm.cageType = row?.cage_type ?? 'cage'
  cageForm.dailyRate = row?.daily_rate ?? 0
  cageForm.status = row?.status ?? 'available'
  cageModalVisible.value = true
}

/**
 * 提交笼位表单(新增或编辑)
 */
async function onSaveCage() {
  if (!tenantStore.currentTenantId || !tenantStore.currentStoreId) {
    useFaToast().warning('请先选择工作门店')
    return
  }
  if (!cageForm.name.trim() || !cageForm.code.trim()) {
    useFaToast().warning('请填写笼位名称与编码')
    return
  }
  submitting.value = true
  try {
    if (editingCage.value && cageForm.id) {
      await apiInpatient.updateCage(cageForm.id, {
        name: cageForm.name.trim(),
        code: cageForm.code.trim(),
        cageType: cageForm.cageType,
        dailyRate: cageForm.dailyRate,
        status: cageForm.status,
      })
      useFaToast().success('笼位已更新')
    }
    else {
      await apiInpatient.createCage({
        tenantId: tenantStore.currentTenantId,
        storeId: tenantStore.currentStoreId,
        roomId: selectedRoomId.value,
        name: cageForm.name.trim(),
        code: cageForm.code.trim(),
        cageType: cageForm.cageType,
        dailyRate: cageForm.dailyRate,
        status: 'available',
      })
      useFaToast().success('笼位已创建')
    }
    cageModalVisible.value = false
    await loadCages()
  }
  catch {
    // 错误已由全局拦截器提示
  }
  finally {
    submitting.value = false
  }
}

/**
 * 切换笼位状态(空闲/维护/清洁);占用中的笼位由住院/寄养流程控制,禁止人工切换
 * @param row 笼位
 * @param to 目标状态
 */
async function onSwitchCageStatus(row: Cage, to: CageStatus) {
  if (row.status === 'occupied') {
    useFaToast().warning('占用中的笼位不可切换状态,请先办理出院/离店')
    return
  }
  submitting.value = true
  try {
    await apiInpatient.updateCage(row.id, { status: to })
    useFaToast().success('笼位状态已更新')
    await loadCages()
  }
  catch {
    // 错误已由全局拦截器提示
  }
  finally {
    submitting.value = false
  }
}

/**
 * 选中房间并加载其笼位
 * @param roomId 房间 id
 */
function onSelectRoom(roomId: string) {
  selectedRoomId.value = roomId
  loadCages()
}

// P0-06:切店后按新门店重载房间/笼位
useStoreScopedPage({
  load: async () => {
    selectedRoomId.value = ''
    await loadRooms()
  },
})

onMounted(async () => {
  await loadRooms()
})

/** 房间列变体 */
function roomTagVariant(room: Room): 'default' | 'outline' {
  return room.is_active ? 'default' : 'outline'
}

/** 笼位状态 Tag 变体(EntityStatusTag 使用 StatusVariant) */
function cageStatusVariant(status: CageStatus): StatusVariant {
  const color = CAGE_STATUS_COLORS[status]
  if (color === 'success') {
    return 'success'
  }
  if (color === 'destructive') {
    return 'danger'
  }
  if (color === 'warning') {
    return 'warning'
  }
  return 'info'
}

const cageColumns = computed<TableColumn<Cage>[]>(() => [
  { accessorKey: 'name', header: '笼位名称' },
  { accessorKey: 'code', header: '编码' },
  {
    accessorKey: 'cage_type',
    header: '类型',
    cell: info => CAGE_TYPE_LABELS[info.getValue() as Cage['cage_type']] ?? info.getValue(),
  },
  {
    accessorKey: 'daily_rate',
    header: '日费率',
    cell: info => `¥${Number(info.getValue() ?? 0).toFixed(2)}`,
  },
  {
    accessorKey: 'status',
    header: '状态',
    cell: (info) => {
      const v = info.getValue() as CageStatus
      return h(EntityStatusTag, { label: CAGE_STATUS_LABELS[v] ?? v, variant: cageStatusVariant(v), dot: true })
    },
  },
  {
    id: 'operation',
    header: '操作',
    width: 240,
    align: 'right',
    fixed: 'right',
  },
])
</script>

<template>
  <div class="flex flex-col min-h-0 inset-0 absolute overflow-hidden">
    <div class="p-2 flex flex-1 flex-col gap-2 h-full min-h-0 overflow-hidden">
      <div class="gap-2 grid grid-cols-1 md:grid-cols-3 min-h-0 flex-1">
        <!-- 左侧:房间列表 -->
        <div class="border rounded-lg bg-card flex flex-col min-h-0 overflow-hidden">
          <div class="px-4 py-3 border-b shrink-0 flex items-center justify-between">
            <span class="font-bold">房间列表</span>
            <FaButton size="sm" @click="openRoomModal()">
              <FaIcon name="i-lucide:plus" />
              新增房间
            </FaButton>
          </div>
          <div v-loading="loading" class="flex-1 min-h-0 overflow-auto">
            <div
              v-for="room in rooms"
              :key="room.id"
              class="p-3 border-b cursor-pointer transition hover:bg-gray-50"
              :class="selectedRoomId === room.id ? 'bg-primary-50' : ''"
              @click="onSelectRoom(room.id)"
            >
              <div class="flex items-center justify-between gap-2">
                <div class="min-w-0">
                  <div class="flex items-center gap-2">
                    <span class="font-medium truncate">{{ room.name }}</span>
                    <FaTag variant="outline" size="sm">
                      {{ ROOM_TYPE_LABELS[room.room_type] ?? room.room_type }}
                    </FaTag>
                  </div>
                  <div class="text-xs text-muted-foreground mt-0.5">
                    {{ room.code }}
                    <template v-if="room.floor"> · {{ room.floor }} 楼</template>
                    · 容量 {{ room.capacity }}
                  </div>
                </div>
                <div class="flex gap-1 shrink-0 items-center">
                  <FaTag :variant="roomTagVariant(room)" size="sm">
                    {{ room.is_active ? '启用' : '停用' }}
                  </FaTag>
                  <FaButton variant="ghost" size="sm" @click.stop="openRoomModal(room)">
                    编辑
                  </FaButton>
                  <FaButton variant="ghost" size="sm" @click.stop="onToggleRoomActive(room)">
                    {{ room.is_active ? '停用' : '启用' }}
                  </FaButton>
                </div>
              </div>
            </div>
            <EmptyState v-if="!loading && rooms.length === 0" compact title="暂无房间,点击右上角新增" />
          </div>
        </div>

        <!-- 右侧:笼位列表 -->
        <div class="border rounded-lg bg-card flex flex-col min-h-0 min-w-0 overflow-hidden md:col-span-2">
          <div class="px-4 py-3 border-b shrink-0 flex items-center justify-between">
            <span class="font-bold">{{ rooms.find(r => r.id === selectedRoomId)?.name ?? '未选择房间' }} · 笼位列表</span>
            <FaButton size="sm" :disabled="!selectedRoomId" @click="openCageModal()">
              <FaIcon name="i-lucide:plus" />
              新增笼位
            </FaButton>
          </div>
          <div v-loading="loading" class="flex-1 min-h-0 overflow-hidden">
            <FaTable
              v-if="selectedRoomId"
              class="h-full min-h-0"
              table-root-class="overflow-hidden"
              row-key="id"
              stripe
              border
              :columns="cageColumns"
              :data="cages"
            >
              <template #cell-operation="{ row }">
                <div class="flex gap-1 justify-end">
                  <FaButton v-if="row.original.status === 'available'" variant="outline" size="sm" @click="onSwitchCageStatus(row.original, 'maintenance')">
                    转维护
                  </FaButton>
                  <FaButton v-if="row.original.status === 'maintenance'" variant="outline" size="sm" @click="onSwitchCageStatus(row.original, 'available')">
                    转空闲
                  </FaButton>
                  <FaButton v-if="row.original.status === 'available'" variant="outline" size="sm" @click="onSwitchCageStatus(row.original, 'cleaning')">
                    转清洁
                  </FaButton>
                  <FaButton v-if="row.original.status === 'cleaning'" variant="outline" size="sm" @click="onSwitchCageStatus(row.original, 'available')">
                    转空闲
                  </FaButton>
                  <FaButton variant="ghost" size="sm" @click="openCageModal(row.original)">
                    编辑
                  </FaButton>
                </div>
              </template>
            </FaTable>
            <EmptyState v-else-if="!loading" compact title="请先在左侧选择房间" />
          </div>
        </div>
      </div>
    </div>

    <!-- 房间新增/编辑弹窗 -->
    <FaModal v-model="roomModalVisible" :title="editingRoom ? '编辑房间' : '新增房间'" :loading="submitting" @confirm="onSaveRoom">
      <div class="space-y-3">
        <FaLabel label="房间名称" required>
          <FaInput v-model="roomForm.name" placeholder="如:住院一区" class="w-full" />
        </FaLabel>
        <FaLabel label="房间编码" required>
          <FaInput v-model="roomForm.code" placeholder="如:WARD-01" class="w-full" />
        </FaLabel>
        <div class="gap-3 grid grid-cols-2">
          <FaLabel label="房间类型">
            <FaSelect
              v-model="roomForm.roomType"
              :options="Object.entries(ROOM_TYPE_LABELS).map(([value, label]) => ({ label, value }))"
              class="w-full"
            />
          </FaLabel>
          <FaLabel label="楼层(可选)">
            <FaInput v-model="roomForm.floor" placeholder="如:1" class="w-full" />
          </FaLabel>
        </div>
        <FaLabel label="容量">
          <FaInputNumber v-model="roomForm.capacity" :min="1" class="w-full" />
        </FaLabel>
        <FaLabel v-if="editingRoom" label="启用状态">
          <FaSwitch v-model="roomForm.isActive" />
        </FaLabel>
      </div>
    </FaModal>

    <!-- 笼位新增/编辑弹窗 -->
    <FaModal v-model="cageModalVisible" :title="editingCage ? '编辑笼位' : '新增笼位'" :loading="submitting" @confirm="onSaveCage">
      <div class="space-y-3">
        <FaLabel label="笼位名称" required>
          <FaInput v-model="cageForm.name" placeholder="如:A-01" class="w-full" />
        </FaLabel>
        <FaLabel label="笼位编码" required>
          <FaInput v-model="cageForm.code" placeholder="如:A01" class="w-full" />
        </FaLabel>
        <div class="gap-3 grid grid-cols-2">
          <FaLabel label="笼位类型">
            <FaSelect
              v-model="cageForm.cageType"
              :options="Object.entries(CAGE_TYPE_LABELS).map(([value, label]) => ({ label, value }))"
              class="w-full"
            />
          </FaLabel>
          <FaLabel label="日费率(元)">
            <FaInputNumber v-model="cageForm.dailyRate" :min="0" class="w-full" />
          </FaLabel>
        </div>
      </div>
    </FaModal>
  </div>
</template>
