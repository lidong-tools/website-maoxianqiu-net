export interface MembershipInfo {
  store_id: string
  role_id: string
  role_code: string
  status: string
}

export interface AppEnv {
  Variables: {
    user: any
    token: string
    roles: string[]
    memberships: MembershipInfo[]
  }
}
