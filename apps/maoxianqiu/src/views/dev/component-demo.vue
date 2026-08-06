<script setup lang="ts">
import { commonStatusMap, employeeStatusMap, storeStatusMap } from '@/utils/status'

defineOptions({
  name: 'DevComponentDemo',
})

const storeId = ref('')
const row = reactive({
  status: 'active',
})

const demoStates = ['active', 'disabled', 'pending', 'approved', 'rejected', 'cancelled', 'completed']
const moneySamples = [0, 12.5, 1234.567, null, undefined]
const dateSamples = ['2026-08-06T08:30:00', '2026-08-01T00:00:00', null]
</script>

<template>
  <div>
    <FaPageHeader title="业务组件演示" description="UI Foundation 基础业务组件(MXQ-1003~1009),供业务页面复用参考" />
    <FaPageMain>
      <!-- StoreSelector -->
      <FaCard title="StoreSelector" description="门店选择器(读取当前可见门店)">
        <StoreSelector v-model="storeId" include-all class="max-w-72" />
        <div class="text-xs text-muted-foreground mt-2">
          当前选中: {{ storeId || '(未选择)' }}
        </div>
      </FaCard>

      <!-- PermissionButton -->
      <FaCard title="PermissionButton" description="权限按钮(hide / disable 两种模式)">
        <div class="flex flex-wrap gap-2">
          <PermissionButton permission="system:store:manage">
            有权限(hide)
          </PermissionButton>
          <PermissionButton permission="__not_exist__">
            无权限(hide,不渲染)
          </PermissionButton>
          <PermissionButton permission="__not_exist__" mode="disable" disabled-reason="需要「查看门店」权限">
            无权限(disable)
          </PermissionButton>
          <PermissionButton permission="" disabled disabled-reason="业务条件不满足">
            业务禁用
          </PermissionButton>
        </div>
      </FaCard>

      <!-- EntityStatusTag -->
      <FaCard title="EntityStatusTag" description="统一状态标签(禁止页面自行写三元表达式)">
        <div class="flex flex-wrap gap-2 items-center">
          <EntityStatusTag
            v-for="s in demoStates"
            :key="s"
            :status="s"
            :map="commonStatusMap"
          />
        </div>
        <div class="mt-2 flex gap-2 items-center">
          <EntityStatusTag :status="row.status" :map="storeStatusMap" />
          <EntityStatusTag status="invited" :map="employeeStatusMap" />
        </div>
      </FaCard>

      <!-- EntityPageHeader -->
      <FaCard title="EntityPageHeader" description="详情页头部(标题+状态+主要操作)">
        <EntityPageHeader
          title="患者档案 #P-20260806-001"
          description="由客户选择器带入的门店与风险上下文"
          show-status
          status="active"
          :status-map="commonStatusMap"
        >
          <template #actions>
            <PermissionButton permission="" variant="outline" size="sm">
              编辑
            </PermissionButton>
            <PermissionButton permission="" variant="destructive" size="sm">
              归档
            </PermissionButton>
          </template>
        </EntityPageHeader>
      </FaCard>

      <!-- Empty / Error / Conflict -->
      <FaCard title="Empty / Error / Conflict" description="三种页面状态">
        <div class="gap-4 grid lg:grid-cols-3">
          <EmptyState title="暂无客户" description="新建第一位客户开始使用" />
          <ErrorState title="加载失败" message="网络异常,请重试" @retry="() => {}" />
          <ConflictState title="数据已变更" message="该记录已被他人更新,请刷新" @reload="() => {}" />
        </div>
      </FaCard>

      <!-- Money / Date -->
      <FaCard title="Money / Date formatter" description="金额与时间展示">
        <div class="gap-3 grid md:grid-cols-2">
          <div>
            <div class="text-sm font-medium mb-2">
              金额
            </div>
            <div v-for="(v, i) in moneySamples" :key="i" class="text-sm">
              <MoneyText :value="v" />
            </div>
          </div>
          <div>
            <div class="text-sm font-medium mb-2">
              时间
            </div>
            <div v-for="(v, i) in dateSamples" :key="i" class="text-sm">
              <DateTimeText :value="v" />
            </div>
          </div>
        </div>
      </FaCard>

      <!-- Shells -->
      <FaCard title="EntityListShell / EntityDetailShell" description="标准列表壳与详情壳">
        <EntityListShell
          title="标准列表壳"
          description="FaPageHeader + FaPageMain + 状态 + 分页"
          :total="0"
        >
          <template #actions>
            <PermissionButton permission="">
              新增
            </PermissionButton>
          </template>
          <template #filter>
            <div class="text-xs text-muted-foreground mb-3 p-3 border rounded-md">
              筛选区(filter slot)
            </div>
          </template>
          <template #default>
            <div class="text-xs text-muted-foreground p-3 border rounded-md">
              表格区(default slot)
            </div>
          </template>
        </EntityListShell>
        <div class="mt-4">
          <EntityDetailShell title="标准详情壳" description="标题+状态+内容区" show-status status="draft" :status-map="commonStatusMap">
            <div class="text-xs text-muted-foreground p-3 border rounded-md">
              详情内容区(default slot)
            </div>
          </EntityDetailShell>
        </div>
      </FaCard>
    </FaPageMain>
  </div>
</template>
