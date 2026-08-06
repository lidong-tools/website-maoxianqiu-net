# 毛线球：完整产品、UI 与 API 设计 v0.4


---

# 文件：README.md

# 【毛线球】完整产品、UI 与 API 设计文档包

> 版本：v0.4  
> 代码基线：`website-maoxianqiu-net-main(1).zip`

## 核心结论

真实技术栈：

```text
Vue 3 + Vite + TypeScript
Fantastic Admin + Reka UI + UnoCSS
Vue Router + Pinia
Supabase Auth/Postgres/RLS
Hono on Vercel
Cloudflare R2
```

v0.4 已统一修正 1—15，不再保留 Next.js 实施假设。

## 文档顺序

1. PRD
2. 系统设计
3. 数据模型与接口
4. 开发计划
5. 待确认决策
6. 来源与差异
7. 小暖映射
8. 页面级需求
9. 状态机
10. DS 唯一任务清单
11. 代码审计摘要
12. 前端 UI 实现
13. 功能 API 实现
14. 模板组件复用
15. 并发执行规范

## DS 阅读顺序

首次开工：

```text
README
→ 11 代码审计
→ 02 系统设计
→ 10 唯一任务清单
→ 12 UI
→ 13 API
→ 对应业务文档
```

## 第一阶段

只执行：

- MXQ-0001～0004
- MXQ-1001～1009
- MXQ-2001～2009
- MXQ-3001～3007

跨租户 RLS 测试未通过前，不批量开发核心业务 CRUD。

## 文档优先级

1. 已接受 ADR；
2. PRD 和状态机；
3. 数据模型；
4. 系统设计；
5. UI/API 实现说明；
6. 小暖手册。

代码事实与文档不一致时，先记录差异并由 DS 更新文档，不得静默偏离产品边界。

---

# 文件：01-产品需求说明书-PRD.md

# 【毛线球】产品需求说明书 PRD

> 版本：v0.4  
> 产品范围：多租户、多门店宠物医院管理 SaaS  
> 真实代码基线：Vue 3 + Vite + Fantastic Admin + Hono + Supabase + Cloudflare R2  
> 本文定义“做什么”和业务验收，不指定 Next.js、React 或其他不存在于当前仓库的实现。

## 0. 文档解释规则

发生冲突时：

1. 已确认的业务决策与 ADR；
2. 本 PRD；
3. 数据模型、状态机；
4. 前端 UI 与 API 实现说明；
5. 旧系统操作手册。

旧系统手册用于提取业务意图，不直接决定现代 SaaS 的界面、权限与技术实现。

## 0.1 当前代码完成度

| 范围 | 当前状态 | 说明 |
|---|---|---|
| 登录、注册、找回密码 | 部分完成 | Supabase Auth 已接入，仍需完善会话、重新认证和安全事件 |
| 门店管理 | 部分完成 | 已有页面和表，需加入 tenant、归档和完整权限 |
| 用户/角色 | 部分完成 | 已有基础功能，需从角色名判断升级为权限码 |
| RLS | 部分完成 | 已有多轮 migration，需补 tenant 隔离测试 |
| R2 文件 | 部分完成 | 已有上传/删除，需私有化、业务实体附件和直传 |
| 客户、宠物 | 未实现 | 需要从数据模型、API 到 UI 完整开发 |
| 预约、候诊、诊疗 | 未实现 | 当前示例页面不可视为业务完成 |
| 收费、库存 | 未实现 | 必须使用 Hono Command + PostgreSQL RPC |
| 检验、影像、住院 | 未实现 | 按状态机逐阶段建设 |
| 运营、报表、消息 | 未实现 | 后续阶段 |

## 0.2 实现约束

- 前端必须复用 Fantastic Admin 与 `@fantastic-admin/components`。
- 简单查询可使用 Supabase anon client + RLS。
- 跨表事务、库存、支付、退款、签署和发布必须走 Hono API，并在必要时调用 PostgreSQL RPC。
- 页面不能使用 fake API 或 example 数据作为完成证据。
- `apps/example` 和演示目录仅供组件参考，不属于毛线球产品功能。

---

# 【毛线球】宠物医院管理系统产品需求说明书（PRD）

## 0. 文档信息

- 产品名称：毛线球宠物医院管理系统
- 产品形态：多租户、多门店 Web SaaS
- 主要用户：宠物医院集团、单体宠物医院、诊所、宠物护理门店
- 终端：第一阶段以桌面 Web 为主，兼容平板；移动端暂以响应式查看和轻操作为主
- 目标应用：`apps/maoxianqiu`
- 版本目标：
  - MVP：完成医院日常核心闭环
  - V1：完成多店运营、住院、检验、库存和经营报表
  - V1.5：营销自动化、客户自助、设备及第三方集成
- 参考基线：小暖医生管理员手册中的产品管理、系统管理、库存、住院寄养、护士工作站、短信、化验与影像流程

---

## 1. 产品愿景

为宠物医院提供一套能够从“客户到店—宠物建档—预约/挂号—接诊—诊断—处方/处置—检验影像—收费—药房/护士执行—住院—复诊提醒—经营分析”完整闭环运行的 SaaS 系统。

系统必须同时解决三个层次的问题：

1. **医疗业务正确**：病历、处方、执行、检验、住院信息形成完整可追溯链路。
2. **门店运营高效**：收费、库存、排班、预约、客户管理和提醒一体化。
3. **集团管理可控**：多租户隔离、多门店协同、总部管控、跨店库存、统一目录和分店差异化配置。

---

## 2. 产品原则

### 2.1 单一事实来源

- 客户、宠物、就诊、处方、收费、库存均有唯一主记录。
- 不允许不同页面维护彼此不一致的“影子数据”。
- 文件存储在 R2，数据库保存对象元数据、归属和业务引用。

### 2.2 医疗与财务可追溯

- 关键业务采用状态机，不以任意布尔字段代替流程。
- 审核、签署、结算后原则上禁止直接编辑。
- 更正采用“新版本、冲销、退费、反审核”等显式动作。
- 关键动作必须进入审计日志。

### 2.3 总部标准化、门店可配置

- 租户级目录可下发到门店。
- 门店可配置售价、启用状态、库存阈值、服务时长等。
- 需要区分“总部模板”和“门店实例”，避免复制后失控。

### 2.4 默认最小权限

- 员工只能看到所属租户内、授权门店与授权模块的数据。
- 超级管理员、租户管理员、门店管理员、医生、护士、前台、药房、财务等权限分离。
- 敏感字段和高风险动作需要单独权限。

---

## 3. 范围定义

## 3.1 MVP 必须包含

1. SaaS 租户注册和初始化
2. 多门店创建、切换与授权
3. 员工、角色、权限
4. 客户和宠物档案
5. 预约、挂号、候诊
6. 门诊病历
7. 诊断、医嘱、处方、处置
8. 商品/药品/疫苗/服务目录
9. 收费单、支付、退款
10. 基础库存入库、出库、盘点
11. 文件上传：宠物照片、病历附件、检验报告
12. 基础报表
13. 操作审计
14. 数据导入

## 3.2 V1 包含

1. 多仓库和跨店调拨
2. 住院与寄养
3. 护士工作站
4. 检验、B 超、X 光/CR 工作流
5. 疫苗、驱虫和复诊提醒
6. 采购和供应商
7. 会员、储值、套餐
8. 排班
9. 高级经营报表
10. 短信/消息模板和发送记录

## 3.3 暂不作为首版核心

- 真实医保或人医医保结算
- 复杂会计总账
- AI 自动诊断
- 直接控制医学设备
- 原生 App
- 完整电商商城
- 公域营销平台
- 复杂集团加盟结算

---

## 4. 多租户与组织模型

### 4.1 层级

```text
平台 Platform
└── 租户 Tenant（医院品牌 / 公司）
    ├── 总部组织
    ├── 门店 Store A
    │   ├── 仓库
    │   ├── 科室/工作区
    │   └── 员工
    └── 门店 Store B
```

### 4.2 租户

租户代表一个独立付费客户和数据隔离边界。

字段至少包括：

- 名称、简称、Logo
- 联系人、手机号、邮箱
- 企业主体信息
- 默认时区、币种、语言
- 订阅方案、状态、试用到期时间
- 数据保留策略
- 创建时间、停用时间

状态：

- `trialing`
- `active`
- `past_due`
- `suspended`
- `cancelled`

### 4.3 门店

- 门店编码在租户内唯一
- 门店名称、电话、地址、营业时间
- 门店类型：医院、诊所、护理/美容、综合门店
- 默认仓库、默认收银台
- 负责人
- 状态：筹备、营业、停业、归档
- 门店停业不等于删除历史业务数据

### 4.4 跨店数据可见性

客户和宠物建议采用**租户级主档、门店级关系**：

- 同一租户内客户主档去重。
- `customer_store_relations` 记录客户与到访门店、首诊门店、归属顾问。
- 默认员工仅能查看授权门店的就诊和交易记录。
- 有“跨店客户查看”权限的角色可查看租户内完整客户视图。
- 医疗记录跨店查看必须记录审计日志。

---

## 5. 用户角色与权限

## 5.1 平台角色

- 平台超级管理员
- 平台运营
- 平台客服
- 平台财务
- 平台只读审计员

平台角色不得通过普通租户前端直接使用 service role 访问数据。

## 5.2 租户角色

建议内置角色模板：

| 角色 | 主要权限 |
|---|---|
| 租户所有者 | 租户全部配置、订阅、门店、管理员 |
| 总部管理员 | 多店配置、目录、人员、报表 |
| 门店店长 | 本店人员、经营、审批 |
| 前台 | 客户、宠物、预约、挂号、收费 |
| 医生 | 病历、诊断、处方、检验申请 |
| 护士 | 执行医嘱、住院护理、基础记录 |
| 药房 | 配药、发药、药品库存 |
| 检验员 | 检验接收、结果录入、报告发布 |
| 影像人员 | 影像检查与报告 |
| 库管 | 采购、入库、盘点、调拨 |
| 财务 | 收费、退款审核、报表 |
| 美容师 | 美容预约、服务记录 |
| 只读审计员 | 查看日志和历史，不可修改 |

## 5.3 权限模型

权限粒度使用 `资源 + 动作 + 范围`：

```text
medical_record.read.store
medical_record.read.tenant
medical_record.sign
prescription.create
prescription.void
payment.refund.request
payment.refund.approve
inventory.transfer.create
inventory.transfer.approve
report.finance.view
```

范围：

- `own`
- `store`
- `multi_store`
- `tenant`
- `platform`

关键规则：

- 创建退款与审核退款不能默认授予同一普通角色。
- 调拨发起和调拨审核分离。
- 病历签署后修改需要特殊权限并生成新版本。
- 删除客户/宠物仅允许软删除，且有业务记录时不得删除。

---

## 6. 首页与工作台

### 6.1 门店工作台

展示：

- 今日预约数、已到店、候诊中、诊疗中、已完成
- 今日收入、退款、欠款
- 待执行处方
- 待出报告检验
- 住院宠物异常提醒
- 低库存、近效期、缺货
- 今日疫苗/复诊/生日提醒
- 快捷入口

### 6.2 医生工作台

- 我的候诊队列
- 未完成病历
- 待签署病历
- 检验结果待查看
- 住院患者
- 今日排班

### 6.3 护士工作台

- 待执行医嘱
- 执行超时
- 住院护理计划
- 输液/注射时间轴
- 待交接事项

### 6.4 总部工作台

- 各门店收入、客流、客单价
- 新客、复诊、活跃客户
- 库存金额与周转
- 门店异常
- 数据同步/导入失败
- 用户活跃和订阅情况

---

## 7. 客户管理

### 7.1 客户档案

字段：

- 客户编号
- 姓名
- 手机号
- 备用手机号
- 微信/其他联系方式
- 性别（可选）
- 生日（可选）
- 地址
- 来源渠道
- 标签
- 归属门店、归属员工
- 备注
- 营销授权状态
- 黑名单/风险提示
- 创建来源和创建人

规则：

- 手机号在租户内可配置为唯一或允许家庭共用。
- 重复客户需提供合并功能。
- 合并后所有宠物、预约、订单、病历关联到主客户，并保留合并日志。
- 客户删除使用归档，不物理删除。

### 7.2 客户 360 视图

- 基本信息
- 所有宠物
- 最近就诊
- 预约
- 消费
- 储值/会员
- 欠款
- 提醒
- 沟通记录
- 文件与授权书

---

## 8. 宠物档案

字段：

- 宠物编号
- 名称
- 物种
- 品种
- 性别
- 是否绝育
- 出生日期/估算年龄
- 毛色
- 体重与体重历史
- 芯片号
- 免疫证号
- 血型（可选）
- 过敏史
- 慢性病
- 重要风险标签
- 主人关系
- 照片
- 状态：正常、失联、死亡、转出、归档

规则：

- 一个客户可有多只宠物。
- 一只宠物可关联多个联系人，但必须有主联系人。
- 宠物死亡后停止自动提醒，但历史记录保留。
- 过敏、咬人风险、传染风险等在接诊页面醒目展示。
- 体重应作为时间序列记录，不只覆盖当前值。

---

## 9. 预约、挂号与候诊

### 9.1 预约类型

- 门诊
- 疫苗
- 复诊
- 检验
- 手术
- 美容/洗护
- 住院办理
- 寄养

### 9.2 预约字段

- 门店
- 客户、宠物
- 服务类型
- 预约医生/员工
- 开始与结束时间
- 来源
- 备注
- 预估时长
- 状态
- 取消原因
- 到店时间

状态机：

```text
draft -> confirmed -> arrived -> checked_in -> in_service -> completed
                  \-> cancelled
confirmed -> no_show
```

规则：

- 同一医生/资源时间冲突校验。
- 支持插队，但需要权限并记录原因。
- 迟到阈值可配置。
- 到店后生成挂号/就诊记录。
- 预约取消不删除。
- 可配置预约提醒。

### 9.3 候诊队列

- 按科室、医生、优先级过滤
- 展示等待时长
- 支持急诊优先
- 状态：候诊、叫号、过号、诊疗中、完成
- 队列变更实时刷新

---

## 10. 门诊诊疗

### 10.1 就诊主记录

字段：

- 就诊号
- 租户、门店
- 客户、宠物
- 挂号来源
- 主治医生
- 接诊时间
- 就诊类型
- 状态
- 关联预约
- 关联收费单
- 创建人、签署人

状态：

```text
registered -> triage -> consulting -> pending_tests -> treatment
-> pending_payment -> completed
```

异常状态：

- `cancelled`
- `reopened`
- `transferred`
- `hospitalized`

### 10.2 病历结构

采用 SOAP 或可配置模板：

- 主诉 Subjective
- 病史
- 生命体征
- 客观检查 Objective
- 评估 Assessment
- 初步诊断
- 鉴别诊断
- 治疗计划 Plan
- 医嘱
- 复诊计划
- 附件

系统管理中维护：

- 主诉项目
- 主观诊断模板
- 疾病诊断字典
- 常用病历模板
- 常用医嘱
- 生命体征字段

### 10.3 病历版本

- 草稿可编辑。
- 医生签署后进入 `signed`。
- 签署后修订必须创建 revision，保留原文、修改人、原因和时间。
- 病历不能因退款或订单取消而删除。
- 导出 PDF 可在后续阶段实现。

### 10.4 诊断

- 支持多诊断
- 区分初步、确认、鉴别
- 诊断字典可维护
- 支持自由文本
- 可设置主要诊断
- 记录诊断时间与医生

---

## 11. 处方、处置与医嘱

### 11.1 处方

处方明细字段：

- 药品
- 规格
- 单次剂量
- 剂量单位
- 给药途径
- 频次
- 疗程
- 总量
- 用法说明
- 是否需皮试/特殊提示
- 医生备注

状态：

```text
draft -> submitted -> dispensed -> administered/completed
draft/submitted -> voided
```

规则：

- 处方提交后锁定价格快照和药品信息快照。
- 发药前检查库存。
- 可配置允许负库存，但默认禁止。
- 处方作废必须有原因。
- 发药后退药走退药流程，不能直接删除明细。

### 11.2 处置

处置包含：

- 注射
- 输液
- 换药
- 清创
- 手术相关
- 一般检查
- 美容洗护
- 其他收费服务

处置项目来自统一产品/服务目录，记录执行人、执行时间、结果、异常。

### 11.3 护士执行

每条医嘱生成执行任务：

- 计划执行时间
- 实际执行时间
- 执行人
- 执行状态
- 剂量/数量
- 异常原因
- 备注

状态：

- 待执行
- 执行中
- 已完成
- 跳过
- 拒绝/无法执行
- 已撤销

---

## 12. 检验与影像

### 12.1 检验项目设置

- 检验目录
- 项目名称、简称、编码
- 标本类型
- 参考范围
- 单位
- 性别/年龄/物种差异
- 价格
- 报告模板
- 是否外送

### 12.2 检验申请流程

```text
医生申请 -> 收费/确认 -> 采样 -> 接收 -> 检测
-> 结果录入 -> 审核 -> 发布 -> 医生查看
```

字段：

- 申请单号
- 就诊
- 项目
- 标本
- 采样人/时间
- 检验人
- 审核人
- 结果
- 异常标记
- 报告文件
- 外送机构
- 状态

规则：

- 结果修订保留版本。
- 发布后医生可一键引用到病历。
- 危急值需要醒目标识与确认记录。
- 报告附件存 R2。

### 12.3 影像

类型：

- B 超
- X 光/CR
- CT/MRI（预留）

流程：

- 申请
- 预约
- 执行
- 上传影像/附件
- 书写报告
- 审核
- 发布

MVP 只管理工作流和文件，不实现 DICOM PACS。

---

## 13. 住院与寄养

### 13.1 房间与笼位

- 房间名称
- 类型：住院、隔离、ICU、寄养
- 笼位编号
- 容量
- 适用物种/体型
- 状态：可用、占用、清洁中、维修、停用
- 门店归属

### 13.2 入院

字段：

- 入院单号
- 宠物
- 关联门诊
- 主治医生
- 入院时间
- 预计出院时间
- 房间/笼位
- 入院原因
- 押金
- 风险等级
- 饮食、过敏、特殊护理
- 联系人授权

状态：

```text
planned -> admitted -> in_care -> discharge_pending -> discharged
                         \-> transferred
```

### 13.3 住院医嘱与护理

