import { colRecords, newRecord, touch, softDelete, onChange } from '../lib/core.js'
import { h, openForm, emptyBlock, fmtAgo, toast } from '../lib/ui.js'
import { setQuickAdd } from '../lib/quickadd.js'

export const meta = { title: '笔记', route: 'notes' }

let off = null
let rootEl = null
let q = ''

export function mount(root) {
  rootEl = root
  // 底栏中央 + 在笔记页 = 新建笔记
  setQuickAdd(() => openEditor(null))
  render()
  off = onChange(render)
  return () => off && off()
}

function render() {
  if (!rootEl) return
  rootEl.innerHTML = ''
  const all = colRecords('notes').slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  const list = q ? all.filter((n) => (n.title || '').includes(q) || (n.content || '').includes(q)) : all

  const search = h('div', { class: 'searchbar' }, [
    h('input', {
      class: 'input',
      type: 'search',
      placeholder: '搜索标题或正文',
      value: q,
      oninput: (e) => {
        q = e.target.value.trim()
        render()
      },
    }),
  ])
  rootEl.appendChild(search)

  const scroll = h('div', { class: 'scroll' })
  rootEl.appendChild(scroll)

  if (!list.length) {
    scroll.appendChild(emptyBlock(q ? '没有匹配的笔记' : '还没有笔记', '标题和正文都会同步到电脑'))
    return
  }

  list.forEach((n) => {
    scroll.appendChild(
      h('div', { class: 'note-card', onclick: () => openEditor(n) }, [
        h('div', { class: 'nc-t', text: n.title || '无标题笔记' }),
        h('div', { class: 'nc-s', text: (n.content || '').replace(/\s+/g, ' ').slice(0, 72) || '（空）' }),
        h('div', { class: 'nc-m' }, [h('span', { text: fmtAgo(n.updatedAt) }), n.dirty ? h('span', { class: 'pend', text: '待同步' }) : null]),
      ])
    )
  })
  scroll.appendChild(h('div', { class: 'list-pad' }))
}

export function openEditor(n) {
  const base = n || null
  openForm({
    title: n ? '编辑笔记' : '新建笔记',
    fields: [
      { key: 'title', label: '标题', type: 'text', maxlength: 200, placeholder: '给笔记起个名字' },
      { key: 'content', label: '正文', type: 'textarea', rows: 12, maxlength: 200000, placeholder: '支持纯文本与 Markdown' },
    ],
    values: { title: base ? base.title : '', content: base ? base.content || '' : '' },
    async onSave(v) {
      const fields = { title: String(v.title || '').trim() || '无标题笔记', content: String(v.content || '') }
      if (base) await touch(base, fields)
      else await touch(newRecord('notes', fields))
      toast('已保存')
    },
    onDelete: base
      ? async () => {
          await softDelete(base)
          toast('已删除')
        }
      : null,
  })
}
