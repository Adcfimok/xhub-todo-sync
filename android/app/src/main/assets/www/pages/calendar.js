import { colRecords, touch, onChange } from '../lib/core.js'
import { h, startOfDay, fmtClock, fmtDateInput } from '../lib/ui.js'
import { aggregate, monthMatrix, cellNode, WEEK_HEAD } from '../lib/cal.js'
import { openTodoForm } from '../lib/todoform.js'
import { setQuickAdd } from '../lib/quickadd.js'

export const meta = { title: '日历', route: 'calendar' }

let rootEl = null
let off = null
let pending = null
let viewY = 0
let viewM = 0
let selMs = 0

/** 由首页卡片指定进入时聚焦的日期（同一模块实例，直接传值最省事） */
export function focus(ms) {
  pending = Number(ms) || Date.now()
}

export function mount(root) {
  rootEl = root
  const base = pending || Date.now()
  pending = null
  selMs = startOfDay(base)
  // 中央 + 按当前选中日建待办（原先靠右下角 FAB）
  setQuickAdd(() => addOn(selMs))
  const d = new Date(base)
  viewY = d.getFullYear()
  viewM = d.getMonth()
  render()
  off = onChange(render)
  return () => off && off()
}

function render() {
  if (!rootEl) return
  rootEl.innerHTML = ''

  const todos = colRecords('todos')
  const agg = aggregate(todos)
  const cells = monthMatrix(viewY, viewM)
  const todayMs = startOfDay(Date.now())
  const monthTotal = cells.reduce((n, c) => n + (c.inMonth && agg.get(c.key) ? agg.get(c.key).total : 0), 0)
  const noDate = todos.filter((t) => !t.dueAt && !t.done).length

  const scroll = h('div', { class: 'scroll' })
  rootEl.appendChild(scroll)

  // ---- 月份切换 ----
  scroll.appendChild(
    h('div', { class: 'cal-head' }, [
      h('button', { class: 'cal-nav', type: 'button', text: '‹', 'aria-label': '上个月', onclick: () => shift(-1) }),
      h('b', { text: viewY + ' 年 ' + (viewM + 1) + ' 月' }),
      h('button', { class: 'cal-nav', type: 'button', text: '›', 'aria-label': '下个月', onclick: () => shift(1) }),
      h('button', { class: 'mini', type: 'button', text: '今天', onclick: goToday }),
    ])
  )

  // ---- 月历表格 ----
  const wrap = h('div', { class: 'cal-wrap' })
  wrap.appendChild(h('div', { class: 'cal-wk' }, WEEK_HEAD.map((w) => h('span', { text: w }))))
  const grid = h('div', { class: 'cal-cells' })
  cells.forEach((c) =>
    grid.appendChild(
      cellNode(c, agg, {
        todayMs,
        selMs,
        onclick: () => pick(c.ms, c.inMonth),
      })
    )
  )
  wrap.appendChild(grid)
  scroll.appendChild(wrap)

  // ---- 选中日的待办 ----
  const dayTodos = todos
    .filter((t) => t.dueAt && startOfDay(t.dueAt) === selMs)
    .sort((a, b) => (a.done ? 1 : 0) - (b.done ? 1 : 0) || a.dueAt - b.dueAt)

  const d = new Date(selMs)
  const group = h('section', { class: 'group cal-day' })
  group.appendChild(
    h('h2', null, [
      d.getMonth() + 1 + ' 月 ' + d.getDate() + ' 日 · 周' + '日一二三四五六'[d.getDay()],
      dayTodos.length ? h('span', { class: 'n', text: dayTodos.length + ' 件' }) : null,
      h('button', { class: 'mini right', type: 'button', text: '+ 新建', onclick: () => addOn(selMs) }),
    ])
  )
  if (dayTodos.length) dayTodos.forEach((t) => group.appendChild(todoRow(t)))
  else {
    group.appendChild(h('p', { class: 'muted', text: '这一天没有安排' }))
    // 整月都空时补一句上手提示，别再单开一个空态块（两句话说的是同一件事）
    if (monthTotal === 0) {
      group.appendChild(h('p', { class: 'hint-line', text: '本月还没有排期，点右下角 + 新建会带上这一天' }))
    }
  }
  scroll.appendChild(group)

  // 不给「无日期」留死角：它们不在任何格子里，得有个去处
  if (noDate) {
    scroll.appendChild(
      h('button', { class: 'cal-nodate', type: 'button', onclick: () => go('todos') }, [
        h('span', { text: '另有 ' + noDate + ' 条待办没有日期' }),
        h('span', { class: 'go', text: '去待办 ›' }),
      ])
    )
  }

  scroll.appendChild(h('div', { class: 'list-pad' }))
}

function todoRow(t) {
  const box = h('div', {
    class: 'box',
    role: 'checkbox',
    'aria-checked': t.done ? 'true' : 'false',
    onclick: (e) => {
      e.stopPropagation()
      touch(t, { done: !t.done, completedAt: !t.done ? Date.now() : null })
    },
  })

  const m = h('span', { class: 'mini-m', text: fmtClock(t.dueAt) })
  if (t.priority > 0) m.appendChild(h('i', { class: 'cal-pri', text: t.priority === 2 ? '紧急' : '重要' }))
  if (t.dirty) m.appendChild(h('i', { class: 'cal-pri pend', text: '待同步' }))

  return h('div', { class: 'mini-row' + (t.done ? ' done' : ''), onclick: () => openTodoForm(t) }, [
    box,
    h('span', { class: 'mini-t', text: t.title || '（未命名）' }),
    m,
  ])
}

function pick(ms, inMonth) {
  selMs = ms
  if (!inMonth) {
    const d = new Date(ms)
    viewY = d.getFullYear()
    viewM = d.getMonth()
  }
  render()
}

function shift(delta) {
  let m = viewM + delta
  let y = viewY
  if (m < 0) {
    m = 11
    y--
  } else if (m > 11) {
    m = 0
    y++
  }
  viewY = y
  viewM = m
  // 选中日跟着换月：同一天号，月末不足则取当月最后一天，避免选中日跑到视图外
  const keepDay = new Date(selMs).getDate()
  const dim = new Date(y, m + 1, 0).getDate()
  selMs = new Date(y, m, Math.min(keepDay, dim)).getTime()
  render()
}

function goToday() {
  const now = new Date()
  viewY = now.getFullYear()
  viewM = now.getMonth()
  selMs = startOfDay(Date.now())
  render()
}

function addOn(ms) {
  openTodoForm(null, { date: fmtDateInput(ms) })
}

function go(route) {
  location.hash = '#/' + route
}
