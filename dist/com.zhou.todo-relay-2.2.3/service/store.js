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
const BAK_FILE = DATA_FILE + '.bak'
const WAL_FILE = path.join(DATA_DIR, 'hub.wal')
const LOG_LIMIT = 4000
const CONFLICT_LIMIT = 200
const AUDIT_LIMIT = 500
const TOMBSTONE_MS = 30 * 24 * 3600 * 1000
const PAIR_TTL_MS = 5 * 60 * 1000
const MAX_DEVICES = 8
/** 配对码连续输错这么多次就作废当前码——必须真拒绝，不能只提示 */
const MAX_PAIR_ATTEMPTS = 5
const HOST_DEVICE = 'pc-host'
/** WAL 攒到这么多条提交、或距上次快照超过这么久，就做一次全量快照并清空 WAL */
const WAL_COMPACT_ENTRIES = 200
const WAL_COMPACT_MS = 60 * 1000

const COLLECTIONS = ['todos', 'notes', 'stickies', 'resources', 'snippets']

/**
 * 各字段的长度上限，集中一处，避免再出现「notes 允许 20 万、备注只允许 200」这种
 * 同一函数里的自相矛盾。超限会告警，不静默截断。
 */
const FIELD_LIMITS = {
  // title 对所有集合统一 500，与历史行为保持一致；集合特有字段各自列明
  'todos.title': 500,
  'notes.title': 500,
  'stickies.title': 500,
  'snippets.title': 500,
  'resources.title': 500,
  'todos.description': 20000,
  'todos.parentId': 200,
  'todos.repeatMode': 16,
  'notes.content': 200000,
  'stickies.content': 20000,
  'resources.name': 200,
  'resources.target': 2000,
  'resources.category': 60,
  'resources.icon': 200,
  'resources.args': 400,
  'snippets.content': 20000,
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex')
}

/** 等长摘要后再比较，避免逐字符短路带来的时间侧信道 */
function safeEqual(a, b) {
  const ha = Buffer.from(sha256(String(a)), 'hex')
  const hb = Buffer.from(sha256(String(b)), 'hex')
  return ha.length === hb.length && crypto.timingSafeEqual(ha, hb)
}

