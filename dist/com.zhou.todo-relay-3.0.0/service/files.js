'use strict'
/**
 * 文件传输内核（手机 ⇄ 电脑）。
 *
 * 设计要点：
 * 1. 分块：固定 2MiB 明文一块，服务端严格按块序落盘，天然支持断点续传。
 * 2. 加密：Bearer 配对令牌做 HKDF-SHA256 → AES-256-GCM，
 *    每块 nonce = transferId 前缀(4B) + 块序号(8B)，AAD 绑定 id/序号/总长。
 *    链路是局域网明文 HTTP，加密在传输层之上补齐「同一 Wi-Fi 下被嗅探」的风险。
 * 3. 校验：整文件 SHA-256，手机端算、服务端复核（反向则由服务端算、手机复核）。
 * 4. 落盘：客户端文件名永远不参与路径拼接，磁盘名 = <transferId>__<安全名>。
 */

const fs = require('fs')
const fsp = fs.promises
const path = require('path')
const crypto = require('crypto')

const CHUNK = 2 * 1024 * 1024
const MAX_FILE = 512 * 1024 * 1024
const MAX_CHUNK_BODY = CHUNK + 64 * 1024
const QUOTA_BYTES = 2 * 1024 * 1024 * 1024
const MAX_ITEMS = 300
const PENDING_TTL = 24 * 3600 * 1000
const KEEP_MS = 14 * 24 * 3600 * 1000
const ID_RE = /^[a-f0-9]{24}$/

/** 可执行/脚本类：不拦，但打上风险标记，界面必须提示「不要随手双击」 */
const RISK_EXT = new Set([
  'exe', 'msi', 'msix', 'bat', 'cmd', 'com', 'scr', 'pif', 'ps1', 'psm1',
  'vbs', 'vbe', 'wsf', 'wsh', 'hta', 'jar', 'reg', 'lnk', 'apk', 'dll', 'sys',
])

const KIND = {
  image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic', 'heif', 'svg', 'avif'],
  video: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', '3gp'],
  audio: ['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus', 'amr'],
  doc: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'csv', 'rtf', 'epub'],
  archive: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'],
  code: ['js', 'ts', 'json', 'html', 'css', 'py', 'java', 'go', 'rs', 'sh', 'yml', 'yaml', 'xml'],
}

const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

function extOf(name) {
  const m = /\.([a-z0-9]{1,12})$/i.exec(String(name || ''))
  return m ? m[1].toLowerCase() : ''
}

function kindOf(name) {
  const e = extOf(name)
  for (const k of Object.keys(KIND)) if (KIND[k].indexOf(e) >= 0) return k
  return 'other'
}

function riskOf(name) {
  return RISK_EXT.has(extOf(name)) ? 'high' : 'normal'
}

/**
 * 文件名清洗：只保留「显示用」的名字，绝不用它拼路径。
 * 去掉控制字符与 Windows 非法字符，压掉首尾的点/空格，处理保留名。
 */
function safeName(raw) {
  let s = String(raw == null ? '' : raw).normalize('NFC')
  s = s.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_')
  s = s.replace(/\s+/g, ' ').trim()
  s = s.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '')
  if (Buffer.byteLength(s, 'utf8') > 180) {
    const ext = extOf(s)
    const keep = ext ? '.' + ext : ''
    // 按字符截，避免把多字节字符切成半个
    let cut = s.slice(0, 120)
    s = cut + keep
  }
  if (!s) s = 'file-' + Date.now().toString(36)
  if (WIN_RESERVED.test(s)) s = '_' + s
  return s
}

function chunksOf(size) {
  return Math.max(0, Math.ceil(size / CHUNK))
}

// ---------------------------------------------------------------- 加密

/** RFC 5869 HKDF-SHA256（Node 与 Java 两侧实现一致，便于互测） */
function hkdf(ikm, salt, info, len) {
  const prk = crypto.createHmac('sha256', salt).update(ikm).digest()
  const out = []
  let t = Buffer.alloc(0)
  let i = 1
  let total = 0
  while (total < len) {
    t = crypto.createHmac('sha256', prk).update(Buffer.concat([t, info, Buffer.from([i])])).digest()
    out.push(t)
    total += t.length
    i++
  }
  return Buffer.concat(out).slice(0, len)
}

