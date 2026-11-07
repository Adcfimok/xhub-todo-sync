/* 提醒时刻的解析规则：纯函数，单独放一个文件。
 *
 * 为什么要独立：这条规则同时被「全局提醒调度」和「待办行上的标记」使用，
 * 又要能被 Node 单测直接覆盖（alerts.js 依赖 IndexedDB，不能直接跑在 Node 里）。
 */

/** 老记录没有 remindLead 时，沿用历史的「提前 15 分钟」 */
export const DEFAULT_LEAD_MIN = 15

/**
 * 这条待办该在什么时刻提醒。
 * - remindLead === -1 → 明确关闭，返回 0
 * - remindAt 存在 → 优先用它（自定义时刻，或保存时算好的绝对时刻）
 * - 否则回落到 dueAt - 提前量（老记录用 15 分钟）
 * @param {object} r 待办记录
 * @returns {number} 毫秒时间戳；0 表示不提醒
 */
export function remindTimeOf(r) {
  if (!r) return 0
  if (Number(r.remindLead) === -1) return 0
  if (r.remindAt) return Number(r.remindAt) || 0
  if (!r.dueAt) return 0
  const raw = r.remindLead
  const lead = raw == null || raw === '' ? DEFAULT_LEAD_MIN : Number(raw)
  if (!Number.isFinite(lead)) return 0
  return Number(r.dueAt) - lead * 60000
}

/** 提醒标记的文案：提前 N 分钟 / 准时 / 自定义时刻 / 空字符串表示不显示 */
export function remindLabel(r, fmt) {
  if (!r || Number(r.remindLead) === -1) return ''
  if (r.remindLead == null) return r.remindAt ? (fmt ? fmt(r.remindAt) : '') : ''
  const lead = Number(r.remindLead)
  if (lead === 0) return '准时'
  if (lead < 60) return '提前' + lead + ' 分钟'
  if (lead < 1440) return '提前' + Math.round(lead / 60) + ' 小时'
  return '提前' + Math.round(lead / 1440) + ' 天'
}
