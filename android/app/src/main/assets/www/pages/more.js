import { S, colRecords } from '../lib/core.js'
import { h, toast } from '../lib/ui.js'
import { writeClipboard } from '../lib/native.js'

export const meta = { title: '我的', route: 'more' }

let rootEl = null

const ITEMS = [
  { route: 'stickies', title: '便签', desc: '电脑上的两块便签', col: 'stickies', icon: '▤' },
  { route: 'resources', title: '速达', desc: '网页与常用入口', col: 'resources', icon: '◎' },
  { route: 'snippets', title: '提示词', desc: '常用话术一键复制', col: 'snippets', icon: '⌘' },
  { route: 'ext', title: '扩展', desc: '运行电脑上装的 x-hub 扩展', col: null, icon: '◫' },
  { route: 'account', title: '账号与邀请码', desc: '登录、兑换邀请码、平台 AI 额度', col: null, icon: '◈' },
  { route: 'settings', title: '同步与设置', desc: '配对、冲突、外观', col: null, icon: '⚙' },
]

export function mount(root) {
  rootEl = root
  render()
  return () => {}
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
    list.appendChild(
      h('button', { class: 'menu-item', type: 'button', onclick: () => (location.hash = '#/' + it.route) }, [
        h('span', { class: 'mi-ic', text: it.icon }),
        h('span', { class: 'mi-body' }, [
          h('span', { class: 'mi-t', text: it.title }),
          h('span', { class: 'mi-d', text: it.desc }),
        ]),
        it.col ? h('span', { class: 'mi-n', text: String(n) }) : null,
        h('span', { class: 'mi-go', text: '›' }),
      ])
    )
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