- 生命体征计划
- 给药
- 输液
- 喂食
- 排便排尿
- 清洁
- 特殊观察
- 每日病程
- 交接班

### 13.4 寄养

- 寄养服务项目
- 入住和离店时间
- 饮食
- 遛宠
- 用药
- 疫苗要求
- 风险确认
- 每日记录
- 额外消费

住院和寄养共用房态能力，但医疗住院记录与普通寄养权限必须区分。

---

## 14. 产品、药品、疫苗和服务目录

### 14.1 统一目录模型

统一 `catalog_items`，通过类型区分：

- drug
- vaccine
- consumable
- retail_product
- lab_test
- imaging
- procedure
- grooming
- hospitalization
- boarding
- package

总部维护标准主档，门店维护：

- 是否启用
- 门店售价
- 最低售价
- 库存阈值
- 默认仓库
- 服务时长
- 提成规则（后续）

### 14.2 类目

- 支持多级类目，首版最多三级。
- 删除有项目的类目时禁止物理删除。
- 支持排序、停用、迁移。
- 支持批量导入。

### 14.3 药品字段

- 通用名、商品名
- 拼音/搜索码
- 成分
- 规格
- 剂型
- 厂家
- 批准文号（可选）
- 用药单位、库存单位、换算率
- 默认售价、成本价
- 有效期管理
- 批号管理
- 是否处方药
- 风险提示

### 14.4 疫苗

- 疫苗类型
- 推荐物种
- 推荐年龄
- 针次
- 下一针规则
- 有效期
- 批号
- 生产厂家
- 接种禁忌
- 提醒规则

---

## 15. 采购与库存

### 15.1 仓库

- 每门店至少一个默认仓库
- 可有药房仓、耗材仓、零售仓
- 库存按 `tenant + store + warehouse + item + batch` 管理

### 15.2 供应商

- 名称、联系人、电话、地址
- 统一信用代码（可选）
- 账期
- 状态
- 供应品类
- 备注

### 15.3 采购入库

流程：

```text
draft -> submitted -> approved -> received -> posted
```

- 草稿可修改
- 审核后不可直接改
- 过账后增加库存
- 记录批号、效期、成本
- 重复过账必须通过幂等保护

### 15.4 库存流水

每次变动生成不可变流水：

- 入库
- 销售出库
- 处方发药
- 护理消耗
- 盘盈
- 盘亏
- 调拨出
- 调拨入
- 退货
- 报损
- 过期
- 冲销

### 15.5 盘点

流程：

```text
draft -> counting -> submitted -> approved -> posted
```

- 创建盘点时保存账面数量快照。
- 录入实盘数量。
- 产生差异。
- 审核过账后生成盘盈/盘亏流水。
- 已过账盘点不可删除。

### 15.6 跨店调拨

流程：

```text
draft -> submitted -> approved -> outbound
-> in_transit -> received -> completed
```

异常：

- rejected
- cancelled
- partially_received

规则：

- 调出与调入项目必须属于同一租户标准目录。
- 调拨时锁定可用库存或在出库时校验。
- 调出过账与调入过账分别生成流水。
- 收货可记录差异。
- 跨店调拨必须审计。

### 15.7 效期与预警

- 低库存
- 零库存
- 近效期
- 已过期
- 批次召回（预留）
- 默认按 FEFO 推荐批次

---

## 16. 收费、支付、退款和欠款

### 16.1 收费单

收费项目可来源于：

- 挂号
- 处方
- 处置
- 检验
- 影像
- 住院
- 寄养
- 零售
- 套餐

收费单状态：

```text
draft -> pending_payment -> partially_paid -> paid
paid -> refund_pending -> partially_refunded/refunded
```

### 16.2 支付

支付方式：

- 现金
- 银行卡
- 微信
- 支付宝
- 储值
- 组合支付
- 其他

首版可先记录支付，不必接支付网关；但数据模型必须支持外部支付流水号。

### 16.3 退款

- 指定原收费单和明细
- 支持部分退款
- 填写原因
- 高额退款需要审批
- 退款不直接删除原支付
- 相关库存根据业务动作生成退货/退药流水
- 审计发起人、审核人、执行人

### 16.4 欠款

- 是否允许欠款由租户配置
- 记录应收余额
- 后续补缴
- 客户风险提示
- 报表中区分收入与实收

---

## 17. 会员、储值和套餐（V1）

### 17.1 会员

- 会员等级
- 折扣规则
- 有效期
- 适用门店
- 适用项目
- 升降级规则

### 17.2 储值

- 充值
- 赠送金
- 消费
- 退款
- 调整
- 余额流水不可变

### 17.3 套餐

- 疫苗套餐
- 体检套餐
- 洗护套餐
- 次卡
- 组合项目
- 有效期
- 剩余次数
- 适用门店

---

## 18. 消息与客户触达

### 18.1 模板

模板变量：

- 客户姓名
- 宠物名称
- 门店名称
- 预约时间
- 医生
- 疫苗名称
- 下次日期
- 复诊日期

### 18.2 触发场景

- 预约确认
- 预约前提醒
- 未到店
- 疫苗提醒
- 驱虫提醒
- 复诊提醒
- 检验报告发布
- 住院状态通知
- 生日提醒
- 储值余额提醒

### 18.3 发送记录

- 渠道
- 接收人
- 模板
- 渲染内容快照
- 发送时间
- 状态
- 供应商消息 ID
- 失败原因
- 重试次数

首版可仅实现站内任务和记录，为短信/微信供应商留适配层。

---

## 19. 系统管理

### 19.1 机构信息

- 租户信息
- 门店信息
- 营业时间
- 联系方式
- Logo
- 打印抬头
- 发票信息（预留）

### 19.2 用户、角色、权限

- 员工邀请
- 门店授权
- 角色模板
- 自定义角色
- 停用员工
- 重置认证
- 登录日志

### 19.3 基础数据

- 物种
- 品种
- 毛色
- 性别
- 单位
- 给药途径
- 频次
- 来源渠道
- 支付方式
- 取消原因
- 退款原因
- 标本类型

### 19.4 医学数据

- 主诉模板
- 体征模板
- 诊断字典
- 病历模板
- 医嘱模板
- 检验参考范围
- 报告模板

### 19.5 数据导入

支持：

- 客户
- 宠物
- 商品
- 药品
- 服务
- 初始库存
- 供应商

流程：

```text
下载模板 -> 上传 -> 解析 -> 字段映射 -> 预校验
-> 错误报告 -> 确认导入 -> 后台执行 -> 结果报告
```

要求：

- 导入任务异步化
- 可下载错误行
- 幂等或重复检测
- 记录导入人、时间和源文件
- 大文件存 R2
- 导入过程不得绕过租户隔离

---

## 20. 报表

### 20.1 MVP 报表

- 日营业汇总
- 收款方式汇总
- 收费项目汇总
- 医生业绩基础表
- 新增客户与宠物
- 就诊量
- 库存余额
- 库存流水
- 低库存
- 近效期
- 退款明细

### 20.2 V1 报表

- 门店对比
- 客单价
- 复诊率
- 新客转化
- 疫苗覆盖
- 商品毛利
- 库存周转
- 住院床位利用率
- 医生工作量
- 应收与欠款
- 会员与储值

规则：

- 报表按员工权限限制门店范围。
- 金额字段统一使用最小货币单位或高精度 decimal。
- 报表口径必须文档化。
- 大报表异步导出到 R2。

---

## 21. 文件与影像资料

文件类型：

- 宠物头像
- 客户授权书
- 病历附件
- 检验报告
- 影像截图
- 导入文件
- 导出文件

要求：

- 前端不持有 R2 密钥。
- 后端生成短期预签名上传/下载 URL。
- 对象 key 包含环境、租户、业务类型、年月和随机 ID。
- 数据库维护文件元数据和业务引用。
- 私有医疗文件默认不公开。
- 删除业务记录不立即删除对象，使用延迟清理任务。
- 校验 MIME、扩展名、大小和业务权限。

---

## 22. 审计日志

必须审计：

- 登录、登出、登录失败
- 邀请员工、角色和权限变更
- 跨门店查看医疗记录
- 病历签署、修订
- 处方作废
- 收费、退款
- 库存过账、盘点、调拨
- 导入
- 文件下载
- 租户配置变更

审计字段：

- tenant_id
- store_id
- actor_user_id
- actor_employee_id
- action
- resource_type
- resource_id
- before/after 摘要
- IP
- user_agent
- request_id
- occurred_at

审计日志不允许普通业务用户修改。

---

## 23. 搜索

全局搜索：

- 客户姓名、手机号
- 宠物名称、编号、芯片号
- 就诊号
- 收费单号
- 药品/商品名称、拼音码、条码
- 入库单、调拨单、盘点单
- 检验申请单

要求：

- 默认限制当前租户和授权门店。
- 敏感搜索结果不返回无权查看的摘要。
- 输入防抖。
- PostgreSQL trigram/full text 可分阶段引入。

---

## 24. 非功能需求

### 24.1 性能

- 常用列表首屏 P95 小于 2 秒。
- 常用保存操作 P95 小于 1.5 秒。
- 候诊、护士任务等实时更新延迟目标小于 5 秒。
- 10 万客户级租户列表查询仍需分页和索引。
- 禁止一次性加载整租户数据。

### 24.2 可用性

- 生产目标可用性 99.9%（依赖供应商能力）。
- 关键提交具备幂等性。
- 网络失败时明确提示是否已提交成功。
- 不使用“前端乐观成功”掩盖后端失败。

### 24.3 安全

- 全业务表启用 RLS。
- service role 仅服务端使用。
- 机密进入 Vercel 环境变量。
- R2 API 密钥仅服务端。
- 上传使用短期预签名 URL。
- 敏感操作二次确认。
- 防止 IDOR：不得仅凭资源 ID 读取数据。
- 生产禁止日志打印完整病历和认证 token。

### 24.4 数据可靠性

- 所有时间保存 UTC，界面按租户时区显示。
- 金额禁止使用 JS 浮点直接累计。
- 业务单号可读，内部主键使用 UUID。
- 关键过账在数据库事务内完成。
- 每日备份与恢复演练另行配置。

### 24.5 可维护性

- TypeScript 严格模式。
- schema 类型从 Supabase 自动生成。
- 领域服务不直接散落在页面组件。
- 所有 migration 可重放。
- 每个模块有权限矩阵、状态机和测试。

---

## 25. MVP 端到端验收场景

### 场景 A：门诊完整闭环

1. 创建租户和门店。
2. 邀请前台、医生、护士、库管。
3. 创建客户和宠物。
4. 创建预约并到店挂号。
5. 医生接诊，填写病历、诊断和处方。
6. 前台生成收费单并收款。
7. 药房发药，库存减少。
8. 护士执行注射并记录。
9. 医生完成病历。
10. 系统生成复诊提醒。
11. 审计日志完整。

### 场景 B：检验闭环

1. 医生发起检验申请。
2. 收费。
3. 检验员采样、录入结果、审核发布。
4. 医生查看并引用到病历。
5. 报告附件通过受控 URL 下载。

### 场景 C：多门店隔离

1. 租户有 A、B 两店。
2. A 店普通前台不能读取 B 店订单和病历。
3. 总部管理员可查看两店经营汇总。
4. 有跨店医疗权限的医生可以读取 B 店病历，且产生审计日志。
5. 另一个租户的数据任何情况下均不可读取。

### 场景 D：库存

1. 采购入库并审核过账。
2. 发药后库存减少。
3. 盘点产生盘亏。
4. 跨店调拨出库、收货。
5. 每一步均有不可变流水，余额与流水一致。

---

## 26. 成功指标

MVP 试点期建议观察：

- 新员工完成首次业务闭环所需培训时间
- 单次挂号到完成收费的平均操作时长
- 病历完整率
- 库存负数发生次数
- 账实差异
- 预约爽约率
- 提醒触达率
- 日活员工比例
- 页面错误率
- 关键操作 P95 延迟

---

# v0.2 补充：管理员配置、预防保健与页面级规则

> 本章依据《小暖医生动物医院管理系统操作手册（管理员）》的 Markdown 转换稿补充。  
> 手册用于发现旧系统业务意图；其中桌面安装、激活码、设备自动发现、允许直接修改报告等旧实现，不作为毛线球 SaaS 的直接实现方案。

## 27. 门店参数中心

门店参数中心用于承接不同门店的经营习惯、价格规则、打印展示和本地设备能力。所有配置必须明确作用范围：

- 租户默认值
- 门店覆盖值
- 生效时间
- 修改人
- 修改历史

### 27.1 参数分类

#### 27.1.1 计价参数

- 商品、药品、疫苗、处置、化验、影像、美容是否参与会员折扣
- 是否允许项目手工改价
- 最低售价
- 折扣叠加规则
- 四舍五入规则
- 夜诊、急诊附加费规则
- 是否允许零价项目
- 是否显示成本价
- 欠款开关与额度

#### 27.1.2 会员与积分参数

- 会员等级
- 各目录类型折扣
- 指定项目排除
- 消费积分比例
- 充值是否积分
- 退款积分回退
- 积分抵扣比例
- 单笔抵扣上限
- 积分有效期
- 赠送积分与消费积分分账

#### 27.1.3 打印参数

- 小票宽度：58mm / 80mm / A4
- 打印联数
- 抬头、Logo、地址、电话
- 是否显示客户手机号
- 是否显示宠物信息
- 是否显示操作员、医生
- 是否显示折扣前金额
- 页脚与声明
- 自动打印场景
- 支持模板预览和测试打印

#### 27.1.4 本地设备

Web SaaS 不直接承诺浏览器自动发现所有设备。第一阶段提供：

- 浏览器系统打印
- 打印模板
- 本地打印代理适配接口
- 钱箱开启指令配置
- 设备测试页
- 设备状态与最后心跳
- 门店设备绑定

不在首版直接实现：

- 任意厂商硬件的即插即用
- 医学设备控制
- 未经适配的串口/USB 直连

#### 27.1.5 安全通知

- 新设备登录
- 异常地点登录
- 连续失败登录
- 管理员角色变化
- 高额退款
- 大额库存调整
- 跨店医疗记录访问
- 租户停用或订阅异常

通知对象可配置为租户所有者、门店负责人或指定管理员。

### 27.2 配置继承规则

```text
平台默认值
  ↓
租户默认值
  ↓
门店覆盖值
```

读取时采用最近层级的有效配置。门店覆盖可恢复为“继承租户默认”。

### 27.3 配置变更验收

- 修改会员折扣后，只影响新生成的收费明细。
- 已产生的收费单保留价格与折扣快照。
- 修改打印模板后可预览，不影响历史收费数据。
- 高风险参数变更写审计日志。
- 配置错误时提供恢复默认值。
- 不允许前端任意新增未知配置键。

---

## 28. 目录类型能力矩阵

统一目录模型必须保留各业务类型的差异。

| 目录类型 | 可收费 | 管库存 | 批次/效期 | 产生执行任务 | 形成专业记录 |
|---|---:|---:|---:|---:|---:|
| 药品 | 是 | 是 | 是 | 药房/护士 | 处方与给药 |
| 疫苗 | 是 | 是 | 是 | 接种 | 接种记录 |
| 驱虫产品 | 是 | 是 | 可选 | 给药 | 驱虫记录 |
| 商品 | 是 | 是 | 可选 | 否 | 销售记录 |
| 消耗品 | 可选 | 是 | 可选 | 护理消耗 | 消耗记录 |
| 试纸 | 是或内部成本 | 是 | 是 | 检验 | 检验结果 |
| 处置服务 | 是 | 否 | 否 | 护士/医生 | 执行记录 |
| 化验收费项目 | 是 | 否 | 否 | 检验科 | 检验申请 |
| 影像收费项目 | 是 | 否 | 否 | 影像科 | 影像报告 |
| 美容服务 | 是 | 否 | 否 | 美容师 | 服务记录 |
| 住院/寄养项目 | 是 | 否 | 否 | 护理/服务 | 费用记录 |

### 28.1 通用操作

- 查询
- 新增
- 编辑
- 停用
- 恢复
- 导入
- 导出
- 类目迁移
- 门店启用/停用
- 门店改价

交易引用后的目录项目不得物理删除。

### 28.2 类目迁移

批量迁移必须支持：

1. 选择来源类目
2. 多选项目
3. 选择目标类目
4. 预览影响
5. 执行迁移
6. 写审计日志

仅改变项目归类，不改变历史收费单中的项目快照。

---

## 29. 预防保健

疫苗和驱虫不是普通商品销售的附属字段，应形成独立专业记录。

### 29.1 疫苗方案

字段：

- 方案名称
- 适用物种
- 起始年龄
- 针次数
- 针间隔
- 加强周期
- 推荐疫苗
- 有效状态
- 门店适用范围

### 29.2 疫苗接种记录

- 宠物
- 客户
- 门店
- 疫苗目录项目
- 疫苗名称快照
- 厂家
- 批号
- 有效期
- 接种针次
- 接种剂量
- 接种日期
- 接种医生/执行人
- 接种部位
- 接种前检查
- 禁忌确认
- 不良反应
- 下次应接种日期
- 关联就诊、处方、收费单和库存流水
- 接种证明文件

状态：

```text
planned -> due -> administered -> completed
planned/due -> skipped
administered -> adverse_event_recorded
```

### 29.3 驱虫记录

- 类型：体内、体外、体内外
- 药品
- 剂量
- 执行日期
- 下次日期
- 执行人
- 关联收费与库存

### 29.4 提醒规则

- 根据实际接种日期生成下一针
- 手工调整必须记录原因
- 宠物死亡、转出、客户退订营销后停止对应触达
- 医疗提醒与营销授权分开处理
- 消息发送失败不改变专业记录

---

## 30. 领域化数据导入

系统必须为每类数据提供独立模板，而不是一个万能 Excel。

### 30.1 客户与宠物联合导入

模板字段：

- 客户姓名
- 手机号
- 备用手机号
- 性别
- 生日
- 地址
- 来源
- 会员卡号（迁移字段）
- 备注
- 宠物名称
- 宠物性别
- 出生日期或年龄
- 物种
- 品种
- 毛色
- 是否绝育
- 芯片号

规则：

- 同一客户多只宠物可使用多行。
- 优先根据迁移 ID，其次手机号和姓名匹配客户。
- 同手机号多客户进入人工确认。
- 年龄导入需转为估算出生日期并标记 `birth_date_estimated=true`。
- 导入前展示客户合并和宠物归属预览。

