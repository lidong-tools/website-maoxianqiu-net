/**
 * Import Center V2 类型定义（S32-A）
 * 数据迁移工具：客户/宠物/商品/员工/库存期初
 */

export type ImportJobType = 'customer' | 'pet' | 'catalog-item' | 'employee' | 'opening-stock'
export type ImportJobStatus =
  | 'uploaded' | 'mapped' | 'validated' | 'queued' | 'pending'
  | 'processing' | 'completed' | 'failed' | 'cancelled'
export type DuplicateStrategy = 'skip' | 'update' | 'create_duplicate'

export interface ImportFieldDef {
  key: string
  label: string
  required?: boolean
  description?: string
  type?: 'string' | 'int' | 'number' | 'date' | 'boolean' | 'string[]'
  enum?: Record<string, string>
}

export interface ImportTypeMeta {
  type: ImportJobType
  label: string
  description: string
  duplicateStrategies: DuplicateStrategy[]
  duplicateHints: string[]
  fields: ImportFieldDef[]
}

export interface ImportJob {
  id: string
  tenant_id: string
  store_id: string | null
  type: ImportJobType
  status: ImportJobStatus
  source_file_id: string | null
  mapping: Record<string, string> | null
  duplicate_strategy: DuplicateStrategy | null
  total_rows: number
  valid_rows: number
  invalid_rows: number
  success_count: number
  failed_count: number
  error_summary: Record<string, unknown>
  started_at: string | null
  finished_at: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface ImportRowPreview {
  rowNumber: number
  values: Record<string, string>
}

export interface UploadResult {
  job: ImportJob
  headers: string[]
  mapping: Record<string, string>
  duplicateStrategies: DuplicateStrategy[]
  duplicateHints: string[]
  preview: ImportRowPreview[]
  totalRows: number
}

export interface ValidateResult {
  job: ImportJob
  validRows: number
  invalidRows: number
  totalRows: number
  errorCount: number
  errorGroups: { code: string, count: number }[]
  sampleErrors: ImportErrorRow[]
}

export interface StartResult {
  job: ImportJob
  successRows: number
  skippedRows: number
  failedRows: number
  totalRows: number
  pendingOpeningCommands: number
  pendingEmployeeInvites: number
  failedSamples: ImportErrorRow[]
}

export interface ImportErrorRow {
  id: string
  import_job_id: string
  row_number: number
  field: string | null
  code: string
  message: string
  raw_data: Record<string, string> | null
  created_at: string
}

export const IMPORT_TYPES: ImportJobType[] = ['customer', 'pet', 'catalog-item', 'employee', 'opening-stock']

export const IMPORT_TYPE_LABELS: Record<ImportJobType, string> = {
  customer: '客户',
  pet: '宠物',
  'catalog-item': '商品/药品',
  employee: '员工',
  'opening-stock': '库存期初',
}

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
}

export const DUPLICATE_STRATEGY_LABELS: Record<DuplicateStrategy, string> = {
  skip: '跳过重复',
  update: '更新重复',
  create_duplicate: '新建(保留重复)',
}

export const IMPORT_TYPE_META: Record<ImportJobType, ImportTypeMeta> = {
  customer: {
    type: 'customer', label: '客户', description: '批量导入客户档案', duplicateStrategies: ['skip', 'update', 'create_duplicate'],
    duplicateHints: ['按手机号识别重复', '按客户编号识别重复'],
    fields: [
      { key: 'customerNo', label: '客户编号', description: '留空自动生成' },
      { key: 'name', label: '姓名', required: true },
      { key: 'phone', label: '手机号' },
      { key: 'gender', label: '性别', enum: { male: '公', female: '母', unknown: '未知' } },
      { key: 'email', label: '邮箱' },
      { key: 'address', label: '地址' },
      { key: 'birthday', label: '生日', type: 'date' },
      { key: 'memberLevel', label: '会员等级', enum: { normal: '普通', silver: '银卡', gold: '金卡', diamond: '钻石' } },
      { key: 'remark', label: '备注' },
    ],
  },
  pet: {
    type: 'pet', label: '宠物', description: '批量导入宠物档案（需关联主人）', duplicateStrategies: ['skip', 'update', 'create_duplicate'],
    duplicateHints: ['按 主人+宠物名 识别重复', '按芯片号识别重复'],
    fields: [
      { key: 'ownerPhone', label: '主人手机号' },
      { key: 'ownerNo', label: '主人客户编号' },
      { key: 'name', label: '宠物名', required: true },
      { key: 'species', label: '物种' },
      { key: 'breed', label: '品种' },
      { key: 'gender', label: '性别', enum: { male: '公', female: '母', unknown: '未知' } },
      { key: 'birthDate', label: '出生日期', type: 'date' },
      { key: 'weight', label: '体重(kg)', type: 'number' },
      { key: 'microchip', label: '芯片号' },
      { key: 'color', label: '毛色' },
      { key: 'isNeutered', label: '已绝育', type: 'boolean' },
      { key: 'riskTags', label: '风险标签', type: 'string[]' },
      { key: 'remark', label: '医疗备注' },
    ],
  },
  'catalog-item': {
    type: 'catalog-item', label: '商品/药品', description: '批量导入价目表', duplicateStrategies: ['skip', 'update', 'create_duplicate'],
    duplicateHints: ['按商品编码识别重复'],
    fields: [
      { key: 'code', label: '编码', required: true },
      { key: 'name', label: '名称', required: true },
      { key: 'billingType', label: '类型', enum: { service: '服务', product: '商品', drug: '药品', vaccine: '疫苗', exam: '检验' } },
      { key: 'categoryCode', label: '类目编码' },
      { key: 'unit', label: '单位' },
      { key: 'defaultPrice', label: '默认售价', type: 'number' },
      { key: 'costPrice', label: '成本价', type: 'number' },
      { key: 'isActive', label: '启用', type: 'boolean' },
      { key: 'tags', label: '标签', type: 'string[]' },
    ],
  },
  employee: {
    type: 'employee', label: '员工', description: '批量导入待邀请员工（由 IAM 邀请）', duplicateStrategies: ['skip', 'create_duplicate'],
    duplicateHints: ['按邮箱识别重复'],
    fields: [
      { key: 'email', label: '邮箱', required: true },
      { key: 'name', label: '姓名', required: true },
      { key: 'phone', label: '手机号' },
      { key: 'employeeNo', label: '员工编号' },
      { key: 'title', label: '职位' },
      { key: 'roleCode', label: '角色码' },
      { key: 'storeCodes', label: '门店编码', type: 'string[]' },
    ],
  },
  'opening-stock': {
    type: 'opening-stock', label: '库存期初', description: '批量导入库存期初（生成期初入账命令）', duplicateStrategies: ['skip', 'update'],
    duplicateHints: ['按 商品+仓库+批次 识别重复'],
    fields: [
      { key: 'catalogCode', label: '商品编码', required: true },
      { key: 'warehouseCode', label: '仓库编码', required: true },
      { key: 'batchNo', label: '批次号' },
      { key: 'quantity', label: '数量', required: true, type: 'number' },
      { key: 'unitCost', label: '成本价', type: 'number' },
      { key: 'expiryDate', label: '失效日期', type: 'date' },
    ],
  },
}
