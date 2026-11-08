import { S, colRecords, newRecord, touch, softDelete, onChange, saveMeta } from '../lib/core.js'
import { h, openForm, emptyBlock, toast, confirmAsync } from '../lib/ui.js'
import { setQuickAdd } from '../lib/quickadd.js'
import { openExternal, hasAppCatalog, listInstalledApps, launchApp, appIconFor } from '../lib/native.js'
import {
  PHONE_APPS_KEY,
  MAX_PHONE_APPS,
  normalizeApps,
  addApp,
  removeApp,
  hasApp,
} from '../lib/appShortcuts.js'

export const meta = { title: '速达', route: 'resources' }

/**
 * 速达 = 两个完全独立的个体，共用一个页面外壳但互不读写、互不影响：
 *   - 「手机应用」：只存 S.meta.phoneApps（meta 不在 PROTO 2 同步载荷内），
 *     图标取自系统真实图标，点按直接拉起本机应用，可添加 / 移除。
 *   - 「电脑同步」：仍是 records 里的 resources 集合，与 PC 端同步；
 *     其中 kind=app/file 的电脑程序**只读**展示，取消原来「在手机端新建 / 打开 PC 程序」的方案。
 * 两区不共享筛选状态、不共享数据、不互相转换类型。
 */

let off = null
let rootEl = null
let zone = 'phone' // 'phone' | 'pc'
let filter = 'all' // 只属于 pc 区
let phoneApps = []

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
  phoneApps = normalizeApps(S.meta[PHONE_APPS_KEY])
  syncQuickAdd()
  render()
  off = onChange(render)
  return () => off && off()
}

function syncQuickAdd() {
  // 底栏「＋」按当前分区给动作：两个分区的功能也彼此独立
  setQuickAdd(() => (zone === 'phone' ? openAppPicker() : edit(null)))
}

function render() {
  if (!rootEl) return
  rootEl.innerHTML = ''
  const pcAll = colRecords('resources')
  rootEl.appendChild(
    h('div', { class: 'res-tabs' }, [
      h('button', {
        class: 'res-tab' + (zone === 'phone' ? ' on' : ''),
        type: 'button',
        text: '手机应用 ' + phoneApps.length,
        onclick: () => switchZone('phone'),
      }),
      h('button', {
        class: 'res-tab' + (zone === 'pc' ? ' on' : ''),
        type: 'button',
        text: '电脑同步 ' + pcAll.length,
        onclick: () => switchZone('pc'),
      }),
    ])
  )
  if (zone === 'pc') rootEl.appendChild(pcFilterBar(pcAll))

  const scroll = h('div', { class: 'scroll res-scroll' })
  rootEl.appendChild(scroll)
  if (zone === 'phone') renderPhone(scroll)
  else renderPcBody(scroll, pcAll)
}

function switchZone(z) {
  if (zone === z) return
  zone = z
  syncQuickAdd()
  render()
}

// ---------------------------------------------------------------- 个体一：手机应用

function renderPhone(scroll) {
  scroll.appendChild(
    h('div', { class: 'res-section' }, [
      h('div', { class: 'res-section-head' }, [
        h('b', { text: '手机应用' }),
        h('button', { class: 'btn mini', type: 'button', text: '＋ 添加应用', onclick: openAppPicker }),
      ]),
      h('p', { class: 'hint-line', text: '只保存在这台手机，不与电脑同步。图标取自系统真实图标，点按直接打开应用。' }),
    ])
  )
  if (!phoneApps.length) {
    scroll.appendChild(emptyBlock('还没有添加应用', '点「＋ 添加应用」从本机已安装的应用里挑选'))
    scroll.appendChild(h('div', { class: 'list-pad' }))
    return
  }

  const grid = h('div', { class: 'app-grid' })
  phoneApps.forEach((app) => grid.appendChild(appTile(app)))
  scroll.appendChild(grid)
  scroll.appendChild(h('div', { class: 'hint-line', text: '点按打开；右上角 × 从速达移除（不会卸载应用）' }))
  scroll.appendChild(h('div', { class: 'list-pad' }))
}

