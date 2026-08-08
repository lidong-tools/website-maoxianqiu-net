/**
 * 未保存内容保护:
 * - 页面通过 register(pageId) 注册自己的 dirty 状态(进入编辑态置 true,提交/保存后置 false)
 * - confirmLeave() 在切换门店/离开前检查全局是否有 dirty 页面,有则弹确认框
 * - 页面注册的 dirty 会自动随页面销毁清理(KeepAlive 页面除外,由页面自行管理)
 */

const dirtyPages = reactive(new Set<string>())

export function useUnsavedChangesGuard() {
  /**
   * 注册一个页面的 dirty 状态
   * @param pageId 页面唯一标识(建议用路由 name)
   * @returns { setDirty } 更新 dirty 状态
   */
  function register(pageId: string) {
    return {
      setDirty(dirty: boolean) {
        if (dirty) {
          dirtyPages.add(pageId)
        }
        else {
          dirtyPages.delete(pageId)
        }
      },
    }
  }

  /** 当前是否存在未保存内容 */
  function isDirty() {
    return dirtyPages.size > 0
  }

  /** 存在未保存内容时弹确认,返回是否继续 */
  function confirmLeave(message?: string): Promise<boolean> {
    if (!isDirty()) {
      return Promise.resolve(true)
    }
    return new Promise((resolve) => {
      useFaModal().confirm({
        title: '未保存的内容',
        content: message ?? '当前页面有尚未保存的内容，确定要离开吗？',
        confirmButtonText: '放弃并离开',
        cancelButtonText: '取消',
        onConfirm: () => resolve(true),
        onCancel: () => resolve(false),
      })
    })
  }

  return {
    register,
    isDirty,
    confirmLeave,
  }
}

/**
 * 页面级未保存离开保护(P0-07):
 * - 注册 onBeforeRouteLeave(路由离开确认)与 beforeunload(刷新/关闭浏览器确认)
 * - 组件卸载/停用时按 keepAlive 决定是否清理 dirty(KeepAlive 页面由页面自行管理)
 * 用法:const { setDirty } = usePageUnsavedGuard('routeName');编辑时 setDirty(true),保存后 setDirty(false)
 */
export function usePageUnsavedGuard(pageId: string, opts?: { keepAlive?: boolean }) {
  const { register, confirmLeave, isDirty } = useUnsavedChangesGuard()
  const { setDirty } = register(pageId)

  onBeforeRouteLeave(async () => {
    const ok = await confirmLeave()
    if (!ok) {
      return false
    }
    setDirty(false)
    return true
  })

  function onBeforeUnload(e: BeforeUnloadEvent) {
    if (isDirty()) {
      e.preventDefault()
      e.returnValue = ''
    }
  }

  onMounted(() => window.addEventListener('beforeunload', onBeforeUnload))

  onBeforeUnmount(() => {
    window.removeEventListener('beforeunload', onBeforeUnload)
    if (!opts?.keepAlive) {
      setDirty(false)
    }
  })

  onDeactivated(() => {
    if (!opts?.keepAlive) {
      setDirty(false)
    }
  })

  return { setDirty }
}
