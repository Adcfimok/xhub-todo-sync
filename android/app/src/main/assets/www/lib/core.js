/* 内核：本地库 / 时钟 / 状态 / 同步。所有页面只通过这里读写数据。 */

export const COLS = ['todos', 'notes', 'stickies', 'resources', 'snippets']
export const COL_NAME = { todos: '待办', notes: '笔记', stickies: '便签', resources: '速达', snippets: '提示词' }
export const DB_NAME = 'todolink'
export const DB_VER = 2
/** 版本号优先取原生（与 APK 的 versionName 同源），取不到才回退到构建常量 */
export const APP_VER = (function () {
  try {
    const v = window.Android && window.Android.appVersion && window.Android.appVersion()
    return (v && String(v)) || '2.12.1'
  } catch (e) {
    return '2.12.1'
  }
})()

const REQ_TIMEOUT = 9000

// ---------------------------------------------------------------- IndexedDB

let dbp = null
function idb() {
  if (dbp) return dbp
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER)
    req.onupgradeneeded = () => {
      const d = req.result
      if (!d.objectStoreNames.contains('records')) d.createObjectStore('records', { keyPath: 'id' })
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'k' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbp
}

export function idbAll(store) {
  return idb().then(
    (d) =>
      new Promise((resolve, reject) => {
        const rq = d.transaction(store, 'readonly').objectStore(store).getAll()
        rq.onsuccess = () => resolve(rq.result || [])
        rq.onerror = () => reject(rq.error)
      })
  )
}

export function idbWrite(ops) {
  if (!ops.length) return Promise.resolve()
  return idb().then(
    (d) =>
      new Promise((resolve, reject) => {
        const tx = d.transaction(['records', 'meta'], 'readwrite')
        const recs = tx.objectStore('records')
        const meta = tx.objectStore('meta')
        ops.forEach((op) => {
          if (op.type === 'put') recs.put(op.value)
          else if (op.type === 'del') recs.delete(op.key)
          else if (op.type === 'meta') meta.put({ k: op.key, v: op.value })
        })
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error)
      })
  )
}

// ---------------------------------------------------------------- 时钟

const CLOCK = { t: 0, c: 0, node: '0000' }
const pad = (n, w) => n.toString(16).padStart(w, '0')

export function hlcNext() {
  const now = Date.now()
  if (now > CLOCK.t) {
    CLOCK.t = now
    CLOCK.c = 0
  } else {
    CLOCK.c += 1
    if (CLOCK.c > 0xffff) {
      CLOCK.t += 1
      CLOCK.c = 0
    }
  }
  return pad(CLOCK.t, 16) + '-' + pad(CLOCK.c, 4) + '-' + CLOCK.node
}

export function hlcObserve(hlc) {
  if (typeof hlc !== 'string' || hlc.length !== 26) return
  const t = parseInt(hlc.slice(0, 16), 16)
  const c = parseInt(hlc.slice(17, 21), 16)
  if (!isFinite(t) || !isFinite(c)) return
  const now = Date.now()
  const nt = Math.max(now, CLOCK.t, t)
  let nc
  if (nt === CLOCK.t && nt === t) nc = Math.max(CLOCK.c, c) + 1
  else if (nt === CLOCK.t) nc = CLOCK.c + 1
  else if (nt === t) nc = c + 1
  else nc = 0
  if (nc > 0xffff) {
    CLOCK.t = nt + 1
    CLOCK.c = 0
  } else {
    CLOCK.t = nt
    CLOCK.c = nc
  }
}

export function shortCode(s) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return (h & 0xffff).toString(16).padStart(4, '0')
}

export function uuid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '').slice(0, 16)
  return Math.random().toString(16).slice(2, 10) + Math.random().toString(16).slice(2, 10)
}

// ---------------------------------------------------------------- 状态

export const S = {
  records: [],
  meta: {},
  status: 'offline',
  statusText: '未配对',
  conflicts: [],
  syncAt: 0,
  lastErr: '',
  streamOk: false,
  listeners: new Set(),
}

export function onChange(fn) {
  S.listeners.add(fn)
  return () => S.listeners.delete(fn)
}

export function emit() {
  for (const fn of S.listeners) {
    try {
      fn()
    } catch (e) {
      console.error(e)
    }
  }
}

export function colRecords(col) {
  return S.records.filter((r) => r.col === col && !r.deleted)
}

