/**
 * 门店切换自动刷新(P0-06)
 * 页面统一监听 currentStoreId,切店后重置局部状态并重载数据。
 * - 首次挂载不触发(页面在 onMounted 自行 load)
 * - 不做 confirmLeave(那是 ToolbarStart 切换门店前的职责,避免确认取消后仍触发重载)
 * - 用 runId 防止旧请求的 load 覆盖新门店数据
 */

export interface StoreScopedPageOptions {
  /** 门店切换后重新加载页面数据 */
  load: () => Promise<void> | void
  /** 加载前重置页面局部状态(分页、store 筛选等) */
  reset?: () => void
  /** 可选:自定义门店 id 来源,默认 currentStoreId */
  storeIdRef?: () => string
}

export function useStoreScopedPage(options: StoreScopedPageOptions) {
  const appTenantStore = useAppTenantStore()
  const getStoreId = options.storeIdRef ?? (() => appTenantStore.currentStoreId)
  let runId = 0

  watch(
    () => getStoreId(),
    async (newVal, oldVal) => {
      if (newVal === oldVal) {
        return
      }
      if (!appTenantStore.isReady) {
        return
      }
      const currentRun = ++runId
      options.reset?.()
      await options.load()
      // 新切换已触发新一轮 reset+load,丢弃本轮(防止旧数据覆盖)
      if (currentRun !== runId) {
        return
      }
    },
  )
}
