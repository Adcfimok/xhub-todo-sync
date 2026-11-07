/* 文件传输页：选文件 → 加密分块上传；接收电脑发来的文件；进度、取消、重试。 */

import { S, http, saveMeta } from '../lib/core.js'
import { h, toast, confirmAsync, emptyBlock, fmtAgo } from '../lib/ui.js'
import {
  MAX_FILE,
  ACTIVE,
  fmtSize,
  kindOf,
  kindIcon,
  riskOf,
  etaText,
  pctOf,
  pickFile,
  uploadFile,
  downloadFile,
  cancelTransfer,
  clearFinished,
  onTransfer,
  canTransfer,
} from '../lib/transfer.js'

export const meta = { title: '文件传输', route: 'transfer' }

const JOBS = 'transferJobs'

let rootEl = null
let scrollEl = null
let offers = []
let history = []
let picked = null
let busyPick = false
let maxFile = MAX_FILE
let timer = null
let offT = null
let lastErr = ''

export function mount(root) {
  rootEl = root
  render()
  refresh()
  timer = setInterval(refresh, 6000)
  offT = onTransfer(onEvent)
  return () => {
    clearInterval(timer)
    timer = null
    if (offT) offT()
    offT = null
    rootEl = null
    scrollEl = null
  }
}

// ---------------------------------------------------------------- 数据

function jobs() {
  const raw = S.meta[JOBS]
  return raw && typeof raw === 'object' ? raw : {}
}

function saveJobs(v) {
  saveMeta(JOBS, v).catch(() => {})
}

async function refresh() {
  if (!S.meta.host || !S.meta.token) {
    offers = []
    history = []
    render()
    return
  }
  try {
    const [p, hs] = await Promise.all([
      http(S.meta.host, '/api/v1/files/pending', { token: S.meta.token }),
      http(S.meta.host, '/api/v1/files/history', { token: S.meta.token }),
    ])
    offers = (p && p.offers) || []
    maxFile = (p && p.maxFile) || MAX_FILE
    history = (hs && hs.items) || []
    lastErr = ''
  } catch (e) {
    lastErr = e.message || '连不上电脑'
  }
  render()
}

function onEvent(p) {
  if (!p) return
  if (p.state === 'offered' && p.fileId) {
    const all = jobs()
    const cur = ACTIVE.get(p.id) || {}
    all[p.id] = { fileId: p.fileId, sha: p.sha256 || '', name: p.name, size: p.size, uri: cur.uri || '' }
    saveJobs(all)
  }
  if (p.state === 'done' || p.state === 'canceled') {
    const all = jobs()
    if (all[p.id]) {
      delete all[p.id]
      saveJobs(all)
    }
  }
  if (p.state === 'done') {
    toast(p.dir === 'down' ? '已保存到 ' + (p.savedTo || '下载目录') : '已发到电脑')
    refresh()
  } else if (p.state === 'error') {
    toast(p.message || '传输失败')
  }
  updateActive()
}

// ---------------------------------------------------------------- 渲染

function render() {
  if (!rootEl) return
  const keep = scrollEl ? scrollEl.scrollTop : 0
  rootEl.innerHTML = ''
  const scroll = h('div', { class: 'scroll' })
  scrollEl = scroll
  scroll.appendChild(statusCard())
  scroll.appendChild(sendCard())
  scroll.appendChild(activeCard())
  scroll.appendChild(resumeCard())
  scroll.appendChild(offersCard())
  scroll.appendChild(historyCard())
  scroll.appendChild(h('div', { class: 'list-pad' }))
  rootEl.appendChild(scroll)
  scroll.scrollTop = keep
}

