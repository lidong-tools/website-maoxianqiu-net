<script setup lang="ts">
// TODO: 替换为毛线球专属 logo 文件
import logo from '@/assets/images/logo.svg'

defineOptions({
  name: 'WorkbenchHome',
})

const appAccountStore = useAppAccountStore()

// 工作台分组：随角色返回不同卡片(Phase 3+ 接入聚合数据)
const groupCards = [
  { title: '今日经营指标', description: '营收 · 客流 · 退款（待数据模块）' },
  { title: '今日预约 / 候诊', description: '预约与候诊队列（待数据模块）' },
  { title: '待处理任务', description: '病历草稿 · 检验结果 · 护理任务（待数据模块）' },
  { title: '库存预警', description: '近效期与低库存（待数据模块）' },
  { title: '最近就诊', description: '今日就诊记录（待数据模块）' },
  { title: '快捷操作', description: '新建客户 · 新建预约 · 收费（待数据模块）' },
]
</script>

<template>
  <div>
    <FaPageHeader title="工作台">
      <template #description>
        毛线球宠物医院管理系统 · {{ appAccountStore.isLogin ? appAccountStore.account : '未登录' }}
      </template>
    </FaPageHeader>
    <FaPageMain>
      <FaCard class="mb-4">
        <div class="flex gap-4 items-center">
          <img :src="logo" class="h-12 w-12 object-contain" alt="毛线球">
          <div>
            <div class="text-lg font-semibold">
              欢迎使用毛线球
            </div>
            <div class="text-sm text-muted-foreground">
              系统处于第一阶段壳层构建阶段，业务数据模块将在 Tenant/RLS 验收后接入。
            </div>
          </div>
        </div>
      </FaCard>

      <div class="gap-4 grid md:grid-cols-2 xl:grid-cols-3">
        <FaCard
          v-for="card in groupCards"
          :key="card.title"
          :title="card.title"
          :description="card.description"
        >
          <div class="text-sm text-muted-foreground flex h-28 items-center justify-center">
            <FaIcon name="i-lucide:inbox" class="mr-2" />
            待数据模块接入
          </div>
        </FaCard>
      </div>
    </FaPageMain>
  </div>
</template>