function clip(col, field, value) {
  const max = FIELD_LIMITS[col + '.' + field]
  const s = value == null ? '' : String(value)
  if (max && s.length > max) {
    console.warn(`[store] ${col}.${field} 超长，截断 ${s.length} → ${max}`)
    return s.slice(0, max)
  }
  return s
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
    audit: [],
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
    this.readOnly = false
    this.fatal = null
    this.saveFails = 0
    this.dirty = false
    this.saveTimer = null
    this.retryTimer = null
    this.savePromise = null
    this.walQueue = []
    this.walWriting = false
    this.walEntries = 0
    this.lastCompact = Date.now()
    this.recoveredFrom = null

    const loaded = this.load()
    this.state = loaded.state || emptyState(hubName)
    if (loaded.fatal) {
      // 坏库且无备份可恢复：只读启动，宁可停写也不覆盖现场
      this.readOnly = true
      this.fatal = loaded.fatal
    }
    if (loaded.recoveredFrom) this.recoveredFrom = loaded.recoveredFrom

    this.hostIndex = {}
    for (const rec of Object.values(this.state.records)) {
      if (rec.hostId != null) this.hostIndex[rec.col + ':' + rec.hostId] = rec.id
    }
    this.listeners = new Set()
  }

  // ---------- 持久化 ----------

  /**
   * 读状态：快照 + WAL 重放。
   * 快照损坏时隔离原文件、尝试备份；都失败则返回 fatal 让调用方转只读。
   * 任何情况下都不返回「空库」来顶替损坏的真实数据——那会导致下一次落盘覆盖原件。
   */
  load() {
    let snapshot = null
    let fatal = null
    let recoveredFrom = null

    try {
      const raw = fs.readFileSync(DATA_FILE, 'utf8')
      const s = JSON.parse(raw)
      if (!s || typeof s !== 'object' || typeof s.records !== 'object') {
        throw new Error('结构不合法（缺少 records）')
      }
      snapshot = s
    } catch (e) {
      if (e.code === 'ENOENT') {
        snapshot = null
      } else {
        const bad = `${DATA_FILE}.corrupt-${Date.now()}`
        try {
          fs.renameSync(DATA_FILE, bad)
          console.error(`[store] 状态文件损坏，已隔离到 ${bad}：${e.message}`)
        } catch (renameErr) {
          console.error('[store] 状态文件损坏且隔离失败:', renameErr.message)
        }
        try {
          const s = JSON.parse(fs.readFileSync(BAK_FILE, 'utf8'))
          if (s && typeof s.records === 'object') {
            snapshot = s
            recoveredFrom = BAK_FILE
            console.error(`[store] 已从备份恢复（${Object.keys(s.records).length} 条记录）`)
          }
        } catch (_) {
          fatal = {
            code: 'STATE_CORRUPT',
            message: `状态文件损坏且无法从备份恢复；原件已隔离为 ${bad}`,
            at: Date.now(),
          }
        }
      }
    }

    if (!snapshot) return { state: null, fatal, recoveredFrom }

    // WAL 重放：逐行读，单行坏了只丢那一行，不影响其余
    try {
      const wal = fs.readFileSync(WAL_FILE, 'utf8')
      let replayed = 0
      for (const line of wal.split('\n')) {
        if (!line.trim()) continue
        try {
          const entry = JSON.parse(line)
          if (!entry || !entry.id || !entry.rec) continue
          if (entry.seq && entry.seq > snapshot.seq) snapshot.seq = entry.seq
          snapshot.records[entry.id] = entry.rec
          snapshot.log.push({ seq: entry.rec.seq || entry.seq, id: entry.id })
          replayed++
        } catch (_) {
          /* 单行损坏跳过 */
        }
      }
      if (snapshot.log.length > LOG_LIMIT) snapshot.log.splice(0, snapshot.log.length - LOG_LIMIT)
      if (replayed) console.log(`[store] WAL 重放 ${replayed} 条`)
    } catch (e) {
      if (e.code !== 'ENOENT') console.error('[store] WAL 读取失败（忽略）:', e.message)
    }

    if (!Array.isArray(snapshot.audit)) snapshot.audit = []
    if (!snapshot.host) snapshot.host = { mirror: {}, cursor: 0, outbox: [] }
    return { state: snapshot, fatal: null, recoveredFrom }
  }

  scheduleSave() {
    if (this.readOnly) return
    this.dirty = true
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.flush()
    }, 400)
  }

  /** 追加一条 WAL：轻量、异步、失败不阻塞主流程（快照会兜底） */
  appendWal(rec) {
    if (this.readOnly) return
    try {
      this.walQueue.push(JSON.stringify({ seq: rec.seq, id: rec.id, rec }) + '\n')
      this.walEntries += 1
    } catch (e) {
      console.error('[store] WAL 序列化失败:', e.message)
      this.scheduleSave()
      return
    }
    this.drainWal()
    if (this.walEntries >= WAL_COMPACT_ENTRIES) this.flush()
  }

  drainWal() {
    if (this.walWriting || !this.walQueue.length) return
    this.walWriting = true
    const chunk = this.walQueue.join('')
    this.walQueue = []
    fs.promises
      .mkdir(DATA_DIR, { recursive: true })
      .then(() => fs.promises.appendFile(WAL_FILE, chunk))
      .catch((e) => {
        console.error('[store] WAL 追加失败（等快照兜底）:', e.message)
        this.scheduleSave()
      })
      .finally(() => {
        this.walWriting = false
        if (this.walQueue.length) this.drainWal()
      })
  }

  /** 全量快照：写 .tmp → 备份旧文件 → rename，全程异步 */
  flush() {
    if (this.readOnly || !this.dirty) return this.savePromise || Promise.resolve()
    if (this.savePromise) return this.savePromise

    this.savePromise = (async () => {
      try {
        await fs.promises.mkdir(DATA_DIR, { recursive: true })
        const tmp = DATA_FILE + '.tmp'
        const body = JSON.stringify(this.state)
        await fs.promises.writeFile(tmp, body)

        // 覆盖前留一代备份：坏库恢复靠它
        try {
          await fs.promises.copyFile(DATA_FILE, BAK_FILE)
        } catch (e) {
          if (e.code !== 'ENOENT') console.error('[store] 备份失败（继续写）:', e.message)
        }

        await fs.promises.rename(tmp, DATA_FILE)
        this.dirty = false
        this.saveFails = 0
        this.walEntries = 0
        this.lastCompact = Date.now()
        // 快照已含 WAL 全部内容，安全清空
        await fs.promises.writeFile(WAL_FILE, '').catch(() => {})
        this.emit('saved', { bytes: body.length })
      } catch (e) {
        this.saveFails += 1
        console.error(`[store] 落盘失败（第 ${this.saveFails} 次）:`, e.message)
        this.emit('save-error', { message: e.message, fails: this.saveFails })
        clearTimeout(this.retryTimer)
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null
          this.flush()
        }, Math.min(30000, 1000 * 2 ** this.saveFails))
        this.retryTimer.unref?.()
      } finally {
        this.savePromise = null
      }
    })()
    return this.savePromise
  }

  /** 进程退出用：同步写完再走，避免最后 400ms 的改动丢失 */
  flushSync() {
    if (this.readOnly) return
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true })
      const tmp = DATA_FILE + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(this.state))
      try {
        fs.copyFileSync(DATA_FILE, BAK_FILE)
      } catch (_) {}
      fs.renameSync(tmp, DATA_FILE)
      try {
        fs.writeFileSync(WAL_FILE, '')
      } catch (_) {}
      this.dirty = false
      this.saveFails = 0
      this.walEntries = 0
    } catch (e) {
      console.error('[store] 退出前落盘失败:', e.message)
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

  commit(rec, source) {
    const seq = this.nextSeq()
    rec.seq = seq
    this.state.records[rec.id] = rec
    if (rec.hostId != null) this.hostIndex[rec.col + ':' + rec.hostId] = rec.id
    this.state.log.push({ seq, id: rec.id })
    if (this.state.log.length > LOG_LIMIT) {
      this.state.log.splice(0, this.state.log.length - LOG_LIMIT)
    }
    if (source) this.audit(source, rec)
    // 先追加 WAL：单条只写几百字节，进程意外退出也能重放；
    // 全量快照按条数/时间触发，避免每次改动都序列化整个库
    this.appendWal(rec)
    if (Date.now() - this.lastCompact > WAL_COMPACT_MS) this.scheduleSave()
    this.emit('change', { seq, id: rec.id, col: rec.col })
    return rec
  }

  /** 审计环形缓冲：谁在何时改了哪条、哪些字段 */
  audit(action, rec, deviceId) {
    if (!rec) return
    const entry = {
      at: Date.now(),
      action: action || 'commit',
      device: deviceId || rec.by || HOST_DEVICE,
      col: rec.col,
      id: rec.id,
      deleted: !!rec.deleted,
    }
    this.state.audit.push(entry)
    if (this.state.audit.length > AUDIT_LIMIT) {
      this.state.audit.splice(0, this.state.audit.length - AUDIT_LIMIT)
    }
  }

  auditLog(limit) {
    const n = Math.max(1, Math.min(AUDIT_LIMIT, Number(limit) || 100))
    return this.state.audit.slice(-n).reverse()
  }

  minSeq() {
    return this.state.log.length ? this.state.log[0].seq : this.state.seq
  }

  changesSince(sinceSeq, limit, cols) {
    // 同一个 id 在 log 里可能有多条（每次提交都记一条），按 id 聚合只留最新，
    // 否则一次增量会把同一条记录重复推好几遍，手机端要做无谓的重复写入。
    const seen = new Map()
    let scanned = 0
    for (const e of this.state.log) {
      if (e.seq <= sinceSeq) continue
      const rec = this.state.records[e.id]
      if (!rec) continue
      if (cols && cols.length && cols.indexOf(rec.col) < 0) continue
      seen.set(rec.id, rec)
      scanned++
      if (seen.size >= limit) break
    }
    const changes = Array.from(seen.values())
    // hasMore 用「是否还有未消费的 log 条目」判断，而不是本次条数，
    // 避免重复条目把 limit 占满导致提前判定「还有更多」
    let hasMore = false
    if (changes.length) {
      const lastSeq = changes.reduce((m, r) => Math.max(m, r.seq || 0), sinceSeq)
      hasMore = this.state.log.some((e) => e.seq > lastSeq)
    }
    return { changes, hasMore, scanned }
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

    // 时钟异常必须拒收并留痕：静默采纳会让本机时钟被推到极远未来，
    // 之后本机所有改动都被判 STALE；静默丢弃又会让改动凭空消失。
    const clockOut = this.clock.observe(rec.hlc)
    if (clockOut.rejected) {
      this.state.audit.push({
        at: Date.now(),
        action: 'clock-anomaly',
        device: deviceId,
        col: rec.col,
        id: rec.id,
        reason: clockOut.reason,
        driftMs: clockOut.drift || 0,
      })
      if (this.state.audit.length > AUDIT_LIMIT) this.state.audit.shift()
      return {
        accepted: false,
        reason: 'CLOCK_ANOMALY',
        clockReason: clockOut.reason,
        driftMs: clockOut.drift || 0,
      }
    }

    const local = this.state.records[rec.id]
    if (!local) {
      rec.by = deviceId
      this.commit(rec, 'merge')
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
    this.commit(rec, 'merge')
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
    if (this.state.host.outbox.length > LOG_LIMIT) {
      // 按超出量裁剪，避免「刚好超一条却删掉 500 条」的过度丢弃
      this.state.host.outbox.splice(0, this.state.host.outbox.length - LOG_LIMIT)
    }
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
    if (p.expiresAt <= Date.now()) return { ok: false, reason: 'EXPIRED' }
    // 先判封禁再比码：否则「超限」只是句提示，猜对照样放行
    if (p.locked || p.attempts >= MAX_PAIR_ATTEMPTS) {
      return { ok: false, reason: 'TOO_MANY_ATTEMPTS' }
    }
    if (!safeEqual(String(code), p.code)) {
      p.attempts = (p.attempts || 0) + 1
      if (p.attempts >= MAX_PAIR_ATTEMPTS) {
        // 锁死当前码（但不丢弃），让后续尝试明确拿到 TOO_MANY_ATTEMPTS；
        // 用户点「换配对码」会生成新码，把枚举成本抬到「每次都要人点一下」
        p.locked = true
        this.scheduleSave()
        return { ok: false, reason: 'TOO_MANY_ATTEMPTS' }
      }
      this.scheduleSave()
      return { ok: false, reason: 'INVALID_CODE', remaining: MAX_PAIR_ATTEMPTS - p.attempts }
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
      // 可靠性状态：页面据此显示红条，而不是让问题只留在控制台
      readOnly: this.readOnly,
      fatal: this.fatal,
      saveFails: this.saveFails || 0,
      recoveredFrom: this.recoveredFrom,
      walPending: this.walEntries || 0,
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
    title: clip(parsed.col, 'title', r.title),
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
      // 提前量：-1 关闭、0 准时、正数 = 提前分钟。保留 -1，因此不能走 toMsOrNull
      remindLead: r.remindLead == null || r.remindLead === '' ? null : clampInt(r.remindLead, -1, 525600),
      // 备注与笔记同样属于「正文」，上限见 FIELD_LIMITS；超长会告警，不静默吞掉
      description: clip('todos', 'description', r.description),
      parentId: r.parentId ? clip('todos', 'parentId', r.parentId) : null,
      pinned: !!r.pinned,
      repeatMode: clip('todos', 'repeatMode', r.repeatMode || 'once'),
      createdAt: Number(r.createdAt) || Date.now(),
      completedAt: toMsOrNull(r.completedAt),
    })
  }
  if (parsed.col === 'notes') {
    return Object.assign(base, {
      content: clip('notes', 'content', r.content),
      folderId: r.folderId != null ? r.folderId : null,
      createdAt: Number(r.createdAt) || Date.now(),
    })
  }
  if (parsed.col === 'stickies') {
    return Object.assign(base, {
      slot: Number(r.slot) || 1,
      content: clip('stickies', 'content', r.content),
    })
  }
  if (parsed.col === 'resources') {
    const name = clip('resources', 'name', r.name || r.title)
    return Object.assign(base, {
      kind: String(r.kind || 'web').slice(0, 8),
      name,
      title: name,
      target: clip('resources', 'target', r.target),
      category: r.category == null ? null : clip('resources', 'category', r.category),
      icon: r.icon == null ? null : clip('resources', 'icon', r.icon),
      args: r.args == null ? null : clip('resources', 'args', r.args),
      zoneId: r.zoneId != null ? r.zoneId : null,
      createdAt: Number(r.createdAt) || Date.now(),
    })
  }
  return Object.assign(base, {
    content: clip('snippets', 'content', r.content),
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
        remindLead: KEEP(row.remindLead != null ? row.remindLead : row.remind_lead, p.remindLead),
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
