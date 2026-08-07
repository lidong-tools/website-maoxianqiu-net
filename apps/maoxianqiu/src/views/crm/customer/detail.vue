<script setup lang="ts">
import type { CustomerRecord, PetRecord } from '@/types/customer'
import type { AttachmentWithFile } from '@/types/file'
import apiCustomer from '@/api/modules/customer'
import apiFile from '@/api/modules/file'
import { useAppTenantStore } from '@/store/modules/app/tenant'
import {
  CUSTOMER_GENDER_LABELS,
  CUSTOMER_STATUS_LABELS,
  MEMBER_LEVEL_LABELS,
  PET_GENDER_LABELS,
  PET_SPECIES_LABELS,
  PET_STATUS_LABELS,
} from '@/types/customer'

defineOptions({
  name: 'CrmCustomerDetail',
})

const route = useRoute()
const router = useRouter()
const tenantStore = useAppTenantStore()

const customerId = computed(() => route.params.id as string)
const isNew = computed(() => customerId.value === 'new')
const isEditMode = computed(() => route.query.mode === 'edit' || isNew.value)

const loading = ref(false)
const saving = ref(false)
const customer = ref<CustomerRecord | null>(null)
const pets = ref<PetRecord[]>([])
const attachments = ref<AttachmentWithFile[]>([])

/** 新增宠物抽屉显隐(AUD-004 客户 → 宠物建档) */
const petDrawerVisible = ref(false)

/** 编辑表单数据 */
const formData = ref({
  name: '',
  gender: 'unknown' as 'male' | 'female' | 'unknown',
  phone: '',
  email: '',
  address: '',
  birthday: '',
  source: 'walk_in',
  member_level: 'normal' as 'normal' | 'silver' | 'gold' | 'diamond',
  remark: '',
})

/**
 * 加载客户详情
 */
async function loadDetail() {
  if (isNew.value) {
    return
  }
  loading.value = true
  try {
    const res: any = await apiCustomer.detail(customerId.value)
    customer.value = res.data.customer
    pets.value = res.data.pets ?? []

    // 回填编辑表单
    const c = customer.value
    if (!c) {
      return
    }
    formData.value = {
      name: c.name ?? '',
      gender: c.gender ?? 'unknown',
      phone: c.phone ?? '',
      email: c.email ?? '',
      address: c.address ?? '',
      birthday: c.birthday ?? '',
      source: c.source ?? 'walk_in',
      member_level: c.member_level ?? 'normal',
      remark: c.remark ?? '',
    }

    // 加载附件
    loadAttachments()
  }
  catch (e: any) {
    useFaToast().error('加载失败', { description: e?.message })
  }
  finally {
    loading.value = false
  }
}

/**
 * 加载客户附件
 */
async function loadAttachments() {
  if (isNew.value || !customer.value) {
    return
  }
  try {
    const res: any = await apiFile.listAttachments({
      entityType: 'customer',
      entityId: customerId.value,
    })
    attachments.value = res.data.list ?? []
  }
  catch {
    attachments.value = []
  }
}

/**
 * 保存客户(新建/更新)
 */
async function onSave() {
  if (!formData.value.name.trim()) {
    useFaToast().warning('请填写客户姓名')
    return
  }

  saving.value = true
  try {
    if (isNew.value) {
      const res: any = await apiCustomer.create({
        tenantId: tenantStore.currentTenantId,
        storeId: tenantStore.currentStoreId || undefined,
        name: formData.value.name.trim(),
        gender: formData.value.gender,
        phone: formData.value.phone || undefined,
        email: formData.value.email || undefined,
        address: formData.value.address || undefined,
        birthday: formData.value.birthday || undefined,
        source: formData.value.source,
        memberLevel: formData.value.member_level,
        remark: formData.value.remark || undefined,
      })
      useFaToast().success('创建成功')
      router.replace(`/crm/customer/${res.data.id}`)
    }
    else {
      await apiCustomer.update(customerId.value, {
        name: formData.value.name.trim(),
        gender: formData.value.gender,
        phone: formData.value.phone || undefined,
        email: formData.value.email || undefined,
        address: formData.value.address || undefined,
        birthday: formData.value.birthday || undefined,
        source: formData.value.source,
        memberLevel: formData.value.member_level,
        remark: formData.value.remark || undefined,
      })
      useFaToast().success('保存成功')
      await loadDetail()
    }
  }
  catch (e: any) {
    useFaToast().error('保存失败', { description: e?.message })
  }
  finally {
    saving.value = false
  }
}

