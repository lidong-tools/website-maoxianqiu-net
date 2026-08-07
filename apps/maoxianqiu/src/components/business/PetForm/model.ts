/**
 * PetForm 数据模型(AUD-004)
 * 独立于 .vue 文件,供 PetForm 组件与 PetCreateDrawer 共享,
 * 避免在 <script setup> 中直接 export(违反 vue/no-export-in-script-setup)。
 */

/** 宠物表单数据模型 */
export interface PetFormModel {
  name: string
  species: string
  breed: string
  gender: 'male' | 'female' | 'unknown'
  birthDate: string
  weight: number | undefined
  isNeutered: boolean
  microchip: string
  color: string
  riskTags: string
  temperament: string
  medicalNotes: string
}

/** 创建默认空表单 */
export function createEmptyPetForm(): PetFormModel {
  return {
    name: '',
    species: 'dog',
    breed: '',
    gender: 'unknown',
    birthDate: '',
    weight: undefined,
    isNeutered: false,
    microchip: '',
    color: '',
    riskTags: '',
    temperament: '',
    medicalNotes: '',
  }
}