export function findRec(id) {
  for (let i = 0; i < S.records.length; i++) if (S.records[i].id === id) return S.records[i]
  return null
}

export function saveMeta(key, value) {
  S.meta[key] = value
  return idbWrite([{ type: 'meta', key, value }])
}

// ---------------------------------------------------------------- 记录

export function makeId(col) {
  return col + ':a' + uuid()
}

export function newRecord(col, fields) {
  const now = Date.now()
  const rec = Object.assign(
    { id: makeId(col), col, deleted: false, dirty: 1, hostId: null, updatedAt: now, createdAt: now },
    fields || {}
  )
  rec.hlc = hlcNext()
  S.records.push(rec)
  return rec
}

/** 修改一条记录：更新时间戳、标脏、落盘 */
export async function touch(rec, fields) {
  Object.assign(rec, fields || {})
  rec.updatedAt = Date.now()
  rec.hlc = hlcNext()
  rec.dirty = 1
  await idbWrite([{ type: 'put', value: rec }])
  emit()
  scheduleSoon()
  return rec
}

export async function softDelete(rec) {
  rec.deleted = true
  rec.updatedAt = Date.now()
  rec.hlc = hlcNext()
  rec.dirty = 1
  await idbWrite([{ type: 'put', value: rec }])
  emit()
  scheduleSoon()
}

// ---------------------------------------------------------------- HTTP

export function normalizeHost(v) {
  let s = String(v || '').trim()
  s = s.replace(/^https?:\/\//i, '').replace(/\/+$/, '')
  if (!s) return ''
  if (!/:\d+$/.test(s)) s += ':47821'
  return s
}

export async function http(host, path, opts = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), opts.timeout || REQ_TIMEOUT)
  const headers = {}
  if (opts.body) headers['Content-Type'] = 'application/json'
  if (opts.token) headers['Authorization'] = 'Bearer ' + opts.token
  try {
    const r = await fetch('http://' + host + path, {
      method: opts.method || 'GET',
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: ctrl.signal,
      cache: 'no-store',
    })
    const txt = await r.text()
    let data = null
    try {
      data = txt ? JSON.parse(txt) : null
    } catch {
      data = null
    }
    if (!r.ok) {
      const err = new Error((data && (data.message || data.code)) || 'HTTP ' + r.status)
      err.status = r.status
      err.code = data && data.code
      throw err
    }
    return data
  } catch (e) {
    if (e.name === 'AbortError') {
      const t = new Error('连接超时')
      t.timeout = true
      throw t
    }
    throw e
  } finally {
    clearTimeout(timer)
  }
}

/** 电脑中转调用 AI（手机端不直连外网供应商） */
export function hubUrl(path) {
  return 'http://' + (S.meta.host || '') + path
}

export function authHeaders() {
  return { Authorization: 'Bearer ' + (S.meta.token || '') }
}

// ---------------------------------------------------------------- 同步

const SYNC = { busy: false, fails: 0, timer: null }

export function setStatus(state, text) {
  S.status = state
  S.statusText = text
  emit()
}

export function scheduleSoon() {
  clearTimeout(SYNC.timer)
  SYNC.timer = setTimeout(() => syncNow('local'), 800)
}

function scheduleBackoff() {
  const n = Math.min(5, SYNC.fails)
  const base = Math.min(60000, 2000 * Math.pow(2, n))
  const jitter = base * 0.2 * (Math.random() * 2 - 1)
  clearTimeout(SYNC.timer)
  SYNC.timer = setTimeout(() => syncNow('retry'), Math.max(1500, base + jitter))
}

// ---------------------------------------------------------------- 实时推送
// 服务端 /api/v1/stream 早就实现了，但手机端一直靠 30 秒定时器发现改动，
// 导致「PC 改完，手机半分钟后才变」。接上 SSE 后基本即时；
// EventSource 不能设请求头，所以令牌走查询参数（服务端两种都认）。

let es = null
let esFails = 0

