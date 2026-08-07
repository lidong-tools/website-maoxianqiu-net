import { defineFakeRoute } from 'vite-plugin-fake-server/client'

export default defineFakeRoute([
  {
    url: '/fake/upload',
    method: 'post',
    response: () => {
      return {
        error: '',
        status: 1,
        data: {
          // TODO: 旧品牌引用，上线前需替换为毛线球 logo
          url: 'https://fantastic-admin.hurui.me/logo.svg',
        },
      }
    },
  },
])
