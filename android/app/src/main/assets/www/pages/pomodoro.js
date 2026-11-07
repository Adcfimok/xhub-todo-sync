import { S, saveMeta } from '../lib/core.js'
import { h, toast, openForm, confirmAsync } from '../lib/ui.js'
import { finishPomodoro, scheduleAlarms } from '../lib/alerts.js'
import { pomoCfg, durOf, savePomoCfg, fmtMinutes, LIMITS } from '../lib/pomo.js'

export const meta = { title: '番茄钟', route: 'pomodoro' }

const R = 100
const CIRC = 2 * Math.PI * R

let rootEl = null
let timer = null

function state() {
  const s = S.meta.pomState || {}
  const mode = s.mode === 'break' ? 'break' : 'focus'
  return {
    mode,
    running: !!s.running,
    endAt: Number(s.endAt) || 0,
    left: s.left == null ? durOf(mode) : Number(s.left),
    done: Number(s.done) || 0,
  }
}

function remain(s) {
  if (s.running && s.endAt) return Math.max(0, Math.round((s.endAt - Date.now()) / 1000))
  return Math.max(0, s.left == null ? durOf(s.mode) : s.left)
}

function mmss(sec) {
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0')
}

export function mount(root) {
  rootEl = root
  render()
  timer = setInterval(tick, 250)
  return () => {
    clearInterval(timer)
    timer = null
  }
}

function tick() {
  const s = state()
  if (s.running && s.endAt && Date.now() >= s.endAt) {
    finishPomodoro().then(() => render())
    return
  }
  const left = remain(s)
  const clock = document.getElementById('pomo-clock')
  if (clock) clock.textContent = mmss(left)
  const arc = document.getElementById('pomo-arc')
  if (arc) {
    const p = Math.max(0, Math.min(1, left / durOf(s.mode)))
    arc.setAttribute('stroke-dashoffset', String(CIRC * (1 - p)))
  }
  const label = document.getElementById('pomo-label')
  if (label) label.textContent = s.running ? (s.mode === 'break' ? '休息中' : '专注中') : '已暂停'
}

function render() {
  if (!rootEl) return
  const s = state()
  const cfg = pomoCfg()
  const left = remain(s)
  const p = Math.max(0, Math.min(1, left / durOf(s.mode)))
  rootEl.innerHTML = ''

  const scroll = h('div', { class: 'scroll' })

  const ring = h('div', { class: 'pomo-ring' })
  ring.innerHTML =
    '<svg viewBox="0 0 236 236" width="236" height="236">' +
    '<circle cx="118" cy="118" r="' + R + '" fill="none" stroke="var(--line)" stroke-width="10"/>' +
    '<circle id="pomo-arc" cx="118" cy="118" r="' + R + '" fill="none" stroke="var(--accent)" stroke-width="10" ' +
    'stroke-linecap="round" stroke-dasharray="' + CIRC.toFixed(1) + '" stroke-dashoffset="' + (CIRC * (1 - p)).toFixed(1) + '"/>' +
    '</svg>'
  ring.appendChild(
    h('div', { class: 'pomo-time' }, [
      h('div', { class: 'pomo-clock', id: 'pomo-clock', text: mmss(left) }),
      h('div', { class: 'pomo-label', id: 'pomo-label', text: s.running ? (s.mode === 'break' ? '休息中' : '专注中') : '已暂停' }),
    ])
  )

  const actions = h('div', { class: 'pomo-actions' }, [
    h('button', {
      class: 'btn primary',
      type: 'button',
      text: s.running ? '暂停' : left === 0 ? '重新开始' : '开始',
      onclick: () => toggle(),
    }),
    h('button', {
      class: 'btn',
      type: 'button',
      text: '重置',
      onclick: async () => {
        await saveMeta('pomState', { mode: s.mode, running: false, endAt: 0, left: durOf(s.mode), done: s.done })
        toast('已重置')
        scheduleAlarms()
        render()
      },
    }),
  ])

  scroll.appendChild(
    h('div', { class: 'card' }, [h('h2', { text: '番茄钟' }), h('div', { class: 'pomo-wrap' }, [ring, actions])])
  )

  const seg = h('div', { class: 'seg' }, [
    h('button', {
      class: s.mode === 'focus' ? 'on' : '',
      type: 'button',
      text: '专注 ' + fmtMinutes(cfg.focusMin),
      onclick: () => switchMode('focus', s),
    }),
    h('button', {
      class: s.mode === 'break' ? 'on' : '',
      type: 'button',
      text: '休息 ' + fmtMinutes(cfg.breakMin),
      onclick: () => switchMode('break', s),
    }),
  ])
  scroll.appendChild(
    h('div', { class: 'card' }, [
      seg,
      h('p', { class: 'pomo-rounds', text: '已完成 ' + s.done + ' 个番茄' }),
      h('button', {
        class: 'btn block',
        type: 'button',
        text: '自定义时长',
        onclick: () => editDurations(s),
      }),
    ])
  )

  scroll.appendChild(
    h('div', { class: 'card' }, [
      h('h2', { text: '说明' }),
      h('p', {
        class: 'muted',
        text:
          '专注 ' + fmtMinutes(cfg.focusMin) + '、休息 ' + fmtMinutes(cfg.breakMin) + '。' +
          '到点会发系统通知、震动并弹窗；切到别的应用或息屏时由系统闹钟兜底提醒。',
      }),
    ])
  )
  scroll.appendChild(h('div', { class: 'list-pad' }))
  rootEl.appendChild(scroll)
}