### 30.2 药品与商品导入

分为两个阶段：

1. 目录主档导入
2. 初始化库存导入

目录字段：

- 代码
- 条码
- 名称
- 规格
- 单位
- 厂家
- 进价参考
- 售价
- 类目
- 是否批号管理
- 是否效期管理

初始化库存字段：

- 门店
- 仓库
- 商品
- 批号
- 有效期
- 数量
- 单位成本

导入成功后生成“初始化入库单”，必须审核过账后才影响库存。

### 30.3 服务项目导入

分别提供：

- 处置
- 化验收费项目
- 影像
- 美容
- 住院/寄养

通用字段：

- 项目编码
- 名称
- 类目
- 售价
- 单位
- 预计时长
- 是否会员折扣
- 状态

### 30.4 疫苗导入

- 名称
- 代码/条码
- 采购价
- 售价
- 推荐间隔
- 推荐针次
- 厂家
- 批号/效期开关

推荐间隔和针次只作为默认值，正式接种方案单独维护。

### 30.5 导入状态机

```text
uploaded -> parsing -> validation_failed
                    -> ready -> importing -> completed
                                      \-> partially_completed
                                      \-> failed
```

每个任务包含：

- 原始文件
- 字段映射
- 总行数
- 成功数
- 失败数
- 警告数
- 错误文件
- 操作人
- 导入策略
- 结果摘要

---

## 31. 医学问题库与模板

### 31.1 问诊问题库

问题字段：

- 类目
- 问题文本
- 回答类型：文本、单选、多选、数字、日期、是/否
- 选项
- 单位
- 是否必填
- 适用物种
- 适用科室
- 排序
- 启用状态

医生使用病历模板时，系统将问题实例写入当前病历版本，不依赖后续模板变化。

### 31.2 主诉快捷短语

用于快速插入常见主诉，不替代患者真实主诉。

### 31.3 主观判断模板

作为医生输入辅助，不应自动作为已确认诊断。

### 31.4 疾病诊断字典

- 编码
- 名称
- 别名
- 类目
- 适用物种
- 状态
- 来源
- 自定义说明

允许自由文本诊断，但应区分标准诊断与自由文本。

---

## 32. 化验收费与检测定义

### 32.1 对象分离

```text
化验收费项目 catalog_item
        ↓
检验组合 diagnostic_panel
        ↓
检验指标 diagnostic_analyte
```

一个收费项目可以关联：

- 一个单项
- 一个组合
- 多个外送项目

同一检验组合可在不同门店拥有不同售价。

### 32.2 结果发布

- 检验人员录入
- 审核人员审核
- 发布后形成版本
- 医生可以引用报告
- 医生不能直接覆盖已审核的原始结果
- 结果修订生成新版本并记录修订原因
- 危急值必须有通知和确认闭环

### 32.3 病历引用

病历中保存：

- 报告 ID
- 报告版本
- 引用时间
- 医生解释

专业报告原文与医生解释分离。

---

## 33. 住院和寄养计费规则

### 33.1 计费单位

项目支持：

- 按次
- 按小时
- 按自然日
- 按 24 小时
- 按数量

### 33.2 房费

- 房间类型关联默认收费项目
- 具体笼位可覆盖
- 入院时保存价格快照
- 换房分段计费
- 暂离不自动释放房位
- 出院时停止后续自动计费

### 33.3 日切

租户配置：

- 自然日零点
- 固定营业日切时间
- 入住不足一日的计费规则
- 延迟出院宽限时长

### 33.4 自动计费任务

后台任务按规则生成住院费用明细，具备幂等键：

```text
admission_id + charge_item + billing_period
```

重复执行不重复计费。

---

## 34. 页面级通用交互要求

所有业务列表至少支持：

- 权限范围内查询
- 分页
- 关键字
- 状态过滤
- 门店过滤
- 日期范围
- 排序
- 空状态
- 错误重试
- 导出权限

所有详情页面至少展示：

- 业务单号
- 当前状态
- 所属门店
- 创建人/时间
- 最近修改人/时间
- 状态时间线
- 关联业务
- 审计入口（有权限时）

按钮必须根据“权限 + 当前状态 + 数据条件”共同决定是否可用，不能仅按角色显示。

---

## 35. v0.2 新增验收场景

### 场景 E：会员折扣与打印

1. 租户设置默认折扣。
2. A 店覆盖美容项目折扣。
3. 创建收费单，价格按 A 店规则计算。
4. 修改折扣后，原收费单金额不变。
5. 结算后生成 80mm 小票预览。
6. 小票展示门店 Logo 和宠物信息。

### 场景 F：疫苗闭环

1. 医生选择疫苗并开具。
2. 收费。
3. 药房/护士按批次出库并接种。
4. 生成接种记录。
5. 计算下一针日期。
6. 生成提醒任务。
7. 批号和收费、库存、接种记录可追溯。

### 场景 G：初始化导入

1. 上传客户宠物模板。
2. 系统识别重复手机号。
3. 用户确认合并策略。
4. 导入完成并下载错误行。
5. 上传初始化库存。
6. 系统生成待审核初始化入库单。
7. 审核后库存增加。

### 场景 H：住院自动计费

1. 宠物办理住院并选择笼位。
2. 系统保存房费价格快照。
3. 日切任务生成一日房费。
4. 更换房间后分段计费。
5. 重复运行任务不重复收费。
6. 出院后停止计费。

---

# 文件：02-系统设计说明书.md

# 【毛线球】系统设计说明书

> 版本：v0.4  
> 本文完全基于上传代码仓库修正，不再采用 Next.js 假设。

## 1. 已确认技术基线

| 层 | 真实实现 |
|---|---|
| Monorepo | pnpm workspace |
| 管理端 | Vue 3.5 + TypeScript + Vite |
| 管理模板 | Fantastic Admin 6.3 |
| 路由 | Vue Router 模块路由 |
| 状态 | Pinia + persisted state |
| 样式 | UnoCSS + SCSS |
| UI 底层 | Reka UI |
| 表单 | vee-validate + Zod |
| 普通表格 | Fantastic Admin `FaTable` |
| 复杂表格 | `vxe-table` / `vxe-pc-ui` |
| 图表 | ECharts / VChart |
| 浏览器数据 | Supabase JS anon client + RLS |
| 服务端 API | Hono，部署为 Vercel Functions |
| 强事务 | Supabase PostgreSQL RPC |
| 文件 | Cloudflare R2 |
| 认证 | Supabase Auth |

## 2. 总体架构

```text
Browser / Vue SPA
├── Vue Router
├── Pinia
├── Fantastic Admin + Reka UI
├── vee-validate + Zod
├── Supabase anon client
│   └── 简单查询和受 RLS 保护的普通 CRUD
└── Axios
    └── Hono /api
        ├── 认证与权限上下文
        ├── Command service
        ├── Supabase service role（仅服务端）
        ├── PostgreSQL RPC
        ├── R2 签名和文件管理
        ├── 外部服务适配器
        └── 审计、幂等和统一错误
```

### 2.1 浏览器职责

- 渲染 UI；
- 本地交互和表单初步校验；
- 调用 Supabase 查询或 Hono API；
- 使用预签名 URL 上传文件；
- 展示 loading、empty、error、conflict；
- 不保存 service role 或 R2 secret；
- 不承担最终权限判断；
- 不直接完成跨表业务事务。

### 2.2 Hono 职责

- 验证 Supabase access token；
- 解析 tenant、store、employee 上下文；
- Zod 输入校验；
- 权限码校验；
- 业务 Command 编排；
- 调用数据库 RPC；
- Auth Admin 操作；
- R2 签名、完成确认、下载授权；
- 审计、request ID 和幂等；
- 统一 HTTP 状态和错误码。

### 2.3 PostgreSQL 职责

- 数据持久化；
- RLS；
- 外键、唯一约束、check constraint；
- 原子过账；
- 不可变流水；
- 并发控制；
- 强一致事务 RPC；
- 数据视图和报表基础。

## 3. 真实代码目录与目标目录

### 3.1 当前主要目录

```text
apps/maoxianqiu/src/
├── api/
├── assets/
├── components/
├── composables/
├── layouts/
├── lib/
├── router/
├── store/
├── ui/
└── views/

api/
├── index.ts
├── lib/
├── middlewares/
└── routes/

packages/
├── components/
├── composables/
├── settings/
└── types/

supabase/
├── migrations/
└── seed.sql
```

### 3.2 渐进式领域组织

不要求一次性重构全部模板。新功能先按现有约定落地：

```text
src/views/customers/
src/api/modules/customer.ts
src/types/customer.ts
src/schemas/customer.ts
src/components/business/
```

当模块变大后，再迁移为：

```text
src/features/customers/
├── api.ts
├── types.ts
├── schemas.ts
├── composables/
├── components/
└── views/
```

### 3.3 代码边界

- `.vue` 页面负责组合与交互，不承载复杂数据库事务。
- `src/api/modules` 提供类型化查询和命令客户端。
- `api/routes` 仅处理 HTTP 契约，不堆积全部业务逻辑。
- 强事务进入 SQL function/RPC。
- `packages/components` 只放通用基础组件。
- `src/components/business` 放跨领域业务组件。
- 单一领域专用组件放领域目录。

## 4. Query 与 Command 分层

### 4.1 Supabase Query

适合：

- 单表或稳定视图查询；
- 分页列表；
- 基础字典；
- RLS 已能完整表达的普通读取；
- 低风险、单对象轻量修改。

### 4.2 Hono Command

必须用于：

- Auth Admin；
- 员工邀请和密码重置；
- 门店归档；
- 客户合并；
- 状态转换；
- 病历签署和修订；
- 处方提交与发药；
- 收费、支付和退款；
- 入库、盘点和调拨过账；
- 检验报告发布；
- 住院房位分配；
- R2 文件授权；
- 异步导入和外部服务。

### 4.3 PostgreSQL RPC

必须用于需要原子性和并发控制的命令：

- `post_goods_receipt`
- `post_stock_count`
- `ship_inventory_transfer`
- `receive_inventory_transfer`
- `dispense_prescription`
- `record_payment`
- `execute_refund`
- `sign_medical_record`
- `merge_customers`
- `assign_inpatient_unit`

## 5. 多租户和门店上下文

目标关系：

```text
tenant
├── stores
├── memberships
├── employees
├── roles
└── business data
```

每张业务表至少包含：

```text
tenant_id
store_id（门店业务需要时）
```

### 5.1 当前迁移要求

现有 `stores`、`store_members`、`roles` 和 `profiles` 需要映射到目标模型。正式扩展业务表前：

1. 建立 `tenants`；
2. 给 stores 增加 `tenant_id`；
3. 建立 membership/employee 关系；
4. 迁移当前角色关联；
5. 补跨租户 RLS 测试；
6. 禁止硬编码 tenant/store。

### 5.2 前端门店选择

门店选择器只设置工作上下文：

```text
currentTenantId
currentStoreId
```

API 和 RLS 仍必须独立判断访问权限。

## 6. 认证与会话

- Supabase session 是 access token 真值来源。
- 统一使用 `Authorization: Bearer <token>`。
- localStorage 可用于 UI 偏好和当前门店，但不自建另一套认证真值。
- 401 时刷新 session；刷新失败跳转登录。
- 修改本人密码需要重新认证。
- 管理员重置密码使用独立 Hono API。
- 新设备登录、异常登录进入安全事件。

## 7. 权限

目标权限格式：

```text
customer.read
customer.create
medical_record.sign
inventory.transfer.approve
billing.refund.execute
```

前端：

```vue
<PermissionButton permission="inventory.transfer.approve" />
```

服务端：

```ts
requirePermission(c, {
  code: 'inventory.transfer.approve',
  storeId,
})
```

数据库 RLS 是最后防线。禁止只依赖菜单隐藏或角色名称。

## 8. 文件架构

当前上传经 Vercel 中转且使用公共 URL，只适合过渡。

目标流程：

```text
POST /api/files/upload-intents
→ 浏览器直传 R2
→ POST /api/files/:id/complete
→ 建立 attachment 关系
```

对象 key：

```text
{env}/tenant/{tenantId}/store/{storeId}/{domain}/{yyyy}/{mm}/{uuid}.{ext}
```

文件默认私有，下载通过短期签名 URL。删除采用归档和生命周期清理，不直接信任浏览器传来的任意 key。

## 9. API 基础设施

必须先实现：

- request ID middleware；
- auth middleware；
- tenant/store context；
- Zod validation；
- permission helper；
- error handler；
- audit helper；
- idempotency helper；
- rate-limit 扩展点。

统一成功：

```json
{
  "ok": true,
  "data": {},
  "requestId": "req_xxx"
}
```

统一失败：

```json
{
  "ok": false,
  "error": {
    "code": "INSUFFICIENT_STOCK",
    "message": "库存不足",
    "fieldErrors": {}
  },
  "requestId": "req_xxx"
}
```

## 10. 前端状态管理

Pinia 只保存：

- session/profile 快照；
- 当前 tenant/store；
- 菜单与权限；
- UI 设置；
- 需要跨页面共享的短期业务上下文。

服务端数据不应无边界复制进全局 store。普通列表优先由页面 composable 管理，并保存必要的筛选条件。

## 11. 路由设计

领域路由：

```text
router/modules/
├── frontdesk.ts
├── clinical.ts
├── nursing.ts
├── billing.ts
├── inventory.ts
├── operations.ts
└── system.ts
```

模板 example 路由先从生产路由注册中移除，源码暂留供参考。

## 12. 实时与后台任务

Supabase Realtime 仅用于高价值场景：

- 候诊队列；
- 护士任务；
- 住院房态；
- 检验状态。

导入、提醒扫描、自动计费和消息发送采用后台任务表 + 定时触发/队列适配，不把长任务放在浏览器请求生命周期内。

## 13. 环境与部署

环境：

- local
- preview
- staging
- production

要求：

- Preview 不得连接生产数据库和生产 R2 前缀；
- service role、R2 secret 仅存在服务端环境；
- `.env.example` 只放名称和说明；
- Vercel Function 超时和上传体积需要显式测试；
- 数据 migration 必须与代码 PR 同步。

## 14. 可观测性

每个 Command 记录：

- request ID
- actor
- tenant/store
- command
- entity ID
- duration
- result
- error code

关键状态变化写业务审计表，不以 Vercel 日志替代。

## 15. 测试

- Vue 组件：关键状态和交互；
- API：认证、权限、校验、错误码；
- RLS：跨租户、跨店和同店角色；
- RPC：重复请求、并发和回滚；
- E2E：核心业务闭环；
- Preview：1280、1440、1920 桌面验收。

## 16. 禁止事项

- 创建 Next.js 目录或 Server Action；
- 在 Vue 页面中使用 service role；
- 在浏览器暴露 R2 secret；
- 为每个页面复制一套表格和状态组件；
- 用 HTTP 200 包装所有错误；
- 用 `any` 作为正式接口契约；
- 直接更新不可变流水和已签署/已发布记录；
- 把 example 页面当成业务完成。

---

# 文件：03-数据模型与接口设计.md

# 【毛线球】数据模型与接口设计

> 版本：v0.4  
> 数据模型沿用 v0.2 的领域设计；接口实现统一修正为 Vue/Supabase Query + Hono Command + PostgreSQL RPC。

## 0. 现有数据库到目标模型的迁移

| 现有对象 | 目标对象 | v0.4 处理 |
|---|---|---|
| Supabase Auth user | auth user | 保留 |
| `profiles` | `profiles` | 保留并补审计字段 |
| `stores` | `stores` | 增加 `tenant_id`、归档状态 |
| `store_members` | membership + employee assignment | 迁移兼容 |
| `roles` | tenant roles | 增加权限集合和作用域 |
| 当前角色关联 | role assignments | 迁移 |
| `r2_files` | files + attachments | 迁移为私有文件和业务关联 |
| 现有 RLS helper | tenant/store permission helper | 统一并补测试 |

正式业务表扩展前，必须先完成 tenants 与跨租户隔离。

## 0.1 数据访问类型

| 类型 | 实现 | 示例 |
|---|---|---|
| Query | 浏览器 Supabase + RLS，或 Hono 聚合查询 | 客户列表、门店字典 |
| Command | Hono API | 提交处方、门店归档 |
| Transaction | Hono 调用 PostgreSQL RPC | 入库过账、付款、退款 |
| File | Hono 签名 + 浏览器 R2 直传 | 病历附件 |
| Async Job | job 表 + worker/定时触发 | 导入、提醒、自动计费 |

## 0.2 统一分页与错误

分页：

```ts
interface PageResult<T> {
  items: T[]
  page: number
  pageSize: number
  total: number
}
```

Command 失败使用明确 HTTP 状态和稳定错误码，不返回字符串模糊错误。

---

## 1. 命名与通用字段

- 表名：snake_case 复数
- 主键：`id uuid primary key default gen_random_uuid()`
- 租户字段：`tenant_id uuid not null`
- 门店字段：`store_id uuid`
- 时间：`created_at timestamptz`, `updated_at timestamptz`
- 创建修改人：`created_by`, `updated_by`
- 软删除：`archived_at`, `archived_by`
- 状态：text + check constraint 或 enum（谨慎使用 enum，变化频繁时用 check）
- 金额：`numeric(18,2)`；全项目统一
- 乐观锁：关键记录增加 `version integer not null default 1`

## 2. 平台与组织

### 2.1 tenants

```sql
tenants(
  id, slug, name, short_name, logo_file_id,
  timezone, currency, locale,
  status, trial_ends_at,
  created_at, updated_at
)
```

唯一：`slug`

### 2.2 stores

```sql
stores(
  id, tenant_id, code, name, type,
  phone, address_json, business_hours_json,
  status, manager_employee_id,
  created_at, updated_at, archived_at
)
```

唯一：`(tenant_id, code)`

### 2.3 profiles

```sql
profiles(
  user_id references auth.users,
  display_name, avatar_file_id,
  locale, created_at, updated_at
)
```

### 2.4 tenant_memberships

```sql
tenant_memberships(
  id, tenant_id, user_id,
  status, joined_at, invited_by
)
```

唯一：`(tenant_id, user_id)`

### 2.5 employees

```sql
employees(
  id, tenant_id, user_id,
  employee_no, name, phone, email,
  title, status,
  created_at, updated_at
)
```

唯一：`(tenant_id, employee_no)`

### 2.6 employee_store_assignments

