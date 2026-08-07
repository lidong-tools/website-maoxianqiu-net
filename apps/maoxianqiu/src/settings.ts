import { setSettings } from '@fantastic-admin/settings'

export default setSettings({
  app: {
    account: {
      auth: true,
    },
    dynamicTitle: true,
    home: {
      title: '工作台',
    },
    copyright: {
      enable: true,
      dates: '2026-present',
      company: '毛线球',
    },
  },
  menu: {
    mainMenuClickMode: 'jump',
    subMenuCollapseButton: true,
    hotkeys: true,
  },
  topbar: {
    tabbar: true,
    mode: 'fixed',
  },
  tabbar: {
    icon: true,
    hotkeys: true,
  },
  toolbar: {
    menuSearch: {
      hotkeys: false,
    },
    fullscreen: true,
    pageReload: true,
    colorScheme: true,
  },
})
