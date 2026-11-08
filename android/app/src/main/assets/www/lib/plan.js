/* 提醒调度的纯逻辑。
 *
 * 为什么单独拆出来：alerts.js 里牵着 DOM 弹窗、震动、原生桥，跑不进 Node，
 * 而「哪条该响 / 下次几点响 / 原生日志怎么对账」恰恰是最容易算错、也最该被单测盯住的部分。
 * 这里不碰 window / document / IndexedDB，只吃数据和 now。
 */

import { remindTimeOf } from './remind.js'

/** 回到前台时补发 15 分钟内错过的提醒 */
export const OVERDUE_GRACE = 15 * 60 * 1000
/** 关机 / 强停期间错过的（原生会标成 late），放宽到 12 小时内补发一次 */
export const LATE_WINDOW = 12 * 3600 * 1000
/** 下发给原生的计划上限，与 Reminders.MAX_PLAN 对齐 */
export const MAX_PLAN = 60
/** 最远排多久下的提醒；再远的等下次打开 App 自然会重新下发 */
export const PLAN_AHEAD = 180 * 86400000

function isOpenTodo(r) {
  return !!r && r.col === 'todos' && !r.deleted && !r.done
}

/**
 * 要交给系统闹钟的未来提醒（已排序、已截断）。
 * tag 是原生侧的去重键：一个待办一个 tag，改时间时旧的自动作废。
 * @param {Array<object>} records
 * @param {object} meta
 * @param {number} now
 * @returns {Array<{at:number, tag:string, kind:string, id:string}>}
 */
export function planItems(records, meta, now) {
  const items = []
  for (const r of records || []) {
    if (!isOpenTodo(r)) continue
    const at = remindTimeOf(r)
    if (!at || at <= now) continue
    if (at - now > PLAN_AHEAD) continue
    items.push({ at, tag: 'todo-' + r.id, kind: 'todo', id: r.id })
  }
  const s = meta && meta.pomState
  if (s && s.running && Number(s.endAt) > now) {
    items.push({ at: Number(s.endAt), tag: 'pomo', kind: 'pomo', id: 'pomo' })
  }
  items.sort((a, b) => a.at - b.at)
  return items.slice(0, MAX_PLAN)
}

/**
 * 此刻应该真的响的提醒。
 *
 * 三条规则决定了「响不响」：
 * 1. 已经提醒过的不再响（notifiedMap 按 id@时刻 去重）
 * 2. 逾期超过 15 分钟的不再补响，除非原生标记过「关机期间错过」且还在 12 小时内
 * 3. 用户点了「稍后 10 分钟」的，在 snooze 到期前不响
 * @returns {Array<{record:object, at:number, key:string, late:boolean}>}
 */
export function dueNow(records, now, opt) {
  const o = opt || {}
  const notified = o.notified || {}
  const snooze = o.snooze || {}
  const missed = o.missed || null
  const out = []
  for (const r of records || []) {
    if (!isOpenTodo(r)) continue
    const at = remindTimeOf(r)
    if (!at || at > now) continue
    const key = r.id + '@' + at
    const late = now - at > OVERDUE_GRACE
    if (late && !(missed && missed.has(key) && now - at <= LATE_WINDOW)) continue
    if (notified[key]) continue
    if (snooze[key] && snooze[key] > now) continue
    out.push({ record: r, at, key, late })
  }
  return out
}

/**
 * 下一条提醒的时刻（含番茄钟），没有则 0。
 * 页面用它精确 setTimeout，避免固定轮询带来的最多 30 秒延迟。
 */
export function nextDueAt(records, meta, now) {
  let next = 0
  for (const r of records || []) {
    if (!isOpenTodo(r)) continue
    const at = remindTimeOf(r)
    if (!at || at <= now) continue
    if (!next || at < next) next = at
  }
  const s = meta && meta.pomState
  const endAt = s && s.running ? Number(s.endAt) || 0 : 0
  if (endAt > now && (!next || endAt < next)) next = endAt
  return next
}

/**
 * 原生日志对账：
 * - late=false → 原生已经弹过通知，写进 notifiedMap，页面别再弹一次
 * - late=true  → 关机 / 强停期间错过，交给 dueNow 在 12 小时内补发
 * @param {Array<{tag:string, at:number, ts:number, late:boolean}>} events
 */
export function readAlarmEvents(events) {
  const fired = []
  const missed = []
  for (const ev of events || []) {
    if (!ev) continue
    const tag = String(ev.tag || '')
    const at = Number(ev.at) || 0
    if (!tag || !at) continue
    // 只认待办：「pomo」「selftest」由各自的流程处理，混进来会污染 notifiedMap
    if (tag.indexOf('todo-') !== 0) continue
    const key = tag.slice(5) + '@' + at
    if (ev.late) {
      missed.push(key)
      continue
    }
    fired.push({ key, ts: Number(ev.ts) || at })
  }
  return { fired, missed }
}

/** 只保留最近 MAX_FIRED 条已提醒记录，避免 meta 无限膨胀 */
export function trimFired(fired, max) {
  const keys = Object.keys(fired || {})
  const limit = max || 200
  if (keys.length <= limit) return fired
  keys.sort((a, b) => fired[a] - fired[b])
  const out = Object.assign({}, fired)
  keys.slice(0, keys.length - limit).forEach((k) => delete out[k])
  return out
}
