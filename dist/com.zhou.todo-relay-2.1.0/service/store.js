'use strict'
/**
 * 同步中枢的持久状态与合并逻辑（多集合版）。
 *
 * 集合：todos / notes / stickies / resources / snippets —— 对应宿主 data.* 的五组能力。
 * 每条记录 id 形如 `todos:h12`（宿主行）或 `notes:a9f3…`（手机新建），前缀即集合名，
 * 因此合并、回写、落盘都不需要额外的类型字段。
 *
 * 设计要点：
 * - 全部状态在内存，落盘是防丢而不是读源：写路径先改内存再异步刷盘。
 * - 记录级 LWW：比较 HLC 字符串即可，定宽保证字典序 == 时间序。
 * - 宿主（PC 本机）也是一个对等写入方，用 hostId 关联，不特殊对待。
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { Clock, compare } = require('./hlc')

const DATA_DIR = process.env.RELAY_DATA_DIR
  ? path.resolve(process.env.RELAY_DATA_DIR)
  : path.join(__dirname, '..', '.data')
const DATA_FILE = path.join(DATA_DIR, 'hub.json')
const LOG_LIMIT = 4000
const CONFLICT_LIMIT = 200
const TOMBSTONE_MS = 30 * 24 * 3600 * 1000
const PAIR_TTL_MS = 5 * 60 * 1000
const MAX_DEVICES = 8
const HOST_DEVICE = 'pc-host'

const COLLECTIONS = ['todos', 'notes', 'stickies', 'resources', 'snippets']

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex')
}

function emptyState(hubName) {
  return {
    v: 2,
    hubId: crypto.randomBytes(8).toString('hex'),
    hubName: hubName || 'x-hub',
    createdAt: Date.now(),
    seq: 0,
    records: {},
    log: [],
    devices: {},
    conflicts: [],
    host: { mirror: {}, cursor: 0, outbox: [] },
    pair: null,
  }
}

/** 宿主 `updated_at` 是本地时间文本（YYYY-MM-DD HH:MM:SS.SSS），转毫秒 */
function parseHostTime(s) {
  if (!s) return 0
  const t = Date.parse(String(s).replace(' ', 'T'))
  return Number.isFinite(t) ? t : 0
}

class Store {
  constructor(hubName) {
    this.clock = new Clock('hub-' + (hubName || 'x-hub'))
    const loaded = this.load()
    this.state = loaded && loaded.v === 2 ? loaded : emptyState(hubName)
    this.hostIndex = {}
    for (const rec of Object.values(this.state.records)) {
      if (rec.hostId != null) this.hostIndex[rec.col + ':' + rec.hostId] = rec.id
    }
    this.saveTimer = null
    this.dirty = false
    this.listeners = new Set()
  }

  // ---------- 持久化 ----------

  load() {
    try {
      const raw = fs.readFileSync(DATA_FILE, 'utf8')
      const s = JSON.parse(raw)
      if (!s || typeof s !== 'object' || typeof s.records !== 'object') return null
      return s
    } catch (e) {
      if (e.code !== 'ENOENT') console.error('[store] 读取失败，按空库启动:', e.message)
      return null
    }
  }