function appTile(app) {
  const tile = h('div', { class: 'app-tile' })
  const btn = h('button', { class: 'app-btn', type: 'button', onclick: () => openApp(app) })

  // 图标就是原生从 PackageManager 导出的 PNG，绝不是统一占位图。
  // 只有缓存被系统清理这种异常才会重取一次；仍失败时显示该应用自己的名字，不画通用图标。
  const img = h('img', { class: 'app-icon', src: app.icon || appIconFor(app.pkg), alt: app.label })
  let retried = false
  img.addEventListener('error', () => {
    const u = appIconFor(app.pkg)
    if (u && !retried) {
      retried = true
      img.src = u + '?r=' + Date.now()
      return
    }
    img.remove()
    btn.insertBefore(h('span', { class: 'app-fallback', text: (app.label || '?').slice(0, 2) }), btn.firstChild)
  })
  btn.appendChild(img)
  btn.appendChild(h('span', { class: 'app-label', text: app.label }))

  tile.appendChild(btn)
  tile.appendChild(
    h('button', {
      class: 'app-del',
      type: 'button',
      text: '×',
      'aria-label': '移除 ' + app.label,
      onclick: () => removePhoneApp(app),
    })
  )
  return tile
}

function openApp(app) {
  if (!launchApp(app.pkg)) toast('打不开这个应用，可能已卸载；可点 × 从速达移除')
}

async function removePhoneApp(app) {
  if (!(await confirmAsync('从速达移除「' + app.label + '」？不会卸载应用，也不影响电脑端。', '移除'))) return
  phoneApps = removeApp(phoneApps, app.pkg)
  await saveMeta(PHONE_APPS_KEY, phoneApps)
  render()
  toast('已移除')
}

/** 从本机已安装应用里挑：列表同样显示系统真实图标 */
function openAppPicker() {
  if (!hasAppCatalog()) return toast('这版 App 还不支持读取已安装应用')
  const apps = listInstalledApps()
  if (!apps.length) return toast('没有读到已安装应用，请检查系统权限')

  const mask = h('div', { class: 'school-mask app-pick-mask' })
  const panel = h('div', { class: 'school-panel app-pick-panel' })
  const search = h('input', { class: 'input school-search', type: 'search', placeholder: '搜索应用名或包名' })
  const count = h('span', { class: 'school-count' })
  const list = h('div', { class: 'school-list' })
  let hits = []
  let shown = 0
  let moreBtn = null

  function more() {
    hits.slice(shown, shown + 60).forEach((a) => {
      list.appendChild(
        h('button', { class: 'school-row app-pick-row', type: 'button', onclick: () => choose(a) }, [
          h('img', { class: 'app-pick-ic', src: a.icon, alt: a.label }),
          h('div', { class: 'app-pick-body' }, [
            h('b', { text: a.label }),
            h('span', { class: 'school-url', text: a.pkg }),
          ]),
        ])
      )
    })
    shown = Math.min(hits.length, shown + 60)
    if (!hits.length) list.appendChild(h('p', { class: 'lib-hint', text: '没有匹配的应用。' }))
    if (moreBtn) {
      moreBtn.hidden = shown >= hits.length
      moreBtn.textContent = '加载更多（还有 ' + Math.max(0, hits.length - shown) + ' 个）'
    }
  }

  function doFilter(q) {
    const s = String(q || '').trim().toLowerCase()
    hits = apps.filter((a) => !s || String(a.label || '').toLowerCase().indexOf(s) >= 0 || String(a.pkg || '').toLowerCase().indexOf(s) >= 0)
    shown = 0
    list.innerHTML = ''
    count.textContent = '本机共 ' + apps.length + ' 个可启动应用 · 已添加 ' + phoneApps.length + ' 个'
    more()
  }

  function choose(a) {
    if (hasApp(phoneApps, a.pkg)) return toast('已经添加过了')
    if (phoneApps.length >= MAX_PHONE_APPS) return toast('最多添加 ' + MAX_PHONE_APPS + ' 个应用')
    const next = addApp(phoneApps, { pkg: a.pkg, label: a.label, icon: a.icon })
    if (next === phoneApps) return
    phoneApps = next
    saveMeta(PHONE_APPS_KEY, phoneApps)
    mask.remove()
    render()
    toast('已添加 ' + a.label)
  }

  moreBtn = h('button', { class: 'btn block', type: 'button', text: '加载更多', onclick: more })
  panel.appendChild(h('div', { class: 'school-head' }, [
    h('b', { text: '添加应用' }),
    h('button', { class: 'mini', type: 'button', text: '关闭', onclick: () => mask.remove() }),
  ]))
  panel.appendChild(search)
  panel.appendChild(count)
  panel.appendChild(list)
  panel.appendChild(moreBtn)
  panel.appendChild(h('p', { class: 'school-src', text: '列表与图标来自这台手机的系统应用信息，仅在本机使用，不上传、不同步到电脑。' }))
  mask.appendChild(panel)
  document.body.appendChild(mask)
  mask.addEventListener('click', (e) => { if (e.target === mask) mask.remove() })
  search.addEventListener('input', () => doFilter(search.value))
  doFilter('')
  setTimeout(() => search.focus(), 120)
}

