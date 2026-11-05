import { S, http, hubUrl, authHeaders } from '../lib/core.js'
import { h, emptyBlock, toast } from '../lib/ui.js'

export const meta = { title: '扩展', route: 'ext' }

let rootEl = null
let items = null
let errText = ''

export function mount(root) {
  rootEl = root
  if (items) render()
  else load()
  return () => {
    const ov = document.getElementById('ext-overlay')
    if (ov) ov.remove()
  }
}

async function load() {
  if (!rootEl) return
  if (!S.meta.token) {
    errText = '还没配对，先到「我的 → 同步」里连上电脑'
    render()
    return
  }
  rootEl.innerHTML = ''
  rootEl.appendChild(h('div', { class: 'loading', text: '正在读取电脑上的扩展…' }))
  try {
    const res = await http(S.meta.host, '/ext/list', { token: S.meta.token })
    items = res.items || []
    errText = res.readable === false ? '电脑上的扩展目录读不到，请确认扩展安装在 x-hub 数据目录下' : ''
  } catch (e) {
    items = []
    errText = '读取失败：' + (e.message || e)
  }
  render()
}

function render() {
  if (!rootEl) return
  rootEl.innerHTML = ''
  const scroll = h('div', { class: 'scroll' })
  rootEl.appendChild(scroll)

  // 内置工具：不依赖电脑，未配对也能用
  scroll.appendChild(builtinCard())

  if (errText) scroll.appendChild(h('div', { class: 'card' }, [h('p', { class: 'muted', text: errText })]))

  if (!items || !items.length) {
    scroll.appendChild(emptyBlock('没有可用扩展', '电脑上装好的扩展会出现在这里'))
    scroll.appendChild(h('div', { class: 'list-bignav' }))
    return
  }

  const grid = h('div', { class: 'ext-grid' })
  items.forEach((it) => {
    const iconUrl = it.icon ? hubUrl('/ext/r/' + S.meta.token + '/' + it.id + '/' + it.icon.replace(/^\/ext\/[^/]+\//, '')) : ''
    const icon = iconUrl
      ? h('img', { class: 'ext-ic', src: iconUrl, alt: '', onerror: (e) => (e.target.style.visibility = 'hidden') })
      : h('span', { class: 'ext-ic ph', text: (it.name || '?').slice(0, 1) })
    grid.appendChild(
      h('button', { class: 'ext', type: 'button', onclick: () => open(it) }, [
        icon,
        h('span', { class: 'ext-n', text: it.name }),
        h('span', { class: 'ext-v', text: (it.surfaces || []).join(' · ') || it.runtime }),
      ])
    )
  })
  scroll.appendChild(grid)
  scroll.appendChild(
    h('div', { class: 'hint-line', text: '扩展页面由电脑提供；需要读取待办/笔记等数据的扩展，要求电脑端「待办同步」页面保持打开' })
  )
  scroll.appendChild(h('div', { class: 'list-bignav' }))
}

function open(it) {
  const entry = (it.entry && (it.entry.view || it.entry.module)) || 'index.html'
  const rel = String(entry).replace(/^\.?\//, '')
  const src = hubUrl('/ext/r/' + S.meta.token + '/' + it.id + '/' + rel)

  const old = document.getElementById('ext-overlay')
  if (old) old.remove()

  const frame = h('iframe', { class: 'ext-frame', src, title: it.name })
  const bar = h('div', { class: 'ext-bar' }, [
    h('button', { class: 'back', type: 'button', text: '‹', onclick: () => ov.remove() }),
    h('b', { text: it.name }),
    h('span', { class: 'grow' }),
    h('button', {
      class: 'mini',
      type: 'button',
      text: '刷新',
      onclick: () => {
        frame.src = 'about:blank'
        setTimeout(() => (frame.src = src), 60)
      },
    }),
  ])
  const ov = h('div', { class: 'ext-overlay', id: 'ext-overlay' }, [bar, frame])
  document.body.appendChild(ov)
}

/** 内置工具区（番茄钟等，纯本地） */
function builtinCard() {
  return h('div', { class: 'card' }, [
    h('h2', { text: '内置工具' }),
    h(
      'button',
      { class: 'builtin-row', type: 'button', onclick: () => (location.hash = '#/pomodoro') },
      [
        h('span', { class: 'builtin-ic', text: '⏱' }),
        h('span', { class: 'mi-body' }, [
          h('span', { class: 'mi-t', text: '番茄钟' }),
          h('span', { class: 'mi-d', text: '25 分钟专注 + 5 分钟休息，到点提醒' }),
        ]),
        h('span', { class: 'mi-go', text: '›' }),
      ]
    ),
  ])
}