  scheduleSave() {
    this.dirty = true
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.flush()
    }, 400)
  }

  flush() {
    if (!this.dirty) return
    this.dirty = false
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true })
      const tmp = DATA_FILE + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(this.state))
      fs.renameSync(tmp, DATA_FILE)
    } catch (e) {
      console.error('[store] 落盘失败:', e.message)
    }
  }

  // ---------- 订阅（SSE 用） ----------

  onChange(fn) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  emit(event, payload) {
    for (const fn of this.listeners) {
      try {
        fn(event, payload)
      } catch (_) {
        /* 单个订阅者异常不影响其它连接 */
      }
    }
  }

  // ---------- 记录 ----------

  get(id) {
    return this.state.records[id] || null
  }

  nextSeq() {
    this.state.seq += 1
    return this.state.seq
  }

  commit(rec) {
    const seq = this.nextSeq()
    rec.seq = seq
    this.state.records[rec.id] = rec
    if (rec.hostId != null) this.hostIndex[rec.col + ':' + rec.hostId] = rec.id
    this.state.log.push({ seq, id: rec.id })
    if (this.state.log.length > LOG_LIMIT) {
      this.state.log.splice(0, this.state.log.length - LOG_LIMIT)
    }
    this.scheduleSave()
    this.emit('change', { seq, id: rec.id, col: rec.col })
    return rec
  }

  minSeq() {
    return this.state.log.length ? this.state.log[0].seq : this.state.seq
  }

  changesSince(sinceSeq, limit, cols) {
    const out = []
    let hasMore = false
    for (const e of this.state.log) {
      if (e.seq <= sinceSeq) continue
      const rec = this.state.records[e.id]
      if (!rec) continue
      if (cols && cols.length && cols.indexOf(rec.col) < 0) continue
      if (out.length >= limit) {
        hasMore = true
        break
      }
      out.push(rec)
    }
    return { changes: out, hasMore }
  }

  snapshot(cols) {
    const records = []
    const cutoff = Date.now() - TOMBSTONE_MS
    for (const rec of Object.values(this.state.records)) {
      if (cols && cols.length && cols.indexOf(rec.col) < 0) continue
      if (rec.deleted && parseMs(rec.hlc) < cutoff) continue
      records.push(rec)
    }
    return { seq: this.state.seq, records }
  }

  /** 记一条冲突。同一条记录的同一个败方版本只记一次（重放同步不会刷屏）。 */
  logConflict(winner, winnerDevice, loser, loserDevice) {
    if (!winner || !loser) return null
    const fields = diffFields(loser, winner)
    if (!fields.length) return null
    const dup = this.state.conflicts.find((c) => c.id === winner.id && c.loser && c.loser.hlc === loser.hlc)
    if (dup) return null
    const conflict = {
      at: Date.now(),
      col: winner.col,
      id: winner.id,
      title: winner.title || loser.title || winner.id,
      fields,
      winner: { device: winnerDevice || winner.by || HOST_DEVICE, hlc: winner.hlc, record: clone(winner) },
      loser: { device: loserDevice || loser.by || '?', hlc: loser.hlc, record: clone(loser) },
    }
    this.state.conflicts.unshift(conflict)
    if (this.state.conflicts.length > CONFLICT_LIMIT) this.state.conflicts.length = CONFLICT_LIMIT
    this.scheduleSave()
    return conflict
  }

  /** 合并一条远端记录 */
  merge(incoming, deviceId) {
    const rec = normalizeRecord(incoming)
    if (!rec) return { accepted: false, reason: 'BAD_RECORD' }
    this.clock.observe(rec.hlc)

    const local = this.state.records[rec.id]
    if (!local) {
      rec.by = deviceId
      this.commit(rec)
      if (deviceId !== HOST_DEVICE) this.pushOutbox(rec.id, rec.seq)
      return { accepted: true }
    }
    if (local.hlc === rec.hlc) {
      return { accepted: false, reason: 'DUPLICATE' }
    }
    if (compare(rec.hlc, local.hlc) <= 0) {
      if (local.hlc !== rec.hlc) this.logConflict(local, local.by, rec, deviceId)
      return { accepted: false, reason: 'STALE', winnerHlc: local.hlc }
    }

    let conflict = null
    if (local.by && local.by !== deviceId) conflict = this.logConflict(rec, deviceId, local, local.by)

    rec.by = deviceId
    if (rec.hostId == null && local.hostId != null) rec.hostId = local.hostId
    this.commit(rec)
    if (deviceId !== HOST_DEVICE) this.pushOutbox(rec.id, rec.seq)
    return { accepted: true, conflict }
  }

  // ---------- 宿主桥接 ----------

  /**
   * 某一集合的本机快照 → 中枢。
   * @param {string} col 集合名
   * @param {Array} rows 宿主行（snake_case 或 camelCase 均可）
   * @param {{full?:boolean,allowEmpty?:boolean}} opts full=false 时不做「消失即删除」推断；
   *        allowEmpty=true 才允许用空快照把已有记录判成删除
   */
  applyHostSnapshot(col, rows, nowMs, opts) {
    if (COLLECTIONS.indexOf(col) < 0) return { created: 0, updated: 0, skipped: 0 }
    const now = nowMs || Date.now()
    const full = !opts || opts.full !== false
    const seen = new Set()
    let created = 0
    let updated = 0
    let skipped = 0

    for (const row of rows) {
      if (!row || row.id == null) continue
      const hostId = /^\d+$/.test(String(row.id)) ? Number(row.id) : String(row.id)
      seen.add(String(hostId))
      const indexKey = col + ':' + hostId
      const id = this.hostIndex[indexKey] || col + ':h' + hostId
      const local = this.state.records[id]
      const mirror = this.state.host.mirror[indexKey]

      if (!local) {
        const rec = fromHostRow(col, row, id, this.clock.next(now), null)
        if (!rec) continue
        rec.by = HOST_DEVICE
        this.commit(rec)
        this.state.host.mirror[indexKey] = { version: versionOf(row), id }
        created++
        continue
      }

      const version = versionOf(row)
      if (mirror && mirror.version === version) continue

      const hostMs = parseHostTime(row.updatedAt || row.updated_at)
      const hubMs = parseMs(local.hlc)
      if (hubMs > hostMs + 1000) {
        skipped++
        continue
      }

      const rec = fromHostRow(col, row, id, this.clock.next(now), local)
      if (!rec) continue
      rec.by = HOST_DEVICE
      rec.seq = local.seq
      if (local.by && local.by !== HOST_DEVICE) this.logConflict(rec, HOST_DEVICE, local, local.by)
      this.commit(rec)
      this.state.host.mirror[indexKey] = { version, id }
      updated++
    }

    if (full) {
      const prefix = col + ':'
      // 空快照不等于「宿主全删了」：页面刚载入、某一类读失败、或另开着一个数据更旧的
      // 页面，都可能送来 rows=[]。这时批量打墓碑会把手机上还好的数据连带删掉。
      // 规则：空快照默认只做 upsert；要真删到底得调用方连续确认后显式 allowEmpty。
      const mirrorCount = Object.keys(this.state.host.mirror).filter((k) => k.indexOf(prefix) === 0).length
      if (rows.length === 0 && mirrorCount > 0 && !(opts && opts.allowEmpty)) {
        try {
          console.log(`[todo-relay] skip empty snapshot ${col} mirror=${mirrorCount}（未确认，保留原记录）`)
        } catch (e) {}
        this.scheduleSave()
        return { created, updated, skipped, pruned: 0, prunedSkipped: true }
      }
      for (const [indexKey, mirror] of Object.entries(this.state.host.mirror)) {
        if (indexKey.indexOf(prefix) !== 0) continue
        const hostIdRaw = indexKey.slice(prefix.length)
        if (seen.has(hostIdRaw)) continue
        const rec = this.state.records[mirror.id]
        delete this.state.host.mirror[indexKey]
        if (!rec || rec.deleted) continue
        // 删一条是重操作，留痕：排查「宿主明明有、中枢却没了」时靠这行定位
        try {
          console.log(`[todo-relay] tombstone ${col} hostId=${hostIdRaw} rows=${rows.length} id=${mirror.id}`)
        } catch (e) {}
        const tomb = Object.assign({}, rec, {
          deleted: true,
          hlc: this.clock.next(now),
          by: HOST_DEVICE,
          updatedAt: now,
        })
        tomb.seq = rec.seq
        this.commit(tomb)
        updated++
      }
    }

    this.scheduleSave()
    return { created, updated, skipped }
  }

  /** 待回写到宿主的记录（来自非 PC 设备） */
  outbound(limit, cols) {
    const out = []
    let cursor = this.state.host.cursor
    for (const e of this.state.host.outbox) {
      if (e.seq <= this.state.host.cursor) continue
      if (out.length >= limit) break
      const rec = this.state.records[e.id]
      if (!rec) continue
      if (cols && cols.length && cols.indexOf(rec.col) < 0) continue
      out.push(rec)
      cursor = e.seq
    }
    return { items: out, cursor }
  }

  ackHost(cursor, applied) {
    const c = Number(cursor) || 0
    if (c > this.state.host.cursor) this.state.host.cursor = c
    if (Array.isArray(applied)) {
      for (const a of applied) {
        if (!a || !a.id) continue
        const rec = this.state.records[a.id]
        if (!rec) continue
        if (a.hostId != null) {
          rec.hostId = /^\d+$/.test(String(a.hostId)) ? Number(a.hostId) : a.hostId
          this.hostIndex[rec.col + ':' + rec.hostId] = rec.id
        }
        if (rec.hostId != null && a.hostVersion != null) {
          const key = rec.col + ':' + rec.hostId
          const prev = this.state.host.mirror[key]
          if (!prev || String(a.hostVersion) !== String(prev.version)) {
            this.state.host.mirror[key] = { version: a.hostVersion, id: rec.id }
          }
        }
      }
    }
    this.state.host.outbox = this.state.host.outbox.filter((e) => e.seq > this.state.host.cursor)
    this.scheduleSave()
  }

  pushOutbox(id, seq) {
    this.state.host.outbox.push({ id, seq })
    if (this.state.host.outbox.length > LOG_LIMIT) this.state.host.outbox.splice(0, 500)
  }

  // ---------- 配对与设备 ----------

  pairCode() {
    const now = Date.now()
    const p = this.state.pair
    if (p && p.expiresAt > now) return p
    const code = String(crypto.randomInt(100000, 1000000))
    this.state.pair = { code, expiresAt: now + PAIR_TTL_MS, attempts: 0 }
    this.scheduleSave()
    return this.state.pair
  }

  verifyCode(code) {
    const p = this.state.pair
    if (!p) return { ok: false, reason: 'INVALID_CODE' }
    if (p.expiresAt <= Date.now()) return { ok: false, reason: 'INVALID_CODE' }
    if (String(code) !== p.code) {
      p.attempts += 1
      return { ok: false, reason: p.attempts >= 5 ? 'TOO_MANY_ATTEMPTS' : 'INVALID_CODE' }
    }
    return { ok: true }
  }

  rotateCode() {
    this.state.pair = null
    return this.pairCode()
  }

  deviceCount() {
    return Object.keys(this.state.devices).length
  }

  pairDevice(device) {
    const id = String(device.id || '').slice(0, 64)
    if (!id) return { ok: false, reason: 'BAD_REQUEST' }
    const existing = this.state.devices[id]
    if (!existing && this.deviceCount() >= MAX_DEVICES) return { ok: false, reason: 'DEVICE_LIMIT' }

    const token = crypto.randomBytes(32).toString('hex')
    this.state.devices[id] = {
      id,
      name: String(device.name || '未命名设备').slice(0, 40),
      platform: String(device.platform || 'android').slice(0, 16),
      appVersion: String(device.appVersion || '').slice(0, 16),
      tokenHash: sha256(token),
      pairedAt: existing ? existing.pairedAt : Date.now(),
      lastSeen: Date.now(),
      revoked: false,
      cursor: existing ? existing.cursor || 0 : 0,
    }
    this.state.pair = null
    this.scheduleSave()
    this.emit('peer', { deviceId: id, online: true })
    return { ok: true, token, device: this.state.devices[id] }
  }

  auth(token) {
    if (!token) return null
    const h = sha256(token)
    for (const d of Object.values(this.state.devices)) {
      if (d.revoked) continue
      if (d.tokenHash === h) return d
    }
    return null
  }

  touch(deviceId) {
    const d = this.state.devices[deviceId]
    if (!d) return
    const wasOffline = !d.lastSeen || Date.now() - d.lastSeen > 90 * 1000
    d.lastSeen = Date.now()
    if (wasOffline) this.emit('peer', { deviceId, online: true })
  }

  revoke(deviceId) {
    const d = this.state.devices[deviceId]
    if (!d) return false
    d.revoked = true
    this.scheduleSave()
    this.emit('peer', { deviceId, online: false })
    return true
  }

  deviceList() {
    return Object.values(this.state.devices).map((d) => ({
      id: d.id,
      name: d.name,
      platform: d.platform,
      appVersion: d.appVersion,
      pairedAt: d.pairedAt,
      lastSeen: d.lastSeen,
      revoked: d.revoked,
      online: !d.revoked && Date.now() - (d.lastSeen || 0) < 90 * 1000,
    }))
  }

  // ---------- 维护 ----------

  stats() {
    const byCol = {}
    for (const c of COLLECTIONS) byCol[c] = { live: 0, deleted: 0 }
    for (const r of Object.values(this.state.records)) {
      const b = byCol[r.col]
      if (!b) continue
      if (r.deleted) b.deleted++
      else b.live++
    }
    return {
      total: Object.values(byCol).reduce((n, b) => n + b.live, 0),
      deleted: Object.values(byCol).reduce((n, b) => n + b.deleted, 0),
      pendingHost: this.state.host.outbox.length,
      conflicts: this.state.conflicts.length,
      seq: this.state.seq,
      minSeq: this.minSeq(),
      byCol,
    }
  }

  purgeTombstones() {
    const cutoff = Date.now() - TOMBSTONE_MS
    let n = 0
    for (const [id, rec] of Object.entries(this.state.records)) {
      if (rec.deleted && parseMs(rec.hlc) < cutoff) {
        delete this.state.records[id]
        if (rec.hostId != null) delete this.hostIndex[rec.col + ':' + rec.hostId]
        n++
      }
    }
    if (n) this.scheduleSave()
    return n
  }
}