```sql
employee_store_assignments(
  id, tenant_id, employee_id, store_id,
  is_primary, starts_at, ends_at
)
```

### 2.7 roles / permissions

```sql
roles(id, tenant_id nullable, code, name, scope, is_system)
permissions(id, code, name, module)
role_permissions(role_id, permission_id)
employee_role_assignments(id, tenant_id, employee_id, role_id, store_id nullable)
```

系统角色 `tenant_id null`，租户自定义角色带 tenant_id。

---

## 3. 客户与宠物

### 3.1 customers

```sql
customers(
  id, tenant_id, customer_no,
  name, phone, phone_normalized, backup_phone,
  email, gender, birthday,
  address_json, source_code,
  marketing_consent, risk_level,
  notes, status,
  created_store_id, owner_employee_id,
  created_at, updated_at, archived_at
)
```

索引：

- `(tenant_id, phone_normalized)`
- `(tenant_id, name)`
- `(tenant_id, customer_no) unique`

### 3.2 customer_store_relations

```sql
customer_store_relations(
  id, tenant_id, customer_id, store_id,
  first_visit_at, last_visit_at,
  visit_count, lifetime_value,
  owner_employee_id
)
```

### 3.3 pets

```sql
pets(
  id, tenant_id, pet_no, primary_customer_id,
  name, species_code, breed_code,
  gender, neutered,
  birth_date, birth_date_estimated,
  color, microchip_no, vaccine_certificate_no,
  allergies, chronic_conditions,
  risk_flags jsonb,
  status, deceased_at,
  avatar_file_id,
  created_at, updated_at, archived_at
)
```

### 3.4 pet_contacts

```sql
pet_contacts(
  id, tenant_id, pet_id, customer_id,
  relationship, is_primary,
  can_authorize_treatment, can_receive_messages
)
```

### 3.5 pet_weight_records

```sql
pet_weight_records(
  id, tenant_id, store_id, pet_id,
  weight_kg numeric(8,3),
  measured_at, source_type, source_id,
  created_by
)
```

---

## 4. 预约与就诊

### 4.1 appointments

```sql
appointments(
  id, tenant_id, store_id, appointment_no,
  customer_id, pet_id,
  type, service_item_id,
  assigned_employee_id,
  starts_at, ends_at,
  status, source,
  notes, cancellation_reason_code,
  arrived_at, checked_in_at,
  created_by, created_at, updated_at
)
```

约束：

- ends_at > starts_at
- customer/pet 属于同 tenant
- 状态 check

### 4.2 encounters

```sql
encounters(
  id, tenant_id, store_id, encounter_no,
  appointment_id,
  customer_id, pet_id,
  attending_doctor_id,
  encounter_type, status,
  registered_at, started_at, completed_at,
  created_by, created_at, updated_at
)
```

### 4.3 triage_records

```sql
triage_records(
  id, tenant_id, store_id, encounter_id,
  temperature_c, heart_rate, respiratory_rate,
  weight_kg, pain_score,
  notes, measured_by, measured_at
)
```

### 4.4 medical_records

```sql
medical_records(
  id, tenant_id, store_id, encounter_id,
  current_revision_id,
  status, signed_by, signed_at,
  created_at, updated_at
)
```

### 4.5 medical_record_revisions

```sql
medical_record_revisions(
  id, tenant_id, medical_record_id,
  revision_no,
  subjective, objective, assessment, plan,
  history_text, exam_json, instructions,
  change_reason,
  authored_by, created_at
)
```

唯一：`(medical_record_id, revision_no)`

### 4.6 diagnoses

```sql
encounter_diagnoses(
  id, tenant_id, store_id, encounter_id,
  diagnosis_code, diagnosis_text,
  diagnosis_type, is_primary,
  diagnosed_by, diagnosed_at
)
```

---

## 5. 目录

### 5.1 catalog_categories

```sql
catalog_categories(
  id, tenant_id, parent_id,
  type, code, name, sort_order,
  status, created_at, updated_at
)
```

### 5.2 catalog_items

```sql
catalog_items(
  id, tenant_id, category_id,
  item_code, item_type,
  name, short_name, search_code, barcode,
  specification, manufacturer,
  base_unit, inventory_unit, conversion_rate,
  requires_batch, requires_expiry,
  prescription_required,
  default_cost, default_price,
  metadata jsonb,
  status, created_at, updated_at
)
```

### 5.3 store_catalog_items

```sql
store_catalog_items(
  id, tenant_id, store_id, catalog_item_id,
  enabled, sale_price, min_price,
  default_warehouse_id,
  low_stock_threshold,
  service_duration_minutes,
  metadata jsonb
)
```

唯一：`(store_id, catalog_item_id)`

避免直接复制 catalog item 到每个门店。

---

## 6. 处方与执行

### 6.1 prescriptions

```sql
prescriptions(
  id, tenant_id, store_id, prescription_no,
  encounter_id, pet_id, doctor_id,
  status, submitted_at, voided_at, void_reason,
  created_at, updated_at
)
```

### 6.2 prescription_items

```sql
prescription_items(
  id, tenant_id, prescription_id,
  catalog_item_id,
  item_snapshot jsonb,
  dose numeric, dose_unit,
  route_code, frequency_code,
  duration_value, duration_unit,
  quantity numeric,
  instructions,
  status
)
```

### 6.3 care_orders

```sql
care_orders(
  id, tenant_id, store_id, encounter_id,
  inpatient_admission_id,
  order_type, catalog_item_id,
  instructions, schedule_rule jsonb,
  starts_at, ends_at,
  ordered_by, status
)
```

### 6.4 care_tasks

```sql
care_tasks(
  id, tenant_id, store_id, care_order_id,
  scheduled_at, status,
  executed_at, executed_by,
  actual_quantity, result, exception_reason
)
```

索引：`(store_id, status, scheduled_at)`

---

## 7. 收费与支付

### 7.1 invoices

```sql
invoices(
  id, tenant_id, store_id, invoice_no,
  customer_id, pet_id, encounter_id,
  status,
  subtotal, discount_total, total,
  paid_total, refunded_total, balance_due,
  issued_at, paid_at,
  created_by, created_at, updated_at
)
```

### 7.2 invoice_lines

```sql
invoice_lines(
  id, tenant_id, invoice_id,
  source_type, source_id,
  catalog_item_id,
  item_snapshot jsonb,
  quantity, unit_price,
  discount_amount, line_total,
  tax_amount,
  status
)
```

### 7.3 payments

```sql
payments(
  id, tenant_id, store_id, payment_no,
  customer_id,
  method, amount, status,
  external_transaction_id,
  received_by, received_at,
  idempotency_key,
  created_at
)
```

唯一：`(tenant_id, idempotency_key)`

### 7.4 payment_allocations

```sql
payment_allocations(
  id, tenant_id, payment_id, invoice_id, amount
)
```

### 7.5 refunds

```sql
refunds(
  id, tenant_id, store_id, refund_no,
  payment_id, invoice_id,
  requested_amount, approved_amount,
  reason_code, reason_text,
  status,
  requested_by, approved_by, executed_by,
  requested_at, approved_at, executed_at
)
```

---

## 8. 库存

### 8.1 warehouses

```sql
warehouses(
  id, tenant_id, store_id,
  code, name, type, status,
  is_default
)
```

### 8.2 inventory_batches

```sql
inventory_batches(
  id, tenant_id, store_id, warehouse_id,
  catalog_item_id,
  batch_no, expiry_date,
  supplier_id, unit_cost,
  received_at
)
```

### 8.3 inventory_balances

```sql
inventory_balances(
  id, tenant_id, store_id, warehouse_id,
  catalog_item_id, batch_id,
  on_hand, reserved, available,
  version, updated_at
)
```

唯一：

`(warehouse_id, catalog_item_id, batch_id)`

### 8.4 inventory_movements

```sql
inventory_movements(
  id, tenant_id, store_id, warehouse_id,
  catalog_item_id, batch_id,
  movement_type,
  quantity_delta,
  unit_cost,
  source_type, source_id, source_line_id,
  reversal_of_id,
  idempotency_key,
  occurred_at, created_by
)
```

唯一：

- `(tenant_id, idempotency_key)`
- 根据 source 防重复过账

### 8.5 suppliers

```sql
suppliers(
  id, tenant_id, supplier_no, name,
  contact_name, phone, address_json,
  payment_terms, status
)
```

### 8.6 goods_receipts / lines

包含单号、供应商、仓库、状态、总成本、审核和过账信息；行记录商品、批次、效期、数量、成本。

### 8.7 stock_counts / lines

主表保存范围与状态；行保存账面数量快照、实盘数量和差异。

### 8.8 inventory_transfers / lines

主表：

- from_store/warehouse
- to_store/warehouse
- 状态
- 发起、审核、发货、收货人员和时间

行：

- item
- batch（可在出库时确定）
- requested_qty
- shipped_qty
- received_qty
- variance_reason

---

## 9. 住院

### 9.1 facility_rooms / facility_units

房间和笼位分两层，支持状态和类型。

### 9.2 inpatient_admissions

```sql
inpatient_admissions(
  id, tenant_id, store_id, admission_no,
  pet_id, customer_id, encounter_id,
  admission_type,
  attending_doctor_id,
  room_id, unit_id,
  admitted_at, expected_discharge_at, discharged_at,
  status, risk_level,
  diet_instructions, care_notes,
  deposit_amount
)
```

### 9.3 inpatient_daily_notes

按日期/班次记录病程和交接。

---

## 10. 检验与影像

### 10.1 diagnostic_orders

统一申请主表，`type = lab/imaging`。

### 10.2 lab_specimens

记录标本类型、采样、接收、拒收。

### 10.3 lab_results

```sql
lab_results(
  id, tenant_id, diagnostic_order_id,
  analyte_code, analyte_name,
  value_text, value_numeric,
  unit, reference_range,
  abnormal_flag,
  result_version,
  entered_by, verified_by,
  entered_at, verified_at
)
```

### 10.4 diagnostic_reports

报告正文、状态、审核人、发布时间、文件 ID、版本。

---

## 11. 文件

### 11.1 files

```sql
files(
  id, tenant_id, store_id,
  bucket, object_key,
  original_name, mime_type, size_bytes,
  checksum, category,
  status,
  uploaded_by, uploaded_at,
  archived_at
)
```

`object_key` 全局唯一。

### 11.2 attachments

```sql
attachments(
  id, tenant_id, file_id,
  entity_type, entity_id,
  purpose, sort_order,
  created_by, created_at
)
```

对于高完整性要求可改用领域专用关联表；首版可统一 attachment + 服务端校验。

---

## 12. 消息与任务

### 12.1 reminders

记录业务触发、计划时间、接收对象、状态。

### 12.2 message_templates

租户/门店模板、渠道、变量 schema、版本。

### 12.3 message_deliveries

发送内容快照、供应商 ID、状态、错误、重试。

### 12.4 jobs

```sql
jobs(
  id, tenant_id,
  type, payload jsonb,
  status, run_after,
  attempts, max_attempts,
  locked_at, locked_by,
  last_error,
  created_at, updated_at
)
```

---

## 13. 审计

### 13.1 audit_logs

建议写入独立 schema 或至少禁止普通角色 update/delete。

`before_data` 和 `after_data` 仅存必要摘要，避免大量敏感正文。

---

## 14. RLS 函数建议

```sql
private.current_employee_id(p_tenant_id uuid)
private.is_tenant_member(p_tenant_id uuid)
private.can_access_store(p_tenant_id uuid, p_store_id uuid)
private.has_permission(
  p_tenant_id uuid,
  p_store_id uuid,
  p_permission text
)
```

要求：

- `security definer` 时固定 `search_path`
- revoke public execute
- 仅授予 authenticated
- 函数内部避免可注入动态 SQL
- 给 membership/assignment 建索引

---

## 15. 关键 RPC

建议实现：

```text
bootstrap_tenant
sign_medical_record
post_goods_receipt
post_stock_count
approve_inventory_transfer
ship_inventory_transfer
receive_inventory_transfer
capture_payment
execute_refund
dispense_prescription
reverse_inventory_movement
merge_customers
```

每个 RPC 返回：

- 业务结果 ID
- 新状态
- request_id / transaction reference
- 可理解错误码

---

## 16. HTTP 接口建议

### 16.1 文件上传

`POST /api/files/upload-intents`

请求：

```json
{
  "tenantId": "...",
  "storeId": "...",
  "category": "medical-record",
  "entityType": "encounter",
  "entityId": "...",
  "filename": "report.pdf",
  "contentType": "application/pdf",
  "sizeBytes": 12345
}
```

响应：

```json
{
  "fileId": "...",
  "objectKey": "...",
  "uploadUrl": "...",
  "expiresAt": "..."
}
```

`POST /api/files/{fileId}/complete`

服务端 HEAD 校验后标记 uploaded。

`POST /api/files/{fileId}/download-url`

权限校验并记录审计。

### 16.2 导入

- `POST /api/imports`
- `GET /api/imports/{id}`
- `GET /api/imports/{id}/errors`
- `POST /api/imports/{id}/commit`

### 16.3 报表导出

- `POST /api/exports`
- `GET /api/exports/{id}`
- 完成后返回受控下载

### 16.4 Webhook

- 消息供应商状态回调
- 支付供应商回调（后续）

必须验签、幂等、记录原始事件摘要。

---

## 17. 业务单号

格式可配置，默认：

```text
{STORE_CODE}-{TYPE}-{YYYYMMDD}-{SEQUENCE}
```

示例：

- `SH01-EN-20260806-000123`
- `SH01-INV-20260806-000045`
- `SH01-GR-20260806-000008`

内部逻辑不依赖可读单号。

---

## 18. 索引基线

每张高频业务表至少评估：

- `(tenant_id, id)`
- `(tenant_id, store_id, created_at desc)`
- `(tenant_id, store_id, status, created_at desc)`
- 外键列
- 搜索字段
- 软删除 partial index

示例：

```sql
create index on appointments
(tenant_id, store_id, starts_at)
where archived_at is null;
```

---

## 19. 数据完整性要求

- pet.primary_customer_id 与 pet tenant 一致
- encounter 的 customer/pet/store/tenant 一致
- invoice line 快照不可因目录改价而变化
- movement 过账后不可更新
- signed medical revision 不可更新
- refund 总额不得超过可退款额
- received_qty 不得无规则超过 shipped_qty
- 支付分配和不得超过 payment amount
- invoice paid_total 由交易更新，不能任意写

---

## 20. 数据库测试矩阵

至少包含：

1. 租户 A 用户不能 select/insert/update 租户 B。
2. A 店员工不能读取 B 店明细。
3. 总部角色可读取授权多店。
4. 无退款权限无法执行退款 RPC。
5. 入库重复调用只过账一次。
6. 发药库存不足失败且无部分流水。
7. 病历签署后旧 revision 不可修改。
8. 调拨收货产生正确双边流水。
9. 文件下载 URL 仅对有业务权限用户生成。
10. 审计日志不可被普通用户删除。

---

# v0.2 新增数据模型

## 21. 配置与打印

```sql
setting_definitions
tenant_settings
store_settings
setting_change_logs

print_templates(
  id, tenant_id, store_id nullable,
  document_type,
  name,
  paper_size,
  template_body,
  version,
  status
);

store_devices(
  id, tenant_id, store_id,
  device_type,
  name,
  connection_type,
  capabilities jsonb,
  status,
  last_seen_at
);

print_jobs(
  id, tenant_id, store_id,
  device_id,
  document_type,
  source_type,
  source_id,
  payload_snapshot jsonb,
  status,
  idempotency_key,
  created_at, printed_at
);
```

## 22. 会员与积分

```sql
membership_tiers(
  id, tenant_id, name, rank, status
);

membership_discount_rules(
  id, tenant_id, store_id nullable,
  tier_id,
  catalog_item_type nullable,
  catalog_item_id nullable,
  discount_rate,
  starts_at, ends_at,
  priority
);

loyalty_accounts(
  id, tenant_id, customer_id,
  available_points, frozen_points
);

loyalty_transactions(
  id, tenant_id, store_id,
  customer_id,
  type,
  points_delta,
  source_type, source_id,
  reversal_of_id,
  idempotency_key,
  occurred_at
);
```

积分流水不可更新或删除。

## 23. 预防保健

```sql
vaccination_plans(
  id, tenant_id,
  name, species_code,
  start_age_days,
  status
);

vaccination_plan_steps(
  id, tenant_id, plan_id,
  step_no,
  recommended_item_id,
  interval_days,
  label
);

vaccination_records(
  id, tenant_id, store_id,
  pet_id, customer_id,
  encounter_id,
  prescription_item_id,
  invoice_line_id,
  catalog_item_id,
  vaccine_snapshot jsonb,
  batch_id,
  dose, dose_unit,
  administered_at,
  administered_by,
  injection_site,
  precheck_json,
  adverse_reaction,
  next_due_at,
  status
);

deworming_records(
  id, tenant_id, store_id,
  pet_id,
  catalog_item_id,
  type,
  dose,
  administered_at,
  administered_by,
  next_due_at,
  encounter_id
);
```

## 24. 检验定义

```sql
diagnostic_panels(
  id, tenant_id,
  code, name, type, status
);

diagnostic_analytes(
  id, tenant_id,
  code, name, data_type,
  unit, status
);

diagnostic_panel_analytes(
  panel_id, analyte_id,
  sort_order,
  reference_rule jsonb
);

catalog_diagnostic_links(
  id, tenant_id,
  catalog_item_id,
  diagnostic_panel_id,
  quantity
);

diagnostic_report_versions(
  id, tenant_id,
  report_id,
  version_no,
  content_json,
  rendered_file_id,
  change_reason,
  created_by,
  verified_by,
  created_at
);
```

## 25. 问诊问题库

```sql
clinical_question_categories(
  id, tenant_id, parent_id,
  name, sort_order, status
);

clinical_questions(
  id, tenant_id, category_id,
  question_text,
  answer_type,
  options jsonb,
  unit,
  required,
  species_codes text[],
  department_codes text[],
  status,
  version
);

medical_template_questions(
  id, tenant_id,
  template_id,
  question_id,
  sort_order,
  required_override
);

medical_record_answers(
  id, tenant_id,
  medical_record_revision_id,
  question_snapshot jsonb,
  answer_json jsonb
);
```

## 26. 数据导入

