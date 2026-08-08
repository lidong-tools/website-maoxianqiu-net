<script setup lang="ts">
import type { CustomerRecord, PetRecord, PetWeightRecord } from '@/types/customer'
import apiPet from '@/api/modules/pet'
import { supabase } from '@/lib/supabase'
import {
  PET_GENDER_LABELS,
  PET_SPECIES_LABELS,
  PET_STATUS_LABELS,
} from '@/types/customer'

defineOptions({
  name: 'CrmPetDetail',
})

const route = useRoute()
const router = useRouter()

const petId = computed(() => route.params.id as string)
const loading = ref(false)
const pet = ref<PetRecord | null>(null)
const owner = ref<CustomerRecord | null>(null)
const weights = ref<PetWeightRecord[]>([])

const editingWeight = ref(false)
const newWeight = ref<number | undefined>(undefined)
const newWeightNote = ref('')
const savingWeight = ref(false)

const editingRisk = ref(false)
const riskTagsInput = ref('')
const temperamentInput = ref('')
const medicalNotesInput = ref('')
const savingRisk = ref(false)

/** 宠物年龄(周岁) */
const ageText = computed(() => {
  if (!pet.value?.birth_date) {
    return ''
  }
  const diff = Date.now() - new Date(pet.value.birth_date).getTime()
  const years = Math.floor(diff / (365.25 * 24 * 3600 * 1000))
  if (years >= 1) {
    return `${years} 岁`
  }
  const months = Math.max(1, Math.floor(diff / (30 * 24 * 3600 * 1000)))
  return `${months} 个月`
})

async function loadDetail() {
  loading.value = true
  try {
    const res: any = await apiPet.detail(petId.value)
    pet.value = res.data.pet
    weights.value = res.data.weights ?? []

    if (pet.value) {
      riskTagsInput.value = pet.value.risk_tags?.join(', ') ?? ''
      temperamentInput.value = pet.value.temperament ?? ''
      medicalNotesInput.value = pet.value.medical_notes ?? ''
      if (pet.value.customer_id) {
        const ownerRes = await supabase.from('customers').select('*').eq('id', pet.value.customer_id).maybeSingle()
        owner.value = (ownerRes.data ?? null) as CustomerRecord | null
      }
    }
  }
  catch (e: any) {
    useFaToast().error('加载失败', { description: e?.message })
  }
  finally {
    loading.value = false
  }
}

async function onSaveWeight() {
  if (!newWeight.value || newWeight.value <= 0) {
    useFaToast().warning('请输入有效体重')
    return
  }
  if (!pet.value) {
    return
  }
  savingWeight.value = true
  try {
    await apiPet.addWeight(
      petId.value,
      pet.value.tenant_id,
      newWeight.value,
      newWeightNote.value || undefined,
    )
    useFaToast().success('记录已添加')
    newWeight.value = undefined
    newWeightNote.value = ''
    editingWeight.value = false
    await loadDetail()
  }
  catch (e: any) {
    useFaToast().error('添加失败', { description: e?.message })
  }
  finally {
    savingWeight.value = false
  }
}

async function onSaveRisk() {
  if (!pet.value) {
    return
  }
  savingRisk.value = true
  try {
    const tags = riskTagsInput.value
      .split(/[,，]/)
      .map(t => t.trim())
      .filter(Boolean)
    await apiPet.update(petId.value, {
      riskTags: tags,
      temperament: temperamentInput.value || undefined,
      medicalNotes: medicalNotesInput.value || undefined,
    })
    useFaToast().success('保存成功')
    editingRisk.value = false
    await loadDetail()
  }
  catch (e: any) {
    useFaToast().error('保存失败', { description: e?.message })
  }
  finally {
    savingRisk.value = false
  }
}

function onBack() {
  router.back()
}

function formatDateTime(dateStr: string): string {
  if (!dateStr) {
    return '-'
  }
  return new Date(dateStr).toLocaleString('zh-CN')
}

onMounted(loadDetail)
</script>

