import { S, findRec, colRecords, newRecord, touch, softDelete, saveMeta } from '../lib/core.js'
import { h, toast, confirmAsync } from '../lib/ui.js'
import { writeClipboard } from '../lib/native.js'
import { holidaysInRange } from '../lib/holidays.js'

export const meta = { title: '我的', route: 'more' }

let rootEl = null
/** 批量写 40+ 条记录时挡住重复点击，避免并发插入 */
let busy = false
const BULK_KEY = 'holidayBulk'

const ITEMS = [
  // 笔记已从底栏移出，「我的」是它的主入口（另外两处在首页：最近笔记、统计格）
  { route: 'notes', title: '笔记', desc: '长文本，正文同步到电脑', col: 'notes', icon: '▦' },
  { route: 'stickies', title: '便签', desc: '电脑上的两块便签', col: 'stickies', icon: '▤' },
  { route: 'resources', title: '速达', desc: '网页与常用入口', col: 'resources', icon: '◎' },
  { route: 'snippets', title: '提示词', desc: '常用话术一键复制', col: 'snippets', icon: '⌘' },
  { route: 'holidays', title: '节日', desc: '传统节日 · 二十四节气 · 外国节日', col: null, icon: '❖' },
  { route: 'ext', title: '扩展', desc: '运行电脑上装的 x-hub 扩展', col: null, icon: '◫' },
  { route: 'account', title: '账号与邀请码', desc: '登录、兑换邀请码、平台 AI 额度', col: null, icon: '◈' },
  { route: 'settings', title: '同步与设置', desc: '配对、冲突、外观', col: null, icon: '⚙' },
]

export function mount(root) {
  rootEl = root
  render()
  return () => {}
}

// ---------------------------------------------------------------- 节日批量添加

/** 未来 13 个月里还没过的节日（与节日页同一口径） */
function upcomingHolidays() {
  const now = new Date()
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  return holidaysInRange(now.getFullYear(), 2).filter((x) => x.date >= from)
}

/** 批量添加过、且仍然存在的待办 id（用户手动删掉的不再算数） */
function bulkIds(includeDone) {
  const raw = S.meta[BULK_KEY]
  const ids = raw && Array.isArray(raw.ids) ? raw.ids : []
  return ids.filter((id) => {
    const r = findRec(id)
    if (!r || r.deleted) return false
    // 已完成的当历史留着：取消勾选时只清还没做的
    return includeDone ? true : !r.done
  })
}

function holidayBulkRow() {
  const list = upcomingHolidays()
  const ids = bulkIds(true)
  const on = ids.length > 0
  const sub = on
    ? '已批量加入 ' + ids.length + ' 条待办 · 关闭会一并移除'
    : '把未来 13 个月的 ' + list.length + ' 个节日一次加入待办，默认提前 1 天提醒'

  return h('div', { class: 'menu-sub' }, [
    h('div', { class: 'switch-row' }, [
      h('div', { class: 'switch-meta' }, [
        h('div', { class: 'switch-title', text: '一键添加所有节日' }),
        h('div', { class: 'switch-sub', text: sub }),
      ]),
      h('label', { class: 'toggle' }, [
        h('input', {
          type: 'checkbox',
          checked: on,
          'aria-label': '一键添加所有节日',
          onchange: (e) => applyBulk(e.target.checked, e.target),
        }),
        h('span', { class: 'knob' }),
      ]),
    ]),
  ])
}

