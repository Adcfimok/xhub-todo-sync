import { S, saveMeta } from '../lib/core.js'
import { h, toast, confirmAsync, openForm } from '../lib/ui.js'
import { normalizeCountdowns, normalizeCountdown, countdownLabel, dayAbs, toYmd } from '../lib/countdown.js'

export const meta = { title: '倒数日', route: 'countdown' }

let rootEl = null

export function mount(root) {
  rootEl = root
  render()
  return () => {}
}

function list() {
  return normalizeCountdowns(S.meta.countdowns)
}

async function save(list) {
  await saveMeta('countdowns', list)
}

function render() {
  if (!rootEl) return
  rootEl.innerHTML = ''
  const scroll = h('div', { class: 'scroll' })
  rootEl.appendChild(scroll)

  const items = list()
  if (!items.length) {
    scroll.appendChild(
      h('div', { class: 'card' }, [
        h('div', { class: 'empty' }, [
          h('p', { class: 'empty-t', text: '还没有倒数日' }),
          h('p', { class: 'empty-s', text: '点下方「添加」记一个重要的日子，首页卡片可以左右滑动切换。' }),
        ]),
      ])
    )
  } else {
    const card = h('div', { class: 'card' })
    items.forEach((c) => card.appendChild(row(c)))
    scroll.appendChild(card)
  }

  scroll.appendChild(
    h('div', { class: 'card' }, [
      h('button', { class: 'btn primary block', type: 'button', text: '＋ 添加倒数日', onclick: () => editCountdown(null) }),
    ])
  )
  scroll.appendChild(h('div', { class: 'list-pad' }))
}

function row(c) {
  const n = dayAbs(c)
  return h('div', { class: 'cd-row' }, [
    h('div', { class: 'cd-num' }, [h('b', { text: String(n) }), h('span', { text: '天' })]),
    h('div', { class: 'cd-main' }, [
      h('div', { class: 'cd-title', text: c.title }),
      h('div', { class: 'cd-sub', text: countdownLabel(c) + ' · ' + c.date }),
    ]),
    h('div', { class: 'course-btns' }, [
      h('button', { class: 'mini', type: 'button', text: '编辑', onclick: () => editCountdown(c) }),
      h('button', { class: 'mini', type: 'button', text: '删除', onclick: () => removeCountdown(c) }),
    ]),
  ])
}

function editCountdown(c) {
  const isNew = !c
  const base = c || { title: '', date: toYmd(Date.now()) }
  openForm({
    title: isNew ? '添加倒数日' : '编辑倒数日',
    values: { title: base.title, date: base.date },
    fields: [
      { key: 'title', label: '名称', type: 'text', placeholder: '例如：期末考试' },
      { key: 'date', label: '日期', type: 'date' },
    ],
    onSave: async (values) => {
      const rec = normalizeCountdown({ id: isNew ? null : base.id, title: values.title, date: values.date })
      if (!rec) {
        toast('名称和日期都不能为空')
        return
      }
      const items = list().filter((x) => x.id !== rec.id)
      items.push(rec)
      await save(items)
      render()
      toast(isNew ? '已添加' : '已保存')
    },
  })
}

async function removeCountdown(c) {
  if (!(await confirmAsync('删除「' + c.title + '」？', '删除'))) return
  await save(list().filter((x) => x.id !== c.id))
  render()
  toast('已删除')
}