<template>
  <div v-loading="loading" class="flex flex-col h-full">
    <EntitySummaryHeader
      avatar="i-lucide:paw-print"
      :subtitle="pet ? `${PET_SPECIES_LABELS[pet.species ?? 'other'] ?? pet.species} · ${pet.breed ?? ''} · ${ageText}` : ''"
      :tags="pet ? [{ label: PET_STATUS_LABELS[pet.status], variant: pet.status === 'active' ? 'success' : 'neutral' }] : []"
    >
      <template #title>
        <span>{{ pet?.name ?? '宠物详情' }}</span>
      </template>
      <template #actions>
        <FaButton v-if="pet" size="sm" variant="outline" @click="onBack">
          <FaIcon name="i-lucide:arrow-left" />
          返回
        </FaButton>
        <FaButton v-if="pet" size="sm" @click="router.push(`/clinical/appointment?petId=${pet.id}`)">
          <FaIcon name="i-lucide:calendar-plus" />
          新建就诊
        </FaButton>
      </template>
    </EntitySummaryHeader>

    <div class="p-4 flex flex-1 flex-col gap-3 min-h-0 overflow-auto">
      <!-- 医疗安全信息:长期可见,Icon+文字 -->
      <PetSafetyBanner
        v-if="pet"
        :risk-tags="pet.risk_tags"
        :temperament="pet.temperament"
        :medical-notes="pet.medical_notes"
      />

      <!-- 基本信息 -->
      <FaCard title="基本信息">
        <div v-if="pet" class="gap-4 grid grid-cols-1 md:grid-cols-2">
          <div class="flex flex-col gap-1">
            <span class="text-xs text-muted-foreground">宠物名字</span>
            <span>{{ pet.name }}</span>
          </div>
          <div class="flex flex-col gap-1">
            <span class="text-xs text-muted-foreground">主人</span>
            <span>{{ owner?.name ?? '未知' }}<template v-if="owner?.phone"> · {{ owner.phone }}</template></span>
          </div>
          <div class="flex flex-col gap-1">
            <span class="text-xs text-muted-foreground">物种</span>
            <span>{{ PET_SPECIES_LABELS[pet.species ?? 'other'] ?? pet.species }}</span>
          </div>
          <div class="flex flex-col gap-1">
            <span class="text-xs text-muted-foreground">品种</span>
            <span>{{ pet.breed ?? '-' }}</span>
          </div>
          <div class="flex flex-col gap-1">
            <span class="text-xs text-muted-foreground">性别</span>
            <span>{{ PET_GENDER_LABELS[pet.gender ?? 'unknown'] }}</span>
          </div>
          <div class="flex flex-col gap-1">
            <span class="text-xs text-muted-foreground">出生日期</span>
            <span>{{ pet.birth_date ?? '-' }}</span>
          </div>
          <div class="flex flex-col gap-1">
            <span class="text-xs text-muted-foreground">当前体重</span>
            <span>{{ pet.weight != null ? `${pet.weight} kg` : '-' }}</span>
          </div>
          <div class="flex flex-col gap-1">
            <span class="text-xs text-muted-foreground">绝育</span>
            <span>{{ pet.is_neutered ? '已绝育' : '未绝育' }}</span>
          </div>
          <div class="flex flex-col gap-1">
            <span class="text-xs text-muted-foreground">毛色</span>
            <span>{{ pet.color ?? '-' }}</span>
          </div>
          <div class="flex flex-col gap-1">
            <span class="text-xs text-muted-foreground">芯片号</span>
            <span>{{ pet.microchip ?? '-' }}</span>
          </div>
          <div v-if="pet.remark" class="flex flex-col gap-1 md:col-span-2">
            <span class="text-xs text-muted-foreground">备注</span>
            <span>{{ pet.remark }}</span>
          </div>
        </div>
        <EmptyState v-else compact description="暂无数据" />
      </FaCard>

      <!-- 体重记录 -->
      <FaCard title="体重趋势">
        <template #extra>
          <FaButton variant="outline" size="sm" @click="editingWeight = !editingWeight">
            <FaIcon name="i-lucide:plus" />
            记录体重
          </FaButton>
        </template>
        <div v-if="editingWeight" class="mb-4 p-3 border rounded-lg bg-muted/30">
          <div class="flex flex-wrap gap-3 items-end">
            <FaLabel label="体重(kg)">
              <FaInput v-model="newWeight" type="number" placeholder="请输入体重" class="w-32" />
            </FaLabel>
            <FaLabel label="备注">
              <FaInput v-model="newWeightNote" placeholder="可选备注" class="w-48" />
            </FaLabel>
            <div class="flex gap-2">
              <FaButton variant="outline" size="sm" @click="editingWeight = false">
                取消
              </FaButton>
              <FaButton size="sm" :loading="savingWeight" @click="onSaveWeight">
                保存
              </FaButton>
            </div>
          </div>
        </div>
        <EmptyState v-if="weights.length === 0" compact description="暂无体重记录" />
        <div v-else class="flex flex-col gap-2">
          <div
            v-for="w in weights"
            :key="w.id"
            class="p-2 border rounded flex items-center justify-between"
          >
            <div class="flex gap-3 items-center">
              <span class="font-medium">{{ w.weight }} kg</span>
              <span v-if="w.note" class="text-sm text-muted-foreground">{{ w.note }}</span>
            </div>
            <span class="text-xs text-muted-foreground">{{ formatDateTime(w.recorded_at) }}</span>
          </div>
        </div>
      </FaCard>

      <!-- 风险标记 / 过敏史 / 慢病史 -->
      <FaCard title="风险标记 / 过敏史 / 慢病史">
        <template #extra>
          <FaButton variant="outline" size="sm" @click="editingRisk = !editingRisk">
            <FaIcon name="i-lucide:pencil" />
            编辑
          </FaButton>
        </template>
        <div v-if="editingRisk" class="space-y-3">
          <FaLabel label="风险标签(逗号分隔,如:过敏, 攻击性, 慢性病)">
            <FaInput v-model="riskTagsInput" placeholder="如:对青霉素过敏, 攻击性" class="w-full" />
          </FaLabel>
          <FaLabel label="性格特征">
            <FaInput v-model="temperamentInput" placeholder="如:温顺 / 胆小 / 活泼" class="w-full" />
          </FaLabel>
          <FaLabel label="医疗备注(过敏史/慢病史等)">
            <FaInput v-model="medicalNotesInput" type="textarea" :rows="3" placeholder="详细描述过敏史、慢病史等" class="w-full" />
          </FaLabel>
          <div class="flex gap-2 justify-end">
            <FaButton variant="outline" size="sm" @click="editingRisk = false">
              取消
            </FaButton>
            <FaButton size="sm" :loading="savingRisk" @click="onSaveRisk">
              保存
            </FaButton>
          </div>
        </div>
        <div v-else-if="pet" class="space-y-3">
          <div class="flex flex-wrap gap-2">
            <span class="text-xs text-muted-foreground">风险标签:</span>
            <template v-if="pet.risk_tags && pet.risk_tags.length > 0">
              <span
                v-for="tag in pet.risk_tags"
                :key="tag"
                class="bg-warning-100 text-warning-700 text-xs px-2 py-0.5 rounded"
              >
                {{ tag }}
              </span>
            </template>
            <span v-else class="text-sm text-muted-foreground">无</span>
          </div>
          <div class="flex flex-col gap-1">
            <span class="text-xs text-muted-foreground">性格特征:</span>
            <span>{{ pet.temperament ?? '-' }}</span>
          </div>
          <div class="flex flex-col gap-1">
            <span class="text-xs text-muted-foreground">医疗备注(过敏史/慢病史):</span>
            <span class="whitespace-pre-wrap">{{ pet.medical_notes ?? '-' }}</span>
          </div>
        </div>
        <EmptyState v-else compact description="暂无数据" />
      </FaCard>
    </div>
  </div>
</template>