function keyFor(token, id) {
  return hkdf(Buffer.from(String(token), 'utf8'), Buffer.from(id, 'utf8'), Buffer.from('xhub-file-v1', 'utf8'), 32)
}

function nonceFor(id, index) {
  const prefix = crypto.createHash('sha256').update(id).digest().slice(0, 4)
  const n = Buffer.alloc(8)
  n.writeBigUInt64BE(BigInt(index))
  return Buffer.concat([prefix, n])
}

function aadFor(id, index, size) {
  return Buffer.from(`xhub-file-v1|${id}|${index}|${size}`, 'utf8')
}

function seal(key, nonce, aad, plain) {
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce)
  c.setAAD(aad)
  const body = Buffer.concat([c.update(plain), c.final()])
  return Buffer.concat([body, c.getAuthTag()])
}

function open(key, nonce, aad, sealed) {
  if (!sealed || sealed.length < 17) return null
  const body = sealed.subarray(0, sealed.length - 16)
  const tag = sealed.subarray(sealed.length - 16)
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, nonce)
    d.setAAD(aad)
    d.setAuthTag(tag)
    return Buffer.concat([d.update(body), d.final()])
  } catch (e) {
    return null
  }
}

/** 流式算哈希，512MiB 也不会把内存吃满 */
function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256')
    const rs = fs.createReadStream(file)
    rs.on('data', (b) => h.update(b))
    rs.on('error', reject)
    rs.on('end', () => resolve(h.digest('hex')))
  })
}

function diskFree(dir) {
  try {
    if (typeof fs.statfsSync !== 'function') return null
    const s = fs.statfsSync(dir)
    return Number(s.bavail) * Number(s.bsize)
  } catch (e) {
    return null
  }
}

// ---------------------------------------------------------------- 内核

class FileHub {
  constructor(dataDir, opts) {
    const o = opts || {}
    this.root = path.join(dataDir, 'files')
    this.inbox = path.join(this.root, 'inbox')
    this.outbox = path.join(this.root, 'out')
    this.tmp = path.join(this.root, 'tmp')
    this.indexFile = path.join(this.root, 'index.json')
    this.maxFile = o.maxFile || MAX_FILE
    this.quota = o.quota || QUOTA_BYTES
    this.onEvent = o.onEvent || function () {}
    this.items = new Map()
    this.locks = new Map()
    this.saveTimer = null
    this.ready = this.init()
  }

  async init() {
    for (const d of [this.inbox, this.outbox, this.tmp]) await fsp.mkdir(d, { recursive: true })
    try {
      const raw = JSON.parse(await fsp.readFile(this.indexFile, 'utf8'))
      for (const it of raw.items || []) if (it && ID_RE.test(it.id)) this.items.set(it.id, it)
    } catch (e) {
      /* 首次启动或索引损坏：从空开始，残留文件仍可在磁盘上找到 */
    }
    // 上次进程被杀：以 .part 实际长度为准恢复 received
    for (const it of this.items.values()) {
      if (it.state !== 'uploading') continue
      try {
        const st = await fsp.stat(this.partPath(it.id))
        it.received = Math.min(it.size, st.size)
      } catch (e) {
        it.received = 0
      }
    }
    this.sweep()
  }

  partPath(id) {
    return path.join(this.tmp, id + '.part')
  }

  filePath(it) {
    return path.join(it.dir === 'out' ? this.outbox : this.inbox, it.id + '__' + it.file)
  }

  withLock(id, fn) {
    const prev = this.locks.get(id) || Promise.resolve()
    const next = prev.then(fn, fn)
    this.locks.set(id, next.catch(() => {}))
    return next
  }

