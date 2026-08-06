<script setup lang="ts">
defineOptions({
  name: 'BusinessEntityListShell',
})

withDefaults(defineProps<{
  title?: string
  description?: string
  loading?: boolean
  /** 请求错误信息,非空时展示 ErrorState */
  error?: string
  /** 无数据(含筛选无结果)时展示 EmptyState */
  empty?: boolean
  emptyTitle?: string
  emptyDescription?: string
  total?: number
  page?: number
  pageSize?: number
  showPagination?: boolean
}>(), {
  loading: false,
  error: '',
  empty: false,
  emptyTitle: '暂无数据',
  emptyDescription: '',
  total: 0,
  page: 1,
  pageSize: 20,
  showPagination: true,
})

const emit = defineEmits<{
  retry: []
  pageChange: [page: number]
  sizeChange: [size: number]
}>()
</script>

<template>
  <div>
    <FaPageHeader :title="title" :description="description">
      <template v-if="$slots.actions" #default>
        <slot name="actions" />
      </template>
    </FaPageHeader>
    <FaPageMain>
      <slot v-if="$slots.filter" name="filter" />

      <template v-if="error">
        <ErrorState
          :title="error"
          message="请检查网络或稍后重试"
          @retry="emit('retry')"
        />
      </template>
      <template v-else>
        <div v-if="$slots.toolbar" class="mb-3 flex items-center justify-between">
          <slot name="toolbar" />
        </div>
        <div v-loading="loading">
          <slot v-if="!empty" name="default" />
          <EmptyState
            v-else
            :title="emptyTitle"
            :description="emptyDescription"
          >
            <template v-if="$slots.emptyAction" #action>
              <slot name="emptyAction" />
            </template>
          </EmptyState>
        </div>
        <FaPagination
          v-if="showPagination && !error && total > 0"
          :page="page"
          :size="pageSize"
          :total="total"
          class="mt-2"
          @page-change="emit('pageChange', $event)"
          @size-change="emit('sizeChange', $event)"
        />
      </template>
    </FaPageMain>
  </div>
</template>