export function connectStream() {
  if (typeof EventSource === 'undefined') return
  if (!S.meta.token || !S.meta.host) return
  if (es && es.readyState !== EventSource.CLOSED) return
  const url = 'http://' + S.meta.host + '/api/v1/stream?token=' + encodeURIComponent(S.meta.token)
  try {
    es = new EventSource(url)
  } catch (e) {
    es = null
    return
  }
  es.addEventListener('hello', () => {
    esFails = 0
    S.streamOk = true
    scheduleSoon()
  })
  es.addEventListener('change', () => scheduleSoon())
  es.onerror = () => {
    esFails += 1
    S.streamOk = false
    // 连续失败就关掉，交回 30 秒轮询兜底，别让它在后台空转重连
    if (esFails > 5 && es) {
      try { es.close() } catch (e) {}
      es = null
    }
  }
}

export function closeStream() {
  if (!es) return
  try { es.close() } catch (e) {}
  es = null
  esFails = 0
  S.streamOk = false
}

function strip(r) {
  const out = {}
  for (const k of Object.keys(r)) if (k !== 'dirty') out[k] = r[k]
  return out
}

export async function syncNow(reason) {
  if (SYNC.busy) return
  if (!S.meta.token || !S.meta.host) {
    setStatus('offline', '未配对')
    return
  }
  SYNC.busy = true
  setStatus('syncing', '同步中…')
  try {
    const dirty = S.records.filter((r) => r.dirty)
    const pushed = dirty.map((r) => ({ id: r.id, hlc: r.hlc }))
    const res = await http(S.meta.host, '/api/v1/sync', {
      method: 'POST',
      token: S.meta.token,
      body: {
        deviceId: S.meta.deviceId,
        sinceSeq: S.meta.lastSeq || 0,
        changes: dirty.map(strip),
        cols: COLS,
        limit: 500,
      },
    })

    if (res.resyncRequired) await pullSnapshot()
    else {
      await applyIncoming(res.changes || [])
      await saveMeta('lastSeq', res.seq || 0)
    }

    const rejected = {}
    ;(res.rejected || []).forEach((x) => (rejected[x.id] = x))
    const ops = []
    pushed.forEach((p) => {
      const r = findRec(p.id)
      if (!r || !r.dirty) return
      const rej = rejected[p.id]
      if (rej) {
        // 被拒绝＝服务端已有更新版本。以前这里直接清 dirty，
        // 结果这条改动既不重试、也等不到覆盖，永远悬空且用户无感。
        // 现在：记进冲突表 + 标 blocked，让胜出版本能落地，同时留下原值可查。
        addConflict({
          col: r.col,
          id: r.id,
          title: r.title,
          fields: diffFields(r, rej.winner || {}),
          winner: 'pc-host',
          loser: 'phone',
          reason: rej.reason || 'STALE',
          localHlc: r.hlc,
          remoteHlc: rej.winnerHlc || '',
        })
        r.dirty = 0
        r.blocked = 1
        ops.push({ type: 'put', value: r })
        return
      }
      // 只有确认服务端收下了（hlc 未变）才清脏标记
      if (r.hlc === p.hlc) {
        r.dirty = 0
        ops.push({ type: 'put', value: r })
      }
    })
    if (ops.length) await idbWrite(ops)

    if (res.conflicts && res.conflicts.length) {
      res.conflicts.forEach((c) =>
        addConflict({ col: c.col, id: c.id, title: c.title, fields: c.fields, winner: c.winner, loser: c.loser })
      )
      setStatus('conflict', res.conflicts.length + ' 条冲突')
    } else setStatus('online', '已连接')

    SYNC.fails = 0
    S.syncAt = Date.now()
    S.lastErr = ''
    emit()
    if (res.hasMore) scheduleSoon()
  } catch (e) {
    SYNC.fails += 1
    S.lastErr = String((e && e.message) || e)
    if (e && e.status === 401) {
      await saveMeta('token', '')
      closeStream()
      setStatus('error', '需要重新配对')
    } else {
      setStatus('offline', e && e.timeout ? '电脑无响应' : '离线')
      scheduleBackoff()
    }
    emit()
  } finally {
    SYNC.busy = false
  }
}

function addConflict(c) {
  S.conflicts.unshift(Object.assign({ at: Date.now() }, c))
  if (S.conflicts.length > 50) S.conflicts.length = 50
}

/** 冲突涉及的可比较字段（与 PC 端 store 的 KEEP 白名单对齐） */
const DIFF_FIELDS = {
  todos: ['title', 'done', 'priority', 'dueAt', 'description', 'pinned'],
  notes: ['title', 'content'],
  stickies: ['content'],
  resources: ['name', 'target'],
  snippets: ['title', 'content'],
}