/** 自定义专注/休息时长；正在计时时问清楚「重新计时还是下一轮生效」 */
async function editDurations(s) {
  const cfg = pomoCfg()
  openForm({
    title: '自定义时长',
    focus: false,
    fields: [
      { key: 'focusMin', label: '专注（分钟，1–180）', type: 'number' },
      { key: 'breakMin', label: '休息（分钟，1–60）', type: 'number' },
    ],
    values: { focusMin: String(cfg.focusMin), breakMin: String(cfg.breakMin) },
    async onSave(v) {
      const next = { focusMin: Number(v.focusMin), breakMin: Number(v.breakMin) }
      if (!Number.isFinite(next.focusMin) || !Number.isFinite(next.breakMin)) return toast('请填写数字')
      if (next.focusMin < LIMITS.focusMin[0] || next.focusMin > LIMITS.focusMin[1]) return toast('专注需在 1–180 分钟')
      if (next.breakMin < LIMITS.breakMin[0] || next.breakMin > LIMITS.breakMin[1]) return toast('休息需在 1–60 分钟')

      const saved = await savePomoCfg(next)
      const cur = state()
      const total = saved.focusMin * 60
      const breakTotal = saved.breakMin * 60

      if (cur.running) {
        const restart = await confirmAsync('正在计时，是否按新时长重新开始？', '重新开始')
        if (restart) {
          await saveMeta('pomState', { mode: cur.mode, running: false, endAt: 0, left: cur.mode === 'break' ? breakTotal : total, done: cur.done })
          toast('已按新时长重置')
        } else {
          // 保留当前这一轮，只把下一轮的时长换掉
          toast('当前这一轮保持原时长，下一轮生效')
        }
      } else {
        await saveMeta('pomState', { mode: cur.mode, running: false, endAt: 0, left: cur.mode === 'break' ? breakTotal : total, done: cur.done })
        toast('已保存：专注 ' + fmtMinutes(saved.focusMin) + ' · 休息 ' + fmtMinutes(saved.breakMin))
      }
      scheduleAlarms()
      render()
    },
  })
}

async function toggle() {
  const s = state()
  if (s.running) {
    const left = remain(s)
    await saveMeta('pomState', { mode: s.mode, running: false, endAt: 0, left, done: s.done })
  } else {
    const left = s.left > 0 ? s.left : durOf(s.mode)
    await saveMeta('pomState', { mode: s.mode, running: true, endAt: Date.now() + left * 1000, left, done: s.done })
  }
  scheduleAlarms()
  render()
}

async function switchMode(mode, s) {
  if (mode === s.mode) return
  await saveMeta('pomState', { mode, running: false, endAt: 0, left: durOf(mode), done: s.done })
  scheduleAlarms()
  render()
}
