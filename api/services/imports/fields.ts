/**
 * S32-A 导入中心 V2 —— 每类数据的字段定义 / 模板 / 去重策略
 *
 * 设计原则（S32-A §7）：禁止 Generic 逻辑一套套全部。每类数据拥有独立的
 * 字段集、必填项、枚举、去重键与执行语义（customers/pets/catalog 直写，
 * employee 写待邀请队列，opening-stock 写期初命令队列）。
 */

export type ImportJobType = 'customer' | 'pet' | 'catalog-item' | 'employee' | 'opening-stock'
export type ImportJobStatus =
  | 'uploaded' | 'mapped' | 'validated' | 'queued' | 'pending'
  | 'processing' | 'completed' | 'failed' | 'cancelled'
export type DuplicateStrategy = 'skip' | 'update' | 'create_duplicate'
export type FieldType = 'string' | 'int' | 'number' | 'date' | 'boolean' | 'string[]'

export interface FieldDef {
  key: string
  label: string
  /** 表头匹配别名（归一化后） */
  aliases?: string[]
  required?: boolean
  description?: string
  type?: FieldType
  enum?: Record<string, string>
  /** 逗号分隔转数组（string[]） */
  array?: boolean
}

export interface ImportTypeMeta {
  type: ImportJobType
  label: string
  description: string
  duplicateStrategies: DuplicateStrategy[]
  duplicateHints: string[]
  fields: FieldDef[]
}

/** 表头/别名归一化：小写、去空格、去星号与常见标点 */
export function normalizeKey(s: string): string {
  return s.trim().replace(/\*/g, '').replace(/[\s，。、：:（）()]/g, '').toLowerCase()
}

const GENDER_ENUM: Record<string, string> = { male: '公', female: '母', unknown: '未知' }

