import { setSettings } from '@fantastic-admin/settings'

export default setSettings({
  app: {
    account: {
      auth: true,
    },
    home: {
      enable: true,
      title: '工作台',
      fullPath: '/',
    },
    dynamicTitle: true,
    copyright: {
      enable: true,
      dates: '2026-present',
      company: '毛线球',
      website: '',
    },
  },
  menu: {
    mainMenuClickMode: 'smart',
    subMenuCollapseButton: true,
    hotkeys: true,
  },
  topbar: {
    tabbar: true,
    toolbar: true,
    mode: 'fixed',
  },
  tabbar: {
    icon: true,
    hotkeys: true,
  },
  toolbar: {
    fullscreen: true,
    pageReload: true,
    colorScheme: true,
  },
})