```sql
import_jobs(
  id, tenant_id, store_id,
  import_type,
  source_file_id,
  status,
  mapping_json,
  strategy_json,
  total_rows,
  success_rows,
  warning_rows,
  error_rows,
  error_file_id,
  created_by,
  created_at,
  completed_at
);

import_rows(
  id, tenant_id, import_job_id,
  row_no,
  source_json,
  normalized_json,
  status,
  errors jsonb,
  warnings jsonb,
  result_type,
  result_id
);
```

生产规模较大时，`import_rows` 可设置保留周期。

## 27. 住院计费

```sql
inpatient_charge_rules(
  id, tenant_id, store_id,
  name,
  catalog_item_id,
  billing_unit,
  cutoff_time,
  grace_minutes,
  status
);

inpatient_charge_periods(
  id, tenant_id, store_id,
  admission_id,
  charge_rule_id,
  period_start,
  period_end,
  invoice_line_id,
  status,
  idempotency_key,
  unique(admission_id, charge_rule_id, period_start, period_end)
);
```

## 28. 安全事件

```sql
security_events(
  id,
  tenant_id nullable,
  user_id,
  event_type,
  risk_level,
  ip,
  user_agent,
  location_json,
  metadata jsonb,
  occurred_at,
  acknowledged_at,
  acknowledged_by
);
```

---

# 文件：04-分阶段并发开发计划.md

# 【毛线球】分阶段并发开发计划

> 版本：v0.4  
> 本计划以真实 Vue/Fantastic Admin/Hono 仓库为基线。

## 1. 总原则

- 先修基础设施，再批量开发业务 CRUD。
- UI Foundation、API Foundation、Tenant/RLS 是所有领域前置。
- 一个领域先确定数据表、类型、权限和 API 契约，再并行开发 UI 与 API。
- example 源码暂留参考，但必须先移出生产菜单。
- 同一文件同一时间只归一个 Agent 所有。
- DS 负责契约、合并、迁移顺序和验收，不把架构决策交给子 Agent。

## 2. Phase 0：基线冻结

### 目标

建立可验证的真实基线，不开发新业务。

### 任务

- 记录代码 commit；
- 运行安装、lint、build；
- 列出现有路由、页面、API 和 migrations；
- 标记真实功能与演示功能；
- 建立 `BASELINE_AUDIT.md`；
- 建立 `GAP_ANALYSIS.md`；
- 确认 Vercel、Supabase、R2 环境；
- 备份当前数据库 schema。

### 完成条件

- 本地 build 通过；
- 当前功能截图；
- 数据库对象清单；
- 已知风险清单；
- v0.4 文档被写入仓库。

## 3. Phase 1：生产壳层与 API 基础

### UI Foundation

- 从生产路由移除 example 模块；
- 品牌、Logo、favicon、版权；
- 领域菜单骨架；
- `StoreSelector`；
- `PermissionButton`；
- `EntityStatusTag`；
- 标准列表壳；
- 标准详情壳；
- Empty/Error/Conflict 状态。

### API Foundation

- Result/Error；
- request ID；
- `Authorization: Bearer`；
- Zod 校验 middleware；
- permission helper；
- audit helper；
- idempotency helper；
- 统一 Axios 拦截器。

### 完成条件

- 不再展示 Fantastic Admin 演示菜单；
- API 可返回 401/403/409/422；
- 前后端 request ID 可关联；
- 公共组件有演示页或 Story 页面。

## 4. Phase 2：Tenant、门店、员工、RBAC

### 数据库

- tenants；
- stores.tenant_id；
- memberships；
- employees；
- store assignments；
- roles/permissions；
- RLS helpers；
- 迁移现有 `store_members`。

### UI/API

- 门店列表和归档；
- 员工邀请；
- 员工停用；
- 角色权限；
- 当前 tenant/store 切换。

### 门禁

必须通过：

- A 租户无法读取 B 租户；
- 门店用户无法读取无权门店；
- system admin 的特殊路径有审计；
- 用户创建失败补偿测试。

未通过不得进入大规模业务开发。

## 5. Phase 3：客户与宠物

并行：

```text
CRM-DB
CRM-API
CRM-UI
CRM-IMPORT
```

交付：

- 客户列表、详情、新建、编辑、归档；
- 宠物档案、风险、体重；
- 客户宠物联合导入；
- 客户合并 RPC；
- 宠物时间线。

## 6. Phase 4：目录与医学基础数据

交付：

- 类目树；
- 统一目录；
- 门店价格与启用；
- 药品/疫苗扩展；
- 批量迁移；
- 问诊问题库；
- 诊断字典；
- 检验 panel/analyte 与收费关联。

## 7. Phase 5：预约、候诊和就诊

交付：

- 预约列表；
- 到店、取消、爽约；
- 候诊队列；
- 就诊开始/完成；
- 医生工作台；
- 冲突和状态机测试。

Realtime 只在候诊有明确价值时接入。

## 8. Phase 6：病历和处方

交付：

- 病历草稿；
- 自动保存与版本冲突；
- 签署/修订；
- 问诊模板；
- 处方编辑器；
- 处方提交；
- 护士任务初版。

## 9. Phase 7：收费与库存闭环

### 收费

- 发票草稿；
- 折扣快照；
- 支付；
- 退款审批；
- 小票预览。

### 库存

- 仓库和批次；
- 入库；
- 发药；
- 盘点；
- 调拨；
- 库存流水。

所有过账命令必须为 RPC，并完成幂等与并发测试。

## 10. Phase 8：预防保健和检验

- 疫苗方案；
- 接种记录；
- 驱虫记录；
- 批次追溯；
- 下次提醒；
- 检验申请；
- 标本；
- 结果录入；
- 审核发布；
- 报告版本；
- 危急值。

## 11. Phase 9：住院与寄养

- 房间/笼位；
- 房态；
- 入院；
- 护理计划；
- 任务执行；
- 交接班；
- 换房；
- 自动计费；
- 出院。

## 12. Phase 10：运营、导入和报表

- 完整导入适配器；
- 会员积分；
- 消息模板；
- 提醒任务；
- 报表；
- 打印中心；
- 安全事件后台。

## 13. 并发所有权

| 工作流 | 允许修改 |
|---|---|
| UI Foundation | 公共业务组件、settings、菜单 |
| API Foundation | `api/lib`、middlewares、客户端拦截器 |
| DB/RLS | migrations、generated types、RLS tests |
| Domain UI | 自己领域 views/components |
| Domain API | 自己领域 routes/services/schemas |
| RPC | 对应领域 migration/function |

跨工作流修改需要 DS 重新分配，不允许“顺手修改”。

## 14. 每个领域的开发节奏

```text
契约 PR
→ migration/RLS PR
→ API PR 与 UI skeleton PR 并行
→ 联调 PR
→ E2E/验收 PR
```

## 15. PR 完成证据

- 任务 ID；
- 修改范围；
- migration；
- API 契约；
- 权限码；
- RLS 测试；
- UI 截图；
- 自动化测试；
- Vercel Preview；
- 已知限制；
- 文档更新。

## 16. 禁止并发方式

- 多个 Agent 同时编辑 router 总入口；
- 多个 Agent 同时修改同一个 migration；
- UI Agent 自行改变 API 字段；
- API Agent自行改变状态机；
- 为赶进度先绕过 RLS；
- 用 mock/fake API 宣称完成；
- 合并未 build 的 PR。

---

# 文件：05-待确认问题与决策记录.md

# 【毛线球】待确认问题与决策记录

> 版本：v0.4

## 1. 已由代码确认

| 项目 | 结论 |
|---|---|
| 前端框架 | Vue 3 + Vite |
| 管理模板 | Fantastic Admin 6.3 |
| 路由 | Vue Router |
| 状态管理 | Pinia |
| UI 底层 | Reka UI + Fantastic Admin components |
| 样式 | UnoCSS + SCSS |
| 表单校验 | vee-validate + Zod |
| 复杂表格 | vxe-table |
| 认证和数据库 | Supabase |
| 服务端 API | Hono on Vercel |
| 文件 | Cloudflare R2 |
| Monorepo | pnpm workspace |
| 已有业务 | 登录、门店、用户、角色、部分 RLS 和文件上传 |
| 主要缺口 | 宠物医院核心业务基本未实现 |

这些问题不再作为 DS 的开放问题。

## 2. P0 业务决策

必须在 Phase 2 前确认：

1. 第一批客户是单店还是连锁？
2. 是否立即引入完整 tenant，还是先把现有所有数据归入默认 tenant？
3. 同租户是否跨店共享客户和病历？
4. 普通医生是否可以跨店查看历史医疗记录？
5. 首版登录方式：邮箱、手机号、微信，优先级是什么？
6. 首版支付仅记录线下收款，还是接微信/支付宝？
7. 会员储值、积分、折扣是否进入 MVP？
8. 住院、寄养、美容是否进入第一阶段销售版本？
9. 是否已有真实生产数据？
10. 是否需要从小暖或其他系统迁移？

## 3. P0 技术迁移决策

1. 现有 `store_members` 是否原地扩展，还是迁移到 employee/assignment 新表？
2. 当前 Supabase 项目是否允许执行破坏性 migration？
3. 是否先建立 staging 环境验证迁移？
4. 当前用户和门店数据量？
5. R2 现有公共文件是否需要批量迁移到私有 key？
6. 是否接受对历史文件 URL 进行过渡兼容？
7. 上传大于 10MB 的影像是否属于 MVP？
8. 是否部署独立后台任务执行器，还是首版使用 Vercel Cron + job 表？
9. 是否已有短信供应商账号？
10. 是否有打印机和钱箱的明确型号？

## 4. 打印与设备

1. 小票规格：58mm、80mm、A4？
2. 必须打印哪些文档：收费单、处方、病历、检验报告、接种证明？
3. 是否必须联动钱箱？
4. 是否接受安装本地打印代理？
5. 是否需要离线打印队列？

## 5. 医疗业务

1. 是否涉及麻醉药、处方药等特殊权限？
2. 病历签署是否需要电子签名？
3. 检验报告审核是否要求双人？
4. 危急值确认是否进入 MVP？
5. 疫苗证明是否需要监管格式？
6. 宠物死亡记录和数据可见性规则？

## 6. 住院计费

1. 房费按自然日还是 24 小时？
2. 日切时间？
3. 不足一日计费规则？
4. 是否收住院押金？
5. 换房何时生效？
6. 寄养与医疗住院是否共享房间？

## 7. 决策记录格式

```text
ADR-编号：
日期：
状态：proposed / accepted / superseded
问题：
决策：
原因：
影响：
迁移方案：
负责人：
```

DS 不得自行决定 P0 业务问题；未确认时应实现可配置结构或暂停相关功能。

---

# 文件：06-参考来源与差异说明.md

# 【毛线球】参考来源、代码基线与差异说明

> 版本：v0.4

## 1. 代码基线

文件：

```text
website-maoxianqiu-net-main(1).zip
```

压缩包标识：

```text
eb44aa971d6431fcffb04b19fd242c613fca8a1f
```

审计日期：2026-08-06。

重点目录：

```text
apps/maoxianqiu
apps/example
api
packages/components
supabase/migrations
.agents/skills
```

## 2. 代码确认结果

- pnpm workspace；
- Fantastic Admin 6.3；
- Vue 3 + Vite + TypeScript；
- Vue Router、Pinia、UnoCSS、Reka UI；
- Hono Vercel API；
- Supabase Auth/Postgres/RLS；
- Cloudflare R2；
- 已有登录、门店、用户、角色、部分 RLS 和文件接口；
- 大量 example 页面仍存在；
- 宠物医院核心业务尚未形成。

## 3. 业务参考

### 小暖管理员手册

文件：

```text
小暖医生动物医院管理系统操作手册（管理员）.md
```

用于发现：

- 产品和目录；
- 系统权限与配置；
- 数据导入；
- 库存；
- 住院寄养；
- 护士工作站；
- 短信；
- 化验和影像。

旧手册不作为现代 UI、安全、权限和技术架构依据。

## 4. 自动转换限制

Markdown 转换稿存在：

- OCR 错别字；
- 标题重复；
- 图片字段未结构化；
- 表格列错位；
- 某些段落复制错误。

因此字段级实现需结合截图、现有代码和业务确认。

## 5. 文档推导范围

文档中：

- “当前已实现”来自代码审计；
- “目标实现”来自 PRD 和系统设计；
- “旧系统能力”来自操作手册；
- 未由代码或手册支持的业务细节均应进入待确认，而不是由 DS 猜测。

## 6. 版本维护

代码继续变化后，DS 必须：

1. 更新 baseline commit；
2. 更新完成度矩阵；
3. 更新 API 和路由清单；
4. 更新 migration 状态；
5. 不在旧文档中保留已失效技术假设。

---

# 文件：07-小暖功能映射与差异矩阵.md

# 【毛线球】小暖功能映射与差异矩阵

> 目的：明确旧手册中的功能如何映射到毛线球 SaaS，以及哪些功能保留、升级、延后或淘汰。

## 1. 判定标签

- **保留**：业务需求仍有效
- **升级**：保留业务意图，但更换产品或技术实现
- **拆分**：旧系统混合能力需要拆成多个领域
- **延后**：不是 MVP
- **淘汰**：不适合 Web SaaS 或存在风险
- **待确认**：需要项目负责人决策

## 2. 总体矩阵

| 小暖功能 | 毛线球模块 | 处理 | 说明 |
|---|---|---|---|
| 安装向导 | SaaS 租户初始化 | 升级 | 改为在线注册、租户初始化向导 |
| 16 位激活密钥 | 订阅与租户状态 | 淘汰/升级 | 改为 SaaS 订阅、试用、停用 |
| 管理员账号 | Auth/IAM | 升级 | 支持邀请、多租户成员关系 |
| 药品目录 | 统一目录 | 保留 | 增加批次、效期、门店定价 |
| 药品快速导入 | 导入平台 | 升级 | 使用模板、预校验和错误报告 |
| 处置目录 | 统一目录 | 保留 | 关联医生/护士执行 |
| 化验目录 | 收费目录 + 检验定义 | 拆分 | 收费项目与 panel/analyte 分离 |
| 预防目录 | 疫苗/驱虫 | 拆分 | 目录、库存、接种记录、提醒 |
| 美容目录 | 美容服务 | 保留 | 支持时长、员工和预约 |
| 商品目录 | 零售商品 | 保留 | 管库存、条码和销售 |
| 消耗品目录 | 库存消耗品 | 保留 | 可设为内部消耗或收费 |
| 试纸目录 | 检验耗材 | 升级 | 与检验执行、成本关联 |
| 影像目录 | 影像收费与报告 | 拆分 | 项目与报告工作流分开 |
| 机构信息 | 租户/门店 | 升级 | 多租户、多门店和配置继承 |
| 用户角色 | RBAC | 升级 | 资源+动作+范围 |
| 权限管理 | RBAC + RLS | 升级 | 数据库强制隔离 |
| 系统用户 | 员工与账号 | 升级 | Auth 身份与员工档案分开 |
| 供应商 | 采购 | 保留 | 租户级供应商、门店采购 |
| 会员导入 | 客户宠物导入 | 升级 | 支持去重、合并和多宠物 |
| 系统参数 | 配置中心 | 升级 | 租户默认、门店覆盖、审计 |
| 会员打折 | 会员规则 | 升级 | 规则优先级和价格快照 |
| 小票打印 | 打印中心 | 升级 | 浏览器/PDF/本地代理 |
| 设备接入 | 本地设备适配 | 延后 | 不承诺任意设备自动识别 |
| Logo 设置 | 品牌与打印模板 | 保留 | R2 文件 + 模板版本 |
| 钱箱设置 | 收银设备 | 延后 | 通过打印机/本地代理 |
| 积分设置 | 积分账户 | 保留 | 不可变积分流水 |
| 登录提醒 | 安全通知 | 升级 | 新设备、异常登录、敏感操作 |
| 主诉项目 | 问诊问题库 | 升级 | 回答类型、选项、适用物种 |
| 主观诊断 | 医生模板 | 升级 | 不自动作为正式诊断 |
| 疾病诊断 | 诊断字典 | 保留 | 标准诊断 + 自由文本 |
| 快速入库 | 采购入库 | 升级 | 草稿、审核、过账、幂等 |
| 入库管理 | 库存查询/入库 | 拆分 | 库存余额与入库单分开 |
| 入库清单 | 入库单列表 | 保留 | 状态和审计 |
| 库存盘点 | 盘点 | 升级 | 快照、差异、审核、流水 |
| 库存调拨 | 跨店调拨 | 升级 | 在途、部分收货、差异 |
| 调拨记录 | 库存流水/单据 | 保留 | 不可变记录 |
| 住院寄养室 | 房间/笼位 | 升级 | 房态和并发占用约束 |
| 住院寄养费用 | 收费规则 | 升级 | 按时/按日/按次、自动计费 |
| 住院寄养办理 | 入院/入住 | 升级 | 医疗住院与普通寄养分权 |
| 护士执行处方 | 护士任务 | 升级 | 计划时间、结果、异常 |
| 短信发送 | 消息中心 | 升级 | 供应商适配、同意状态、重试 |
| 短信模板 | 消息模板 | 保留 | 变量 schema 和版本 |
| 已发短信 | 发送记录 | 保留 | 状态、失败原因、供应商 ID |
| 短信购买 | SaaS/供应商计费 | 待确认 | 取决于商业模式 |
| 化验项目设置 | 检验定义 | 升级 | panel/analyte/参考范围 |
| 检查化验 | 检验工作流 | 升级 | 采样、审核、版本、危急值 |
| 手工改结果 | 报告修订 | 淘汰/升级 | 禁止覆盖，改为新版本 |
| B 超/CR | 影像工作流 | 升级 | 文件、报告、审核；不做 PACS |

## 3. 旧手册未覆盖但 SaaS 必须具备

- tenant_id / store_id 隔离
- Supabase RLS
- R2 私有文件
- 审计日志
- 状态机
- 幂等
- API 错误契约
- Vercel 环境隔离
- 多门店客户可见范围
- 订阅状态
- 数据备份与恢复
- 实时队列
- 报表权限
- 安全事件
- 文件生命周期
- 数据导入异步任务

## 4. 风险说明

旧手册是管理员操作说明，并非完整产品需求。它未完整描述：

- 前台接诊的所有字段
- 经营管理模块细节
- 财务对账
- 法规和隐私
- 异常流程
- 并发和性能
- 数据删除策略

因此不可将“手册没写”理解为“系统不需要”。
## 5. Vue 页面与 API 落点

