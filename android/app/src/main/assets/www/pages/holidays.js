import { colRecords, newRecord, touch, onChange } from '../lib/core.js'
import { h, toast } from '../lib/ui.js'
import { CATS, holidaysInRange, daysFromToday, fmtFull, fmtYmd } from '../lib/holidays.js'
import { setQuickAdd } from '../lib/quickadd.js'

export const meta = { title: '节日', route: 'holidays' }

let rootEl = null
let off = null
let cat = 'all'

export function mount(root) {
  rootEl = root
  setQuickAdd(null)
  render()
  off = onChange(render)
  return () => off && off()
}

/** 未来 13 个月，足够覆盖一整年与跨年的农历节日 */
function upcoming() {
  const now = new Date()
  const list = holidaysInRange(now.getFullYear(), 2)
  const from = Date.now() - 7 * 86400000
  return list.filter((x) => x.date >= from).slice(0, 140)
}

function render() {
  if (!rootEl) return
  rootEl.innerHTML = ''
  const all = upcoming()
  const list = cat === 'all' ? all : all.filter((x) => x.cat === cat)

  rootEl.appendChild(
    h('div', { class: 'filterbar' }, [
      chip('all', '全部', all.length),
      ...CATS.map((c) => chip(c.id, c.name, all.filter((x) => x.cat === c.id).length)),
    ])
  )

  const scroll = h('div', { class: 'scroll' })
  rootEl.appendChild(scroll)

  if (!list.length) {
    scroll.appendChild(h('p', { class: 'muted', text: '近一年内没有可展示的节日' }))
    scroll.appendChild(h('div', { class: 'list-pad' }))
    return
  }

  // 按自然月分组：节日列表的价值在于「这个月还有哪些日子要准备」
  const groups = []
  let cur = ''
  list.forEach((x) => {
    const d = new Date(x.date)
    const key = d.getFullYear() + '-' + (d.getMonth() + 1)
    if (key !== cur) {
      cur = key
      groups.push({ label: d.getFullYear() + ' 年 ' + (d.getMonth() + 1) + ' 月', items: [] })
    }
    groups[groups.length - 1].items.push(x)
  })

  groups.forEach((g) => {
    const sec = h('section', { class: 'group' })
    sec.appendChild(h('h2', null, [g.label, h('span', { class: 'n', text: String(g.items.length) })]))
    g.items.forEach((x) => sec.appendChild(row(x)))
    scroll.appendChild(sec)
  })

  scroll.appendChild(h('p', { class: 'hint-line', text: '节气按世纪常数公式推算，个别年份可能与日历差 1 天。添加的待办会默认提前 1 天提醒。' }))
  scroll.appendChild(h('div', { class: 'list-pad' }))
  rootEl.appendChild(scroll)
}

function chip(id, label, n) {
  return h('button', { class: 'chip' + (cat === id ? ' on' : ''), type: 'button', onclick: () => { cat = id; render() } }, [
    label,
    h('b', { text: String(n) }),
  ])
}

const CAT_TAG = { cn: '传统', term: '节气', intl: '外国' }

function row(x) {
  const left = daysFromToday(x.date)
  const when = left === 0 ? '今天' : left === 1 ? '明天' : left < 0 ? '已过' : left + ' 天后'
  const btn = h('button', { class: 'mini add-h', type: 'button', text: '＋ 待办' })
  btn.addEventListener('click', () => addTodo(x, btn))

  return h('div', { class: 'holiday-row' }, [
    h('div', { class: 'hd-date' }, [h('b', { text: fmtYmd(x.date) }), h('span', { text: '周' + '日一二三四五六'[new Date(x.date).getDay()] })]),
    h('div', { class: 'hd-main' }, [
      h('div', { class: 'hd-name' }, [x.name, h('span', { class: 'hd-tag', text: CAT_TAG[x.cat] || '' })]),
      h('div', { class: 'hd-note', text: (x.note || '') + (x.note ? ' · ' : '') + when }),
    ]),
    btn,
  ])
}

/** 一键建待办：同一天同一节日只建一条，重复点给出明确提示而不是静默堆叠 */
async function addTodo(x, btn) {
  const due = new Date(x.date)
  due.setHours(9, 0, 0, 0)
  const dueAt = due.getTime()

  const dup = colRecords('todos').filter(
    (t) => !t.deleted && t.title && t.title.indexOf(x.name) >= 0 && t.dueAt && Math.abs(t.dueAt - dueAt) < 86400000
  )[0]
  if (dup) {
    toast('这一天已有「' + x.name + '」的待办')
    return
  }

  if (btn) {
    btn.disabled = true
    btn.textContent = '已添加'
  }
  await touch(
    newRecord('todos', {
      title: x.name,
      dueAt,
      // 节日提前一天提醒，早上 9 点到期
      remindLead: 1440,
      remindAt: dueAt - 86400000,
      priority: 0,
      description: fmtFull(x.date) + ' · ' + (x.note || ''),
    })
  )
  toast('已加入待办：' + x.name + ' · ' + fmtYmd(dueAt))
}
