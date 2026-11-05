/* 全局提醒调度：待办临期 + 番茄钟结束。
   放在页面之外的定时器里，切到任何页面都能触发通知。 */

import { S, saveMeta, onChange } from './core.js'
import { notify, vibrate } from './native.js'
import { fmtDue } from './ui.js'

const SOON_MS = 15 * 60 * 1000 // 提前 15 分钟提醒
const OVERDUE_GRACE = 60 * 1000 // 过期 1 分钟内的也补一次
const TICK = 30 * 1000
const MAX_FIRED = 200

let started = false
let finishing = false
let soon = null

export function initAlerts() {
  if (started) return
  started = true
  setInterval(sweep, TICK)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) sweep()
  })
  // 首屏稍等一会儿再扫，避开 boot 尚未就绪
  setTimeout(sweep, 4000)
  // 新建/改期待办后尽快检查一次（防抖，避免同步抖动时反复扫）
  onChange(() => {
    clearTimeout(soon)
    soon = setTimeout(sweep, 2500)
  })
}

function sweep() {
  try {
    checkTodos()
  } catch (e) {
    /* 提醒失败不该影响主流程 */
  }
  checkPomodoro()
}

/** 待办临期：每条 (id + 截止时间) 只提醒一次 */
function checkTodos() {
  if (S.meta.notifyTodo === '0') return
  const now = Date.now()
  const fired = Object.assign({}, S.meta.notifiedMap || {})
  let changed = false

  for (const r of S.records) {
    if (r.col !== 'todos' || r.deleted || r.done || !r.dueAt) continue
    const delta = r.dueAt - now
    if (delta > SOON_MS) continue
    if (delta < -OVERDUE_GRACE) continue
    const key = r.id + '@' + r.dueAt
    if (fired[key]) continue

    notify('待办快到了', (r.title || '未命名') + ' · ' + fmtDue(r.dueAt))
    vibrate(140)
    fired[key] = now
    changed = true
  }

  if (changed) {
    const keys = Object.keys(fired)
    if (keys.length > MAX_FIRED) {
      keys.sort((a, b) => fired[a] - fired[b])
      keys.slice(0, keys.length - MAX_FIRED).forEach((k) => delete fired[k])
    }
    saveMeta('notifiedMap', fired)
  }
}

/**
 * 番茄钟到点：幂等（页面 tick 与全局 sweep 都可能先看到）。
 * @returns {Promise<void>}
 */
export function finishPomodoro() {
  if (finishing) return Promise.resolve()
  const s = S.meta.pomState
  if (!s || !s.running || !s.endAt) return Promise.resolve()

  finishing = true
  const wasFocus = s.mode !== 'break'
  const next = wasFocus ? 'break' : 'focus'
  const total = next === 'break' ? 5 * 60 : 25 * 60

  notify(wasFocus ? '专注结束' : '休息结束', wasFocus ? '25 分钟完成，起来活动一下' : '休息结束，继续下一个番茄')
  vibrate(wasFocus ? 420 : 200)

  const nextState = {
    mode: next,
    running: false,
    endAt: 0,
    left: total,
    done: (Number(s.done) || 0) + (wasFocus ? 1 : 0),
  }
  return saveMeta('pomState', nextState).then(() => {
    finishing = false
  })
}

function checkPomodoro() {
  const s = S.meta.pomState
  if (!s || !s.running || !s.endAt) return
  if (Date.now() < s.endAt) return
  finishPomodoro()
}

/** 供设置页或调试手动触发一次检查 */
export function sweepNow() {
  sweep()
}