| 领域 | 页面目录 | 查询/命令 |
|---|---|---|
| 客户 | `src/views/customers` | Supabase Query + `/api/customers/*` Command |
| 宠物 | `src/views/pets` | Supabase Query + `/api/pets/*` |
| 预约 | `src/views/frontdesk/appointments` | `/api/appointments/*` |
| 候诊 | `src/views/frontdesk/queue` | `/api/queues/*` |
| 病历 | `src/views/clinical/encounters` | `/api/medical-records/*` |
| 处方 | `src/views/clinical/prescriptions` | `/api/prescriptions/*` + RPC |
| 收费 | `src/views/billing` | `/api/invoices/*`、payments、refunds |
| 库存 | `src/views/inventory` | Hono + inventory RPC |
| 疫苗 | `src/views/prevention` | `/api/vaccinations/*` |
| 检验 | `src/views/diagnostics` | `/api/diagnostic-orders/*` |
| 住院 | `src/views/inpatient` | `/api/admissions/*`、care tasks |
| 系统设置 | `src/views/system` | Supabase Query + Hono Command |
| 导入 | `src/views/imports` | `/api/imports/*` |
| 打印 | `src/views/system/print` | `/api/print-jobs/*` |

## 6. 实现判定

- 页面存在于 example 目录：不算完成。
- 只有静态表格和 fake API：不算完成。
- 只有数据库表，没有 RLS/API/UI：算基础未联调。
- UI、API、RLS、状态机和测试齐全：才算业务完成。

---

# 文件：08-页面级详细需求说明.md

# 【毛线球】页面级详细需求说明

> 版本：v0.4  
> 页面基于 Vue Router、Fantastic Admin 和 `@fantastic-admin/components` 实现。

## 1. 页面实现模板

每个页面任务必须写明：

- route name/path；
- route meta 权限；
- Vue view 文件；
- 使用的公共组件；
- Query API；
- Command API；
- 数据范围；
- 字段与按钮；
- 状态机；
- loading/empty/error/conflict；
- 验收。

## 2. 通用页面骨架

### 2.1 列表页

```vue
<FaPageHeader title="客户管理">
  <template #actions>
    <PermissionButton permission="customer.create">
      新增客户
    </PermissionButton>
  </template>
</FaPageHeader>

<FaPageMain>
  <FilterPanel />
  <FaTable />
  <FaPagination />
</FaPageMain>
```

要求：

- 服务端分页；
- 筛选条件可恢复；
- 固定操作列；
- 行点击详情；
- 空状态和失败重试；
- 批量操作必须显式权限。

### 2.2 详情页

```text
EntityPageHeader
FaDescriptions / Summary cards
FaTabs
AuditTimeline
```

### 2.3 表单

- `FaForm` + vee-validate + Zod；
- 简单对象用 `FaModal`；
- 快速查看或轻编辑用 `FaDrawer`；
- 复杂流程用独立页面；
- 底部主要操作用 `FaFixedBar`；
- 离开未保存使用模板 `leavetips` 能力。

## 3. 路由与菜单

```text
/workbench
/frontdesk/customers
/frontdesk/pets
/frontdesk/appointments
/frontdesk/queue
/clinical/workbench
/clinical/encounters/:id
/clinical/prescriptions/:id
/nursing/tasks
/inpatient/board
/billing/invoices
/inventory/balances
/inventory/receipts
/inventory/counts
/inventory/transfers
/operations/memberships
/operations/reports
/system/stores
/system/employees
/system/roles
/system/catalog
/system/clinical-data
/system/settings
/system/imports
```

路由定义分散在领域 module 中，父级菜单使用 Layout，实际页面必须由 child route 加载。

## 4. 工作台

### UI

- `FaCard` 指标；
- 待办列表；
- 今日预约/候诊；
- 库存预警；
- 快捷操作。

### API

使用聚合 endpoint：

```text
GET /api/workbench?storeId=...
```

不要让首页并发请求十几个完整列表。

## 5. 客户列表

### 文件

```text
src/views/customers/index.vue
src/api/modules/customer.ts
```

### 组件

- `FaPageHeader`
- `FilterPanel`
- `FaTable`
- `FaPagination`
- `CustomerFormModal`

### 列

姓名、手机号、宠物数、会员等级、最近到店、归属门店、负责人、状态。

### API

- Query：客户分页；
- Command：新建、编辑、归档；
- 合并：独立流程。

## 6. 客户详情

页头：

- 客户姓名；
- 联系方式；
- 标签；
- 归属；
- 风险；
- 新建预约；
- 新建宠物。

Tabs：

- 宠物；
- 就诊；
- 消费；
- 会员积分；
- 提醒；
- 沟通；
- 文件；
- 审计。

## 7. 宠物详情

页头常驻：

- 名称、物种、品种、年龄；
- 当前体重；
- 过敏；
- 慢性病；
- 咬人/传染风险；
- 主联系人。

Tabs：

- 概览；
- 病历；
- 处方；
- 检验影像；
- 疫苗驱虫；
- 体重；
- 住院；
- 文件。

风险不允许仅通过颜色表达。

## 8. 预约与候诊

### 预约列表

首版先实现列表，后续增加日历。

创建预约使用 `FaDrawer`，冲突由 API 返回 409，并在表单内展示可理解提示。

### 候诊工作台

- 紧凑列表；
- 状态标签；
- 叫号、跳过、开始就诊；
- Realtime 可作为增强；
- 页面重连后必须从数据库恢复。

## 9. 医生工作台与病历

推荐三栏：

```text
左：宠物摘要和历史
中：病历编辑
右：处方、检验、处置
```

病历编辑：

- 草稿自动保存；
- 显示保存状态；
- 乐观锁 version；
- 签署后二次确认；
- 签署后只读；
- 修订生成新 revision；
- 问诊问题库快速插入。

## 10. 处方编辑

复杂明细使用 `vxe-table`：

- 项目搜索；
- 剂量；
- 单位；
- 频次；
- 途径；
- 疗程；
- 总量；
- 备注；
- 删除。

提交前可展示库存提示，最终库存校验由发药 Command/RPC 完成。

## 11. 收银页面

布局：

```text
左：收费明细
右：客户、会员、优惠、支付
底部固定：应收、实收、找零、结算
```

组件：

- `vxe-table` 明细；
- `FaFixedBar`；
- `MoneyInput`；
- `DangerConfirm` 用于退款。

支付按钮生成 idempotency key 并在请求期间锁定。

## 12. 库存

### 库存余额

普通 `FaTable`，支持仓库、项目、批次、近效期筛选。

### 入库、盘点、调拨

使用独立全屏页面 + `vxe-table`。

状态操作只通过 Command：

- 提交；
- 审核；
- 过账；
- 发货；
- 收货。

## 13. 检验工作台

队列：

- 待采样；
- 待接收；
- 检测中；
- 待审核；
- 已发布；
- 已退回。

结果编辑使用 `vxe-table`，报告发布后二次确认。版本历史使用 `FaDrawer` 或独立 Tab。

## 14. 住院房态

卡片网格展示：

- 可用；
- 占用；
- 清洁；
- 维修；
- 隔离。

点击卡片打开 Drawer；办理入住和换房使用独立 Command，409 表示房位并发冲突。

## 15. 系统管理

### 门店

列表、详情、归档、恢复。禁止物理删除 UI。

### 员工

邀请、门店分配、角色、停用、管理员重置密码。

### 角色权限

权限树或分组复选，系统角色只读。

### 参数

显示租户默认与门店覆盖来源。

## 16. 导入中心

步骤：

1. 类型；
2. 模板；
3. 上传；
4. 字段映射；
5. 校验；
6. 重复处理；
7. 提交；
8. 结果。

使用 `FaProgress`；复杂预览使用 `vxe-table`。任务异步，不保持一个长 HTTP 请求。

## 17. 文件和图片

- 头像：`FaImageUpload`；
- 附件：`FaFileUpload`；
- 上传前校验；
- 进度和取消；
- 上传完成后保存 file ID/key；
- 私有下载 URL 由 API 获取；
- 删除采用 archive。

## 18. 状态与权限

统一：

```vue
<EntityStatusTag domain="prescription" :status="row.status" />
<PermissionButton
  permission="prescription.submit"
  :disabled="row.status !== 'draft'"
/>
```

禁止页面自行重复状态文案和颜色。

## 19. 页面完成标准

- route 正常；
- 使用真实 API；
- 类型完整；
- 分页；
- loading/empty/error/conflict；
- 权限；
- 状态机；
- 表单校验；
- 防重复提交；
- Preview 截图；
- 无 example 数据；
- 1280/1440/1920 验收。

---

# 文件：09-业务流程与状态机.md

# 【毛线球】业务流程与状态机

## 1. 原则

- 状态只能通过命令改变。
- 每次转换校验权限、当前状态和业务条件。
- 状态变化写历史。
- 已过账、已发布、已签署对象不允许普通 CRUD 修改。

## 2. 租户

```text
trialing -> active -> past_due -> suspended -> cancelled
```

## 3. 预约

```text
draft -> confirmed -> arrived -> checked_in -> in_service -> completed
confirmed -> cancelled
confirmed -> no_show
```

## 4. 就诊

```text
registered -> triage -> consulting -> pending_tests
-> treatment -> pending_payment -> completed
```

## 5. 病历

```text
draft -> signed -> revised
draft -> voided
```

`revised` 表示存在更新版本，旧版本仍不可变。

## 6. 处方

```text
draft -> submitted -> dispensed -> completed
draft/submitted -> voided
dispensed -> return_pending -> partially_returned/returned
```

## 7. 收费

```text
draft -> pending_payment -> partially_paid -> paid
paid -> refund_pending -> partially_refunded/refunded
```

## 8. 入库

```text
draft -> submitted -> approved -> posted
submitted -> rejected
draft/submitted -> cancelled
```

## 9. 盘点

```text
draft -> counting -> submitted -> approved -> posted
submitted -> rejected
```

## 10. 调拨

```text
draft -> submitted -> approved -> outbound
-> in_transit -> partially_received -> completed
```

也可从 `in_transit` 直接 `completed`。

## 11. 检验

```text
ordered -> payment_pending -> ready_for_sampling
-> sampled -> received -> processing
-> result_entered -> verification_pending -> published
```

异常：

```text
sampled/received -> specimen_rejected
verification_pending -> returned
published -> revised
```

## 12. 疫苗接种

```text
planned -> due -> administered -> completed
planned/due -> skipped
administered/completed -> corrected
```

接种确认应在同一业务事务或可靠编排中完成：

- 检查库存批次
- 生成出库
- 写接种记录
- 计算下一针
- 生成提醒事件

## 13. 住院

```text
planned -> admitted -> in_care
-> discharge_pending -> discharged
```

辅助：

- transferred
- cancelled
- deceased

## 14. 护理任务

```text
pending -> in_progress -> completed
pending -> skipped
pending/in_progress -> failed
pending -> cancelled
```

## 15. 导入

```text
uploaded -> parsing -> validating
-> ready -> importing -> completed
```

失败分支：

- validation_failed
- partially_completed
- failed
- cancelled

## 16. 打印任务

```text
queued -> dispatched -> printing -> printed
queued/dispatched/printing -> failed
failed -> queued
```

## 17. 状态转换验收模板

每条转换至少测试：

1. 正常转换
2. 无权限
3. 错误当前状态
4. 跨租户
5. 跨门店
6. 重复请求
7. 并发请求
8. 审计记录
## 18. 状态转换实现绑定

| 状态转换 | UI | Hono Command | 数据库 |
|---|---|---|---|
| 预约确认 | 确认按钮 | `POST /api/appointments/:id/confirm` | transaction/update with version |
| 到店挂号 | 到店按钮 | `POST /api/appointments/:id/arrive` | check-in command |
| 开始就诊 | 开始诊疗 | `POST /api/encounters/:id/start` | encounter transition |
| 病历签署 | 签署按钮 | `POST /api/medical-records/:id/sign` | `sign_medical_record` RPC |
| 处方提交 | 提交处方 | `POST /api/prescriptions/:id/submit` | transition |
| 发药 | 发药按钮 | `POST /api/prescriptions/:id/dispense` | `dispense_prescription` RPC |
| 收费支付 | 结算 | `POST /api/payments` | `record_payment` RPC |
| 退款执行 | 执行退款 | `POST /api/refunds/:id/execute` | `execute_refund` RPC |
| 入库过账 | 过账 | `POST /api/goods-receipts/:id/post` | `post_goods_receipt` RPC |
| 盘点过账 | 过账 | `POST /api/stock-counts/:id/post` | `post_stock_count` RPC |
| 调拨发货 | 发货 | `POST /api/transfers/:id/ship` | `ship_inventory_transfer` RPC |
| 调拨收货 | 收货 | `POST /api/transfers/:id/receive` | `receive_inventory_transfer` RPC |
| 报告发布 | 发布 | `POST /api/diagnostic-orders/:id/publish` | report version transaction |
| 办理入住 | 入住 | `POST /api/admissions` | `assign_inpatient_unit` RPC |
| 护理完成 | 完成任务 | `POST /api/care-tasks/:id/complete` | guarded transition |

## 19. 前端规则

- 状态标签来自统一 map；
- 操作按钮同时校验权限和当前状态；
- API 返回 409 时刷新实体并展示状态冲突；
- 前端不得直接 update 状态字段；
- 已签署、已发布、已过账对象只允许修订或冲销。

---

# 文件：10-DS并发任务清单.md

# 【毛线球】DS 唯一执行任务清单

> 版本：v0.4  
> 本文件是唯一主任务清单。第 15 份文档仅定义任务卡格式和并发边界，不再重复任务。

## 00 基线

### MXQ-0001 仓库基线
- build/lint
- 路由、API、migration 清单
- commit 和环境记录

### MXQ-0002 演示与真实功能矩阵
- 标记 example
- 标记真实 Supabase/Hono 功能
- 不删除参考源码

### MXQ-0003 数据库与 RLS 审计
- 表、函数、策略
- 两租户测试计划

### MXQ-0004 R2 审计
- key、公开性、大小、MIME、删除授权

## 10 UI Foundation

### MXQ-1001 移除生产 example 路由
### MXQ-1002 品牌替换
### MXQ-1003 StoreSelector
### MXQ-1004 PermissionButton
### MXQ-1005 EntityStatusTag
### MXQ-1006 标准列表壳
### MXQ-1007 标准详情壳
### MXQ-1008 Empty/Error/Conflict
### MXQ-1009 Money/Date formatter

## 20 API Foundation

### MXQ-2001 Result/Error
### MXQ-2002 Request ID
### MXQ-2003 Authorization Bearer
### MXQ-2004 Zod validation
### MXQ-2005 tenant/store context
### MXQ-2006 permission helper
### MXQ-2007 audit helper
### MXQ-2008 idempotency helper
### MXQ-2009 Axios compatibility migration

## 30 Tenant 与 IAM

### MXQ-3001 tenants migration
### MXQ-3002 stores.tenant_id migration
### MXQ-3003 memberships/employees
### MXQ-3004 roles/permissions
### MXQ-3005 现有数据迁移
### MXQ-3006 RLS helper
### MXQ-3007 跨租户/跨店测试
### MXQ-3008 门店归档
### MXQ-3009 员工邀请补偿
### MXQ-3010 员工和角色 UI

## 40 文件

### MXQ-4001 files/attachments 数据模型
### MXQ-4002 R2 私有 key
### MXQ-4003 upload intent
### MXQ-4004 complete
### MXQ-4005 download URL
### MXQ-4006 archive/delete
### MXQ-4007 旧 r2_files 迁移

## 50 CRM

### MXQ-5001 客户表/RLS
### MXQ-5002 客户 Query/Command
### MXQ-5003 客户列表
### MXQ-5004 客户详情
### MXQ-5005 宠物表/RLS
### MXQ-5006 宠物 API
### MXQ-5007 宠物详情
### MXQ-5008 体重/风险
### MXQ-5009 客户合并 RPC
### MXQ-5010 客户宠物导入

## 60 Catalog

### MXQ-6001 类目
### MXQ-6002 统一目录
### MXQ-6003 门店项目/价格
### MXQ-6004 药品疫苗扩展
### MXQ-6005 批量迁移
### MXQ-6006 目录 UI
### MXQ-6007 问诊问题库
### MXQ-6008 诊断字典
### MXQ-6009 检验 panel/analyte
### MXQ-6010 收费关联

## 70 前台与诊疗

### MXQ-7001 预约表/API/UI
### MXQ-7002 预约冲突
### MXQ-7003 候诊队列
### MXQ-7004 就诊
### MXQ-7005 医生工作台
### MXQ-7006 病历草稿
### MXQ-7007 病历签署/修订 RPC
### MXQ-7008 病历 UI
### MXQ-7009 处方 API
### MXQ-7010 处方编辑器
### MXQ-7011 护士任务基础

## 80 收费

### MXQ-8001 invoice
### MXQ-8002 折扣计算
### MXQ-8003 payment RPC
### MXQ-8004 refund RPC
### MXQ-8005 收银 UI
### MXQ-8006 支付防重复
### MXQ-8007 小票预览

## 90 库存

### MXQ-9001 仓库/批次/余额
### MXQ-9002 不可变流水
### MXQ-9003 入库 RPC/UI
### MXQ-9004 发药 RPC
### MXQ-9005 盘点 RPC/UI
### MXQ-9006 调拨 RPC/UI
### MXQ-9007 近效期预警
### MXQ-9008 并发与幂等测试

## 100 预防与检验

### MXQ-10001 疫苗方案
### MXQ-10002 接种记录
### MXQ-10003 驱虫
### MXQ-10004 下一针和提醒
### MXQ-10005 接种证明
### MXQ-10006 检验申请
### MXQ-10007 标本
### MXQ-10008 结果编辑
### MXQ-10009 审核/发布/版本
### MXQ-10010 危急值
### MXQ-10011 病历引用

## 110 住院

### MXQ-11001 房间/笼位
### MXQ-11002 房态
### MXQ-11003 入院和房位锁
### MXQ-11004 护理计划
### MXQ-11005 护理任务
### MXQ-11006 交接班
### MXQ-11007 换房
### MXQ-11008 自动计费
### MXQ-11009 出院

## 120 运营