// ---------------------------------------------------------------- 个体二：电脑同步（PC 端方案已取消）

function pcFilterBar(all) {
  return h('div', { class: 'filterbar' }, [
    chip('all', '全部', all.length),
    ...KINDS.map((k) => chip(k.value, k.label, all.filter((r) => r.kind === k.value).length)),
    h('button', { class: 'btn mini add-btn', type: 'button', text: '＋ 新建网页', onclick: () => edit(null) }),
  ])
}

function renderPcBody(scroll, all) {
  const list = (filter === 'all' ? all : all.filter((r) => r.kind === filter))
    .slice()
    .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh'))
  scroll.appendChild(
    h('p', { class: 'hint-line', text: '这一区来自电脑同步；电脑程序与文件在手机上只读、不能打开，也不会与「手机应用」互通。' })
  )
  if (!list.length) {
    scroll.appendChild(emptyBlock('还没有速达项', '网页链接可以直接在手机浏览器打开'))
    scroll.appendChild(h('div', { class: 'list-pad' }))
    return
  }

  const grid = h('div', { class: 'res-grid' })
  list.forEach((r) => {
    const isPcOnly = r.kind === 'app' || r.kind === 'file'
    const body = [
      h('span', { class: 'res-ic', text: (r.name || '?').slice(0, 1) }),
      h('span', { class: 'res-n', text: r.name || '未命名' }),
      h('span', { class: 'res-k', text: (isPcOnly ? '电脑端 · ' : '') + kindLabel(r.kind) }),
    ]
    const item = h('div', { class: 'res-item' })
    if (isPcOnly) {
      // 取消原有 PC 端程序方案：只读展示，不提供打开 / 编辑入口
      item.appendChild(h('div', { class: 'res res-readonly' }, body))
    } else {
      item.appendChild(h('button', { class: 'res', type: 'button', onclick: () => open(r) }, body))
      item.appendChild(
        h('button', {
          class: 'res-more',
          type: 'button',
          text: '⋯',
          'aria-label': '编辑或删除',
          onclick: (e) => { e.stopPropagation(); edit(r) },
        })
      )
    }
    grid.appendChild(item)
  })
  scroll.appendChild(grid)
  scroll.appendChild(h('div', { class: 'hint-line', text: '网页点按打开；右上角 ⋯ 可编辑或删除。电脑程序只读。' }))
  scroll.appendChild(h('div', { class: 'list-pad' }))
}

function chip(id, label, n) {
  return h('button', { class: 'chip' + (filter === id ? ' on' : ''), type: 'button', onclick: () => { filter = id; render() } }, [
    label,
    h('b', { text: String(n) }),
  ])
}

function open(r) {
  if (r.kind !== 'web') return toast('电脑端程序与文件只能在电脑上打开')
  const url = r.target || ''
  if (!/^https?:\/\//i.test(url)) return toast('这个目标不是网页地址')
  openExternal(url).catch(() => toast('无法打开浏览器，请手动复制链接'))
}

/** 手机端只允许新建网页入口；PC 程序不再能从这边创建（原方案已取消） */
function edit(r) {
  const base = r || null
  openForm({
    title: r ? '编辑网页入口' : '新增网页入口',
    fields: [
      { key: 'name', label: '名称', type: 'text', maxlength: 200, placeholder: '显示名' },
      { key: 'target', label: '网址', type: 'text', maxlength: 2000, placeholder: 'https://…' },
      { key: 'category', label: '分类', type: 'text', maxlength: 60, placeholder: '可选' },
    ],
    values: {
      name: base ? base.name || '' : '',
      target: base ? base.target || '' : '',
      category: base ? base.category || '' : '',
    },
    async onSave(v) {
      const name = String(v.name || '').trim()
      const target = String(v.target || '').trim()
      if (!name || !target) return toast('名称和网址都要填')
      const fields = { kind: 'web', name, target, category: v.category || null, title: name }
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