// ---------- 纯函数 ----------

function parseMs(hlc) {
  if (typeof hlc !== 'string' || hlc.length < 16) return 0
  const t = parseInt(hlc.slice(0, 16), 16)
  return Number.isFinite(t) ? t : 0
}

function clone(o) {
  return JSON.parse(JSON.stringify(o))
}

/** 各集合参与比较的业务字段；顺序即冲突日志里的展示顺序 */
const FIELDS = {
  todos: ['title', 'done', 'priority', 'dueAt', 'remindAt', 'description', 'parentId', 'pinned', 'repeatMode', 'completedAt', 'deleted'],
  notes: ['title', 'content', 'folderId', 'deleted'],
  stickies: ['content', 'deleted'],
  resources: ['kind', 'name', 'target', 'category', 'icon', 'args', 'zoneId', 'deleted'],
  snippets: ['title', 'content', 'pinned', 'deleted'],
}

function diffFields(a, b) {
  const keys = FIELDS[b.col] || ['title', 'deleted']
  const out = []
  for (const f of keys) {
    const av = a[f] === undefined ? null : a[f]
    const bv = b[f] === undefined ? null : b[f]
    if (JSON.stringify(av) !== JSON.stringify(bv)) out.push(f)
  }
  return out
}

function versionOf(row) {
  const v = row.version != null ? row.version : row.updatedAt || row.updated_at || ''
  return v === '' ? 0 : v
}