export const IMPORT_TYPE_META: Record<ImportJobType, ImportTypeMeta> = {
  customer: {
    type: 'customer',
    label: '客户',
    description: '批量导入客户档案（姓名/手机号/会员等级等）',
    duplicateStrategies: ['skip', 'update', 'create_duplicate'],
    duplicateHints: ['按手机号识别重复', '按客户编号识别重复'],
    fields: [
      { key: 'customerNo', label: '客户编号', aliases: ['客户编号', '编号', '客户号'], description: '医院客户编号；留空自动生成', type: 'string' },
      { key: 'name', label: '姓名', aliases: ['姓名', '客户姓名', '名称'], required: true, description: '客户姓名（必填）', type: 'string' },
      { key: 'phone', label: '手机号', aliases: ['手机号', '手机', '电话', '联系电话'], description: '用于识别重复客户', type: 'string' },
      { key: 'gender', label: '性别', aliases: ['性别'], enum: GENDER_ENUM, description: '枚举：公/母/未知', type: 'string' },
      { key: 'email', label: '邮箱', aliases: ['邮箱', '电子邮件', 'email'], type: 'string' },
      { key: 'address', label: '地址', aliases: ['地址', '住址'], type: 'string' },
      { key: 'birthday', label: '生日', aliases: ['生日', '出生日期'], type: 'date', description: '格式 YYYY-MM-DD' },
      {
        key: 'memberLevel', label: '会员等级', aliases: ['会员等级', '等级'], type: 'string',
        enum: { normal: '普通', silver: '银卡', gold: '金卡', diamond: '钻石' }, description: '枚举：普通/银卡/金卡/钻石',
      },
      { key: 'remark', label: '备注', aliases: ['备注', '说明'], type: 'string' },
    ],
  },
  pet: {
    type: 'pet',
    label: '宠物',
    description: '批量导入宠物档案（需关联已有主人）',
    duplicateStrategies: ['skip', 'update', 'create_duplicate'],
    duplicateHints: ['按 主人+宠物名 识别重复', '按芯片号识别重复'],
    fields: [
      { key: 'ownerPhone', label: '主人手机号', aliases: ['主人手机号', '主人手机', '主人电话', '手机号'], description: '用于匹配主人（与客户编号二选一）', type: 'string' },
      { key: 'ownerNo', label: '主人客户编号', aliases: ['主人客户编号', '主人编号', '客户编号'], description: '用于匹配主人（与手机号二选一）', type: 'string' },
      { key: 'name', label: '宠物名', aliases: ['宠物名', '宠物名称', '名字', '名称'], required: true, description: '宠物名（必填）', type: 'string' },
      { key: 'species', label: '物种', aliases: ['物种', '种类', '动物种类'], description: '如 dog/cat/rabbit', type: 'string' },
      { key: 'breed', label: '品种', aliases: ['品种', '犬种', '猫种'], type: 'string' },
      { key: 'gender', label: '性别', aliases: ['性别'], enum: GENDER_ENUM, type: 'string' },
      { key: 'birthDate', label: '出生日期', aliases: ['出生日期', '生日', '出生日'], type: 'date', description: '格式 YYYY-MM-DD' },
      { key: 'weight', label: '体重(kg)', aliases: ['体重', '体重kg'], type: 'number' },
      { key: 'microchip', label: '芯片号', aliases: ['芯片号', '芯片', '微芯片'], description: '用于识别重复宠物', type: 'string' },
      { key: 'color', label: '毛色', aliases: ['毛色', '颜色'], type: 'string' },
      { key: 'isNeutered', label: '已绝育', aliases: ['已绝育', '绝育'], type: 'boolean', description: '是/否/true/false/1/0' },
      { key: 'riskTags', label: '风险标签', aliases: ['风险标签', '风险', '标签'], type: 'string[]', description: '逗号分隔，如 allergy,aggressive' },
      { key: 'remark', label: '医疗备注', aliases: ['医疗备注', '备注'], type: 'string' },
    ],
  },
  'catalog-item': {
    type: 'catalog-item',
    label: '商品/药品',
    description: '批量导入价目表（服务/商品/药品/疫苗/检验）',
    duplicateStrategies: ['skip', 'update', 'create_duplicate'],
    duplicateHints: ['按商品编码识别重复'],
    fields: [
      { key: 'code', label: '编码', aliases: ['编码', '商品编码', 'SKU', '条码'], required: true, description: '商品编码（必填，租户内唯一）', type: 'string' },
      { key: 'name', label: '名称', aliases: ['名称', '商品名称', '品名'], required: true, description: '商品名称（必填）', type: 'string' },
      {
        key: 'billingType', label: '类型', aliases: ['类型', '收费类型', '项目类型'], type: 'string',
        enum: { service: '服务', product: '商品', drug: '药品', vaccine: '疫苗', exam: '检验' }, description: '枚举：服务/商品/药品/疫苗/检验',
      },
      { key: 'categoryCode', label: '类目编码', aliases: ['类目编码', '分类编码', '类目'], type: 'string' },
      { key: 'unit', label: '单位', aliases: ['单位', '计量单位'], type: 'string', description: '如 次/盒/支/瓶' },
      { key: 'defaultPrice', label: '默认售价', aliases: ['默认售价', '售价', '单价', '价格'], type: 'number' },
      { key: 'costPrice', label: '成本价', aliases: ['成本价', '成本', '进价'], type: 'number' },
      { key: 'isActive', label: '启用', aliases: ['启用', '是否启用', '状态'], type: 'boolean' },
      { key: 'tags', label: '标签', aliases: ['标签'], type: 'string[]', description: '逗号分隔' },
    ],
  },
  employee: {
    type: 'employee',
    label: '员工',
    description: '批量导入待邀请员工（不直接创建账号，交由 IAM 邀请）',
    duplicateStrategies: ['skip', 'create_duplicate'],
    duplicateHints: ['按邮箱识别重复'],
    fields: [
      { key: 'email', label: '邮箱', aliases: ['邮箱', '电子邮件', 'email'], required: true, description: '登录邮箱（必填，用于邀请）', type: 'string' },
      { key: 'name', label: '姓名', aliases: ['姓名', '员工姓名', '名称'], required: true, description: '员工姓名（必填）', type: 'string' },
      { key: 'phone', label: '手机号', aliases: ['手机号', '手机', '电话'], type: 'string' },
      { key: 'employeeNo', label: '员工编号', aliases: ['员工编号', '工号', '编号'], description: '留空自动生成', type: 'string' },
      { key: 'title', label: '职位', aliases: ['职位', '岗位', '职务'], type: 'string' },
      { key: 'roleCode', label: '角色码', aliases: ['角色码', '角色', '权限角色'], description: '如 veterinarian/staff（由 IAM 侧解析）', type: 'string' },
      { key: 'storeCodes', label: '门店编码', aliases: ['门店编码', '门店', '门店代码'], type: 'string[]', description: '逗号分隔' },
    ],
  },
  'opening-stock': {
    type: 'opening-stock',
    label: '库存期初',
    description: '批量导入库存期初（生成期初入账命令，不直接改余额）',
    duplicateStrategies: ['skip', 'update'],
    duplicateHints: ['按 商品+仓库+批次 识别重复'],
    fields: [
      { key: 'catalogCode', label: '商品编码', aliases: ['商品编码', 'SKU', '编码'], required: true, description: '对应价目表商品编码（必填）', type: 'string' },
      { key: 'warehouseCode', label: '仓库编码', aliases: ['仓库编码', '仓库', '库房'], required: true, description: '对应仓库编码（必填）', type: 'string' },
      { key: 'batchNo', label: '批次号', aliases: ['批次号', '批次', '批号'], type: 'string' },
      { key: 'quantity', label: '数量', aliases: ['数量', '期初数量', '库存数量'], required: true, type: 'number', description: '期初数量（必填，>0）' },
      { key: 'unitCost', label: '成本价', aliases: ['成本价', '成本', '单价'], type: 'number' },
      { key: 'expiryDate', label: '失效日期', aliases: ['失效日期', '有效期至', '过期日'], type: 'date', description: '格式 YYYY-MM-DD，可空' },
    ],
  },
}

export const IMPORT_TYPE_LABELS: Record<ImportJobType, string> = Object.fromEntries(
  Object.entries(IMPORT_TYPE_META).map(([k, v]) => [k, v.label]),
) as Record<ImportJobType, string>

export const IMPORT_JOB_STATUS_LABELS: Record<ImportJobStatus, string> = {
  uploaded: '已上传',
  mapped: '已映射',
  validated: '已校验',
  queued: '排队中',
  pending: '待处理',
  processing: '处理中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  awaiting_domain_apply: '待领域应用',
}

/** 默认去重策略：全部保守 skip */
export const DEFAULT_DUPLICATE_STRATEGY: Record<ImportJobType, DuplicateStrategy> = {
  customer: 'skip',
  pet: 'skip',
  'catalog-item': 'skip',
  employee: 'skip',
  'opening-stock': 'skip',
}

export function getTypeMeta(type: ImportJobType): ImportTypeMeta {
  return IMPORT_TYPE_META[type]
}

export const IMPORT_JOB_TYPES: ImportJobType[] = ['customer', 'pet', 'catalog-item', 'employee', 'opening-stock']
