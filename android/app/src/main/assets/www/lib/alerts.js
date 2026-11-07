/* 全局提醒调度：待办提醒 + 番茄钟结束。
   三层一起用，缺一层就会出现「锁屏不响 / 后台不响 / 前台只弹个通知看不清」：
   1) 应用内弹窗：前台时盖在最上层，可直接完成或稍后提醒
   2) 系统通知 + 震动：切到别的应用时也能看到
   3) 原生闹钟（AlarmManager）：JS 定时器在息屏/后台会被冻结，靠系统闹钟兜底
*/

import { S, saveMeta, onChange, touch } from './core.js'
import { notify, vibrate, setAlarms, cancelAlarms, hasAlarms } from './native.js'
import { fmtDue, h, toast } from './ui.js'
import { pomoCfg, durOf, fmtMinutes } from './pomo.js'
import { remindTimeOf } from './remind.js'

const OVERDUE_GRACE = 15 * 60 * 1000 // 回到前台时补发 15 分钟内错过的提醒
const TICK = 30 * 1000
const MAX_FIRED = 200
const SNOOZE_MS = 10 * 60 * 1000

let started = false
let finishing = false
let soon = null
let overlay = null

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
    soon = setTimeout(() => {
      sweep()
      scheduleAlarms()
    }, 2500)
  })
  scheduleAlarms()
}

// 提醒时刻的规则见 lib/remind.js（纯函数，可单测）；这里重新导出，供页面复用
export { remindTimeOf }

function sweep() {
  try {
    checkTodos()
  } catch (e) {
    /* 提醒失败不该影响主流程 */
  }
  checkPomodoro()
}

/** 待办提醒：每个 (id + 提醒时刻) 只提醒一次；稍后提醒单独记在 snooze 里 */
function checkTodos() {
  if (S.meta.notifyTodo === '0') return
  const now = Date.now()
  const fired = Object.assign({}, S.meta.notifiedMap || {})
  const snooze = Object.assign({}, S.meta.remindSnooze || {})
  let changed = false
  let snoozeChanged = false

  for (const r of S.records) {
    if (r.col !== 'todos' || r.deleted || r.done) continue
    const at = remindTimeOf(r)
    if (!at) continue
    if (at > now) continue
    if (now - at > OVERDUE_GRACE) continue
    const key = r.id + '@' + at
    if (fired[key]) continue
    if (snooze[key] && snooze[key] > now) continue

    fireTodo(r, at)
    fired[key] = now
    changed = true
    if (snooze[key]) {
      delete snooze[key]
      snoozeChanged = true
    }
  }

  if (changed) {
    const keys = Object.keys(fired)
    if (keys.length > MAX_FIRED) {
      keys.sort((a, b) => fired[a] - fired[b])
      keys.slice(0, keys.length - MAX_FIRED).forEach((k) => delete fired[k])
    }
    saveMeta('notifiedMap', fired)
  }
  if (snoozeChanged) saveMeta('remindSnooze', snooze)
}

function fireTodo(r, at) {
  const lead = Number(r.remindLead)
  const when = fmtDue(at)
  const detail = r.dueAt ? (lead > 0 ? '截止 ' + fmtDue(r.dueAt) : '现在到期') : '提醒时间到'
  notify('待办提醒 · ' + (r.title || '未命名'), detail + '（' + when + '）')
  vibrate(260)
  showRemind({
    kind: 'todo',
    title: r.title || '未命名待办',
    sub: detail + ' · ' + when,
    actions: [
      { text: '稍后 10 分钟', onClick: () => snoozeTodo(r, at) },
      { text: '标记完成', primary: true, onClick: () => touch(r, { done: true, completedAt: Date.now() }) },
    ],
  })
}

function snoozeTodo(r, at) {
  const key = r.id + '@' + at
  const snooze = Object.assign({}, S.meta.remindSnooze || {})
  snooze[key] = Date.now() + SNOOZE_MS
  // 从已提醒里摘掉，否则到点会被 fired 挡住
  const fired = Object.assign({}, S.meta.notifiedMap || {})
  delete fired[key]
  saveMeta('remindSnooze', snooze)
  saveMeta('notifiedMap', fired)
  scheduleAlarms()
  toast('已稍后 10 分钟提醒')
}

