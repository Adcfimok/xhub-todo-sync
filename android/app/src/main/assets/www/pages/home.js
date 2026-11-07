import { S, colRecords, touch, onChange, saveMeta } from '../lib/core.js'
import { h, fmtDue, dayDiff, fmtAgo, startOfDay, toast, confirmAsync } from '../lib/ui.js'
import { aggregate, monthMatrix, cellNode, dayKey, WEEK_HEAD } from '../lib/cal.js'
import { focus as focusCalendar } from './calendar.js'
import { openExternal } from '../lib/platform.js'
import { dailyQuote, nextQuote, todaySeed, LOCAL_QUOTES } from '../lib/quotes.js'
import {
  GRID_COLS,
  CARD_DEFS,
  cardDef,
  loadLayout,
  defaultLayout,
  normalizeLayout,
  placeCard,
  addCard,
  removeCard,
  missingCards,
  EXT_COLLECTIONS,
} from '../lib/homeLayout.js'
import { holidaysInRange, daysFromToday, fmtYmd } from '../lib/holidays.js'

export const meta = { title: '首页', route: 'home' }

let rootEl = null
let off = null
let clockTimer = null
let editing = false
let layout = null
let drag = null

export function mount(root) {
  rootEl = root
  layout = loadLayout(S.meta.homeLayout)
  render()
  off = onChange(render)
  startClock()
  return () => {
    if (off) off()
    stopClock()
  }
}

// ---------------------------------------------------------------- 秒级时钟

/**
 * 对齐到整秒边界再触发，避免 setTimeout(1000) 的相位漂移越走越慢。
 * 只改文本节点，不触发整页 render —— 否则每秒重建一次首页，滚动位置都会丢。
 */
function startClock() {
  stopClock()
  const tick = () => {
    const el = document.getElementById('home-clock')
    if (el) el.textContent = hhmmss(new Date())
    const dateEl = document.getElementById('home-date')
    if (dateEl) dateEl.textContent = dateText(new Date())
    // 问好与时间同一行，跨过 6/11/14/18 点就该跟着变，不能等下次整页渲染
    const greetEl = document.getElementById('home-greet')
    if (greetEl) greetEl.textContent = greeting()
    clockTimer = setTimeout(tick, 1005 - (Date.now() % 1000))
  }
  tick()
}

function stopClock() {
  if (clockTimer) clearTimeout(clockTimer)
  clockTimer = null
}

function hhmmss(d) {
  return (
    String(d.getHours()).padStart(2, '0') +
    ':' +
    String(d.getMinutes()).padStart(2, '0') +
    ':' +
    String(d.getSeconds()).padStart(2, '0')
  )
}

