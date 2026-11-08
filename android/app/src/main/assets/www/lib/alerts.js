/* 全局提醒调度：待办提醒 + 番茄钟结束。
   三层一起用，缺一层就会出现「锁屏不响 / 后台不响 / 前台只弹个通知看不清」：
   1) 应用内弹窗：前台时盖在最上层，可直接完成或稍后提醒
   2) 系统通知 + 震动：切到别的应用时也能看到
   3) 原生闹钟（AlarmManager）：JS 定时器在息屏/后台会被冻结，靠系统闹钟兜底
*/

import { S, saveMeta, onChange, touch } from './core.js'
import { notify, vibrate, setAlarms, cancelAlarms, hasAlarms, takeAlarmEvents } from './native.js'
import { fmtDue, h, toast } from './ui.js'
import { pomoCfg, durOf, fmtMinutes } from './pomo.js'
import { remindTimeOf } from './remind.js'
import { planItems, dueNow, nextDueAt, readAlarmEvents, trimFired } from './plan.js'

const TICK = 30 * 1000
const MAX_FIRED = 200
const SNOOZE_MS = 10 * 60 * 1000

let started = false
let finishing = false
let soon = null
let overlay = null
let tickTimer = 0
/** 原生标记为「错过了」的提醒键：id@at，允许突破常规逾期宽限补发一次 */
const missed = new Set()

export function initAlerts() {
  if (started) return
  started = true
  reconcile()
  setInterval(sweep, TICK)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      // 切走前把最新计划钉进系统：之后再也不会被 WebView 冻结影响
      scheduleAlarms()
      return
    }
    // 回到前台：先对账（后台期间可能是原生替我们发的通知），再补扫，再重排
    reconcile()
    sweep()
    scheduleAlarms()
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

/**
 * 和原生的「已响 / 错过」事件对账。
 *
 * App 没打开时提醒是原生发的，但页面里的 notifiedMap 并不知道，
 * 不对账的话用户一打开 App 就会被同一条提醒再弹一次（重复提醒）。
 */
function reconcile() {
  const events = takeAlarmEvents()
  if (!events.length) return
  const { fired, missed: late } = readAlarmEvents(events)
  const map = Object.assign({}, S.meta.notifiedMap || {})
  let changed = false
  for (const ev of fired) {
    if (map[ev.key]) continue
    map[ev.key] = ev.ts
    changed = true
  }
  // 关机 / 强停期间错过的：不写 notifiedMap，交给 sweep 在 12 小时内补发
  late.forEach((k) => missed.add(k))
  if (changed) saveMeta('notifiedMap', map)
}

/**
 * 按「下一条到点时刻」精确唤醒一次。
 *
 * 固定 30 秒轮询意味着最坏情况要晚 30 秒才响；这里直接算到下一个提醒时刻，
 * 到点就触发（上限 60 秒兜底，避免长时间挂一个超时被系统清掉）。
 * 后台 / 息屏时 JS 定时器仍会冻结，那条路由原生闹钟负责。
 */
function armTick() {
  clearTimeout(tickTimer)
  const now = Date.now()
  const next = nextDueAt(S.records, S.meta, now)
  const wait = next ? Math.min(Math.max(next - now + 120, 300), 60000) : TICK
  tickTimer = setTimeout(() => {
    sweep()
    armTick()
  }, wait)
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
  armTick()
}

/** 待办提醒：每个 (id + 提醒时刻) 只提醒一次；稍后提醒单独记在 snooze 里 */
function checkTodos() {
  if (S.meta.notifyTodo === '0') return
  const now = Date.now()
  const fired = Object.assign({}, S.meta.notifiedMap || {})
  const snooze = Object.assign({}, S.meta.remindSnooze || {})
  let changed = false
  let snoozeChanged = false

  const due = dueNow(S.records, now, { notified: fired, snooze, missed })
  for (const item of due) {
    fireTodo(item.record, item.at, item.late)
    fired[item.key] = now
    changed = true
    missed.delete(item.key)
    if (snooze[item.key]) {
      delete snooze[item.key]
      snoozeChanged = true
    }
  }

  if (changed) saveMeta('notifiedMap', trimFired(fired, MAX_FIRED))
  if (snoozeChanged) saveMeta('remindSnooze', snooze)
}

function fireTodo(r, at, late) {
  const lead = Number(r.remindLead)
  const when = fmtDue(at)
  const detail = r.dueAt ? (lead > 0 ? '截止 ' + fmtDue(r.dueAt) : '现在到期') : '提醒时间到'
  const tag = late ? '补发 · ' : ''
  notify('待办提醒 · ' + (r.title || '未命名'), tag + detail + '（' + when + '）')
  vibrate(260)
  showRemind({
    kind: 'todo',
    title: r.title || '未命名待办',
    sub: tag + detail + ' · ' + when,
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

/**
 * 把「完整」提醒计划交给系统。
 *
 * 以前这里只下发最近 3 条，且响过之后不再补排，于是第 4 条起就再也不响、
 * 3 条都响过之后更是全静音——这是「App 没打开就收不到提醒」的根因。
 * 现在下发全量（上限 MAX_PLAN），到点由 AlarmReceiver 摘一条、补一条。
 */
export function scheduleAlarms() {
  if (!hasAlarms()) return
  // 用户在设置里关掉提醒后，必须把已排的闹钟撤掉，否则开关形同虚设
  if (S.meta.notifyTodo === '0') {
    cancelAlarms()
    return
  }
  const now = Date.now()
  const byId = new Map()
  for (const r of S.records) byId.set(r.id, r)

  const plan = planItems(S.records, S.meta, now).map((it) => {
    if (it.kind === 'pomo') {
      const mode = (S.meta.pomState || {}).mode
      return {
        at: it.at,
        tag: it.tag,
        title: mode === 'break' ? '休息结束' : '专注结束',
        body: mode === 'break' ? '继续下一个番茄' : '起来活动一下',
      }
    }
    const r = byId.get(it.id) || {}
    return {
      at: it.at,
      tag: it.tag,
      title: '待办提醒 · ' + (r.title || '未命名'),
      body: r.dueAt ? '截止 ' + fmtDue(r.dueAt) : '提醒时间到',
    }
  })

  if (!plan.length) {
    cancelAlarms()
    return
  }
  try {
    setAlarms(JSON.stringify(plan))
  } catch (e) {
    /* 老版本没有这个桥，退回纯 JS 提醒 */
  }
}