### MXQ-12001 会员折扣
### MXQ-12002 积分
### MXQ-12003 消息模板
### MXQ-12004 提醒扫描
### MXQ-12005 发送适配器
### MXQ-12006 导入平台
### MXQ-12007 打印中心
### MXQ-12008 报表
### MXQ-12009 安全事件

## 任务门禁

任务完成必须同时满足：

- 正确目录；
- 无未说明 `any`；
- migration 可重复应用；
- RLS 测试；
- API 契约；
- UI 状态完整；
- build/lint；
- Preview；
- 截图；
- 文档更新。

## 首批允许执行

```text
MXQ-0001 ~ MXQ-0004
MXQ-1001 ~ MXQ-1009
MXQ-2001 ~ MXQ-2009
MXQ-3001 ~ MXQ-3007
```

在 MXQ-3007 通过前，不开始 50 之后的大规模业务 CRUD。

---

# 文件：11-代码审计摘要与修正决策.md

# 【毛线球】代码审计摘要与修正决策

## 1. 已确认

- Monorepo：pnpm workspace
- 模板：Fantastic Admin 6.3.0
- 前端：Vue 3.5 + Vite 8 + TypeScript
- 路由：Vue Router
- 状态：Pinia
- 样式：UnoCSS + SCSS
- 基础组件：Fantastic Admin 自有组件，底层 Reka UI
- 表格：FaTable / TanStack Vue Table；复杂表格另有 vxe-table
- 数据：Supabase browser client
- 服务端：Hono + Vercel
- 文件：Cloudflare R2
- 已实现：登录、注册、找回密码、店铺、用户、角色、部分 RLS、R2 上传删除
- 未实现：绝大多数宠物医院业务

## 2. 与 v0.2 假设冲突

v0.2 中出现的 Next.js App Router、Server Components、Server Actions 不适用于当前代码。

修正：

| 原假设 | 实际方案 |
|---|---|
| Next.js | Vue 3 SPA |
| App Router | Vue Router modules |
| Server Actions | Hono JSON API |
| Server Components | Vue SFC |
| Next Route Handler | Hono Vercel Functions |
| React component | Vue component |
| React Hook Form | vee-validate |
| Tailwind | UnoCSS |

Supabase RLS、R2、状态机、数据模型和业务边界仍有效。

## 3. 当前风险

1. 仍保留大量 example 演示路由。
2. API 和业务代码大量使用 `any`。
3. 当前数据库未形成完整 tenant 模型。
4. 权限主要依赖角色名。
5. 店铺支持物理删除。
6. R2 当前使用公共 URL。
7. 上传经 Vercel 中转，不适合大文件。
8. 用户创建缺少失败补偿。
9. 错误响应全部偏向 HTTP 200。
10. 前端 localStorage 单独保存 token，需要继续依赖 Supabase session 为真值。
11. 现有 `r2_files` 按 user 归属，不满足业务实体文件授权。
12. 系统管理路由结构需核验是否实际加载 view。

## 4. DS 第一批修复

```text
UI-001 清理生产菜单中的演示路由
UI-002 完成品牌替换
UI-003 建公共业务组件
API-001 统一结果与错误码
API-002 Authorization Bearer
API-003 request ID
DB-001 tenants 与 store tenant_id
DB-002 权限 helper
SEC-001 文件私有化设计
SEC-002 用户创建补偿
```


## 5. v0.4 修正状态

- 01 已增加真实完成度和技术约束；
- 02 已按 Vue/Hono 全面重写；
- 03 已加入现有数据库迁移和 Query/Command/RPC 分层；
- 04 已按真实代码重排阶段；
- 05 已移除已确认技术问题；
- 06 已加入代码基线；
- 07 已加入 Vue 页面和 API 落点；
- 08 已按 Fantastic Admin 组件重写；
- 09 已绑定 UI、Hono 和 RPC；
- 10 已成为唯一 DS 主任务清单。

从 v0.4 起，不再把 11—15 视为纠错补丁，而是统一文档体系的一部分。

---

# 文件：12-前端UI实现说明书.md

# 【毛线球】前端 UI 实现说明书（基于现有代码）

> 版本：v0.4  
> 适用代码：`apps/maoxianqiu`  
> 真实技术栈：Vue 3 + Vite + TypeScript + Fantastic Admin + Reka UI + UnoCSS + Pinia + Vue Router  
> 表格增强：`vxe-table` / `vxe-pc-ui`  
> 表单校验：`vee-validate` + Zod  
> 图表：ECharts / VChart  
> 部署：Vercel 静态前端 + Hono Functions

---

## 1. 代码审计结论

### 1.1 当前不是 Next.js

此前设计文档中的 Next.js 目录仅为假设。真实仓库是 Vue 3 SPA：

```text
apps/maoxianqiu/
├── src/
│   ├── api/
│   ├── components/
│   ├── composables/
│   ├── layouts/
│   ├── lib/
│   ├── router/
│   ├── store/
│   ├── ui/
│   └── views/
├── vite.config.ts
└── package.json
```

DS 不得创建 `app/`、Server Component 或 Next.js Route Handler。

### 1.2 模板来源

`apps/maoxianqiu` 从 `apps/example` 复制而来。目前差异集中在：

- Supabase 登录、注册和密码找回
- Supabase 浏览器客户端
- Hono API Axios 客户端
- 店铺管理
- 用户管理
- 角色管理
- 系统管理路由
- R2 上传相关依赖

大量以下内容仍是模板演示，应逐步删除：

```text
router/modules/*.example.ts
views/component_example/
views/plugin_example/
views/feature_example/
views/ui_example/
views/standard_module_example/
```

删除前要先把其中有价值的组件示例映射到业务页面，不能直接全删。

---

## 2. 必须坚持的前端架构

每个业务模块按“视图、组件、领域 API、类型、校验”组织：

```text
src/features/
  customers/
    api.ts
    types.ts
    schemas.ts
    composables/
    components/
    views/
```

由于当前项目尚无 `features`，迁移采用渐进方式：

```text
第一阶段：
src/views/customers/
src/api/modules/customer.ts
src/types/customer.ts

第二阶段：
逐步移动到 src/features/customers/
```

禁止：

- 把所有请求写在 `.vue` 页面中
- 组件内直接拼 Supabase 多表复杂查询
- 页面中出现大量 `any`
- 一个页面文件超过约 500 行仍不拆分
- 每个模块复制一套相同表格和搜索代码

---

## 3. 现有组件库复用

`packages/components` 已提供以下基础组件：

| 组件 | 业务用途 |
|---|---|
| `FaPageHeader` | 页面标题、说明和主要操作 |
| `FaPageMain` | 内容卡片容器 |
| `FaTable` | 普通数据列表 |
| `FaForm/FaFormItem` | 编辑表单 |
| `FaModal/useFaModal` | 新建、编辑、确认 |
| `FaDrawer/useFaDrawer` | 详情、快速编辑 |
| `FaSearchBar` | 复杂筛选 |
| `FaPagination` | 分页 |
| `FaTabs` | 详情页分区 |
| `FaDescriptions` | 基础信息摘要 |
| `FaTag/FaBadge` | 状态与标签 |
| `FaFileUpload/FaImageUpload` | R2 文件上传 |
| `FaFixedBar` | 固定底部操作条 |
| `FaToast` | 成功、警告和失败反馈 |
| `FaCard` | 指标卡片 |
| `FaProgress` | 导入、任务进度 |
| `FaDropdown` | 次要操作菜单 |

### 3.1 不要重复造基础组件

DS 在创建新组件前必须检查：

```text
packages/components/src/basic/
apps/maoxianqiu/src/views/component_example/
```

例如：

- 需要弹窗：先看 `modal.vue`
- 需要抽屉：先看 `drawer.vue`
- 需要固定底栏：先看 `fixed_bar.vue`
- 需要上传：先看 `file_upload.vue` 和 `image_upload.vue`
- 需要复杂表格：先看 `plugin_example/vxe-table.vue`

### 3.2 允许新增的业务组件

基础组件之上新增：

```text
src/components/business/
├── EntityStatusTag.vue
├── PermissionButton.vue
├── StoreSelector.vue
├── CustomerPicker.vue
├── PetPicker.vue
├── CatalogItemPicker.vue
├── EmployeePicker.vue
├── MoneyText.vue
├── DateTimeText.vue
├── AuditTimeline.vue
├── EntityPageHeader.vue
├── FilterPanel.vue
├── EmptyState.vue
└── DangerConfirm.vue
```

业务组件不得包含某个具体页面的全部数据请求。

---

## 4. 设计系统

### 4.1 品牌方向

毛线球是宠物医疗 SaaS，不要继续使用 Fantastic Admin 默认品牌。

建议：

- 品牌主色：温和但专业的蓝绿色系
- 医疗风险：红色
- 警告与近效期：橙色
- 成功与已完成：绿色
- 中性草稿：灰色
- 住院/护理：紫色辅助
- 不通过颜色单独表达状态

颜色必须通过 UnoCSS token 或 CSS variable 管理，不允许页面硬编码不同色值。

### 4.2 布局密度

宠物医院前台和医护工作台属于高频操作系统：

- 桌面优先
- 1280px 以上充分利用横向空间
- 表格默认紧凑或中等密度
- 主要操作按钮固定在可见位置
- 关键宠物风险信息始终可见
- 不为了“漂亮”牺牲信息密度

### 4.3 页面宽度

- 普通列表：全宽
- 表单：最大 960–1200px
- 病历和处方：全宽分栏
- 详情页：全宽
- 弹窗表单：简单对象
- 抽屉：快速查看和轻编辑
- 完整业务流程：独立页面，不使用小弹窗

---

## 5. 应用壳层改造

### 5.1 `settings.ts`

当前仍显示 Fantastic Admin 版权，应改为：

- 毛线球品牌名
- Logo
- 正确版权
- 首页标题
- 默认主题
- 是否允许用户切换主题

### 5.2 顶栏

顶栏必须包含：

```text
租户选择（多租户用户）
门店选择
全局搜索
快捷新建
待办/通知
用户菜单
```

当前用户的门店范围从 `store_members` 获取。选择门店只影响当前工作上下文，不是权限依据。

### 5.3 侧边栏

最终菜单分组：

```text
工作台
前台
  客户
  宠物
  预约
  挂号候诊
诊疗
  医生工作台
  病历
  处方
  检验影像
护理
  护士工作站
  住院
  寄养
收费
  收费单
  支付退款
库存
  库存
  入库
  盘点
  调拨
运营
  会员
  提醒
  报表
系统管理
  门店
  员工
  角色权限
  目录
  医学数据
  参数
  导入
```

菜单由 `meta.auth` 控制显示，但最终权限仍由 RLS/API 决定。

---

## 6. 路由设计

当前路由通过 `router/modules/*.ts` 管理。新增业务路由时按领域建文件：

```text
router/modules/
├── frontdesk.ts
├── clinical.ts
├── nursing.ts
├── billing.ts
├── inventory.ts
├── operations.ts
└── system.ts
```

路由示例：

```ts
{
  path: '/customers',
  component: Layout,
  name: 'customerList',
  meta: {
    title: '客户管理',
    icon: 'i-lucide:users',
    auth: 'customer:read',
    keepAlive: true,
  },
  children: [
    {
      path: '',
      component: () => import('@/views/customers/index.vue'),
    },
    {
      path: ':id',
      name: 'customerDetail',
      component: () => import('@/views/customers/detail.vue'),
      meta: {
        title: '客户详情',
        menu: false,
        auth: 'customer:read',
      },
    },
  ],
}
```

注意：当前 `system.ts` 的父级 `component: Layout` 但没有页面 child 的模式需要核验。新业务路由必须确保实际 view 被加载，不能只加载 Layout。

---

## 7. 标准页面模板

### 7.1 列表页

结构：

```vue
<FaPageHeader title="客户管理">
  <template #actions>
    <PermissionButton permission="customer:create">
      新增客户
    </PermissionButton>
  </template>
</FaPageHeader>

<FaPageMain>
  <FilterPanel />
  <FaTable />
  <FaPagination />
</FaPageMain>
```

必须包含：

- URL 或 store 中保存筛选条件
- 首次 loading
- 翻页 loading
- 空状态
- 请求失败重试
- 权限受限提示
- 分页
- 列表刷新
- 固定操作列
- 行点击进入详情

### 7.2 详情页

```text
EntityPageHeader
├── 编号、姓名、状态
├── 门店
├── 风险提示
└── 主要操作

Summary Cards / Descriptions

Tabs
├── 概览
├── 业务记录
├── 文件
└── 审计
```

### 7.3 表单页

简单配置可使用 Modal，复杂业务必须独立页面。

表单规则：

- Zod schema 为单一校验来源
- `vee-validate` 展示字段错误
- 保存按钮防重复
- 服务端错误映射到字段
- 离开未保存提示
- 区分“保存草稿”和“提交”
- 只读状态不渲染可编辑控件

---

## 8. 表格实现规范

### 8.1 普通表格使用 `FaTable`

适用：

- 客户
- 宠物
- 门店
- 员工
- 角色
- 收费单
- 检验申请

### 8.2 复杂表格使用 `vxe-table`

适用：

- 处方明细编辑
- 收费项目编辑
- 盘点录入
- 调拨明细
- 检验结果批量录入
- 数据导入预览

### 8.3 统一字段

所有业务列表建议包含：

- 编号
- 核心名称
- 门店
- 状态
- 负责人
- 创建/业务时间
- 操作

操作列最多直接显示 2 个高频动作，其余放 `FaDropdown`。

### 8.4 不允许前端全量加载

必须调用分页 API：

```ts
{
  page: 1,
  pageSize: 20,
  keyword: '',
  storeId: '',
  status: '',
}
```

Supabase 查询使用 `.range(from, to)` 并返回精确或计划内 count。

---

## 9. 状态组件

建立统一映射：

```ts
export const encounterStatusMap = {
  registered: { label: '已挂号', variant: 'neutral' },
  consulting: { label: '诊疗中', variant: 'info' },
  pending_tests: { label: '待检查', variant: 'warning' },
  completed: { label: '已完成', variant: 'success' },
  cancelled: { label: '已取消', variant: 'danger' },
}
```

禁止页面自行写三元表达式：

```ts
status === 'active' ? '启用' : '停用'
```

统一使用：

```vue
<EntityStatusTag domain="employee" :status="row.status" />
```

---

## 10. 权限 UI

建立：

```vue
<PermissionButton
  permission="inventory:transfer:approve"
  :disabled="row.status !== 'submitted'"
  disabled-reason="只有待审核调拨单可以审核"
>
  审核
</PermissionButton>
```

按钮显示规则：

```text
是否有权限
AND 当前状态允许
AND 当前门店范围允许
AND 业务条件满足
```

前端隐藏按钮不是安全措施。

---

## 11. 工作台设计

### 11.1 首页

当前 `views/index.vue` 应重做，不继续使用模板首页。

首版布局：

```text
今日经营指标
今日预约/候诊
待处理任务
库存预警
最近就诊
快捷操作
```

根据角色返回不同卡片：

- 前台：预约、候诊、收费
- 医生：我的候诊、未完成病历、检验结果
- 护士：待执行、超时、住院任务
- 店长：收入、客流、退款、库存预警

### 11.2 数据加载

工作台使用单独聚合查询，不并行请求十几个列表 API。

---

## 12. 关键业务页面实现

### 12.1 客户与宠物

建议：

- 客户列表：`FaTable`
- 新建客户：Modal
- 客户详情：独立页
- 宠物风险：顶部常驻 Alert
- 宠物头像：`FaImageUpload`
- 客户和宠物选择：可搜索 Picker

### 12.2 预约

- 日历视图与列表视图切换
- 首版可先完成列表
- 创建预约使用 Drawer
- 冲突返回时在表单顶部展示
- 不允许只用客户端判断冲突

### 12.3 就诊与病历

采用三栏或两栏：

```text
左：宠物与历史摘要
中：病历编辑
右：处方、检验、处置快捷面板
```

病历要支持：

- 自动保存草稿
- 明确保存状态
- 签署
- 签署后只读
- 修订
- 问诊模板快速插入

### 12.4 处方

使用 `vxe-table` 编辑明细：

- 药品搜索
- 剂量
- 单位
- 频次
- 途径
- 疗程
- 总量
- 删除

底部显示库存警告，但最终库存校验在提交/发药 API。

### 12.5 收费

收银页面：

```text
左侧：收费项目
右侧：应收摘要、折扣、支付
底部固定：应收、实收、找零、结算
```

付款操作必须禁用重复提交。

### 12.6 库存

盘点和调拨使用全屏页面，不使用小弹窗。

### 12.7 住院房态

使用卡片网格：

- 可用
- 占用
- 清洁
- 维修
- 隔离

点击笼位打开详情 Drawer；办理入住使用独立流程。

---

## 13. 文件上传

现有上传接口通过 Vercel Function 中转整个文件，最大 10MB。首版可继续用于头像和小附件，但病历大文件和影像应升级为预签名直传。

UI 必须：

- 限制类型
- 限制大小
- 展示进度
- 支持取消
- 上传完成后记录 `key`
- 删除使用服务端 `/api/files/delete`
- 不仅保存公开 URL

---

## 14. Loading、错误和空状态

每个页面必须区分：

```text
首次加载
局部刷新
提交中
空数据
筛选无结果
权限不足
请求失败
业务冲突
```

禁止所有错误只显示一个 Toast。表单错误应靠近字段，页面级失败需要 ErrorState。

---

## 15. 前端并发拆分

不同 Agent 可按领域开发，但公共组件由 UI 负责人先完成：

### UI Foundation

- 品牌和 settings
- 菜单
- StoreSelector
- PermissionButton
- EntityStatusTag
- EntityPageHeader
- FilterPanel
- Empty/Error State
- Money/Date format

### 领域 Agent

只允许使用公共组件，不自行造另一套状态标签、搜索栏和弹窗规范。

---

## 16. 前端 Definition of Done

- 使用真实 API，不是 fake module
- 没有未说明的 `any`
- loading/empty/error 完整
- 权限与状态控制按钮
- 支持分页
- Zod 校验
- 成功与失败反馈
- 未保存提示
- Vercel Preview 可访问
- 桌面 1280/1440/1920 验收
- 平板基本可用
- 无明显模板演示残留

---

# 文件：13-功能API设计与实现说明书.md

# 【毛线球】功能 API 设计与实现说明书（基于现有代码）

> 版本：v0.4  
> 前端：Vue SPA  
> 浏览器数据访问：Supabase anon client + RLS  
> 服务端：Hono on Vercel  
> 文件：Cloudflare R2

