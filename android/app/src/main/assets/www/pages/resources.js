import { colRecords, newRecord, touch, softDelete, onChange } from '../lib/core.js'
import { h, openForm, emptyBlock, toast } from '../lib/ui.js'
import { setQuickAdd } from '../lib/quickadd.js'

export const meta = { title: '速达', route: 'resources' }

let off = null
let rootEl = null
let filter = 'all'

const KINDS = [
  { value: 'web', label: '网页' },
  { value: 'file', label: '文件' },
  { value: 'app', label: '程序' },
]

function kindLabel(k) {
  const f = KINDS.filter((x) => x.value === k)[0]
  return f ? f.label : '网页'
}

export function mount(root) {
  rootEl = root
  setQuickAdd(() => edit(null))
  render()
  off = onChange(render)
  return () => off && off()
}

function render() {
  if (!rootEl) return
  rootEl.innerHTML = ''
  const all = colRecords('resources').slice().sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh'))
  const list = filter === 'all' ? all : all.filter((r) => r.kind === filter)

  const bar = h('div', { class: 'filterbar' }, [
    chip('all', '全部', all.length),
    ...KINDS.map((k) => chip(k.value, k.label, all.filter((r) => r.kind === k.value).length)),
  ])
  rootEl.appendChild(bar)

  const scroll = h('div', { class: 'scroll' })
  rootEl.appendChild(scroll)

  if (!list.length) {
    scroll.appendChild(emptyBlock('还没有速达项', '网页链接可以直接在手机浏览器打开'))
    return
  }

  const grid = h('div', { class: 'res-grid' })
  list.forEach((r) => {
    grid.appendChild(
      h('button', { class: 'res', type: 'button', onclick: () => open(r), oncontextmenu: (e) => { e.preventDefault(); edit(r) } }, [
        h('span', { class: 'res-ic', text: (r.name || '?').slice(0, 1) }),
        h('span', { class: 'res-n', text: r.name || '未命名' }),
        h('span', { class: 'res-k', text: kindLabel(r.kind) }),
      ])
    )
  })
  scroll.appendChild(grid)
  scroll.appendChild(h('div', { class: 'hint-line', text: '点按打开，长按编辑' }))
  scroll.appendChild(h('div', { class: 'list-pad' }))
}

function chip(id, label, n) {
  return h('button', { class: 'chip' + (filter === id ? ' on' : ''), type: 'button', onclick: () => { filter = id; render() } }, [
    label,
    h('b', { text: String(n) }),
  ])
}

function open(r) {
  if (r.kind !== 'web') return toast('文件与程序只能在电脑上打开')
  const url = r.target || ''
  if (!/^https?:\/\//i.test(url)) return toast('这个目标不是网页地址')
  openExternal(url).catch(() => toast('无法打开浏览器，请手动复制链接'))
}

function edit(r) {
  const base = r || null
  openForm({
    title: r ? '编辑速达' : '新增速达',
    fields: [
      { key: 'kind', label: '类型', type: 'select', options: KINDS },
      { key: 'name', label: '名称', type: 'text', maxlength: 200, placeholder: '显示名' },
      { key: 'target', label: '目标', type: 'text', maxlength: 2000, placeholder: 'https://… 或本地路径' },
      { key: 'category', label: '分类', type: 'text', maxlength: 60, placeholder: '可选' },
    ],
    values: {
      kind: base ? base.kind || 'web' : 'web',
      name: base ? base.name || '' : '',
      target: base ? base.target || '' : '',
      category: base ? base.category || '' : '',
    },
    async onSave(v) {
      const name = String(v.name || '').trim()
      const target = String(v.target || '').trim()
      if (!name || !target) return toast('名称和目标都要填')
      const fields = { kind: v.kind, name, target, category: v.category || null, title: name }
      if (base) await touch(base, fields)
      else await touch(newRecord('resources', fields))
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
