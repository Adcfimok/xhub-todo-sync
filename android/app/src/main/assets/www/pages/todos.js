import { colRecords, touch, onChange } from '../lib/core.js'
import { h, emptyBlock, fmtDue, dayDiff } from '../lib/ui.js'
import { openTodoForm } from '../lib/todoform.js'

export const meta = { title: '待办', route: 'todos' }

let filter = 'todo'
let off = null
let rootEl = null

const GROUPS = ['逾期', '今天', '明天', '本周', '以后', '无日期']

function groupOf(r) {
  if (!r.dueAt) return '无日期'
  const d = dayDiff(r.dueAt)
  if (d < 0) return '逾期'
  if (d === 0) return '今天'
  if (d === 1) return '明天'
  if (d < 7) return '本周'
  return '以后'
}

function filtered() {
  const live = colRecords('todos')
  if (filter === 'done') return live.filter((r) => r.done)
  const todo = live.filter((r) => !r.done)
  if (filter === 'today') return todo.filter((r) => r.dueAt && dayDiff(r.dueAt) <= 0)
  return todo
}

export function mount(root) {
  rootEl = root
  render()
  off = onChange(render)
  return () => off && off()
}

function render() {
  if (!rootEl) return
  const all = colRecords('todos')
  rootEl.innerHTML = ''

  const bar = h('div', { class: 'filterbar' }, [
    chip('todo', '待办', all.filter((r) => !r.done).length),
    chip('today', '今天', all.filter((r) => !r.done && r.dueAt && dayDiff(r.dueAt) <= 0).length),
    chip('done', '已完成', all.filter((r) => r.done).length),
  ])
  rootEl.appendChild(bar)

  const scroll = h('div', { class: 'scroll' })
  rootEl.appendChild(scroll)

  const rows = filtered()
  if (!rows.length) {
    scroll.appendChild(emptyBlock(filter === 'done' ? '还没有完成的待办' : '还没有待办', '点底部中间的 + 新建一条，离线也能用'))
    return
  }

  const buckets = {}
  rows.forEach((r) => {
    const g = r.done ? '已完成' : groupOf(r)
    ;(buckets[g] = buckets[g] || []).push(r)
  })

  const order = filter === 'done' ? ['已完成'] : GROUPS
  order.forEach((name) => {
    const list = buckets[name]
    if (!list || !list.length) return
    list.sort((a, b) => (a.dueAt || Infinity) - (b.dueAt || Infinity))
    const g = h('section', { class: 'group' })
    g.appendChild(h('h2', null, [name, h('span', { class: 'n', text: String(list.length) })]))
    list.forEach((r) => g.appendChild(todoNode(r)))
    scroll.appendChild(g)
  })
  scroll.appendChild(h('div', { class: 'list-pad' }))
}

function chip(id, label, n) {
  return h(
    'button',
    {
      class: 'chip' + (filter === id ? ' on' : ''),
      type: 'button',
      onclick: () => {
        filter = id
        render()
      },
    },
    [label, h('b', { text: String(n) })]
  )
}

function todoNode(r) {
  const box = h('div', {
    class: 'box',
    role: 'checkbox',
    'aria-checked': r.done ? 'true' : 'false',
    onclick: (ev) => {
      ev.stopPropagation()
      toggle(r)
    },
  })
  const m = h('div', { class: 'm' })
  if (r.dueAt) {
    const late = !r.done && r.dueAt < Date.now()
    m.appendChild(h('span', { class: late ? 'late' : '', text: fmtDue(r.dueAt) }))
  }
  if (r.priority > 0) m.appendChild(h('span', { class: 'pri', text: r.priority === 2 ? '紧急' : '重要' }))
  if (r.dirty) m.appendChild(h('span', { class: 'pend', text: '待同步' }))
  if (r.repeatMode && r.repeatMode !== 'once') m.appendChild(h('span', { text: '周期' }))

  const body = h('div', { class: 'body' }, [
    h('div', { class: 't', text: r.title || '（未命名）' }),
    m.childNodes.length ? m : null,
    r.description ? h('div', { class: 'desc', text: r.description }) : null,
  ])

  return h(
    'div',
    {
      class: 'todo',
      'data-done': r.done ? '1' : '0',
      // 优先级用左侧竖条表达（样式里 ::before），高度仍由内容决定
      'data-pri': String(r.priority || 0),
      onclick: () => openTodoForm(r),
    },
    [box, body]
  )
}

async function toggle(r) {
  await touch(r, { done: !r.done, completedAt: !r.done ? Date.now() : null })
}
