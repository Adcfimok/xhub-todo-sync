import { colRecords, newRecord, touch, onChange } from '../lib/core.js'
import { h, emptyBlock, fmtAgo } from '../lib/ui.js'

export const meta = { title: '便签', route: 'stickies' }

let off = null
let rootEl = null
const timers = {}

export function mount(root) {
  rootEl = root
  render()
  off = onChange(() => {
    // 输入过程中不重建 DOM，否则光标会跳
    if (document.activeElement && document.activeElement.tagName === 'TEXTAREA') return
    render()
  })
  return () => {
    off && off()
    Object.values(timers).forEach(clearTimeout)
  }
}

function bySlot(slot) {
  return colRecords('stickies').filter((r) => Number(r.slot) === slot)[0] || null
}

function render() {
  if (!rootEl) return
  rootEl.innerHTML = ''
  const scroll = h('div', { class: 'scroll' })
  rootEl.appendChild(scroll)

  const list = colRecords('stickies')
  if (!list.length) {
    scroll.appendChild(emptyBlock('还没有便签', '电脑端两块便签的内容会同步到这里'))
  }

  ;[1, 2].forEach((slot) => {
    const rec = bySlot(slot)
    const ta = h('textarea', {
      class: 'sticky-area',
      rows: 7,
      placeholder: '便签 ' + slot + '…',
    })
    ta.value = rec ? rec.content || '' : ''
    ta.addEventListener('input', () => {
      clearTimeout(timers[slot])
      timers[slot] = setTimeout(() => save(slot, ta.value), 700)
    })

    scroll.appendChild(
      h('div', { class: 'sticky-card' }, [
        h('div', { class: 'st-head' }, [
          h('b', { text: '便签 ' + slot }),
          h('span', { class: 'st-m', text: rec ? (rec.dirty ? '待同步' : fmtAgo(rec.updatedAt)) : '未同步' }),
        ]),
        ta,
      ])
    )
  })
  scroll.appendChild(h('div', { class: 'hint-line', text: '输入后自动保存，停止输入约 0.7 秒开始同步' }))
  scroll.appendChild(h('div', { class: 'list-pad' }))
}

async function save(slot, content) {
  const rec = bySlot(slot)
  if (rec) {
    if ((rec.content || '') === content) return
    await touch(rec, { content })
    return
  }
  const created = newRecord('stickies', { slot, content, title: '便签 ' + slot })
  await touch(created, { content })
}