// ---------------------------------------------------------------- 番茄钟

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
  const cfg = pomoCfg()
  const total = durOf(next)
  const justDone = wasFocus ? cfg.focusMin : cfg.breakMin

  notify(wasFocus ? '专注结束' : '休息结束', wasFocus ? fmtMinutes(justDone) + '完成，起来活动一下' : '休息结束，继续下一个番茄')
  vibrate(wasFocus ? 520 : 260)
  showRemind({
    kind: 'pomo',
    title: wasFocus ? '专注结束' : '休息结束',
    sub: wasFocus ? '完成 ' + fmtMinutes(justDone) + '，休息 ' + fmtMinutes(cfg.breakMin) : '下一段专注 ' + fmtMinutes(cfg.focusMin),
    actions: [
      { text: '稍后', onClick: () => {} },
      { text: wasFocus ? '开始休息' : '开始专注', primary: true, onClick: () => startPomodoro(next) },
    ],
  })

  const nextState = {
    mode: next,
    running: false,
    endAt: 0,
    left: total,
    done: (Number(s.done) || 0) + (wasFocus ? 1 : 0),
  }
  return saveMeta('pomState', nextState).then(() => {
    finishing = false
    scheduleAlarms()
  })
}

function startPomodoro(mode) {
  const total = durOf(mode)
  saveMeta('pomState', {
    mode,
    running: true,
    endAt: Date.now() + total * 1000,
    left: total,
    done: Number((S.meta.pomState || {}).done) || 0,
  }).then(() => {
    scheduleAlarms()
    toast(mode === 'break' ? '休息开始' : '专注开始')
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

// ---------------------------------------------------------------- 应用内弹窗

/**
 * 前台提醒弹窗。一次只显示一条，后来的排队（最多保留 3 条），
 * 避免批量建了 3 条待办时三层面板叠在一起。
 */
const queue = []

function showRemind(opt) {
  if (document.hidden) return // 后台只发通知，回来时 sweep 会补弹
  queue.push(opt)
  if (queue.length > 3) queue.shift()
  if (!overlay) nextRemind()
}

function nextRemind() {
  const opt = queue.shift()
  if (!opt) {
    overlay = null
    return
  }
  const box = h('div', { class: 'remind-card' }, [
    h('div', { class: 'remind-k', text: opt.kind === 'pomo' ? '番茄钟' : '待办提醒' }),
    h('div', { class: 'remind-t', text: opt.title }),
    h('div', { class: 'remind-s', text: opt.sub }),
    h(
      'div',
      { class: 'remind-btns' },
      (opt.actions || []).map((a) =>
        h('button', {
          class: 'btn' + (a.primary ? ' primary' : ''),
          type: 'button',
          text: a.text,
          onclick: () => {
            close()
            try {
              a.onClick()
            } catch (e) {
              /* 动作失败不影响关窗 */
            }
          },
        })
      )
    ),
  ])
  const mask = h('div', { class: 'remind-mask' })
  mask.appendChild(box)
  document.body.appendChild(mask)
  overlay = mask
  vibrate(120)

  function close() {
    mask.remove()
    if (overlay === mask) overlay = null
    // 下一条稍微错开，避免同一帧里连弹
    setTimeout(nextRemind, 180)
  }
  mask.addEventListener('click', (e) => {
    if (e.target === mask) close()
  })
}

export function closeRemind() {
  if (overlay) overlay.remove()
  overlay = null
  queue.length = 0
}

// ---------------------------------------------------------------- 原生闹钟

/** 把未来最近的几条提醒交给系统，息屏也能响 */
export function scheduleAlarms() {
  if (!hasAlarms()) return
  const now = Date.now()
  const items = []

  for (const r of S.records) {
    if (r.col !== 'todos' || r.deleted || r.done) continue
    const at = remindTimeOf(r)
    if (!at || at <= now) continue
    if (at - now > 30 * 86400000) continue
    items.push({ at, title: '待办提醒 · ' + (r.title || '未命名'), body: r.dueAt ? '截止 ' + fmtDue(r.dueAt) : '提醒时间到', tag: 'todo-' + r.id })
  }

  const s = S.meta.pomState
  if (s && s.running && s.endAt > now) {
    items.push({
      at: Number(s.endAt),
      title: s.mode === 'break' ? '休息结束' : '专注结束',
      body: s.mode === 'break' ? '继续下一个番茄' : '起来活动一下',
      tag: 'pomo',
    })
  }

  items.sort((a, b) => a.at - b.at)
  const top = items.slice(0, 3)
  if (!top.length) {
    cancelAlarms()
    return
  }
  try {
    setAlarms(JSON.stringify(top))
  } catch (e) {
    /* 老版本没有这个桥，退回纯 JS 提醒 */
  }
}
