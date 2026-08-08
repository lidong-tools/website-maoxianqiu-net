import type { HotkeyBinding } from '@fantastic-admin/hotkeys'

/**
 * 业务扩展快捷键 id
 *
 * 使用方式：
 *
 * export const EXT_HOTKEY_ID = {
 *   demoOpen: 'demo.open',
 * } as const
 */
export const EXT_HOTKEY_ID = {
  globalSearchOpen: 'global.search.open',
  globalSearchMoveUp: 'global.search.moveUp',
  globalSearchMoveDown: 'global.search.moveDown',
  globalSearchConfirm: 'global.search.confirm',
  globalSearchClose: 'global.search.close',
} as const

type ExtendHotkeyId = typeof EXT_HOTKEY_ID[keyof typeof EXT_HOTKEY_ID]

/**
 * 业务扩展全局快捷键
 *
 * 示例：
 *
 * export const extendGlobalHotkeyBindings = [
 *   {
 *     id: EXT_HOTKEY_ID.demoOpen,
 *     keys: ['command+j', 'ctrl+j'],
 *     enabled: ctx => ctx.settings.toolbar.menuSearch.enable,
 *     help: {
 *       group: 'global',
 *       titleKey: 'global.demoOpen',
 *       order: 90,
 *       visible: ctx => ctx.settings.toolbar.menuSearch.enable,
 *       displayKeys: {
 *         default: ['Ctrl', 'J'],
 *         mac: ['⌘', 'J'],
 *       },
 *     },
 *   },
 * ] satisfies HotkeyBinding<ExtendHotkeyId>[]
 */
export const extendGlobalHotkeyBindings = [
  {
    id: EXT_HOTKEY_ID.globalSearchOpen,
    keys: ['command+shift+k', 'ctrl+shift+k'],
    enabled: () => true,
    help: {
      group: 'global',
      titleKey: 'global.globalSearch',
      order: 89,
      visible: () => true,
      displayKeys: {
        default: ['Ctrl', 'Shift', 'K'],
        mac: ['⌘', '⇧', 'K'],
      },
    },
  },
] satisfies HotkeyBinding<ExtendHotkeyId>[]

/**
 * 业务扩展局部快捷键
 *
 * 示例：
 *
 * export const extendScopedHotkeyBindings = [
 *   {
 *     id: EXT_HOTKEY_ID.demoConfirm,
 *     keys: ['enter'],
 *   },
 *   {
 *     id: EXT_HOTKEY_ID.demoClose,
 *     keys: ['esc'],
 *   },
 * ] satisfies HotkeyBinding<ExtendHotkeyId>[]
 */
export const extendScopedHotkeyBindings = [
  {
    id: EXT_HOTKEY_ID.globalSearchMoveUp,
    keys: ['up'],
  },
  {
    id: EXT_HOTKEY_ID.globalSearchMoveDown,
    keys: ['down'],
  },
  {
    id: EXT_HOTKEY_ID.globalSearchConfirm,
    keys: ['enter'],
  },
  {
    id: EXT_HOTKEY_ID.globalSearchClose,
    keys: ['esc'],
  },
] satisfies HotkeyBinding<ExtendHotkeyId>[]
