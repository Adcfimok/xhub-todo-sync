import { colRecords, newRecord, touch, softDelete, onChange } from '../lib/core.js'
import { h, openForm, emptyBlock, toast } from '../lib/ui.js'
import { setQuickAdd } from '../lib/quickadd.js'

export const meta = { title: '提示词', route: 'snippets' }

let off = null
let rootEl = null
let q = ''

export function mount(root) {
  rootEl = root
  setQuickAdd(() => openEditor(null))
  render()
  off = onChange(render)
  return () => off && off()
}

function render() {
  if (!rootEl) return
  rootEl.innerHTML = ''
  const all = colRecords('snippets').slice().sort((a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1
    return (b.updatedAt || 0) - (a.updatedAt || 0)
  })
  const list = q ? all.filter((s) => (s.title || '').includes(q) || (s.content || '').includes(q)) : all

  rootEl.appendChild(
    h('div', { class: 'searchbar' }, [
      h('input', {
        class: 'input',
        type: 'search',
        placeholder: '搜索提示词',
        value: q,
        oninput: (e) => {
          q = e.target.value.trim()
          render()
        },
      }),
    ])
  )

  const scroll = h('div', { class: 'scroll' })
  rootEl.appendChild(scroll)

  if (!list.length) {
    scroll.appendChild(emptyBlock(q ? '没有匹配的提示词' : '还没有提示词', '写好一段话，随时复制到别处'))
    return
  }

  list.forEach((s) => {
    scroll.appendChild(
      h('div', { class: 'snip', onclick: () => openEditor(s) }, [
        h('div', { class: 'sn-head' }, [
          h('span', { class: 'sn-t', text: s.title || '未命名' }),
          s.pinned ? h('span', { class: 'pin', text: '置顶' }) : null,
        ]),
        h('div', { class: 'sn-c', text: (s.content || '').replace(/\s+/g, ' ').slice(0, 90) }),
        h('div', { class: 'sn-actions' }, [
          h('button', {
            class: 'mini',
            type: 'button',
            text: '复制',
            onclick: (e) => {
              e.stopPropagation()
              copy(s.content || '')
            },
          }),
          h('button', {
            class: 'mini',
            type: 'button',
            text: s.pinned ? '取消置顶' : '置顶',
            onclick: (e) => {
              e.stopPropagation()
              touch(s, { pinned: !s.pinned })
            },
          }),
        ]),
      ])
    )
  })
  scroll.appendChild(h('div', { class: 'list-pad' }))
}

function copy(text) {
  writeClipboard(text).then(
    () => toast('已复制'),
    () => toast('复制失败')
  )
}

export function openEditor(s) {
  const base = s || null
  openForm({
    title: s ? '编辑提示词' : '新增提示词',
    fields: [
      { key: 'title', label: '标题', type: 'text', maxlength: 200, placeholder: '这段提示词叫什么' },
      { key: 'content', label: '内容', type: 'textarea', rows: 10, maxlength: 20000, placeholder: '提示词正文' },
    ],
    values: { title: base ? base.title : '', content: base ? base.content || '' : '' },
    async onSave(v) {
      const fields = { title: String(v.title || '').trim() || '未命名', content: String(v.content || '') }
      if (base) await touch(base, fields)
      else await touch(newRecord('snippets', fields))
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
