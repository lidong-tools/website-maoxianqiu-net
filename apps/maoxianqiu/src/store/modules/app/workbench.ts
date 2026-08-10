import type { WorkbenchRole } from '@/types/patient-journey'

export const useWorkbenchStore = defineStore('workbenchPreference', () => {
  const activeRole = ref<WorkbenchRole>('frontdesk')

  /** 切换本次操作使用的岗位上下文，服务端会把该岗位快照写入旅程事件。 */
  function selectRole(role: WorkbenchRole) {
    activeRole.value = role
  }

  return { activeRole, selectRole }
}, {
  persist: {
    pick: ['activeRole'],
  },
})
