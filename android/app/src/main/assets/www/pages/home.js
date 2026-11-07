import { S, colRecords, touch, onChange } from '../lib/core.js'
import { h, fmtDue, dayDiff, fmtAgo, startOfDay, toast } from '../lib/ui.js'
import { aggregate, monthMatrix, cellNode, dayKey, WEEK_HEAD } from '../lib/cal.js'
import { focus as focusCalendar } from './calendar.js'
import { openExternal } from '../lib/platform.js'

export const meta = { title: '首页', route: 'home' }

let rootEl = null
let off = null

export function mount(root) {
  rootEl = root
  render()
  off = onChange(render)
  return () => off && off()
}

function render() {
  if (!rootEl) return
  rootEl.innerHTML = ''
  const scroll = h('div', { class: 'scroll' })
  rootEl.appendChild(scroll)

  const todos = colRecords('todos')
  const openTodos = todos.filter((t) => !t.done)
  const today = openTodos.filter((t) => t.dueAt && dayDiff(t.dueAt) <= 0)
  const notes = colRecords('notes').slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  const stickies = colRecords('stickies').sort((a, b) => (a.slot || 0) - (b.slot || 0))
  const res = colRecords('resources')
  const snips = colRecords('snippets')
  const dirty = S.records.filter((r) => r.dirty).length

  const now = new Date()
  scroll.appendChild(
    h('div', { class: 'hero' }, [
      h('div', { class: 'hero-d', text: now.getMonth() + 1 + ' 月 ' + now.getDate() + ' 日 · 周' + '日一二三四五六'[now.getDay()] }),
      h('div', { class: 'hero-t', text: greeting() }),
      h('div', { class: 'hero-s', text: openTodos.length ? '还有 ' + openTodos.length + ' 件待办，' + (today.length ? '今天到期 ' + today.length + ' 件' : '今天没有到期的') : '待办已清空' }),
    ])
  )

  scroll.appendChild(
    h('div', { class: 'stat-grid' }, [
      stat('待办', openTodos.length, 'todos'),
      stat('笔记', notes.length, 'notes'),
      stat('速达', res.length, 'resources'),
      stat('提示词', snips.length, 'snippets'),
    ])
  )

  if (S.originSwitched) {
    scroll.appendChild(
      h('div', { class: 'banner warn' }, [
        h('b', { text: '本地存储分区已变化（端口 ' + (S.originPort || '?') + '）' }),
        h('div', { text: '旧版本的本地数据不会自动出现在这里。如果之前配对过电脑，到「我的 → 同步与设置」重新配对一次即可同步回来。' }),
      ])
    )
  }

  if (dirty > 0) {
    scroll.appendChild(h('div', { class: 'banner', text: dirty + ' 条改动等待同步' }))
  }

  // 日历卡片：整张卡是入口，点具体某天就跳到那一天
  scroll.appendChild(calendarCard(todos))

  // 今日待办
  scroll.appendChild(section('今天', 'todos', today.length ? today.slice(0, 4) : openTodos.slice(0, 3), (t) =>
    h('div', { class: 'mini-row' }, [
      h('div', {
        class: 'box',
        role: 'checkbox',
        onclick: (e) => {
          e.stopPropagation()
          touch(t, { done: true, completedAt: Date.now() })
        },
      }),
      h('span', { class: 'mini-t', text: t.title || '（未命名）' }),
      h('span', { class: 'mini-m', text: t.dueAt ? fmtDue(t.dueAt) : '' }),
    ])
  , openTodos.length ? '' : '暂无'))

  // 便签
  if (stickies.length) {
    scroll.appendChild(
      h('div', { class: 'card' }, [
        h('h2', null, ['便签', h('button', { class: 'mini right', type: 'button', text: '编辑', onclick: () => go('stickies') })]),
        ...stickies.slice(0, 2).map((s) =>
          h('div', { class: 'sticky-prev', text: (s.content || '（空）').slice(0, 120) })
        ),
      ])
    )
  }

  // 最近笔记（笔记已移出底栏，这里的每一行和「全部」都是入口）
  scroll.appendChild(section('最近笔记', 'notes', notes.slice(0, 3), (n) =>
    h('div', { class: 'mini-row', onclick: () => go('notes') }, [
      h('span', { class: 'mini-t', text: n.title || '无标题笔记' }),
      h('span', { class: 'mini-m', text: fmtAgo(n.updatedAt) }),
    ])
  , '还没有笔记'))

  // 速达
  if (res.length) {
    const grid = h('div', { class: 'quick-grid' })
    res.slice(0, 6).forEach((r) => {
      grid.appendChild(
        h('button', {
          class: 'quick',
          type: 'button',
          text: r.name || '未命名',
          onclick: () => {
            if (r.kind === 'web' && /^https?:\/\//i.test(r.target || '')) openExternal(r.target).catch(() => toast('无法打开浏览器，请手动复制链接'))
            else toast('这类条目只能在电脑上打开')
          },
        })
      )
    })
    scroll.appendChild(h('div', { class: 'card' }, [h('h2', { text: '速达' }), grid]))
  }

  scroll.appendChild(h('div', { class: 'list-pad' }))
}

/**
 * 首页日历卡片：本月缩略月历 + 当天/本月计数。
 * 整张卡是入口；点某个日期格则带着那一天进日历页。
 */
function calendarCard(todos) {
  const now = new Date()
  const agg = aggregate(todos)
  const cells = monthMatrix(now.getFullYear(), now.getMonth())
  const todayMs = startOfDay(Date.now())
  const todayAgg = agg.get(dayKey(todayMs)) || { total: 0, open: 0 }
  const monthTotal = cells.reduce((n, c) => n + (c.inMonth && agg.get(c.key) ? agg.get(c.key).total : 0), 0)
  const openMonth = cells.reduce((n, c) => n + (c.inMonth && agg.get(c.key) ? agg.get(c.key).open : 0), 0)

  const grid = h('div', { class: 'cal-cells' })
  cells.forEach((c) => grid.appendChild(cellNode(c, agg, { todayMs })))

  const sum = (todayAgg.open ? '今天 ' + todayAgg.open + ' 件未完成' : '今天没有到期') + ' · 本月 ' + monthTotal + ' 件'

  return h(
    'div',
    {
      class: 'card cal-card',
      role: 'button',
      tabindex: '0',
      onclick: (e) => {
        const cell = e.target && e.target.closest ? e.target.closest('[data-ms]') : null
        focusCalendar(cell ? Number(cell.getAttribute('data-ms')) : Date.now())
        go('calendar')
      },
    },
    [
      h('h2', null, [
        '日历',
        h('span', { class: 'cal-sum', text: sum }),
        h('span', { class: 'mini right', text: '查看' }),
      ]),
      h('div', { class: 'cal-wk' }, WEEK_HEAD.map((w) => h('span', { text: w }))),
      grid,
      openMonth === 0 ? h('div', { class: 'cal-hint', text: '本月还没有安排，点任意一天开始' }) : null,
    ]
  )
}

function greeting() {
  const hh = new Date().getHours()
  if (hh < 6) return '夜深了'
  if (hh < 11) return '早上好'
  if (hh < 14) return '中午好'
  if (hh < 18) return '下午好'
  return '晚上好'
}

function stat(label, n, route) {
  return h('button', { class: 'stat', type: 'button', onclick: () => go(route) }, [
    h('b', { text: String(n) }),
    h('span', { text: label }),
  ])
}

function section(title, route, list, rowFn, emptyText) {
  return h('div', { class: 'card' }, [
    h('h2', null, [title, h('button', { class: 'mini right', type: 'button', text: '全部', onclick: () => go(route) })]),
    list.length ? h('div', { class: 'mini-list' }, list.map(rowFn)) : h('p', { class: 'muted', text: emptyText }),
  ])
}

function go(route) {
  location.hash = '#/' + route
}
