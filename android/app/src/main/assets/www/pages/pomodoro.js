import { S, saveMeta } from '../lib/core.js'
import { h, toast } from '../lib/ui.js'
import { finishPomodoro } from '../lib/alerts.js'

export const meta = { title: '番茄钟', route: 'pomodoro' }

const FOCUS = 25 * 60
const BREAK = 5 * 60
const R = 100
const CIRC = 2 * Math.PI * R

let rootEl = null
let timer = null

function dur(mode) {
  return mode === 'break' ? BREAK : FOCUS
}

function state() {
  const s = S.meta.pomState || {}
  const mode = s.mode === 'break' ? 'break' : 'focus'
  return {
    mode,
    running: !!s.running,
    endAt: Number(s.endAt) || 0,
    left: s.left == null ? dur(mode) : Number(s.left),
    done: Number(s.done) || 0,
  }
}

function remain(s) {
  if (s.running && s.endAt) return Math.max(0, Math.round((s.endAt - Date.now()) / 1000))
  return Math.max(0, s.left == null ? dur(s.mode) : s.left)
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
    const p = Math.max(0, Math.min(1, left / dur(s.mode)))
    arc.setAttribute('stroke-dashoffset', String(CIRC * (1 - p)))
  }
  const label = document.getElementById('pomo-label')
  if (label) label.textContent = s.running ? (s.mode === 'break' ? '休息中' : '专注中') : '已暂停'
}

function render() {
  if (!rootEl) return
  const s = state()
  const left = remain(s)
  const p = Math.max(0, Math.min(1, left / dur(s.mode)))
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
        await saveMeta('pomState', { mode: s.mode, running: false, endAt: 0, left: dur(s.mode), done: s.done })
        toast('已重置')
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
      text: '专注 25 分钟',
      onclick: () => switchMode('focus', s),
    }),
    h('button', {
      class: s.mode === 'break' ? 'on' : '',
      type: 'button',
      text: '休息 5 分钟',
      onclick: () => switchMode('break', s),
    }),
  ])
  scroll.appendChild(h('div', { class: 'card' }, [seg, h('p', { class: 'pomo-rounds', text: '已完成 ' + s.done + ' 个番茄' })]))

  scroll.appendChild(
    h('div', { class: 'card' }, [
      h('h2', { text: '说明' }),
      h('p', { class: 'muted', text: '到点会发系统通知并震动；切到别的页面也照样计时。手机锁屏或省电模式下，通知可能延迟到下次唤醒。' }),
    ])
  )
  scroll.appendChild(h('div', { class: 'list-pad' }))
  rootEl.appendChild(scroll)
}

async function toggle() {
  const s = state()
  if (s.running) {
    const left = remain(s)
    await saveMeta('pomState', { mode: s.mode, running: false, endAt: 0, left, done: s.done })
  } else {
    const left = s.left > 0 ? s.left : dur(s.mode)
    await saveMeta('pomState', { mode: s.mode, running: true, endAt: Date.now() + left * 1000, left, done: s.done })
  }
  render()
}

async function switchMode(mode, s) {
  if (mode === s.mode) return
  await saveMeta('pomState', { mode, running: false, endAt: 0, left: dur(mode), done: s.done })
  render()
}
