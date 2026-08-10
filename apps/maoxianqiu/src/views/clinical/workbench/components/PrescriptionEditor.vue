<script setup lang="ts">
import type { CatalogItemPicked } from '@/components/business/CatalogItemPicker/index.vue'
/**
 * PrescriptionEditor — 处方明细快速编辑器
 * 每行:药品(目录选择器带出药名/单位) + 剂量 + 频次 + 数量 + 单位 + 用法。
 * 支持连续新增行;提交走 savePrescription + issuePrescription(服务端事务生成收费与药房任务)。
 * 所有字段单向绑定 + emit update,避免子组件直接修改 props。
 */
import type { PrescriptionItemInput } from '@/types/clinical'
import BusinessCatalogItemPicker from '@/components/business/CatalogItemPicker/index.vue'

defineOptions({
  name: 'WorkbenchPrescriptionEditor',
})

defineProps<{
  items: PrescriptionItemInput[]
  submitting: boolean
  readonly: boolean
}>()

const emit = defineEmits<{
  add: []
  remove: [index: number]
  update: [index: number, field: keyof PrescriptionItemInput, value: unknown]
  submit: []
}>()

/** 选中目录项目后回填药名与单位,避免重复录入 */
function onPickItem(index: number, picked?: CatalogItemPicked) {
  if (!picked) {
    emit('update', index, 'catalogItemId', '')
    emit('update', index, 'drugName', '')
    emit('update', index, 'unit', '')
    return
  }
  emit('update', index, 'catalogItemId', picked.id)
  emit('update', index, 'drugName', picked.name)
  emit('update', index, 'unit', picked.unit ?? '')
}
</script>

<template>
  <div class="space-y-2">
    <div
      v-for="(item, index) in items"
      :key="index"
      class="p-2 border rounded-md space-y-1.5"
    >
      <div class="flex gap-1.5 items-center">
        <BusinessCatalogItemPicker
          :model-value="item.catalogItemId"
          billing-type="drug"
          placeholder="搜索药品"
          :disabled="readonly"
          class="flex-1 min-w-0"
          @update:model-value="(v) => emit('update', index, 'catalogItemId', v)"
          @change="onPickItem(index, $event)"
        />
        <FaInput :model-value="item.dosage" placeholder="剂量" :disabled="readonly" class="w-20" @update:model-value="(v) => emit('update', index, 'dosage', v)" />
        <FaInput :model-value="item.frequency" placeholder="频次" :disabled="readonly" class="w-24" @update:model-value="(v) => emit('update', index, 'frequency', v)" />
        <FaInput :model-value="item.quantity" type="number" placeholder="数量" :disabled="readonly" class="w-16" @update:model-value="(v) => emit('update', index, 'quantity', v)" />
        <FaButton
          size="sm"
          variant="ghost"
          class="text-destructive shrink-0"
          :disabled="readonly"
          @click="emit('remove', index)"
        >
          <FaIcon name="i-lucide:trash-2" />
        </FaButton>
      </div>
      <div class="flex gap-1.5 items-center">
        <FaInput :model-value="item.unit" placeholder="单位" :disabled="readonly" class="w-24" @update:model-value="(v) => emit('update', index, 'unit', v)" />
        <FaInput :model-value="item.instructions" placeholder="用法/备注(如:饭后口服)" :disabled="readonly" class="flex-1 min-w-0" @update:model-value="(v) => emit('update', index, 'instructions', v)" />
      </div>
    </div>

    <div class="flex gap-2">
      <FaButton size="sm" variant="outline" :disabled="readonly" @click="emit('add')">
        <FaIcon name="i-lucide:plus" />
        添加一行
      </FaButton>
      <FaButton size="sm" :disabled="readonly" :loading="submitting" @click="emit('submit')">
        <FaIcon name="i-lucide:send" />
        保存并开具处方
      </FaButton>
    </div>
  </div>
</template>