/** 勾选＝批量建待办；取消＝只删这一批自己建的那些，不动用户手写的待办 */
async function applyBulk(on, input) {
  if (busy) return
  const ids = bulkIds()

  if (!on) {
    if (!ids.length) {
      // 这一批都做完了：只清掉批量记录，已完成的历史不动
      await saveMeta(BULK_KEY, { ids: [], at: Date.now() })
      render()
      toast('这批节日待办都已完成，已移出批量记录')
      return
    }
    const ok = await confirmAsync('取消后会把批量添加的 ' + ids.length + ' 条节日待办一并删除，确定吗？', '删除')
    if (!ok) {
      input.checked = true
      return
    }
    busy = true
    input.disabled = true
    try {
      for (let i = 0; i < ids.length; i++) {
        const r = findRec(ids[i])
        if (r && !r.deleted) await softDelete(r)
      }
      await saveMeta(BULK_KEY, { ids: [], at: Date.now() })
      toast('已移除批量添加的 ' + ids.length + ' 条节日待办')
    } finally {
      busy = false
    }
    render()
    return
  }

  const list = upcomingHolidays()
  const exist = colRecords('todos')
  const keep = []
  let added = 0
  busy = true
  input.disabled = true
  try {
    for (let i = 0; i < list.length; i++) {
      const x = list[i]
      const due = new Date(x.date)
      due.setHours(9, 0, 0, 0)
      const dueAt = due.getTime()
      // 同名同一天的待办只认一条，重复勾选不会堆出一串重复项
      const dup = exist.filter(
        (t) => t.title && t.title.indexOf(x.name) >= 0 && t.dueAt && Math.abs(t.dueAt - dueAt) < 86400000
      )[0]
      if (dup) {
        keep.push(dup.id)
        continue
      }
      const rec = newRecord('todos', {
        title: x.name,
        dueAt,
        remindLead: 1440,
        remindAt: dueAt - 86400000,
        priority: 0,
        description: '节日 · ' + (x.note || '') + '（一键添加）',
      })
      await touch(rec, {})
      keep.push(rec.id)
      added++
    }
    await saveMeta(BULK_KEY, { ids: keep, at: Date.now() })
    toast(added ? '已添加 ' + added + ' 条节日待办' : '这些节日都已经在待办里了')
  } finally {
    busy = false
  }
  render()
}

function render() {
  if (!rootEl) return
  rootEl.innerHTML = ''
  const scroll = h('div', { class: 'scroll' })
  rootEl.appendChild(scroll)

  scroll.appendChild(
    h('div', { class: 'card sync-mini' }, [
      h('div', { class: 'sm-row' }, [
        h('span', { class: 'big-dot', 'data-state': S.status === 'online' ? 'online' : S.status === 'conflict' ? 'conflict' : 'offline' }),
        h('b', { text: S.statusText }),
        h('span', { class: 'sm-host', text: S.meta.host || '未配对' }),
      ]),
      h('div', { class: 'sm-sub', text: S.meta.token ? '设备名 ' + (S.meta.deviceName || '—') : '到「同步与设置」里填入电脑地址完成配对' }),
    ])
  )

  const list = h('div', { class: 'menu-list' })
  ITEMS.forEach((it) => {
    const n = it.col ? colRecords(it.col).length : 0
    const subRow = it.route === 'holidays'
    list.appendChild(
      h('button', { class: 'menu-item' + (subRow ? ' no-sep' : ''), type: 'button', onclick: () => (location.hash = '#/' + it.route) }, [
        h('span', { class: 'mi-ic', text: it.icon }),
        h('span', { class: 'mi-body' }, [
          h('span', { class: 'mi-t', text: it.title }),
          h('span', { class: 'mi-d', text: it.desc }),
        ]),
        it.col ? h('span', { class: 'mi-n', text: String(n) }) : null,
        h('span', { class: 'mi-go', text: '›' }),
      ])
    )
    // 节日下面挂一个批量开关：进节日页一个个加太慢
    if (subRow) list.appendChild(holidayBulkRow())
  })
  scroll.appendChild(list)
  scroll.appendChild(creditCard())
  scroll.appendChild(h('div', { class: 'list-pad' }))
}

/** 出品方与联系方式：微信号带一键复制 */
function creditCard() {
  const wx = 'ZJC211026'
  return h('div', { class: 'card credit-card' }, [
    h('h2', { text: '关于出品' }),
    h('p', { class: 'credit-main', text: '本软件由凉风有魈借助 x-hub 项目出品' }),
    h('p', { class: 'muted', text: '使用过程中如有任何问题，欢迎联系：' }),
    h('div', { class: 'wx-row' }, [
      h('code', { class: 'wx-code', text: 'WX: ' + wx }),
      h('button', {
        class: 'mini wx-copy',
        type: 'button',
        text: '复制',
        onclick: async () => {
          try {
            await writeClipboard(wx)
            toast('微信号已复制')
          } catch (e) {
            toast('复制失败，请手动选中')
          }
        },
      }),
    ]),
  ])
}