function parseId(id) {
  const s = String(id)
  const i = s.indexOf(':')
  if (i <= 0) return null
  const col = s.slice(0, i)
  if (COLLECTIONS.indexOf(col) < 0) return null
  return { col, key: s.slice(i + 1) }
}

function normalizeRecord(r) {
  if (!r || typeof r.id !== 'string') return null
  const parsed = parseId(r.id)
  if (!parsed) return null
  if (typeof r.hlc !== 'string' || r.hlc.length !== 26) return null

  const base = {
    id: r.id.slice(0, 200),
    col: parsed.col,
    title: String(r.title || '').slice(0, 500),
    deleted: !!r.deleted,
    hlc: r.hlc,
    hostId: r.hostId != null && r.hostId !== '' ? r.hostId : null,
    updatedAt: Number(r.updatedAt) || Date.now(),
    seq: Number(r.seq) || 0,
  }

  if (parsed.col === 'todos') {
    return Object.assign(base, {
      done: !!r.done,
      priority: clampInt(r.priority, 0, 2),
      dueAt: toMsOrNull(r.dueAt),
      remindAt: toMsOrNull(r.remindAt),
      description: String(r.description || '').slice(0, 200),
      parentId: r.parentId ? String(r.parentId).slice(0, 200) : null,
      pinned: !!r.pinned,
      repeatMode: String(r.repeatMode || 'once').slice(0, 16),
      createdAt: Number(r.createdAt) || Date.now(),
      completedAt: toMsOrNull(r.completedAt),
    })
  }
  if (parsed.col === 'notes') {
    return Object.assign(base, {
      content: String(r.content || '').slice(0, 200000),
      folderId: r.folderId != null ? r.folderId : null,
      createdAt: Number(r.createdAt) || Date.now(),
    })
  }
  if (parsed.col === 'stickies') {
    return Object.assign(base, {
      slot: Number(r.slot) || 1,
      content: String(r.content || '').slice(0, 20000),
    })
  }
  if (parsed.col === 'resources') {
    const name = String(r.name || r.title || '').slice(0, 200)
    return Object.assign(base, {
      kind: String(r.kind || 'web').slice(0, 8),
      name,
      title: name,
      target: String(r.target || '').slice(0, 2000),
      category: r.category == null ? null : String(r.category).slice(0, 60),
      icon: r.icon == null ? null : String(r.icon).slice(0, 200),
      args: r.args == null ? null : String(r.args).slice(0, 400),
      zoneId: r.zoneId != null ? r.zoneId : null,
      createdAt: Number(r.createdAt) || Date.now(),
    })
  }
  return Object.assign(base, {
    content: String(r.content || '').slice(0, 20000),
    pinned: !!r.pinned,
    createdAt: Number(r.createdAt) || Date.now(),
  })
}