function statusCard() {
  const paired = !!S.meta.token && !!S.meta.host
  const online = S.status === 'online' || S.status === 'syncing'
  const dot = paired ? (online ? 'online' : 'offline') : 'offline'
  const sub = !paired
    ? '先在「同步与设置」里扫码配对，文件走同一条局域网通道'
    : lastErr
      ? lastErr + '（文件列表可能不是最新）'
      : '同一 Wi-Fi 直传 · AES-256-GCM · 断点续传'
  return h('div', { class: 'card' }, [
    h('div', { class: 'status-head', style: 'margin-bottom:0' }, [
      h('span', { class: 'big-dot', 'data-state': dot }),
      h('div', { class: 'status-meta' }, [
        h('div', { class: 'status-title', text: paired ? '电脑：' + S.meta.host : '还没有连接电脑' }),
        h('div', { class: 'status-sub', text: sub }),
      ]),
    ]),
    paired
      ? null
      : h('button', {
          class: 'btn block',
          type: 'button',
          text: '去配对',
          onclick: () => (location.hash = '#/settings'),
        }),
  ])
}

function sendCard() {
  const can = canTransfer() && !!S.meta.token
  return h('div', { class: 'card' }, [
    h('h2', {}, [h('span', { text: '发送到电脑' }), h('span', { class: 'count', text: '≤ ' + fmtSize(maxFile) })]),
    picked ? pickedRow() : h('p', { class: 'muted', text: '选择手机里的任意文件，分块加密后发到电脑收件箱。' }),
    picked
      ? null
      : h('button', {
          class: 'btn primary block',
          type: 'button',
          text: busyPick ? '正在打开…' : '选择文件',
          disabled: !can || busyPick,
          onclick: choose,
        }),
    can ? null : h('p', { class: 'hint-line', text: '需要先配对电脑，并在电脑端保持扩展运行。' }),
  ])
}

function pickedRow() {
  const risk = riskOf(picked.name) === 'high'
  return h('div', { class: 'xfer' }, [
    h('div', { class: 'xfer-top' }, [
      h('span', { class: 'xfer-ic', text: kindIcon(kindOf(picked.name)) }),
      h('div', { class: 'xfer-meta' }, [
        h('div', { class: 'xfer-n', text: picked.name }),
        h('div', { class: 'xfer-s', text: fmtSize(picked.size) + (risk ? ' · 可执行文件，确认来源' : '') }),
      ]),
    ]),
    h('div', { class: 'xfer-btns' }, [
      h('button', { class: 'mini on', type: 'button', text: '发送', onclick: send }),
      h('button', {
        class: 'mini',
        type: 'button',
        text: '取消',
        onclick: () => {
          picked = null
          render()
        },
      }),
    ]),
  ])
}

function activeCard() {
  const list = [...ACTIVE.values()].sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0))
  const done = list.filter((x) => x.state === 'done' || x.state === 'error' || x.state === 'canceled').length
  const box = h('div', { class: 'xfer-list', id: 'xfer-active' })
  fillActive(box)
  return h('div', { class: 'card' }, [
    h('h2', {}, [
      h('span', { text: '传输中' }),
      h('span', { class: 'count', text: String(list.filter((x) => x.state !== 'done').length) }),
      done ? h('button', { class: 'mini right', type: 'button', text: '清除已结束', onclick: () => { clearFinished(); render() } }) : null,
    ]),
    list.length ? box : h('p', { class: 'muted', text: '暂时没有进行中的传输。' }),
  ])
}

function fillActive(box) {
  box.innerHTML = ''
  const list = [...ACTIVE.values()].sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0))
  list.forEach((t) => box.appendChild(activeRow(t)))
}

function updateActive() {
  const box = document.getElementById('xfer-active')
  if (box) fillActive(box)
}

