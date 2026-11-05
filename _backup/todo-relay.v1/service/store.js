'use strict'
/**
 * 同步中枢的持久状态与合并逻辑。
 *
 * 设计要点：
 * - 全部状态在内存，落盘是「防丢」而不是「读源」：任何一次写都先改内存再异步刷盘，
 *   读路径不碰磁盘，避免把 IO 抖动带进同步主链路。
 * - 记录级 LWW：比较 HLC 字符串即可，定宽保证字典序 == 时间序。
 * - 宿主待办（PC 本机）也是一个对等写入方，用 hostId 关联，不特殊对待。
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { Clock, compare } = require('./hlc')

const DATA_DIR = process.env.RELAY_DATA_DIR
  ? path.resolve(process.env.RELAY_DATA_DIR)
  : path.join(__dirname, '..', '.data')
const DATA_FILE = path.join(DATA_DIR, 'hub.json')
const LOG_LIMIT = 2000
const CONFLICT_LIMIT = 200
const TOMBSTONE_MS = 30 * 24 * 3600 * 1000
const PAIR_TTL_MS = 5 * 60 * 1000
const MAX_DEVICES = 8
const HOST_DEVICE = 'pc-host'

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex')
}

function emptyState(hubName) {
  return {
    v: 1,
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
    this.state = this.load() || emptyState(hubName)
    this.hostIndex = {}
    for (const rec of Object.values(this.state.records)) {
      if (rec.hostId != null) this.hostIndex[rec.hostId] = rec.id
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
      if (!s || s.v !== 1 || typeof s.records !== 'object') return null
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
    if (rec.hostId != null) this.hostIndex[rec.hostId] = rec.id
    this.state.log.push({ seq, id: rec.id })
    if (this.state.log.length > LOG_LIMIT) {
      this.state.log.splice(0, this.state.log.length - LOG_LIMIT)
    }
    this.scheduleSave()
    this.emit('change', { seq, id: rec.id })
    return rec
  }

  minSeq() {
    return this.state.log.length ? this.state.log[0].seq : this.state.seq
  }

  changesSince(sinceSeq, limit) {
    const out = []
    let hasMore = false
    for (const e of this.state.log) {
      if (e.seq <= sinceSeq) continue
      const rec = this.state.records[e.id]
      if (!rec) continue
      if (out.length >= limit) {
        hasMore = true
        break
      }
      out.push(rec)
    }
    return { changes: out, hasMore }
  }

  snapshot() {
    const records = []
    const cutoff = Date.now() - TOMBSTONE_MS
    for (const rec of Object.values(this.state.records)) {
      if (rec.deleted && parseMs(rec.hlc) < cutoff) continue
      records.push(rec)
    }
    return { seq: this.state.seq, records }
  }

  /**
   * 合并一条远端记录。
   * @returns {{accepted:boolean, reason?:string, conflict?:object}}
   */
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
      // 被判负的一方也要留痕：否则「手机改的那版被覆盖」在 PC 上完全看不到
      if (local.hlc !== rec.hlc) this.logConflict(local, local.by, rec, deviceId)
      return { accepted: false, reason: 'STALE', winnerHlc: local.hlc }
    }

    // 内容真的不同才算一次冲突；仅 hlc 刷新（例如宿主回写）不记日志
    let conflict = null
    if (local.by && local.by !== deviceId) {
      conflict = this.logConflict(rec, deviceId, local, local.by)
    }

    rec.by = deviceId
    // 保留宿主映射：远端不知道 hostId，不能因为一次覆盖就丢掉
    if (rec.hostId == null && local.hostId != null) rec.hostId = local.hostId
    this.commit(rec)
    if (deviceId !== HOST_DEVICE) this.pushOutbox(rec.id, rec.seq)
    return { accepted: true, conflict }
  }

  /**
   * 记一条冲突。同一条记录的同一个败方版本只记一次（重放同步不会刷屏）。
   * @returns {object|null} 新写入的冲突；内容相同或重复时为 null
   */
  logConflict(winner, winnerDevice, loser, loserDevice) {
    if (!winner || !loser) return null
    const fields = diffFields(loser, winner)
    if (!fields.length) return null
    const dup = this.state.conflicts.find((c) => c.id === winner.id && c.loser && c.loser.hlc === loser.hlc)
    if (dup) return null
    const conflict = {
      at: Date.now(),
      id: winner.id,
      title: winner.title || loser.title,
      fields,
      winner: { device: winnerDevice || winner.by || HOST_DEVICE, hlc: winner.hlc, record: clone(winner) },
      loser: { device: loserDevice || loser.by || '?', hlc: loser.hlc, record: clone(loser) },
    }
    this.state.conflicts.unshift(conflict)
    if (this.state.conflicts.length > CONFLICT_LIMIT) this.state.conflicts.length = CONFLICT_LIMIT
    this.scheduleSave()
    return conflict
  }

  // ---------- 宿主桥接 ----------

  /** 本机待办快照 → 中枢。返回本次识别的增 / 改 / 删条数 */
  applyHostSnapshot(rows, nowMs, opts) {
    const now = nowMs || Date.now()
    const full = !opts || opts.full !== false
    const seen = new Set()
    let created = 0
    let updated = 0
    let skipped = 0

    for (const row of rows) {
      if (!row || row.id == null) continue
      const hostId = Number(row.id)
      seen.add(hostId)
      const id = this.hostIndex[hostId] || 'h:' + hostId
      const local = this.state.records[id]
      const mirror = this.state.host.mirror[hostId]

      if (!local) {
        const rec = fromHostRow(row, id, this.clock.next(now), local)
        rec.by = HOST_DEVICE
        this.commit(rec)
        this.state.host.mirror[hostId] = { version: row.version || 0, id }
        created++
        continue
      }

      const version = Number(row.version || 0)
      if (mirror && mirror.version === version) continue

      // 宿主侧更新了。但中枢可能更新（安卓改过还没回写），用物理时间兜底判断
      const hostMs = parseHostTime(row.updatedAt || row.updated_at)
      const hubMs = parseMs(local.hlc)
      if (hubMs > hostMs + 1000) {
        skipped++
        continue
      }

      const rec = fromHostRow(row, id, this.clock.next(now), local)
      rec.by = HOST_DEVICE
      rec.seq = local.seq
      // 只有「上一版来自别的设备」才算冲突；宿主自己的两次连续编辑不是冲突
      if (local.by && local.by !== HOST_DEVICE) this.logConflict(rec, HOST_DEVICE, local, local.by)
      this.commit(rec)
      this.state.host.mirror[hostId] = { version, id }
      updated++
    }

    // 宿主侧消失的行 = 在 PC 上删了。
    // 只有「完整快照」才敢这样判：前端若因过滤/分页只送了部分行，其余行会被误判成删除。
    if (full) {
      for (const [hostIdStr, mirror] of Object.entries(this.state.host.mirror)) {
        const hostId = Number(hostIdStr)
        if (seen.has(hostId)) continue
        const rec = this.state.records[mirror.id]
        delete this.state.host.mirror[hostId]
        if (!rec || rec.deleted) continue
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

  /** 待回写到宿主的记录（来自非 PC 设备）。cursor = 本批最大 seq，ack 时原样回传 */
  outbound(limit) {
    const out = []
    let cursor = this.state.host.cursor
    for (const e of this.state.host.outbox) {
      if (e.seq <= this.state.host.cursor) continue
      if (out.length >= limit) break
      const rec = this.state.records[e.id]
      if (!rec) continue
      out.push(rec)
      cursor = e.seq
    }
    return { items: out, cursor }
  }

  /**
   * 回写完成：推进游标，并用宿主写回后的真实版本号刷新镜像，
   * 避免下一轮 ingest 把「我们自己写的那次」当成用户的新编辑。
   */
  ackHost(cursor, applied) {
    const c = Number(cursor) || 0
    if (c > this.state.host.cursor) this.state.host.cursor = c
    if (Array.isArray(applied)) {
      for (const a of applied) {
        if (!a || !a.id) continue
        const rec = this.state.records[a.id]
        if (!rec) continue
        if (a.hostId != null) {
          rec.hostId = Number(a.hostId)
          this.hostIndex[rec.hostId] = rec.id
        }
        if (rec.hostId != null && a.hostVersion != null) {
          const prev = this.state.host.mirror[rec.hostId]
          if (!prev || Number(a.hostVersion) >= prev.version) {
            this.state.host.mirror[rec.hostId] = { version: Number(a.hostVersion), id: rec.id }
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

  bindHostId(recordId, hostId) {
    const rec = this.state.records[recordId]
    if (!rec) return
    rec.hostId = Number(hostId)
    this.hostIndex[rec.hostId] = recordId
    this.state.host.mirror[rec.hostId] = { version: 0, id: recordId }
    this.scheduleSave()
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
    const recs = Object.values(this.state.records)
    return {
      total: recs.filter((r) => !r.deleted).length,
      deleted: recs.filter((r) => r.deleted).length,
      pendingHost: this.state.host.outbox.length,
      conflicts: this.state.conflicts.length,
      seq: this.state.seq,
      minSeq: this.minSeq(),
    }
  }

  purgeTombstones() {
    const cutoff = Date.now() - TOMBSTONE_MS
    let n = 0
    for (const [id, rec] of Object.entries(this.state.records)) {
      if (rec.deleted && parseMs(rec.hlc) < cutoff) {
        delete this.state.records[id]
        if (rec.hostId != null) delete this.hostIndex[rec.hostId]
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

const FIELDS = [
  'title',
  'done',
  'priority',
  'dueAt',
  'remindAt',
  'description',
  'parentId',
  'pinned',
  'repeatMode',
  'completedAt',
  'deleted',
]

function diffFields(a, b) {
  const out = []
  for (const f of FIELDS) {
    if (JSON.stringify(a[f] ?? null) !== JSON.stringify(b[f] ?? null)) out.push(f)
  }
  return out
}

function normalizeRecord(r) {
  if (!r || typeof r.id !== 'string' || !r.id) return null
  if (typeof r.hlc !== 'string' || r.hlc.length !== 26) return null
  const dueAt = toMsOrNull(r.dueAt)
  return {
    id: r.id.slice(0, 80),
    title: String(r.title || '').slice(0, 500),
    done: !!r.done,
    priority: clampInt(r.priority, 0, 2),
    dueAt,
    remindAt: toMsOrNull(r.remindAt),
    description: String(r.description || '').slice(0, 200),
    parentId: r.parentId ? String(r.parentId).slice(0, 80) : null,
    pinned: !!r.pinned,
    repeatMode: String(r.repeatMode || 'once').slice(0, 16),
    createdAt: Number(r.createdAt) || Date.now(),
    completedAt: toMsOrNull(r.completedAt),
    updatedAt: Number(r.updatedAt) || Date.now(),
    deleted: !!r.deleted,
    hlc: r.hlc,
    hostId: r.hostId != null ? Number(r.hostId) : null,
    seq: Number(r.seq) || 0,
  }
}

function fromHostRow(row, id, hlc, prev) {
  const keep = (v, fallback) => (v === undefined || v === null ? fallback : v)
  return normalizeRecord({
    id,
    title: row.title,
    done: row.done,
    priority: keep(row.priority, prev ? prev.priority : 0),
    dueAt: row.dueAt != null ? row.dueAt : row.due_at != null ? row.due_at : prev ? prev.dueAt : null,
    remindAt: row.remindAt != null ? row.remindAt : row.remind_at != null ? row.remind_at : prev ? prev.remindAt : null,
    description: keep(row.description, prev ? prev.description : ''),
    parentId:
      row.parentId != null
        ? 'h:' + row.parentId
        : row.parent_id != null
          ? 'h:' + row.parent_id
          : prev
            ? prev.parentId
            : null,
    pinned: keep(row.pinned, prev ? prev.pinned : false),
    repeatMode: keep(row.repeatMode != null ? row.repeatMode : row.repeat_mode, prev ? prev.repeatMode : 'once'),
    createdAt: parseHostTime(row.createdAt || row.created_at) || (prev ? prev.createdAt : Date.now()),
    completedAt: parseHostTime(row.completedAt || row.completed_at) || (prev ? prev.completedAt : null),
    updatedAt: parseHostTime(row.updatedAt || row.updated_at) || Date.now(),
    deleted: false,
    hlc,
    hostId: Number(row.id),
  })
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

module.exports = { Store, HOST_DEVICE, parseHostTime, normalizeRecord }
