/**
 * S32-B 医疗运营(clinical)
 *
 * 口径(S32-B 规格 §7 + KPI-DEFINITIONS.md):
 *   - 预约数 = scheduled_start 在周期内的预约(appointments)总数(含取消);
 *   - 到店率 = 到店预约(checked_in/in_progress/completed) ÷ (预约数 − 取消数);
 *   - No-show = 状态为 no_show 的预约数;
 *   - 接诊数 = started_at 在周期内的就诊(encounters)数;
 *   - 完成病历 = signed_at 在周期内且 status='signed' 的就诊数;
 *   - 检验单量 = requested_at 在周期内的检验单(lab_orders)数;
 *   - 影像单量 = created_at 在周期内的影像单(imaging_orders)数;
 *   - 住院量 = admitted_at 在周期内的住院入院(admissions)数。
 *
 * 不做医疗质量评分/医生排名(避免错误激励)。
 */
import type { ServiceClient } from './common'
import { dayKeyInTz } from './common'
import type { ClinicalDailyRow, ClinicalReport, RevenueFilters } from './types'

const SHOW_UP_STATUSES = ['checked_in', 'in_progress', 'completed']
const CANCELLED_STATUS = 'cancelled'

interface AppointmentRow {
  scheduled_start: string
  status: string
}

interface EncounterRow {
  started_at: string
  signed_at: string | null
}

export async function buildClinicalReport(
  service: ServiceClient,
  f: RevenueFilters,
): Promise<ClinicalReport> {
  const [apptRes, encRes, labRes, imgRes, admRes] = await Promise.all([
    service.from('appointments')
      .select('scheduled_start, status')
      .eq('tenant_id', f.tenantId)
      .in('store_id', f.storeIds)
      .gte('scheduled_start', f.period.startISO)
      .lte('scheduled_start', f.period.endISO),
    service.from('encounters')
      .select('started_at, signed_at')
      .eq('tenant_id', f.tenantId)
      .in('store_id', f.storeIds)
      .gte('started_at', f.period.startISO)
      .lte('started_at', f.period.endISO),
    service.from('lab_orders')
      .select('requested_at')
      .eq('tenant_id', f.tenantId)
      .in('store_id', f.storeIds)
      .gte('requested_at', f.period.startISO)
      .lte('requested_at', f.period.endISO),
    service.from('imaging_orders')
      .select('created_at')
      .eq('tenant_id', f.tenantId)
      .in('store_id', f.storeIds)
      .gte('created_at', f.period.startISO)
      .lte('created_at', f.period.endISO),
    service.from('admissions')
      .select('admitted_at')
      .eq('tenant_id', f.tenantId)
      .in('store_id', f.storeIds)
      .gte('admitted_at', f.period.startISO)
      .lte('admitted_at', f.period.endISO),
  ])
  if (apptRes.error) {
    throw new Error(`预约数据查询失败: ${apptRes.error.message}`)
  }
  if (encRes.error) {
    throw new Error(`就诊数据查询失败: ${encRes.error.message}`)
  }
  if (labRes.error) {
    throw new Error(`检验单查询失败: ${labRes.error.message}`)
  }
  if (imgRes.error) {
    throw new Error(`影像单查询失败: ${imgRes.error.message}`)
  }
  if (admRes.error) {
    throw new Error(`住院数据查询失败: ${admRes.error.message}`)
  }

  const appointments = (apptRes.data as AppointmentRow[] | null) ?? []
  const encounters = (encRes.data as EncounterRow[] | null) ?? []
  const labCount = (labRes.data as unknown[] | null)?.length ?? 0
  const imagingCount = (imgRes.data as unknown[] | null)?.length ?? 0
  const admissionCount = (admRes.data as unknown[] | null)?.length ?? 0

  const totalAppointments = appointments.length
  const cancelled = appointments.filter(a => a.status === CANCELLED_STATUS).length
  const showUps = appointments.filter(a => SHOW_UP_STATUSES.includes(a.status)).length
  const noShows = appointments.filter(a => a.status === 'no_show').length
  const showUpRate = (totalAppointments - cancelled) > 0
    ? showUps / (totalAppointments - cancelled)
    : 0

  const encountersCount = encounters.length
  const signedCount = encounters.filter(e => !!e.signed_at && e.signed_at >= f.period.startISO && e.signed_at <= f.period.endISO).length

  // 每日趋势
  const tz = f.period.timezone
  const dailyMap = new Map<string, ClinicalDailyRow>()
  const touch = (date: string) => {
    if (!dailyMap.has(date)) {
      dailyMap.set(date, {
        date,
        appointments: 0,
        showUps: 0,
        noShows: 0,
        encounters: 0,
        signedEncounters: 0,
      })
    }
    return dailyMap.get(date)!
  }
  for (const a of appointments) {
    const r = touch(dayKeyInTz(a.scheduled_start, tz))
    r.appointments += 1
    if (SHOW_UP_STATUSES.includes(a.status)) {
      r.showUps += 1
    }
    if (a.status === 'no_show') {
      r.noShows += 1
    }
  }
  for (const e of encounters) {
    const r = touch(dayKeyInTz(e.started_at, tz))
    r.encounters += 1
    if (e.signed_at && e.signed_at >= f.period.startISO && e.signed_at <= f.period.endISO) {
      r.signedEncounters += 1
    }
  }
  const dailyRows = [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date))

  return {
    period: f.period,
    kpis: [
      {
        key: 'appointments',
        label: '预约数',
        value: totalAppointments,
        format: 'integer',
        definition: 'scheduled_start 在周期内的预约总数(含取消)。',
      },
      {
        key: 'showUpRate',
        label: '到店率',
        value: Math.round(showUpRate * 1000) / 10,
        format: 'percent',
        definition: '到店预约(checked_in/in_progress/completed) ÷ (预约数 − 取消数)。',
      },
      {
        key: 'noShow',
        label: 'No-show',
        value: noShows,
        format: 'integer',
        definition: '状态为 no_show 的预约数。',
      },
      {
        key: 'encounters',
        label: '接诊数',
        value: encountersCount,
        format: 'integer',
        definition: 'started_at 在周期内的就诊数。',
      },
      {
        key: 'signed',
        label: '完成病历',
        value: signedCount,
        format: 'integer',
        definition: 'signed_at 在周期内且已签署的病历数。',
      },
      {
        key: 'labOrders',
        label: '检验单量',
        value: labCount,
        format: 'integer',
        definition: 'requested_at 在周期内的检验单数。',
      },
      {
        key: 'imagingOrders',
        label: '影像单量',
        value: imagingCount,
        format: 'integer',
        definition: 'created_at 在周期内的影像单数。',
      },
      {
        key: 'admissions',
        label: '住院量',
        value: admissionCount,
        format: 'integer',
        definition: 'admitted_at 在周期内的住院入院数。',
      },
    ],
    dailyRows,
  }
}
