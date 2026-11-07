/* 文件传输：桥接封装 + 纯函数 + 全局在途状态。
   原生负责二进制与加解密，这里只做「发起、进度汇总、重试」这几件事。 */

import { S } from './core.js'
import { hasBridge, ensureNativeHooks, onNative } from './native.js'

export const MAX_FILE = 512 * 1024 * 1024
export const CHUNK = 2 * 1024 * 1024

/** 正在进行的传输：页面来回切换也不丢，回到页面还能看到进度 */
export const ACTIVE = new Map()
const listeners = new Set()
let wired = false
let seq = 0

export function extOf(name) {
  const m = /\.([a-z0-9]{1,12})$/i.exec(String(name || ''))
  return m ? m[1].toLowerCase() : ''
}

const KIND = {
  image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic', 'heif', 'svg', 'avif'],
  video: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', '3gp'],
  audio: ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus', 'amr'],
  doc: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'csv', 'rtf', 'epub'],
  archive: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'],
  code: ['js', 'ts', 'json', 'html', 'css', 'py', 'java', 'go', 'rs', 'sh', 'yml', 'yaml', 'xml'],
}

const RISK = new Set([
  'exe', 'msi', 'msix', 'bat', 'cmd', 'com', 'scr', 'pif', 'ps1', 'psm1',
  'vbs', 'vbe', 'wsf', 'wsh', 'hta', 'jar', 'reg', 'lnk', 'apk', 'dll', 'sys',
])

export function kindOf(name) {
  const e = extOf(name)
  const keys = Object.keys(KIND)
  for (let i = 0; i < keys.length; i++) if (KIND[keys[i]].indexOf(e) >= 0) return keys[i]
  return 'other'
}

export function riskOf(name) {
  return RISK.has(extOf(name)) ? 'high' : 'normal'
}

export function fmtSize(n) {
  const v = Number(n) || 0
  if (v < 1024) return v + ' B'
  if (v < 1024 * 1024) return (v / 1024).toFixed(v < 10240 ? 1 : 0) + ' KB'
  if (v < 1024 * 1024 * 1024) return (v / 1048576).toFixed(v < 10 * 1048576 ? 1 : 0) + ' MB'
  return (v / 1073741824).toFixed(2) + ' GB'
}

export function kindIcon(kind) {
  return { image: '▣', video: '▶', audio: '♪', doc: '▤', archive: '▦', code: '⌘' }[kind] || '◇'
}

export function pctOf(sent, total) {
  const t = Number(total) || 0
  if (!t) return 0
  return Math.max(0, Math.min(100, Math.round((Number(sent) || 0) * 100 / t)))
}

/** 传输中显示「剩余 Ns」：只按本次会话均值估，不追求精确 */
export function etaText(sent, total, startedAt) {
  const left = (Number(total) || 0) - (Number(sent) || 0)
  const ms = Date.now() - (startedAt || Date.now())
  if (left <= 0) return ''
  if (ms < 800 || !sent) return '估算中'
  const speed = sent / (ms / 1000)
  if (!speed) return ''
  const sec = Math.ceil(left / speed)
  if (sec < 60) return '约 ' + sec + ' 秒'
  return '约 ' + Math.ceil(sec / 60) + ' 分钟'
}

export function canTransfer() {
  return !!(hasBridge() && S.meta.host && S.meta.token && window.Android.startUpload)
}

function wire() {
  if (wired) return
  wired = true
  ensureNativeHooks()
  onNative('transfer', (p) => {
    if (!p || !p.id) return
    const prev = ACTIVE.get(p.id) || {}
    const next = Object.assign({}, prev, p)
    if (p.state === 'done' || p.state === 'error' || p.state === 'canceled') next.finishedAt = Date.now()
    ACTIVE.set(p.id, next)
    listeners.forEach((fn) => {
      try {
        fn(next)
      } catch (e) {
        /* 页面渲染出错不该影响传输 */
      }
    })
  })
}

export function onTransfer(fn) {
  wire()
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function startWatching() {
  wire()
}

/** 打开系统文件选择器；取消时 reject('已取消')，页面按可选错误处理 */
export function pickFile() {
  if (!hasBridge() || !window.Android.pickFile) return Promise.reject(new Error('当前环境不支持选择文件'))
  wire()
  const id = 'p' + Date.now().toString(36) + ++seq
  return new Promise((resolve, reject) => {
    const off = onNative('pick', (p) => {
      if (!p || p.id !== id) return
      off()
      if (p.ok) resolve({ uri: p.uri, name: p.name, size: Number(p.size) || 0, mime: p.mime || '' })
      else reject(new Error(p.error || '已取消'))
    })
    try {
      window.Android.pickFile(id)
    } catch (e) {
      off()
      reject(e)
    }
  })
}

/** 发起上传（手机 → 电脑）。resumeId/sha 存在时会从服务端记录的位置续传 */
export function uploadFile(opt) {
  if (!canTransfer()) return null
  wire()
  const id = 'u' + Date.now().toString(36) + ++seq
  ACTIVE.set(id, {
    id,
    name: opt.name,
    size: opt.size,
    sent: 0,
    state: 'hashing',
    dir: 'up',
    startedAt: Date.now(),
    uri: opt.uri,
  })
  try {
    window.Android.startUpload(
      id,
      opt.uri,
      opt.name,
      opt.size,
      opt.mime || '',
      S.meta.host,
      S.meta.token,
      opt.resumeId || '',
      opt.sha || ''
    )
  } catch (e) {
    ACTIVE.set(id, Object.assign({}, ACTIVE.get(id), { state: 'error', message: e.message }))
    return null
  }
  return id
}

/** 接收电脑发来的文件 */
export function downloadFile(offer) {
  if (!canTransfer()) return null
  wire()
  const id = 'd' + offer.id
  if (ACTIVE.has(id) && ACTIVE.get(id).state === 'downloading') return id
  ACTIVE.set(id, {
    id,
    fileId: offer.id,
    name: offer.name,
    size: offer.size,
    sent: 0,
    state: 'downloading',
    dir: 'down',
    startedAt: Date.now(),
  })
  try {
    window.Android.startDownload(id, offer.id, offer.name, offer.size, offer.sha256 || '', S.meta.host, S.meta.token)
  } catch (e) {
    ACTIVE.set(id, Object.assign({}, ACTIVE.get(id), { state: 'error', message: e.message }))
    return null
  }
  return id
}

export function cancelTransfer(id) {
  if (!hasBridge() || !window.Android.cancelTransfer) return
  try {
    window.Android.cancelTransfer(id)
  } catch (e) {
    /* 任务可能已经结束 */
  }
}

export function clearFinished() {
  ACTIVE.forEach((v, k) => {
    if (v.state === 'done' || v.state === 'error' || v.state === 'canceled') ACTIVE.delete(k)
  })
}