/**
 * 算「本地版本与胜出版本」具体差在哪几个字段。
 * 以前这里恒传空数组，界面上只能说「有冲突」，说不出冲突了什么。
 */
function diffFields(loser, winner) {
  if (!loser || !winner) return []
  const keys = DIFF_FIELDS[loser.col] || DIFF_FIELDS[winner.col] || ['title']
  const out = []
  for (const k of keys) {
    const a = loser[k] == null ? '' : String(loser[k])
    const b = winner[k] == null ? '' : String(winner[k])
    if (a !== b) out.push(k)
  }
  if (!!loser.deleted !== !!winner.deleted) out.push('deleted')
  return out
}

async function applyIncoming(list) {
  const ops = []
  for (const inc of list) {
    if (!inc || !inc.id) continue
    hlcObserve(inc.hlc)
    const local = findRec(inc.id)
    // blocked 是「本地版本已被服务端判定过期」的标记，此时必须让远端版本落地，
    // 否则本地那条既不会重试、也永远等不到覆盖
    if (local && local.dirty && !local.blocked && local.hlc && local.hlc > inc.hlc) continue
    if (local && local.dirty && !local.blocked && local.hlc !== inc.hlc) {
      addConflict({
        col: inc.col,
        id: inc.id,
        title: inc.title,
        fields: diffFields(local, inc),
        winner: 'pc-host',
        loser: 'phone',
      })
    }
    const rec = Object.assign({}, inc, { dirty: 0, blocked: 0 })
    if (local) Object.assign(local, rec)
    else S.records.push(rec)
    ops.push({ type: 'put', value: rec })
  }
  if (ops.length) await idbWrite(ops)
}

export async function pullSnapshot() {
  const snap = await http(S.meta.host, '/api/v1/snapshot?cols=' + COLS.join(','), { token: S.meta.token })
  const map = {}
  ;(snap.records || []).forEach((r) => (map[r.id] = Object.assign({}, r, { dirty: 0 })))
  S.records.forEach((r) => {
    if (r.dirty && (!map[r.id] || map[r.id].hlc < r.hlc)) map[r.id] = r
  })
  S.records = Object.keys(map).map((k) => map[k])
  await idbWrite(S.records.map((r) => ({ type: 'put', value: r })))
  await saveMeta('lastSeq', snap.seq || 0)
}

export async function pair(host, code, deviceName) {
  const ping = await http(host, '/api/v1/ping', { timeout: 6000 })
  if (!ping.proto) throw new Error('电脑端协议版本不匹配')
  const res = await http(host, '/api/v1/pair', {
    method: 'POST',
    body: {
      code,
      device: {
        id: S.meta.deviceId,
        name: deviceName || S.meta.deviceName || 'Android',
        platform: 'android',
        appVersion: APP_VER,
      },
    },
  })
  await saveMeta('token', res.token)
  await saveMeta('host', host)
  await saveMeta('hubId', res.hubId || '')
  await saveMeta('proto', res.proto || 2)
  await saveMeta('lastSeq', 0)
  setStatus('online', '已连接')
  connectStream()
  await pullSnapshot()
  await syncNow('pair')
  return res
}

export async function boot() {
  const devName = (window.Android && window.Android.deviceName && window.Android.deviceName()) || 'Android 设备'
  const metas = await idbAll('meta')
  metas.forEach((m) => (S.meta[m.k] = m.v))
  if (!S.meta.deviceId) await saveMeta('deviceId', 'and-' + uuid().slice(0, 10))
  if (!S.meta.deviceName) await saveMeta('deviceName', devName)
  CLOCK.node = shortCode(S.meta.deviceId)

  const recs = await idbAll('records')
  recs.forEach((r) => {
    if (r.hlc) hlcObserve(r.hlc)
    S.records.push(r)
  })
  setStatus(S.meta.token ? 'offline' : 'offline', S.meta.token ? '离线' : '未配对')
  emit()
  if (S.meta.token) {
    connectStream()
    syncNow('boot')
  }

  let tick = 0
  setInterval(() => {
    if (document.hidden) return
    if (S.status === 'syncing') return
    tick++
    // SSE 正常时把兜底轮询从 30 秒放宽到 120 秒；断线立刻回到 30 秒
    if (S.streamOk && tick % 4 !== 0) return
    syncNow('tick')
  }, 30000)
}