function activeRow(t) {
  const p = t.state === 'done' ? 100 : pctOf(t.sent, t.size)
  const failed = t.state === 'error'
  const finished = t.state === 'done'
  const sub = failed
    ? t.message || '传输失败'
    : finished
      ? t.dir === 'down'
        ? '已保存到 ' + (t.savedTo || '下载目录')
        : '已发到电脑'
      : stateText(t)
  return h('div', { class: 'xfer' + (failed ? ' bad' : '') }, [
    h('div', { class: 'xfer-top' }, [
      h('span', { class: 'xfer-ic', text: t.dir === 'down' ? '↓' : '↑' }),
      h('div', { class: 'xfer-meta' }, [
        h('div', { class: 'xfer-n', text: t.name || '文件' }),
        h('div', { class: 'xfer-s', text: sub }),
      ]),
      finished || t.state === 'canceled'
        ? null
        : h('button', {
            class: 'mini',
            type: 'button',
            text: failed ? (t.dir === 'down' ? '重试' : '续传') : '取消',
            onclick: () => (failed ? retry(t) : cancelTransfer(t.id)),
          }),
    ]),
    h('div', { class: 'xfer-bar' + (finished ? ' done' : '') }, [h('i', { style: 'width:' + Math.max(2, p) + '%' })]),
  ])
}

function stateText(t) {
  const p = pctOf(t.sent, t.size)
  const head =
    t.state === 'hashing'
      ? '校验中'
      : t.state === 'offered'
        ? '已建立任务'
        : t.state === 'uploading'
          ? '发送中'
          : t.state === 'downloading'
            ? '接收中'
            : t.state === 'canceled'
              ? '已取消'
              : '准备中'
  const eta = t.state === 'uploading' || t.state === 'downloading' ? etaText(t.sent, t.size, t.startedAt) : ''
  return head + ' · ' + fmtSize(t.sent) + ' / ' + fmtSize(t.size) + ' · ' + p + '%' + (eta ? ' · ' + eta : '')
}

function orphanJobs() {
  const all = jobs()
  return Object.keys(all)
    .filter((id) => !ACTIVE.has(id))
    .map((id) => Object.assign({ id }, all[id]))
    .sort((a, b) => (b.at || 0) - (a.at || 0))
}

/** App 被杀后原生任务已中断，但服务端还留着 .part：给一条明确的「继续」入口 */
function resumeCard() {
  const list = orphanJobs()
  if (!list.length) return h('div', { class: 'card', hidden: 'hidden' })
  return h('div', { class: 'card' }, [
    h('h2', {}, [h('span', { text: '未完成的发送' }), h('span', { class: 'count', text: String(list.length) })]),
    h(
      'div',
      { class: 'xfer-list' },
      list.map((j) =>
        h('div', { class: 'xfer' }, [
          h('div', { class: 'xfer-top' }, [
            h('span', { class: 'xfer-ic', text: '↑' }),
            h('div', { class: 'xfer-meta' }, [
              h('div', { class: 'xfer-n', text: j.name || '文件' }),
              h('div', { class: 'xfer-s', text: fmtSize(j.size) + ' · 上次没传完' }),
            ]),
            h('button', { class: 'mini on', type: 'button', text: '继续', onclick: () => resumeJob(j) }),
          ]),
        ])
      )
    ),
  ])
}

function resumeJob(j) {
  if (!j.fileId || !j.uri) {
    toast('原文件已失效，请重新选择')
    return
  }
  const all = jobs()
  delete all[j.id]
  saveJobs(all)
  const id = uploadFile({ uri: j.uri, name: j.name, size: j.size, resumeId: j.fileId, sha: j.sha })
  if (!id) toast('无法继续，请重新选择文件')
  else toast('已从断点继续')
  render()
}

function offersCard() {
  return h('div', { class: 'card' }, [
    h('h2', {}, [h('span', { text: '待接收' }), h('span', { class: 'count', text: String(offers.length) })]),
    offers.length
      ? h(
          'div',
          { class: 'xfer-list' },
          offers.map((o) => offerRow(o))
        )
      : h('p', { class: 'muted', text: '电脑发来的文件会出现在这里，24 小时内有效。' }),
  ])
}