/**
 * 跳转宠物详情
 */
function onViewPet(pet: PetRecord) {
  router.push(`/crm/pet/${pet.id}`)
}

/**
 * 宠物建档成功回调:刷新宠物列表
 */
function onPetCreated() {
  loadDetail()
}

/**
 * 返回列表
 */
function onBack() {
  router.push('/crm/customer')
}

onMounted(loadDetail)
</script>

<template>
  <div>
    <FaPageHeader :title="isNew ? '新增客户' : '客户详情'" class="mb-0" @back="onBack">
      <template #description>
        {{ customer?.customer_no ?? '' }}
      </template>
    </FaPageHeader>
    <FaPageMain v-loading="loading">
      <!-- 基本信息 -->
      <FaCard title="基本信息">
        <template #extra>
          <FaButton v-if="!isEditMode && customer" variant="outline" size="sm" @click="router.push(`/crm/customer/${customerId}?mode=edit`)">
            <FaIcon name="i-ri:edit-line" />
            编辑
          </FaButton>
        </template>
        <div v-if="isEditMode" class="gap-4 grid grid-cols-1 md:grid-cols-2">
          <FaLabel label="客户姓名" required>
            <FaInput v-model="formData.name" placeholder="请输入姓名" class="w-full" />
          </FaLabel>
          <FaLabel label="手机号">
            <FaInput v-model="formData.phone" placeholder="请输入手机号" class="w-full" />
          </FaLabel>
          <FaLabel label="性别">
            <FaSelect
              v-model="formData.gender"
              :options="[
                { label: '男', value: 'male' },
                { label: '女', value: 'female' },
                { label: '未知', value: 'unknown' },
              ]"
              class="w-full"
            />
          </FaLabel>
          <FaLabel label="邮箱">
            <FaInput v-model="formData.email" placeholder="请输入邮箱" class="w-full" />
          </FaLabel>
          <FaLabel label="生日">
            <FaInput v-model="formData.birthday" type="date" class="w-full" />
          </FaLabel>
          <FaLabel label="会员等级">
            <FaSelect
              v-model="formData.member_level"
              :options="[
                { label: '普通', value: 'normal' },
                { label: '银卡', value: 'silver' },
                { label: '金卡', value: 'gold' },
                { label: '钻石', value: 'diamond' },
              ]"
              class="w-full"
            />
          </FaLabel>
          <FaLabel label="地址" class="md:col-span-2">
            <FaInput v-model="formData.address" placeholder="请输入地址" class="w-full" />
          </FaLabel>
          <FaLabel label="备注" class="md:col-span-2">
            <FaInput v-model="formData.remark" type="textarea" :rows="3" placeholder="请输入备注" class="w-full" />
          </FaLabel>
          <div class="flex gap-2 justify-end md:col-span-2">
            <FaButton variant="outline" @click="onBack">
              取消
            </FaButton>
            <FaButton type="primary" :loading="saving" @click="onSave">
              保存
            </FaButton>
          </div>
        </div>
        <div v-else-if="customer" class="gap-4 grid grid-cols-1 md:grid-cols-2">
          <div class="flex flex-col gap-1">
            <span class="text-xs text-muted-foreground">客户编号</span>
            <span>{{ customer.customer_no }}</span>
          </div>
          <div class="flex flex-col gap-1">
            <span class="text-xs text-muted-foreground">姓名</span>
            <span>{{ customer.name }}</span>
          </div>
          <div class="flex flex-col gap-1">
            <span class="text-xs text-muted-foreground">性别</span>
            <span>{{ CUSTOMER_GENDER_LABELS[customer.gender ?? 'unknown'] }}</span>
          </div>
          <div class="flex flex-col gap-1">
            <span class="text-xs text-muted-foreground">手机号</span>
            <span>{{ customer.phone ?? '-' }}</span>
          </div>
          <div class="flex flex-col gap-1">
            <span class="text-xs text-muted-foreground">邮箱</span>
            <span>{{ customer.email ?? '-' }}</span>
          </div>
          <div class="flex flex-col gap-1">
            <span class="text-xs text-muted-foreground">生日</span>
            <span>{{ customer.birthday ?? '-' }}</span>
          </div>
          <div class="flex flex-col gap-1">
            <span class="text-xs text-muted-foreground">会员等级</span>
            <span>{{ MEMBER_LEVEL_LABELS[customer.member_level] }}</span>
          </div>
          <div class="flex flex-col gap-1">
            <span class="text-xs text-muted-foreground">状态</span>
            <span>{{ CUSTOMER_STATUS_LABELS[customer.status] }}</span>
          </div>
          <div class="flex flex-col gap-1 md:col-span-2">
            <span class="text-xs text-muted-foreground">地址</span>
            <span>{{ customer.address ?? '-' }}</span>
          </div>
          <div class="flex flex-col gap-1 md:col-span-2">
            <span class="text-xs text-muted-foreground">备注</span>
            <span>{{ customer.remark ?? '-' }}</span>
          </div>
        </div>
        <FaEmptyState v-else description="暂无数据" />
      </FaCard>

      <!-- 宠物列表 -->
      <FaCard v-if="!isNew" title="宠物列表" class="mt-4">
        <template #extra>
          <FaButton variant="outline" size="sm" @click="petDrawerVisible = true">
            <FaIcon name="i-ri:add-line" />
            新增宠物
          </FaButton>
        </template>
        <FaEmptyState v-if="pets.length === 0" description="暂无宠物,点击右上角「新增宠物」建档" />
        <div v-else class="gap-3 grid grid-cols-1 lg:grid-cols-3 md:grid-cols-2">
          <div
            v-for="pet in pets"
            :key="pet.id"
            class="p-3 border rounded-lg cursor-pointer transition-colors hover:bg-muted/50"
            @click="onViewPet(pet)"
          >
            <div class="flex gap-2 items-center">
              <FaIcon name="i-ri:paw-line" class="text-lg" />
              <span class="font-medium">{{ pet.name }}</span>
              <span class="text-xs px-1.5 py-0.5 rounded bg-muted">
                {{ PET_SPECIES_LABELS[pet.species ?? 'other'] ?? pet.species }}
              </span>
            </div>
            <div class="text-sm text-muted-foreground mt-1">
              {{ PET_GENDER_LABELS[pet.gender ?? 'unknown'] }} · {{ pet.breed ?? '未知品种' }}
            </div>
            <div class="text-xs text-muted-foreground mt-1">
              状态:{{ PET_STATUS_LABELS[pet.status] }}
            </div>
          </div>
        </div>
      </FaCard>

      <!-- 就诊历史(占位) -->
      <FaCard v-if="!isNew" title="就诊历史" class="mt-4">
        <FaEmptyState description="就诊历史功能开发中" />
      </FaCard>

      <!-- 附件 -->
      <FaCard v-if="!isNew" title="附件" class="mt-4">
        <BusinessFilePreview :attachments="attachments" readonly />
      </FaCard>

      <!-- 新增宠物抽屉(AUD-004) -->
      <BusinessPetCreateDrawer
        v-if="customer && !isNew"
        v-model="petDrawerVisible"
        :customer-id="customer.id"
        :tenant-id="customer.tenant_id"
        @created="onPetCreated"
      />
    </FaPageMain>
  </div>
</template>