function dateText(d) {
  return d.getFullYear() + ' 年 ' + (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日 · 周' + '日一二三四五六'[d.getDay()]
}

// ---------------------------------------------------------------- 渲染

function render() {
  if (!rootEl) return
  // 编辑态下的重渲染会丢掉正在拖的手感，所以拖拽中直接跳过
  if (drag) return
  rootEl.innerHTML = ''
  const scroll = h('div', { class: 'scroll home-scroll' })
  rootEl.appendChild(scroll)

  const todos = colRecords('todos')
  const openTodos = todos.filter((t) => !t.deleted && !t.done)
  const today = openTodos.filter((t) => t.dueAt && dayDiff(t.dueAt) <= 0)

  scroll.appendChild(hero(openTodos, today))
  if (S.originSwitched) {
    scroll.appendChild(
      h('div', { class: 'banner warn' }, [
        h('b', { text: '本地存储分区已变化（端口 ' + (S.originPort || '?') + '）' }),
        h('div', { text: '旧版本的本地数据不会自动出现在这里。如果之前配对过电脑，到「我的 → 同步与设置」重新配对一次即可同步回来。' }),
      ])
    )
  }
  const dirty = S.records.filter((r) => r.dirty).length
  if (dirty > 0) scroll.appendChild(h('div', { class: 'banner', text: dirty + ' 条改动等待同步' }))

  // 工具栏放在网格之上：默认布局有 10 行，放下面要滚很久才看得到「卡片库」
  if (editing) scroll.appendChild(editBar())
  scroll.appendChild(gridNode())
  scroll.appendChild(h('div', { class: 'list-pad' }))
}

function hero(openTodos, today) {
  return h('div', { class: 'hero home-hero' }, [
    h('div', { class: 'hero-top' }, [
      h('div', { class: 'hero-d', id: 'home-date', text: dateText(new Date()) }),
      h('button', {
        class: 'mini hero-edit' + (editing ? ' on' : ''),
        type: 'button',
        text: editing ? '完成' : '编辑',
        onclick: () => {
          editing = !editing
          render()
        },
      }),
    ]),
    // 时间与问好同一行：大号时钟 + 小一号的问好，按基线对齐
    h('div', { class: 'hero-line' }, [
      h('div', { class: 'hero-time', id: 'home-clock', text: hhmmss(new Date()) }),
      h('div', { class: 'hero-t', id: 'home-greet', text: greeting() }),
    ]),
    h('div', {
      class: 'hero-s',
      text: openTodos.length
        ? '还有 ' + openTodos.length + ' 件待办，' + (today.length ? '今天到期 ' + today.length + ' 件' : '今天没有到期的')
        : '待办已清空',
    }),
  ])
}

// ---------------------------------------------------------------- 网格

function gridNode() {
  const g = h('div', { class: 'home-grid' + (editing ? ' editing' : '') })
  layout.items.forEach((item) => {
    const def = cardDef(item.id)
    if (!def) return
    const node = h('section', { class: 'hc', 'data-card': item.id }, [
      h('div', { class: 'hc-head' }, [
        editing
          ? h('button', { class: 'hc-drag', type: 'button', text: '⋮⋮', 'aria-label': '拖动' })
          : null,
        h('span', { class: 'hc-title', text: def.title }),
        def.route && !editing
          ? h('button', { class: 'mini hc-more', type: 'button', text: '全部', onclick: () => go(def.route) })
          : null,
        editing
          ? h('button', {
              class: 'hc-del',
              type: 'button',
              text: '×',
              'aria-label': '移除卡片',
              onclick: (e) => {
                e.stopPropagation()
                removeCardAndSave(item.id)
              },
            })
          : null,
      ]),
      h('div', { class: 'hc-body' }, renderCard(item.id)),
      editing ? h('span', { class: 'hc-resize', 'aria-label': '调整大小' }) : null,
    ])
    node.style.gridColumn = item.x + 1 + ' / span ' + item.w
    node.style.gridRow = item.y + 1 + ' / span ' + item.h
    if (editing) {
      const handle = node.querySelector('.hc-drag')
      if (handle) bindDrag(handle, item, 'move')
      const rz = node.querySelector('.hc-resize')
      if (rz) bindDrag(rz, item, 'resize')
    }
    g.appendChild(node)
  })
  // 空网格也要有高度，否则「卡片库」按钮会跳到顶部
  if (!layout.items.length) {
    g.appendChild(h('div', { class: 'hc-empty', text: '卡片都收起来了。点下方「卡片库」加回来。' }))
  }
  return g
}

function editBar() {
  return h('div', { class: 'editbar' }, [
    h('span', { class: 'editbar-hint', text: '拖 ⋮⋮ 移动，拖右下角改大小' }),
    h('button', { class: 'btn mini', type: 'button', text: '卡片库', onclick: () => openLibrary() }),
    h('button', {
      class: 'btn mini',
      type: 'button',
      text: '恢复默认',
      onclick: async () => {
        if (!(await confirmAsync('把首页布局恢复成默认排序？', '恢复'))) return
        layout = defaultLayout()
        await saveMeta('homeLayout', layout)
        render()
        toast('已恢复默认布局')
      },
    }),
  ])
}

// ---------------------------------------------------------------- 拖拽 / 缩放

function bindDrag(handle, item, mode) {
  handle.addEventListener('pointerdown', (e) => {
    if (e.button != null && e.button !== 0) return
    const grid = document.querySelector('.home-grid')
    if (!grid) return
    const rect = grid.getBoundingClientRect()
    const gap = parseFloat(getComputedStyle(grid).columnGap) || 10
    const cellW = (rect.width - gap * (GRID_COLS - 1)) / GRID_COLS
    const rowH = parseFloat(getComputedStyle(grid).gridAutoRows) || 78
    drag = {
      item: Object.assign({}, item),
      mode,
      startX: e.clientX,
      startY: e.clientY,
      cellW: cellW + gap,
      cellH: rowH + gap,
      node: handle.closest('.hc'),
      moved: false,
    }
    try {
      handle.setPointerCapture(e.pointerId)
    } catch (err) {
      /* 老内核没有指针捕获，靠 document 监听兜底 */
    }
    e.preventDefault()
    e.stopPropagation()
  })
}

document.addEventListener(
  'pointermove',
  (e) => {
    if (!drag) return
    const dx = e.clientX - drag.startX
    const dy = e.clientY - drag.startY
    if (!drag.moved && Math.abs(dx) < 5 && Math.abs(dy) < 5) return
    drag.moved = true
    const dCols = Math.round(dx / drag.cellW)
    const dRows = Math.round(dy / drag.cellH)
    if (drag.mode === 'move') {
      const x = Math.max(0, Math.min(GRID_COLS - drag.item.w, drag.item.x + dCols))
      const y = Math.max(0, drag.item.y + dRows)
      drag.preview = { x, y, w: drag.item.w, h: drag.item.h }
    } else {
      const w = Math.max(1, Math.min(GRID_COLS - drag.item.x, drag.item.w + dCols))
      const h = Math.max(1, drag.item.h + dRows)
      drag.preview = { x: drag.item.x, y: drag.item.y, w, h }
    }
    if (drag.node) {
      drag.node.style.gridColumn = drag.preview.x + 1 + ' / span ' + drag.preview.w
      drag.node.style.gridRow = drag.preview.y + 1 + ' / span ' + drag.preview.h
    }
    if (e.cancelable) e.preventDefault()
  },
  { passive: false }
)

function endDrag() {
  if (!drag) return
  const d = drag
  drag = null
  if (d.moved && d.preview) {
    layout = placeCard(layout, d.item.id, d.preview)
    saveMeta('homeLayout', layout)
  }
  render()
}

document.addEventListener('pointerup', endDrag)
document.addEventListener('pointercancel', endDrag)

// ---------------------------------------------------------------- 卡片库

function openLibrary() {
  const mask = h('div', { class: 'lib-mask' })
  const placed = {}
  layout.items.forEach((i) => (placed[i.id] = 1))
  const list = h('div', { class: 'lib-list' })
  CARD_DEFS.forEach((d) => {
    const on = !!placed[d.id]
    list.appendChild(
      h('div', { class: 'lib-row' }, [
        h('div', { class: 'lib-main' }, [
          h('div', { class: 'lib-t' }, [
            d.title,
            EXT_COLLECTIONS.indexOf(d.id) >= 0 ? h('span', { class: 'lib-tag', text: '来自扩展' }) : null,
          ]),
          h('div', { class: 'lib-d', text: d.desc }),
        ]),
        h('button', {
          class: 'btn mini' + (on ? '' : ' primary'),
          type: 'button',
          text: on ? '移除' : '添加',
          onclick: async () => {
            layout = on ? removeCard(layout, d.id) : addCard(layout, d.id)
            await saveMeta('homeLayout', layout)
            close()
            render()
            toast(on ? '已移除「' + d.title + '」' : '已添加「' + d.title + '」')
          },
        }),
      ])
    )
  })
  const box = h('div', { class: 'lib-card' }, [
    h('div', { class: 'lib-head' }, [h('b', { text: '卡片库' }), h('button', { class: 'mini', type: 'button', text: '关闭', onclick: () => close() })]),
    h('p', { class: 'lib-hint', text: '扩展同步的五个集合都能单独作为卡片放到首页。' }),
    list,
  ])
  mask.appendChild(box)
  document.body.appendChild(mask)
  mask.addEventListener('click', (e) => {
    if (e.target === mask) close()
  })
  function close() {
    mask.remove()
  }
}

async function removeCardAndSave(id) {
  layout = removeCard(layout, id)
  await saveMeta('homeLayout', layout)
  render()
  const def = cardDef(id)
  toast('已移除「' + (def ? def.title : id) + '」，可在卡片库加回来')
}

// ---------------------------------------------------------------- 各张卡片

function renderCard(id) {
  switch (id) {
    case 'quote':
      return cardQuote()
    case 'stats':
      return cardStats()
    case 'calendar':
      return cardCalendar()
    case 'today':
      return cardToday()
    case 'todos':
      return cardTodos()
    case 'notes':
      return cardNotes()
    case 'stickies':
      return cardStickies()
    case 'resources':
      return cardResources()
    case 'snippets':
      return cardSnippets()
    case 'holidays':
      return cardHolidays()
    default:
      return h('p', { class: 'muted', text: '未知卡片' })
  }
}

function cardQuote() {
  const q = currentQuote()
  return h('div', { class: 'hc-quote-wrap' }, [
    h('button', {
      class: 'hc-quote',
      type: 'button',
      onclick: async () => {
        if (S.meta.quoteCustom) {
          toast('当前是自定义语录，可在下方「自定义」里清空')
          return
        }
        const nx = nextQuote(q.content, '')
        if (!nx) return
        await saveMeta('quotePick', { day: todaySeed(), content: nx.content })
        render()
      },
    }, [h('span', { class: 'hq-mark', text: '“' }), h('span', { class: 'hq-text', text: q.content })]),
    h('div', { class: 'hc-quote-foot' }, [
      h('span', { class: 'hc-quote-from', text: '—— ' + q.from }),
      h('button', { class: 'mini hq-edit', type: 'button', text: '自定义', onclick: () => editQuote() }),
    ]),
  ])
}

/** 自定义 > 当天的翻页选择 > 每日一句 */
function currentQuote() {
  const custom = S.meta.quoteCustom ? String(S.meta.quoteCustom).trim() : ''
  if (custom) return { content: custom, from: '自定义' }
  const pick = S.meta.quotePick
  if (pick && pick.day === todaySeed() && pick.content) {
    const hit = LOCAL_QUOTES.filter((x) => x.content === pick.content)[0]
    return { content: pick.content, from: hit ? hit.from : '格言' }
  }
  return dailyQuote(todaySeed(), '')
}

function editQuote() {
  const cur = (S.meta && S.meta.quoteCustom) || ''
  const mask = h('div', { class: 'lib-mask' })
  const input = h('input', { class: 'input', value: cur, placeholder: '留空则每天自动换一句' })
  const box = h('div', { class: 'lib-card' }, [
    h('div', { class: 'lib-head' }, [h('b', { text: '自定义语录' }), h('button', { class: 'mini', type: 'button', text: '取消', onclick: () => mask.remove() })]),
    h('p', { class: 'lib-hint', text: '设置后首页固定显示这句话；清空即恢复「每日一句」。' }),
    input,
    h('button', {
      class: 'btn primary block',
      type: 'button',
      text: '保存',
      onclick: async () => {
        await saveMeta('quoteCustom', input.value.trim())
        mask.remove()
        render()
        toast(input.value.trim() ? '已设为自定义语录' : '已恢复每日一句')
      },
    }),
  ])
  mask.appendChild(box)
  document.body.appendChild(mask)
}

function cardStats() {
  const notes = colRecords('notes').filter((x) => !x.deleted)
  const res = colRecords('resources').filter((x) => !x.deleted)
  const snips = colRecords('snippets').filter((x) => !x.deleted)
  const open = colRecords('todos').filter((t) => !t.deleted && !t.done)
  // 今天完成的数量：给统计卡一点「活着」的信息，也把 2 行高度填满
  const todayDone = colRecords('todos').filter((t) => !t.deleted && t.done && t.completedAt && dayDiff(t.completedAt) === 0).length
  const pending = S.records.filter((r) => r.dirty).length
  return h('div', { class: 'hc-stats' }, [
    h('div', { class: 'stat-grid' }, [
      stat('待办', open.length, 'todos'),
      stat('笔记', notes.length, 'notes'),
      stat('速达', res.length, 'resources'),
      stat('提示词', snips.length, 'snippets'),
    ]),
    h('div', {
      class: 'hc-hint',
      text: '今天完成 ' + todayDone + ' 件' + (pending ? ' · ' + pending + ' 条待同步' : ' · 已全部同步'),
    }),
  ])
}

function cardToday() {
  const todos = colRecords('todos').filter((t) => !t.deleted)
  const open = todos.filter((t) => !t.done)
  const today = open.filter((t) => t.dueAt && dayDiff(t.dueAt) <= 0)
  return listBlock(today.length ? today.slice(0, 4) : open.slice(0, 3), (t) =>
    h('div', { class: 'mini-row', onclick: () => go('todos') }, [
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
    ]),
    open.length ? '' : '暂无待办'
  )
}

function cardTodos() {
  const open = colRecords('todos').filter((t) => !t.deleted && !t.done)
  return h('div', null, [
    listBlock(open.slice(0, 5), (t) =>
      h('div', { class: 'mini-row', onclick: () => go('todos') }, [
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
      ]),
      '待办清空了'
    ),
    h('button', { class: 'mini block-more', type: 'button', text: '去待办页', onclick: () => go('todos') }),
  ])
}

function cardNotes() {
  const notes = colRecords('notes')
    .filter((x) => !x.deleted)
    .slice()
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  return h('div', null, [
    listBlock(notes.slice(0, 4), (n) =>
      h('div', { class: 'mini-row', onclick: () => go('notes') }, [
        h('span', { class: 'mini-t', text: n.title || '无标题笔记' }),
        h('span', { class: 'mini-m', text: fmtAgo(n.updatedAt) }),
      ]),
      '还没有笔记'
    ),
    h('button', { class: 'mini block-more', type: 'button', text: '全部笔记', onclick: () => go('notes') }),
  ])
}

function cardStickies() {
  const list = colRecords('stickies')
    .filter((x) => !x.deleted)
    .sort((a, b) => (a.slot || 0) - (b.slot || 0))
  if (!list.length) return h('p', { class: 'muted', text: '电脑上还没有便签' })
  return h(
    'div',
    null,
    list.slice(0, 2).map((s) => h('div', { class: 'sticky-prev', text: (s.content || '（空）').slice(0, 120) }))
  )
}

function cardResources() {
  const res = colRecords('resources').filter((x) => !x.deleted)
  if (!res.length) return h('p', { class: 'muted', text: '还没有速达项' })
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
  return grid
}

function cardSnippets() {
  const list = colRecords('snippets').filter((x) => !x.deleted)
  if (!list.length) return h('p', { class: 'muted', text: '还没有提示词' })
  return h(
    'div',
    null,
    list.slice(0, 4).map((s) =>
      h('div', { class: 'mini-row', onclick: () => go('snippets') }, [
        h('span', { class: 'mini-t', text: s.title || '未命名' }),
        h('span', { class: 'mini-m', text: '复制' }),
      ])
    )
  )
}

function cardHolidays() {
  const now = new Date()
  const list = holidaysInRange(now.getFullYear(), 2)
    .filter((x) => x.date >= Date.now() - 86400000)
    .slice(0, 4)
  if (!list.length) return h('p', { class: 'muted', text: '近期没有节日' })
  return h('div', null, [
    ...list.map((x) =>
      h('div', { class: 'mini-row', onclick: () => go('holidays') }, [
        h('span', { class: 'mini-t', text: x.name }),
        h('span', { class: 'mini-m', text: fmtYmd(x.date) + ' · ' + countdown(x.date) }),
      ])
    ),
    h('button', { class: 'mini block-more', type: 'button', text: '全部节日', onclick: () => go('holidays') }),
  ])
}

function countdown(ms) {
  const d = daysFromToday(ms)
  if (d === 0) return '今天'
  if (d === 1) return '明天'
  return d + ' 天后'
}

/** 首页日历卡片：整张卡是入口，点某天带着那天进日历页 */
function cardCalendar() {
  const todos = colRecords('todos')
  const now = new Date()
  const agg = aggregate(todos)
  const cells = monthMatrix(now.getFullYear(), now.getMonth())
  const todayMs = startOfDay(Date.now())
  const grid = h('div', { class: 'cal-cells' })
  cells.forEach((c) => grid.appendChild(cellNode(c, agg, { todayMs })))
  return h(
    'div',
    {
      class: 'cal-card',
      role: 'button',
      tabindex: '0',
      onclick: (e) => {
        const cell = e.target && e.target.closest ? e.target.closest('[data-ms]') : null
        focusCalendar(cell ? Number(cell.getAttribute('data-ms')) : Date.now())
        go('calendar')
      },
    },
    [h('div', { class: 'cal-wk' }, WEEK_HEAD.map((w) => h('span', { text: w }))), grid]
  )
}

function listBlock(rows, rowFn, emptyText) {
  if (!rows.length) return h('p', { class: 'muted', text: emptyText })
  return h('div', { class: 'mini-list' }, rows.map(rowFn))
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

function go(route) {
  location.hash = '#/' + route
}