function offerRow(o) {
  const risk = o.risk === 'high'
  return h('div', { class: 'xfer' }, [
    h('div', { class: 'xfer-top' }, [
      h('span', { class: 'xfer-ic', text: kindIcon(o.kind) }),
      h('div', { class: 'xfer-meta' }, [
        h('div', { class: 'xfer-n', text: o.name }),
        h('div', { class: 'xfer-s', text: fmtSize(o.size) + (risk ? ' · 可执行文件' : '') + ' · 来自电脑' }),
      ]),
    ]),
    h('div', { class: 'xfer-btns' }, [
      h('button', { class: 'mini on', type: 'button', text: '接收', onclick: () => receive(o) }),
      h('button', { class: 'mini', type: 'button', text: '拒收', onclick: () => decline(o) }),
    ]),
  ])
}

function historyCard() {
  if (!history.length) return h('div', { class: 'card' }, [h('h2', { text: '最近传输' }), emptyBlock('还没有传输记录', '发送或接收后会留在这里')])
  return h('div', { class: 'card' }, [
    h('h2', { text: '最近传输' }),
    h(
      'div',
      { class: 'xfer-list' },
      history.slice(0, 12).map((it) =>
        h('div', { class: 'xfer' }, [
          h('div', { class: 'xfer-top' }, [
            h('span', { class: 'xfer-ic', text: it.dir === 'down' ? '↓' : '↑' }),
            h('div', { class: 'xfer-meta' }, [
              h('div', { class: 'xfer-n', text: it.name }),
              h('div', { class: 'xfer-s', text: fmtSize(it.size) + ' · ' + histState(it) + ' · ' + fmtAgo(it.at) }),
            ]),
          ]),
        ])
      )
    ),
  ])
}

function histState(it) {
  if (it.dir === 'down') {
    if (it.state === 'delivered') return '已接收'
    if (it.state === 'declined') return '已拒收'
    if (it.state === 'expired') return '已过期'
    return '待接收'
  }
  if (it.state === 'received') return '电脑已收到'
  if (it.state === 'aborted') return '已取消'
  return '发送中'
}

// ---------------------------------------------------------------- 动作

async function choose() {
  if (busyPick) return
  busyPick = true
  render()
  try {
    const f = await pickFile()
    if (f.size > maxFile) toast('超过 ' + fmtSize(maxFile) + ' 上限')
    else if (!f.size) toast('空文件不能发送')
    else picked = f
  } catch (e) {
    if (e.message !== '已取消') toast(e.message)
  } finally {
    busyPick = false
    render()
  }
}

function send() {
  if (!picked) return
  if (!canTransfer()) {
    toast('先配对电脑')
    return
  }
  const id = uploadFile({ uri: picked.uri, name: picked.name, size: picked.size, mime: picked.mime })
  if (!id) {
    toast('发送失败，检查网络后重试')
    return
  }
  picked = null
  render()
}

function retry(t) {
  if (t.dir === 'down') {
    const offer = offers.filter((o) => o.id === t.fileId)[0]
    if (!offer) {
      toast('电脑上的这个文件已过期，请让电脑重发')
      return
    }
    ACTIVE.delete(t.id)
    downloadFile(offer)
    render()
    return
  }
  const job = jobs()[t.id]
  if (!job || !job.uri) {
    toast('找不到原文件，请重新选择')
    return
  }
  const all = jobs()
  delete all[t.id]
  saveJobs(all)
  ACTIVE.delete(t.id)
  const id = uploadFile({ uri: job.uri, name: job.name, size: job.size, resumeId: job.fileId, sha: job.sha })
  if (!id) toast('无法续传，请重新选择文件')
  render()
}

async function receive(o) {
  if (!canTransfer()) {
    toast('先配对电脑')
    return
  }
  downloadFile(o)
  render()
}

async function decline(o) {
  if (!(await confirmAsync('拒收「' + o.name + '」？电脑端会看到已拒收。', '拒收'))) return
  try {
    await http(S.meta.host, '/api/v1/files/decline', { method: 'POST', body: { id: o.id }, token: S.meta.token })
    toast('已拒收')
    refresh()
  } catch (e) {
    toast(e.message || '操作失败')
  }
}
