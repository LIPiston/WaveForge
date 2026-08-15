/**
 * 调音分享串编解码（源：原应用 "eq_export_button/eq_import_button" 导出导入功能
 * + fp.m 的 "freq:gain:q;..." 曲线串格式）
 *
 * 把当前 v3 设置中的可分享部分编码为紧凑字符串：
 *   v3|<scheme>|<eqMode>|<eqCurve>|<peq>|<model>|<ieqStyle>|<deviceProfileId>
 * 其中 eqCurve/peq 使用 fp 格式曲线串（与逆向存储格式一致），便于人工阅读与
 * 跨设备粘贴。解码时逐字段校验，任一字段非法则整体回退 null（不半途应用）。
 */

import { parseCurve, serializeCurve, type EqPoint } from './curve'
import { parseCurve as parsePeqCurve } from './curve'

export interface SharePayload {
  version: 3
  scheme: 'standard' | 'spatial'
  eqMode: string
  eqCurve: EqPoint[]
  peq: EqPoint[]
  modelCode: string | null
  deviceProfileId: string | null
  ieqStyle: number
}

/** 编码字段分隔符（不会出现在 fp 曲线串与型号代号中） */
const SEP = '|'
const EMPTY = '-'

/** 编码一个 fp 格式曲线串（空 → EMPTY） */
function encCurve(points: EqPoint[] | null | undefined): string {
  return points && points.length > 0 ? serializeCurve(points) : EMPTY
}

/** 解码曲线字段（EMPTY/非法 → null） */
function decCurve(field: string): EqPoint[] | null {
  if (!field || field === EMPTY) return null
  return parseCurve(field)
}

/** 导出分享串（当前设置 → 字符串） */
export function exportShareString(settings: {
  scheme: 'standard' | 'spatial'
  eqMode: string
  eqCurve: EqPoint[]
  peqBands: EqPoint[]
  modelCode: string | null
  deviceProfileId: string | null
  ieqStyle: number
}): string {
  return [
    'v3',
    settings.scheme,
    settings.eqMode,
    encCurve(settings.eqCurve),
    encCurve(settings.peqBands),
    settings.modelCode || EMPTY,
    settings.deviceProfileId || EMPTY,
    String(settings.ieqStyle),
  ].join(SEP)
}

/** 导入分享串（字符串 → 数据；非法整体返回 null） */
export function importShareString(raw: string): SharePayload | null {
  if (!raw || raw.length > 4096) return null
  const parts = raw.split(SEP)
  if (parts.length !== 8) return null
  const [version, scheme, eqMode, eqCurveField, peqField, modelCode, deviceProfileId, ieqStyleField] = parts
  if (version !== 'v3') return null
  if (scheme !== 'standard' && scheme !== 'spatial') return null
  if (!eqMode) return null
  const eqCurve = decCurve(eqCurveField)
  if (!eqCurve) return null
  const peq = decCurve(peqField)
  if (!peq) return null
  const ieqStyle = parseInt(ieqStyleField!, 10)
  if (Number.isNaN(ieqStyle) || ieqStyle < 0 || ieqStyle > 3) return null
  return {
    version: 3,
    scheme,
    eqMode,
    eqCurve,
    peq,
    modelCode: modelCode === EMPTY || !modelCode ? null : modelCode,
    deviceProfileId: deviceProfileId === EMPTY || !deviceProfileId ? null : deviceProfileId,
    ieqStyle,
  }
}

export function isShareString(raw: string | null | undefined): boolean {
  return !!raw && raw.startsWith('v3' + SEP) && raw.length <= 4096
}

export { parsePeqCurve }