---

## 1. 当前 API 架构

### 1.1 浏览器直连 Supabase

当前模块：

- 登录/注册/密码找回
- profile
- stores
- roles
- store_members

优点：

- 开发快
- RLS 直接生效
- 减少 Function 调用

风险：

- 复杂业务容易散落在页面
- 多表事务无法由浏览器安全完成
- 错误码不统一
- 查询逻辑容易重复
- 业务规则可能只在前端

### 1.2 Hono 服务端 API

当前仅保留浏览器不能安全完成的操作：

```text
GET  /api/health
POST /api/user/create
POST /api/user/reset-password
POST /api/upload
POST /api/files/delete
```

这是合理方向，但需要明确分类。

---

## 2. API 分类规则

### A 类：浏览器可直连 Supabase

仅适用于：

- 简单只读查询
- 单表普通 CRUD
- RLS 足够表达权限
- 不使用 service role
- 不涉及多个业务事实同时提交

示例：

- 查询客户列表
- 查询门店列表
- 修改个人资料
- 读取基础字典

### B 类：必须走 Hono Command API

满足任一条件就必须走后端：

- 需要 service role
- 调用 Auth Admin
- 跨表事务
- 库存变动
- 支付/退款
- 病历签署
- 报告发布
- 用户邀请
- 文件签名
- 外部供应商
- 幂等控制
- 审计要求高

### C 类：数据库 RPC

需要强事务一致性的命令：

- 入库过账
- 盘点过账
- 调拨发货/收货
- 发药
- 支付
- 退款
- 病历签署
- 客户合并

Hono 负责认证、权限、输入校验和调用 RPC。

---

## 3. 当前响应格式问题

当前格式：

```json
{
  "status": 1,
  "error": "",
  "data": {}
}
```

问题：

- `status: 1` 同时可能带 `error`
- 业务错误仍返回 HTTP 200
- 前端依赖字符串错误
- 无稳定错误码
- 无 requestId

建议兼容升级：

```json
{
  "ok": true,
  "data": {},
  "requestId": "req_xxx"
}
```

失败：

```json
{
  "ok": false,
  "error": {
    "code": "INSUFFICIENT_STOCK",
    "message": "库存不足",
    "fieldErrors": {
      "items.0.quantity": ["可用库存为 2"]
    }
  },
  "requestId": "req_xxx"
}
```

HTTP 状态：

- 400 校验失败
- 401 未登录
- 403 无权限
- 404 不存在
- 409 状态/并发冲突
- 422 业务规则失败
- 500 服务端错误

迁移期间 Axios 拦截器同时兼容旧、新格式。

---

## 4. 认证头

当前前端发送：

```text
Token: <access_token>
```

Hono 同时兼容 `Authorization: Bearer`。

建议统一为：

```text
Authorization: Bearer <access_token>
```

不要继续新增依赖 `Token` 的接口。

---

## 5. API 目录结构

当前：

```text
api/
├── index.ts
├── lib/
├── middlewares/
└── routes/
```

建议扩展：

```text
api/
├── index.ts
├── lib/
│   ├── supabase.ts
│   ├── r2.ts
│   ├── result.ts
│   ├── errors.ts
│   ├── validation.ts
│   ├── audit.ts
│   └── request-context.ts
├── middlewares/
│   ├── auth.ts
│   ├── request-id.ts
│   ├── error-handler.ts
│   └── rate-limit.ts
├── routes/
│   ├── users.ts
│   ├── files.ts
│   ├── inventory.ts
│   ├── billing.ts
│   ├── medical-records.ts
│   └── diagnostics.ts
└── schemas/
```

---

## 6. 权限模型修正

当前后端主要使用：

- `hasRole(system_admin)`
- `canManageStore(storeId)`
- `store_manager`

不够满足完整 SaaS。

应逐步升级为：

```ts
requirePermission(c, {
  code: 'inventory.transfer.approve',
  storeId,
})
```

角色只是权限集合，业务代码不应到处判断具体角色名。

### 6.1 当前缺少 tenant

现有表只有 `stores`、`store_members`、`roles`，尚未形成 PRD 中完整的 `tenants` 边界。

在扩展业务 API 前必须先决定：

- 引入 `tenants`
- stores 带 `tenant_id`
- roles 带 tenant 或系统模板范围
- 所有业务表带 `tenant_id`

---

## 7. 当前 API 安全问题与改进

### 7.1 店铺删除

当前前端直接：

```ts
supabase.from('stores').delete()
```

正式系统不应物理删除门店，应改为：

```text
POST /api/stores/:id/archive
```

并检查历史业务记录。

### 7.2 文件上传

当前上传：

- Vercel 中转
- 公共 URL
- 10MB
- R2 key 不含 tenant/store
- MIME 校验不足
- `r2_files` 主要按 user 归属

正式设计：

```text
POST /api/files/upload-intents
POST /api/files/:id/complete
POST /api/files/:id/download-url
POST /api/files/:id/archive
```

对象 key：

```text
{env}/tenant/{tenantId}/store/{storeId}/{domain}/{yyyy}/{mm}/{uuid}.{ext}
```

### 7.3 用户创建补偿

当前先创建 Auth 用户，再插入 store member。第二步失败时会留下孤立 Auth 用户。

必须实现：

- 后端补偿删除 Auth 用户
- 或使用 invitation 状态
- 返回明确错误码
- 记录审计

### 7.4 修改密码

当前 `editPassword` 参数包含旧密码，但实际没有验证旧密码。UI 和 API 契约需要一致：

- 已登录用户修改密码：重新认证后更新
- 管理员重置密码：单独权限 API

---

## 8. 前端 API 模块规范

每个模块：

```ts
// src/api/modules/customer.ts
export interface CustomerListParams {}
export interface CustomerListResult {}

export const customerApi = {
  list(params: CustomerListParams),
  detail(id: string),
  create(input: CreateCustomerInput),
  update(id: string, input: UpdateCustomerInput),
  archive(id: string),
}
```

禁止 `data: any`。

Supabase 的数据库类型应由：

```text
pnpm db:gen-types
```

生成后引用。

---

## 9. 通用查询契约

列表参数：

```ts
interface ListParams {
  page: number
  pageSize: number
  keyword?: string
  storeId?: string
  status?: string[]
  createdFrom?: string
  createdTo?: string
  sort?: string
  order?: 'asc' | 'desc'
}
```

返回：

```ts
interface PageResult<T> {
  items: T[]
  page: number
  pageSize: number
  total: number
}
```

禁止不同模块分别返回 `list`、`rows`、`records`。

---

## 10. 系统管理 API

### 10.1 门店

```text
GET    /api/stores
POST   /api/stores
GET    /api/stores/:id
PATCH  /api/stores/:id
POST   /api/stores/:id/archive
POST   /api/stores/:id/restore
```

简单列表可暂时直连 Supabase，但创建、归档应走 Command API。

### 10.2 员工

```text
GET    /api/employees
POST   /api/employees/invite
GET    /api/employees/:id
PATCH  /api/employees/:id
POST   /api/employees/:id/assign-store
POST   /api/employees/:id/change-role
POST   /api/employees/:id/disable
POST   /api/employees/:id/reset-password
```

### 10.3 角色

```text
GET    /api/roles
POST   /api/roles
PATCH  /api/roles/:id
POST   /api/roles/:id/archive
GET    /api/permissions
```

系统角色不可删除。

---

## 11. 客户与宠物 API

```text
GET    /api/customers
POST   /api/customers
GET    /api/customers/:id
PATCH  /api/customers/:id
POST   /api/customers/:id/archive
POST   /api/customers/merge

GET    /api/pets
POST   /api/pets
GET    /api/pets/:id
PATCH  /api/pets/:id
POST   /api/pets/:id/archive
POST   /api/pets/:id/weights
GET    /api/pets/:id/timeline
```

客户合并必须是后端 command/RPC。

---

## 12. 预约和候诊 API

```text
GET    /api/appointments
POST   /api/appointments
PATCH  /api/appointments/:id
POST   /api/appointments/:id/confirm
POST   /api/appointments/:id/cancel
POST   /api/appointments/:id/arrive
POST   /api/appointments/:id/no-show

POST   /api/encounters/check-in
GET    /api/queues
POST   /api/queues/:id/call
POST   /api/queues/:id/skip
POST   /api/queues/:id/start
```

预约创建由后端检查资源冲突。

---

## 13. 就诊、病历和处方 API

```text
GET    /api/encounters/:id
POST   /api/encounters/:id/start
POST   /api/encounters/:id/complete

GET    /api/medical-records/:id
PUT    /api/medical-records/:id/draft
POST   /api/medical-records/:id/sign
POST   /api/medical-records/:id/revise

POST   /api/prescriptions
PATCH  /api/prescriptions/:id
POST   /api/prescriptions/:id/submit
POST   /api/prescriptions/:id/void
POST   /api/prescriptions/:id/dispense
```

### 13.1 病历草稿

草稿保存可允许较高频率，但：

- 使用 version
- 防止两个窗口覆盖
- 返回 `updatedAt`
- 签署时检查最新 version

---

## 14. 收费和退款 API

```text
POST   /api/invoices
GET    /api/invoices/:id
PATCH  /api/invoices/:id/draft
POST   /api/invoices/:id/issue
POST   /api/payments
POST   /api/refunds
POST   /api/refunds/:id/approve
POST   /api/refunds/:id/execute
```

所有 Command 接受：

```text
Idempotency-Key
```

或请求 body 的 `idempotencyKey`。

---

## 15. 库存 API

```text
GET    /api/inventory/balances
GET    /api/inventory/movements

POST   /api/goods-receipts
POST   /api/goods-receipts/:id/submit
POST   /api/goods-receipts/:id/approve
POST   /api/goods-receipts/:id/post

POST   /api/stock-counts
POST   /api/stock-counts/:id/submit
POST   /api/stock-counts/:id/approve
POST   /api/stock-counts/:id/post

POST   /api/transfers
POST   /api/transfers/:id/submit
POST   /api/transfers/:id/approve
POST   /api/transfers/:id/ship
POST   /api/transfers/:id/receive
```

这些接口不能由浏览器直接 insert/update 多张表。

---

## 16. 检验 API

```text
POST   /api/diagnostic-orders
POST   /api/diagnostic-orders/:id/collect
POST   /api/diagnostic-orders/:id/receive
POST   /api/diagnostic-orders/:id/results
POST   /api/diagnostic-orders/:id/submit-verification
POST   /api/diagnostic-orders/:id/publish
POST   /api/diagnostic-orders/:id/revise
```

已发布报告不允许普通 update。

---

## 17. 住院 API

```text
GET    /api/inpatient/board
POST   /api/admissions
POST   /api/admissions/:id/change-unit
POST   /api/admissions/:id/discharge-request
POST   /api/admissions/:id/discharge

POST   /api/care-orders
POST   /api/care-tasks/:id/start
POST   /api/care-tasks/:id/complete
POST   /api/care-tasks/:id/skip
```

房位分配必须在数据库事务内防冲突。

---

## 18. 导入 API

```text
POST   /api/imports/upload
POST   /api/imports/:id/mapping
POST   /api/imports/:id/validate
POST   /api/imports/:id/commit
GET    /api/imports/:id
GET    /api/imports/:id/errors
```

导入任务异步执行，前端轮询或订阅状态。

---

## 19. API 实现模板

Hono route：

```ts
route.post('/:id/approve', requireAuth(), async (c) => {
  const requestId = c.get('requestId')
  const input = schema.parse(await c.req.json())
  const actor = await requirePermission(c, {
    code: 'inventory.transfer.approve',
    storeId: input.storeId,
  })

  const result = await service.rpc('approve_inventory_transfer', {
    p_transfer_id: c.req.param('id'),
    p_actor_id: actor.employeeId,
    p_idempotency_key: input.idempotencyKey,
  })

  return ok(c, result, requestId)
})
```

---

## 20. API 测试要求

每个 Command 至少测试：

- 未登录
- 无权限
- 跨店
- 跨租户
- 错误状态
- 参数错误
- 重复请求
- 并发请求
- 正常成功
- 审计日志

---

## 21. API 开发顺序

1. 统一 Result/Error
2. request ID
3. tenant/store context
4. permission helper
5. RLS 测试
6. 用户邀请补偿
7. 文件预签名
8. 客户宠物
9. 目录
10. 预约病历
11. 收费库存
12. 检验住院

未完成前 5 项，不扩张业务 API。

---

# 文件：14-前端模板与组件复用矩阵.md

# 【毛线球】前端模板与组件复用矩阵

## 1. 直接保留

| 代码 | 用途 |
|---|---|
| `layouts/` | 应用壳层 |
| `router/guards.ts` | 登录、动态路由、进度条、标题、保活 |
| `store/modules/app/*` | 框架级菜单、路由、Tab、设置 |
| `packages/components` | 基础 UI |
| `composables/app/page.ts` | 页面工具 |
| `@fantastic-admin/composables` pagination | 分页 |
| `ui/provider` | 全局 UI provider |
| `FaModal/FaDrawer/FaToast` | 交互反馈 |
| `vxe-table` | 复杂明细表 |

## 2. 改造后保留

| 代码 | 改造 |
|---|---|
| `views/index.vue` | 改为医院工作台 |
| `settings.ts` | 改品牌、版权、主题 |
| `AppAccountForm/*` | 统一中文文案和租户初始化 |
| `AppAccountButton` | 加门店、用户、会话管理 |
| `router/modules/system.ts` | 扩充并修正 child 路由 |
| `views/system/*` | 引入 tenant、员工、权限和归档 |
| `api/index.ts` | 新响应格式与 Authorization header |
| `lib/supabase.ts` | 加类型、环境校验 |

## 3. 作为参考后删除

| 演示目录 | 可提取能力 |
|---|---|
| `component_example` | 基础组件使用方法 |
| `plugin_example/vxe-table.vue` | 复杂表格 |
| `plugin_example/print.vue` | 打印 |
| `plugin_example/tinymce.vue` | 富文本，谨慎用于报告模板 |
| `plugin_example/echarts.vue` | 报表 |
| `plugin_example/vchart.vue` | 报表 |
| `standard_module_example` | 标准列表详情 |
| `feature_example/leavetips.vue` | 离开未保存提示 |
| `keep_alive_example` | 列表返回状态保留 |

提取完成后从生产路由删除。

## 4. 不建议直接使用

- fake API modules
- `standard_module` 示例表
- 模板生态和 UI 选择页
- demo 外部链接
- JSX 示例
- 多级菜单演示
- Fantastic Admin 品牌资源

## 5. 新增公共业务组件顺序

```text
P0:
StoreSelector
PermissionButton
EntityStatusTag
EntityPageHeader
FilterPanel
EmptyState
ErrorState

P1:
CustomerPicker
PetPicker
CatalogItemPicker
EmployeePicker
MoneyInput
FileAttachmentList
AuditTimeline

P2:
PrescriptionEditor
InvoiceLineEditor
InventoryBatchPicker
CareTaskTimeline
DiagnosticResultEditor
```

---

# 文件：15-前端与API并发开发任务清单.md

# 【毛线球】前端与 API 并发执行规范

> 版本：v0.4  
> 任务编号以 `10-DS并发任务清单.md` 为唯一来源。

## 1. 任务卡模板

```text
任务 ID：
标题：
目标：
前置任务：
允许修改目录：
禁止修改目录：
数据表/视图：
API：
UI 路由：
权限码：
状态转换：
输入类型：
输出类型：
错误码：
测试：
验收截图：
Preview URL：
已知限制：
```

## 2. UI Agent 边界

允许：

- 自己领域的 views/components/composables；
- 已确认的 API client；
- 页面状态和交互；
- 单元组件测试。

禁止：

- 修改 migration；
- 绕过 API 直接完成库存/支付事务；
- 自行改变接口字段；
- 新建重复基础组件；
- 修改公共 router 总入口，除非被明确分配。

## 3. API Agent 边界

允许：

- 自己领域 Hono route/schema/service；
- Query/Command 契约；
- 调用已确认 RPC；
- API 测试。

禁止：

- 自行改变产品状态机；
- 返回 `any`；
- 所有错误都返回 200；
- 在 route 文件中堆积完整业务；
- 使用 service role 绕过未经审计的权限边界。

## 4. DB/RLS Agent 边界

允许：

- migration；
- function/RPC；
- RLS；
- seed/test fixture；
- generated type 更新。

禁止：

- 直接改历史 migration（除非尚未应用并由 DS确认）；
- 仅建表不建 RLS；
- 用 service role 测试代替 anon/authenticated RLS 测试；
- 未定义幂等约束即实现过账。

## 5. 公共文件所有权

以下文件默认只由 Foundation Agent 修改：

```text
apps/maoxianqiu/src/settings.ts
apps/maoxianqiu/src/router/index.ts
apps/maoxianqiu/src/api/index.ts
api/index.ts
api/middlewares/*
apps/maoxianqiu/src/components/business/*
```

领域 Agent 需要修改时先提交契约请求。

## 6. 并发组合

安全组合：

```text
UI Foundation + API Foundation + DB Tenant
CRM UI + CRM API（契约已冻结）
Catalog UI + Catalog API
Billing UI + Inventory RPC（接口已冻结）
```

不安全组合：

```text
两个 Agent 同时修改同一个 migration
两个 Agent 同时重构 packages/components
UI 与 API 各自发明字段
多个 Agent 同时清理 router modules
```

## 7. 契约冻结

领域开工前先合并契约 PR，至少包含：

- TypeScript input/output；
- endpoint；
- HTTP 状态；
- 错误码；
- 权限码；
- 状态转换；
- 表/RPC 名称。

契约变化必须同时更新 UI、API 和文档。

## 8. 联调检查

- tenant/store header/context 一致；
- URL 参数和 Query 参数一致；
- 时间统一 ISO 8601；
- 金额不用浮点；
- enum 与状态 map 一致；
- 409 可被 UI 正确展示；
- 422 fieldErrors 可映射表单；
- request ID 可复制；
- idempotency key 可重试。

## 9. DS 合并顺序

```text
契约
→ migration/RLS
→ generated types
→ API
→ UI
→ integration tests
→ Preview
```

## 10. 子 Agent 回报格式

```text
完成：
未完成：
修改文件：
migration：
API：
UI：
测试：
风险：
需要 DS 决策：
```

只报告“已完成页面”但没有真实 API、权限和测试，不得验收。