const KEEP = (v, fb) => (v === undefined || v === null ? fb : v)

/** 宿主行 → 中枢记录。字段缺失时回落到上一条记录，避免「少传一个字段等于清空」 */
function fromHostRow(col, row, id, hlc, prev) {
  const p = prev || {}
  const updatedAt = parseHostTime(row.updatedAt || row.updated_at) || Date.now()
  const base = { id, col, hlc, hostId: row.id, updatedAt, deleted: false }

  if (col === 'todos') {
    return normalizeRecord(
      Object.assign(base, {
        title: KEEP(row.title, p.title),
        done: KEEP(row.done, p.done),
        priority: KEEP(row.priority, p.priority),
        dueAt: KEEP(row.dueAt != null ? row.dueAt : row.due_at, p.dueAt),
        remindAt: KEEP(row.remindAt != null ? row.remindAt : row.remind_at, p.remindAt),
        description: KEEP(row.description, p.description),
        parentId: KEEP(row.parent_id != null ? 'todos:h' + row.parent_id : row.parentId, p.parentId),
        pinned: KEEP(row.pinned, p.pinned),
        repeatMode: KEEP(row.repeat_mode != null ? row.repeat_mode : row.repeatMode, p.repeatMode),
        createdAt: parseHostTime(row.created_at || row.createdAt) || p.createdAt,
        completedAt: parseHostTime(row.completed_at || row.completedAt) || p.completedAt,
      })
    )
  }
  if (col === 'notes') {
    return normalizeRecord(
      Object.assign(base, {
        title: KEEP(row.title, p.title),
        content: KEEP(row.content, p.content),
        folderId: KEEP(row.folder_id != null ? row.folder_id : row.folderId, p.folderId),
        createdAt: parseHostTime(row.created_at || row.createdAt) || p.createdAt,
      })
    )
  }
  if (col === 'stickies') {
    return normalizeRecord(
      Object.assign(base, {
        title: '便签 ' + (row.slot || 1),
        slot: KEEP(row.slot, p.slot),
        content: KEEP(row.content, p.content),
      })
    )
  }
  if (col === 'resources') {
    return normalizeRecord(
      Object.assign(base, {
        kind: KEEP(row.kind, p.kind),
        name: KEEP(row.name, p.name),
        title: KEEP(row.name, p.title),
        target: KEEP(row.target, p.target),
        category: KEEP(row.category, p.category),
        icon: KEEP(row.icon, p.icon),
        args: KEEP(row.args, p.args),
        zoneId: KEEP(row.zone_id != null ? row.zone_id : row.zoneId, p.zoneId),
        createdAt: parseHostTime(row.created_at || row.createdAt) || p.createdAt,
      })
    )
  }
  if (col === 'snippets') {
    return normalizeRecord(
      Object.assign(base, {
        title: KEEP(row.title, p.title),
        content: KEEP(row.content, p.content),
        pinned: KEEP(row.is_pinned != null ? !!row.is_pinned : row.pinned, p.pinned),
        createdAt: parseHostTime(row.created_at || row.createdAt) || p.createdAt,
      })
    )
  }
  return null
}

function toMsOrNull(v) {
  if (v == null || v === '') return null
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return null
  return n < 1e11 ? Math.round(n * 1000) : Math.round(n)
}

function clampInt(v, lo, hi) {
  const n = Number(v)
  if (!Number.isFinite(n)) return lo
  return Math.min(hi, Math.max(lo, Math.round(n)))
}

module.exports = { Store, HOST_DEVICE, COLLECTIONS, parseHostTime, normalizeRecord, parseId }