  save() {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.saveNow().catch(() => {})
    }, 120)
    this.saveTimer.unref?.()
  }

  async saveNow() {
    const items = [...this.items.values()]
    const body = JSON.stringify({ v: 1, at: Date.now(), items })
    const tmp = this.indexFile + '.tmp'
    await fsp.writeFile(tmp, body)
    await fsp.rename(tmp, this.indexFile)
  }

  saveSync() {
    try {
      if (this.saveTimer) {
        clearTimeout(this.saveTimer)
        this.saveTimer = null
      }
      const items = [...this.items.values()]
      const tmp = this.indexFile + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, at: Date.now(), items }))
      fs.renameSync(tmp, this.indexFile)
    } catch (e) {
      /* 退出路径不抛 */
    }
  }

  used(direction) {
    let n = 0
    for (const it of this.items.values()) {
      if (direction && it.dir !== direction) continue
      if (it.state === 'deleted') continue
      n += it.size || 0
    }
    return n
  }

  stats() {
    let inbox = 0
    let out = 0
    for (const it of this.items.values()) {
      if (it.state === 'deleted') continue
      if (it.dir === 'out') out += it.size || 0
      else inbox += it.size || 0
    }
    return { inbox, out, used: inbox + out, quota: this.quota, maxFile: this.maxFile, chunkSize: CHUNK }
  }

  listInbox() {
    return [...this.items.values()]
      .filter((it) => it.dir === 'in' && it.state === 'received')
      .sort((a, b) => b.at - a.at)
      .map((it) => ({
        id: it.id,
        name: it.name,
        size: it.size,
        mime: it.mime,
        kind: kindOf(it.name),
        risk: riskOf(it.name),
        from: it.fromName || '手机',
        at: it.at,
        sha256: it.sha256,
        path: this.filePath(it),
      }))
  }

  listOut() {
    const now = Date.now()
    return [...this.items.values()]
      .filter((it) => it.dir === 'out' && it.state !== 'deleted' && it.state !== 'cleared')
      .sort((a, b) => b.at - a.at)
      .map((it) => ({
        id: it.id,
        name: it.name,
        size: it.size,
        mime: it.mime,
        kind: kindOf(it.name),
        risk: riskOf(it.name),
        state: it.state,
        deliveredAt: it.deliveredAt || 0,
        declinedAt: it.declinedAt || 0,
        at: it.at,
        expiresAt: it.expiresAt,
        expired: it.state === 'pending' && it.expiresAt <= now,
      }))
  }

  pendingFor(deviceId) {
    const now = Date.now()
    return [...this.items.values()]
      .filter((it) => it.dir === 'out' && it.state === 'pending' && it.expiresAt > now)
      .filter((it) => !it.declinedBy || !it.declinedBy[deviceId])
      .sort((a, b) => b.at - a.at)
      .map((it) => ({
        id: it.id,
        name: it.name,
        size: it.size,
        mime: it.mime,
        kind: kindOf(it.name),
        risk: riskOf(it.name),
        at: it.at,
        sha256: it.sha256,
      }))
  }

  /** 手机端历史：自己发上来的 + 电脑发给自己的（近 30 条） */
  history(deviceId) {
    return [...this.items.values()]
      .filter((it) => it.deviceId === deviceId || it.dir === 'out')
      .filter((it) => it.state !== 'deleted')
      .sort((a, b) => b.at - a.at)
      .slice(0, 30)
      .map((it) => ({
        id: it.id,
        name: it.name,
        size: it.size,
        kind: kindOf(it.name),
        dir: it.dir === 'out' ? 'down' : 'up',
        state: it.state,
        at: it.at,
        deliveredAt: it.deliveredAt || 0,
      }))
  }

  /** 新建上传（手机→电脑）。name/size 全部来自客户端，逐项校验后才落盘 */
  async createUpload(device, body) {
    const name = safeName(body && body.name)
    const size = Number(body && body.size)
    if (!Number.isFinite(size) || size <= 0) return { code: 'BAD_SIZE' }
    if (size > this.maxFile) return { code: 'TOO_LARGE', maxFile: this.maxFile }
    const st = this.stats()
    if (st.used + size > this.quota) return { code: 'QUOTA_FULL', used: st.used, quota: this.quota }
    const free = diskFree(this.root)
    if (free != null && free < size + 64 * 1024 * 1024) return { code: 'NO_SPACE', free }

    await this.evict(size)
    const id = crypto.randomBytes(12).toString('hex')
    const now = Date.now()
    const it = {
      id,
      dir: 'in',
      name,
      file: name,
      size,
      mime: String((body && body.mime) || '').slice(0, 80),
      state: 'uploading',
      received: 0,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + PENDING_TTL,
      deviceId: device ? device.id : '',
      fromName: device ? device.name : '手机',
    }
    this.items.set(id, it)
    await fsp.writeFile(this.partPath(id), Buffer.alloc(0))
    this.save()
    return { id, chunkSize: CHUNK, chunks: chunksOf(size), expiresAt: it.expiresAt, maxFile: this.maxFile }
  }

  async appendUpload(id, index, token, sealed) {
    if (!ID_RE.test(String(id))) return { code: 'BAD_ID' }
    return this.withLock(id, async () => {
      const it = this.items.get(id)
      if (!it || it.dir !== 'in') return { code: 'NOT_FOUND' }
      if (it.state !== 'uploading') return { code: 'BAD_STATE', state: it.state }
      if (Date.now() > it.expiresAt) return { code: 'EXPIRED' }
      const expected = Math.floor(it.received / CHUNK)
      if (index !== expected) return { code: 'OFFSET', expected, received: it.received }
      const off = index * CHUNK
      const plainLen = Math.min(CHUNK, it.size - off)
      if (!sealed || sealed.length !== plainLen + 16) return { code: 'BAD_CHUNK', want: plainLen + 16 }
      const plain = open(keyFor(token, id), nonceFor(id, index), aadFor(id, index, it.size), sealed)
      if (!plain || plain.length !== plainLen) return { code: 'DECRYPT_FAIL' }
      await fsp.appendFile(this.partPath(id), plain)
      it.received += plain.length
      it.updatedAt = Date.now()
      this.save()
      this.progress(it)
      return { received: it.received, chunks: chunksOf(it.size), done: it.received === it.size }
    })
  }

  progress(it) {
    const now = Date.now()
    // 2MiB 一块：大文件会有几百块，按 5% 或 1 秒节流，避免把 SSE 打满
    const pct = it.size ? Math.floor((it.received / it.size) * 20) * 5 : 0
    if (now - (it.lastEmit || 0) < 900 && it.received < it.size) return
    if (pct === it.lastPct && it.received < it.size) return
    it.lastEmit = now
    it.lastPct = pct
    this.onEvent({ kind: 'progress', id: it.id, name: it.name, dir: it.dir === 'out' ? 'down' : 'up', received: it.received, size: it.size, pct })
  }

  async finishUpload(id, token, sha) {
    return this.withLock(id, async () => {
      const it = this.items.get(id)
      if (!it || it.dir !== 'in') return { code: 'NOT_FOUND' }
      if (it.state !== 'uploading') return { code: 'BAD_STATE', state: it.state }
      if (it.received !== it.size) return { code: 'INCOMPLETE', received: it.received, size: it.size }
      const part = this.partPath(id)
      const got = await hashFile(part)
      if (String(sha || '').toLowerCase() !== got) {
        // 校验不过：清空重来，不把可疑内容留在收件箱
        await fsp.writeFile(part, Buffer.alloc(0))
        it.received = 0
        it.updatedAt = Date.now()
        this.save()
        return { code: 'HASH_MISMATCH', expected: got }
      }
      const final = this.filePath(it)
      await fsp.rename(part, final)
      it.state = 'received'
      it.sha256 = got
      it.at = Date.now()
      it.updatedAt = it.at
      this.save()
      this.onEvent({
        kind: 'received',
        id: it.id,
        name: it.name,
        size: it.size,
        risk: riskOf(it.name),
        kindName: kindOf(it.name),
        from: it.fromName,
        at: it.at,
        path: final,
      })
      return { id: it.id, name: it.name, size: it.size, sha256: got, at: it.at, path: final, risk: riskOf(it.name) }
    })
  }

  status(id) {
    const it = this.items.get(String(id))
    if (!it) return null
    return {
      id: it.id,
      dir: it.dir,
      state: it.state,
      name: it.name,
      size: it.size,
      received: it.received || 0,
      chunks: chunksOf(it.size),
      chunkSize: CHUNK,
      expiresAt: it.expiresAt || 0,
      sha256: it.sha256 || '',
    }
  }

  async abort(id, deviceId) {
    const it = this.items.get(String(id))
    if (!it || it.state !== 'uploading') return false
    if (it.dir === 'in' && it.deviceId !== deviceId) return false
    await this.withLock(id, async () => {
      it.state = 'aborted'
      it.updatedAt = Date.now()
      try {
        await fsp.unlink(this.partPath(id))
      } catch (e) {}
      this.save()
    })
    return true
  }

  // ---------------------------------------------------------------- 电脑 → 手机

  async createOutgoing(body) {
    const name = safeName(body && body.name)
    const size = Number(body && body.size)
    if (!Number.isFinite(size) || size <= 0) return { code: 'BAD_SIZE' }
    if (size > this.maxFile) return { code: 'TOO_LARGE', maxFile: this.maxFile }
    const st = this.stats()
    if (st.used + size > this.quota) return { code: 'QUOTA_FULL', used: st.used, quota: this.quota }
    const free = diskFree(this.root)
    if (free != null && free < size + 64 * 1024 * 1024) return { code: 'NO_SPACE', free }

    await this.evict(size)
    const id = crypto.randomBytes(12).toString('hex')
    const now = Date.now()
    const it = {
      id,
      dir: 'out',
      name,
      file: name,
      size,
      mime: String((body && body.mime) || '').slice(0, 80),
      state: 'sending',
      received: 0,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + PENDING_TTL,
      deviceId: '',
      fromName: '电脑',
    }
    this.items.set(id, it)
    await fsp.writeFile(this.partPath(id), Buffer.alloc(0))
    this.save()
    return { id, chunkSize: CHUNK, chunks: chunksOf(size) }
  }

  /**
   * 本机页面把文件块写进来（loopback，不再套一层加密）。
   * 用绝对偏移而不是固定块号：宿主桥只收字符串，页面走 base64 时块会更小。
   */
  async appendLocal(id, offset, buf) {
    if (!ID_RE.test(String(id))) return { code: 'BAD_ID' }
    return this.withLock(id, async () => {
      const it = this.items.get(id)
      if (!it || it.dir !== 'out') return { code: 'NOT_FOUND' }
      if (it.state !== 'sending') return { code: 'BAD_STATE', state: it.state }
      if (!Number.isInteger(offset) || offset < 0) return { code: 'BAD_OFFSET' }
      if (offset !== it.received) return { code: 'OFFSET', expected: it.received, received: it.received }
      if (!buf || !buf.length) return { code: 'BAD_CHUNK', want: 1 }
      if (it.received + buf.length > it.size) return { code: 'BAD_CHUNK', want: it.size - it.received }
      await fsp.appendFile(this.partPath(id), buf)
      it.received += buf.length
      it.updatedAt = Date.now()
      this.save()
      return { received: it.received, chunks: chunksOf(it.size), done: it.received === it.size }
    })
  }

  async finishOutgoing(id) {
    return this.withLock(id, async () => {
      const it = this.items.get(id)
      if (!it || it.dir !== 'out') return { code: 'NOT_FOUND' }
      if (it.state !== 'sending') return { code: 'BAD_STATE', state: it.state }
      if (it.received !== it.size) return { code: 'INCOMPLETE', received: it.received, size: it.size }
      const part = this.partPath(id)
      const sha = await hashFile(part)
      const final = this.filePath(it)
      await fsp.rename(part, final)
      it.state = 'pending'
      it.sha256 = sha
      it.at = Date.now()
      it.updatedAt = it.at
      it.expiresAt = it.at + PENDING_TTL
      this.save()
      this.onEvent({
        kind: 'offer',
        id: it.id,
        name: it.name,
        size: it.size,
        risk: riskOf(it.name),
        kindName: kindOf(it.name),
        at: it.at,
      })
      return { id: it.id, name: it.name, size: it.size, sha256: sha, at: it.at }
    })
  }

  /** 手机拉取一块：服务端按令牌派生同一把钥匙，现场加密 */
  async pullChunk(id, index, token) {
    const it = this.items.get(String(id))
    if (!it || it.dir !== 'out') return { code: 'NOT_FOUND' }
    if (it.state !== 'pending' && it.state !== 'delivered') return { code: 'BAD_STATE', state: it.state }
    const chunks = chunksOf(it.size)
    if (!Number.isInteger(index) || index < 0 || index >= chunks) return { code: 'BAD_INDEX', chunks }
    const off = index * CHUNK
    const len = Math.min(CHUNK, it.size - off)
    const fh = await fsp.open(this.filePath(it), 'r')
    try {
      const buf = Buffer.alloc(len)
      await fh.read(buf, 0, len, off)
      const sealed = seal(keyFor(token, id), nonceFor(id, index), aadFor(id, index, it.size), buf)
      return { buf: sealed, index, chunks, total: it.size, sha256: it.sha256, name: it.name, mime: it.mime }
    } finally {
      await fh.close()
    }
  }

  async finishPull(id, sha, deviceId) {
    return this.withLock(id, async () => {
      const it = this.items.get(id)
      if (!it || it.dir !== 'out') return { code: 'NOT_FOUND' }
      if (it.state !== 'pending' && it.state !== 'delivered') return { code: 'BAD_STATE', state: it.state }
      if (String(sha || '').toLowerCase() !== it.sha256) return { code: 'HASH_MISMATCH' }
      if (it.state !== 'delivered') {
        it.state = 'delivered'
        it.deliveredAt = Date.now()
        it.deliveredTo = deviceId || ''
        this.save()
        this.onEvent({ kind: 'delivered', id: it.id, name: it.name, size: it.size, at: it.deliveredAt })
      }
      return { id: it.id, name: it.name, size: it.size, deliveredAt: it.deliveredAt || Date.now() }
    })
  }

  async decline(id, deviceId) {
    const it = this.items.get(String(id))
    if (!it || it.dir !== 'out' || it.state !== 'pending') return false
    it.declinedBy = it.declinedBy || {}
    it.declinedBy[deviceId || '?'] = Date.now()
    // 任一设备拒收即终结这次发送：电脑侧「发给手机」语义上只针对一台
    it.state = 'declined'
    it.declinedAt = Date.now()
    this.save()
    this.onEvent({ kind: 'declined', id: it.id, name: it.name })
    return true
  }

  async remove(id) {
    const it = this.items.get(String(id))
    if (!it) return false
    await this.withLock(id, async () => {
      for (const p of [this.filePath(it), this.partPath(id)]) {
        try {
          await fsp.unlink(p)
        } catch (e) {}
      }
      this.items.delete(id)
      this.save()
    })
    return true
  }

  async clear(dir) {
    const list = [...this.items.values()].filter((it) => (dir ? it.dir === dir : true))
    for (const it of list) await this.remove(it.id)
    return list.length
  }

  /** 配额不够时先淘汰「已送达/已拒绝」的旧文件，不动还没收的 */
  async evict(need) {
    let used = this.stats().used
    if (used + need <= this.quota) return
    const old = [...this.items.values()]
      .filter((it) => it.state === 'delivered' || it.state === 'declined' || it.state === 'aborted')
      .sort((a, b) => a.at - b.at)
    for (const it of old) {
      if (used + need <= this.quota) break
      used -= it.size || 0
      await this.remove(it.id)
    }
  }

  /** 过期清理：上传一半的 24h 后丢弃；已完成的 14 天后清掉，避免无限涨 */
  sweep() {
    const now = Date.now()
    let changed = 0
    for (const it of [...this.items.values()]) {
      const half = it.state === 'uploading' || it.state === 'sending'
      if (half && it.expiresAt <= now) {
        try {
          fs.unlinkSync(this.partPath(it.id))
        } catch (e) {}
        this.items.delete(it.id)
        changed++
        continue
      }
      if (it.state === 'pending' && it.expiresAt <= now) {
        it.state = 'expired'
        changed++
        continue
      }
      if ((it.state === 'delivered' || it.state === 'received' || it.state === 'declined' || it.state === 'expired') && now - (it.at || it.updatedAt || 0) > KEEP_MS) {
        try {
          fs.unlinkSync(this.filePath(it))
        } catch (e) {}
        this.items.delete(it.id)
        changed++
      }
    }
    // 条目数上限：先删最老的已终结条目
    if (this.items.size > MAX_ITEMS) {
      const done = [...this.items.values()]
        .filter((it) => it.state !== 'uploading' && it.state !== 'sending' && it.state !== 'pending')
        .sort((a, b) => (a.at || 0) - (b.at || 0))
      for (const it of done) {
        if (this.items.size <= MAX_ITEMS) break
        try {
          fs.unlinkSync(this.filePath(it))
        } catch (e) {}
        this.items.delete(it.id)
        changed++
      }
    }
    if (changed) this.save()
    return changed
  }
}

module.exports = {
  FileHub,
  CHUNK,
  MAX_FILE,
  MAX_CHUNK_BODY,
  QUOTA_BYTES,
  safeName,
  kindOf,
  riskOf,
  extOf,
  chunksOf,
  hkdf,
  keyFor,
  nonceFor,
  aadFor,
  seal,
  open,
  hashFile,
}
