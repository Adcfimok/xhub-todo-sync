'use strict'
/**
 * 待办同步 · 局域网中枢
 *
 * 只做三件事：给手机端提供同步接口、给本机页面提供桥接接口、把变更实时推给已连接设备。
 * 不直接读写宿主数据库——宿主待办由扩展前端经 window.xhub 桥搬进搬出（见 /api/local/*）。
 */

const http = require('http')
const os = require('os')
const { Store, normalizeRecord } = require('./store')

const PORT = parseInt(process.env.PORT || '47821', 10)
const HOST = process.env.XHUB_LISTEN_HOST || '0.0.0.0'
const APP = 'xhub-todo-relay'
const PROTO = 1
const BODY_LIMIT = 1024 * 1024
const LOCAL_ONLY = new Set(['/api/local', '/api/admin'])

const store = new Store(os.hostname())
const sseClients = new Set()

store.onChange((event, payload) => {
  broadcast(event, payload)
})

function broadcast(event, payload) {
  const chunk = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
  for (const res of sseClients) {
    try {
      res.write(chunk)
    } catch (_) {
      sseClients.delete(res)
    }
  }
}

// ---------- 工具 ----------

function send(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  })
  res.end(body)
}

function fail(res, status, code, extra) {
  send(res, status, Object.assign({ code, message: code }, extra || {}))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > BODY_LIMIT) {
        reject(Object.assign(new Error('payload too large'), { code: 'PAYLOAD_TOO_LARGE' }))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (e) {
        reject(Object.assign(new Error('invalid json'), { code: 'BAD_REQUEST' }))
      }
    })
    req.on('error', reject)
  })
}

function isLocal(req) {
  const a = req.socket.remoteAddress || ''
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'
}

function tokenOf(req, url) {
  const h = req.headers['authorization'] || ''
  if (h.startsWith('Bearer ')) return h.slice(7)
  const q = url.searchParams.get('token')
  return q || ''
}

function lanAddresses() {
  const out = []
  const ifaces = os.networkInterfaces()
  for (const [name, list] of Object.entries(ifaces)) {
    for (const it of list || []) {
      if (it.family !== 'IPv4' || it.internal) continue
      out.push({ iface: name, address: it.address, preferred: /^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[01])\./.test(it.address) })
    }
  }
  out.sort((a, b) => Number(b.preferred) - Number(a.preferred))
  return out
}

// ---------- 路由 ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const path = url.pathname

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Hub-Device, X-Hub-Proto',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    })
    res.end()
    return
  }

  for (const prefix of LOCAL_ONLY) {
    if (path.startsWith(prefix) && !isLocal(req)) {
      fail(res, 403, 'LOCAL_ONLY')
      return
    }
  }

  try {
    if (path === '/healthz') return send(res, 200, { ok: true, app: APP, seq: store.state.seq })

    if (path === '/api/v1/ping') {
      const auth = store.auth(tokenOf(req, url))
      return send(res, 200, {
        app: APP,
        proto: PROTO,
        hubId: store.state.hubId,
        hubName: store.state.hubName,
        needsPair: store.deviceCount() === 0,
        recordCount: store.stats().total,
        seq: store.state.seq,
        serverTime: Date.now(),
        authorized: !!auth,
      })
    }

    if (path === '/api/v1/pair' && req.method === 'POST') {
      const body = await readBody(req)
      const check = store.verifyCode(body.code)
      if (!check.ok) return fail(res, check.reason === 'TOO_MANY_ATTEMPTS' ? 429 : 400, check.reason)
      const out = store.pairDevice(body.device || {})
      if (!out.ok) return fail(res, out.reason === 'DEVICE_LIMIT' ? 409 : 400, out.reason)
      return send(res, 200, {
        token: out.token,
        hubId: store.state.hubId,
        hubName: store.state.hubName,
        deviceId: out.device.id,
        proto: PROTO,
        serverTime: Date.now(),
        seq: store.state.seq,
      })
    }

    if (path === '/api/v1/snapshot') {
      const dev = store.auth(tokenOf(req, url))
      if (!dev) return fail(res, 401, 'UNAUTHORIZED')
      store.touch(dev.id)
      const snap = store.snapshot()
      return send(res, 200, Object.assign({ serverTime: Date.now(), hubId: store.state.hubId }, snap))
    }

    if (path === '/api/v1/sync' && req.method === 'POST') {
      const dev = store.auth(tokenOf(req, url))
      if (!dev) return fail(res, 401, 'UNAUTHORIZED')
      store.touch(dev.id)

      const body = await readBody(req)
      const limit = Math.min(1000, Math.max(1, Number(body.limit) || 500))
      const sinceSeq = Number(body.sinceSeq) || 0
      const changes = Array.isArray(body.changes) ? body.changes.slice(0, 1000) : []

      let applied = 0
      const rejected = []
      const conflicts = []
      for (const raw of changes) {
        const out = store.merge(raw, dev.id)
        if (out.accepted) applied++
        else if (out.reason !== 'DUPLICATE') rejected.push({ id: raw.id, reason: out.reason, winnerHlc: out.winnerHlc })
        if (out.conflict) {
          conflicts.push({
            id: out.conflict.id,
            title: out.conflict.title,
            fields: out.conflict.fields,
            winner: out.conflict.winner.device,
            loser: out.conflict.loser.device,
          })
        }
      }

      const minSeq = store.minSeq()
      const resyncRequired = sinceSeq > 0 && sinceSeq < minSeq - 1
      const pulled = resyncRequired ? { changes: store.snapshot().records, hasMore: false } : store.changesSince(sinceSeq, limit)

      dev.cursor = store.state.seq
      store.scheduleSave()
      return send(res, 200, {
        seq: store.state.seq,
        serverTime: Date.now(),
        applied,
        rejected,
        conflicts,
        changes: pulled.changes,
        hasMore: pulled.hasMore,
        resyncRequired,
      })
    }

    if (path === '/api/v1/stream') {
      const dev = store.auth(tokenOf(req, url))
      if (!dev) return fail(res, 401, 'UNAUTHORIZED')
      store.touch(dev.id)
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': '*',
      })
      res.write(`event: hello\ndata: ${JSON.stringify({ seq: store.state.seq, serverTime: Date.now() })}\n\n`)
      sseClients.add(res)
      const hb = setInterval(() => {
        try {
          res.write(`event: ping\ndata: ${JSON.stringify({ serverTime: Date.now() })}\n\n`)
          store.touch(dev.id)
        } catch (_) {
          /* 连接已断，交给 close 事件清理 */
        }
      }, 25000)
      req.on('close', () => {
        clearInterval(hb)
        sseClients.delete(res)
      })
      return
    }

    // ---------- 仅本机：宿主桥接 ----------

    if (path === '/api/local/ingest' && req.method === 'POST') {
      const body = await readBody(req)
      const rows = Array.isArray(body.records) ? body.records : []
      const out = store.applyHostSnapshot(rows, Date.now(), { full: body.full !== false })
      return send(res, 200, Object.assign({ ok: true }, out))
    }

    if (path === '/api/local/outbound') {
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50))
      const out = store.outbound(limit)
      return send(res, 200, out)
    }

    if (path === '/api/local/ack' && req.method === 'POST') {
      const body = await readBody(req)
      store.ackHost(body.cursor, body.applied)
      return send(res, 200, { ok: true })
    }

    if (path === '/api/admin/state') {
      const pair = store.pairCode()
      return send(res, 200, {
        hubId: store.state.hubId,
        hubName: store.state.hubName,
        proto: PROTO,
        port: server.address() ? server.address().port : PORT,
        listenHost: HOST,
        addresses: lanAddresses(),
        pairCode: pair.code,
        pairExpiresAt: pair.expiresAt,
        devices: store.deviceList(),
        stats: store.stats(),
        conflicts: store.state.conflicts.slice(0, 50).map((c) => ({
          at: c.at,
          id: c.id,
          title: c.title,
          fields: c.fields,
          winner: c.winner.device,
          loser: c.loser.device,
        })),
        records: store
          .snapshot()
          .records.filter((r) => !r.deleted)
          .slice(0, 500),
        serverTime: Date.now(),
      })
    }

    if (path === '/api/admin/rotate-code' && req.method === 'POST') {
      const p = store.rotateCode()
      return send(res, 200, { code: p.code, expiresAt: p.expiresAt })
    }

    if (path === '/api/admin/revoke' && req.method === 'POST') {
      const body = await readBody(req)
      const ok = store.revoke(String(body.deviceId || ''))
      return send(res, ok ? 200 : 404, { ok })
    }

    if (path === '/api/admin/restore' && req.method === 'POST') {
      const body = await readBody(req)
      const idx = Number(body.index)
      const c = store.state.conflicts[idx]
      if (!c) return fail(res, 404, 'NOT_FOUND')
      const rec = normalizeRecord(Object.assign({}, c.loser.record, { hlc: store.clock.next(), deleted: false }))
      if (!rec) return fail(res, 400, 'BAD_REQUEST')
      rec.by = 'pc-host'
      store.commit(rec)
      store.pushOutbox(rec.id, rec.seq)
      store.state.conflicts.splice(idx, 1)
      store.scheduleSave()
      return send(res, 200, { ok: true, record: rec })
    }

    if (path === '/api/admin/clear-conflicts' && req.method === 'POST') {
      store.state.conflicts = []
      store.scheduleSave()
      return send(res, 200, { ok: true })
    }

    if (path === '/api/admin/purge' && req.method === 'POST') {
      return send(res, 200, { removed: store.purgeTombstones() })
    }

    fail(res, 404, 'NOT_FOUND')
  } catch (e) {
    const code = e && e.code
    if (code === 'BAD_REQUEST' || code === 'PAYLOAD_TOO_LARGE') {
      return fail(res, code === 'PAYLOAD_TOO_LARGE' ? 413 : 400, code)
    }
    console.error('[http] 未处理异常:', e)
    fail(res, 500, 'INTERNAL', { detail: String(e && e.message) })
  }
})

server.listen(PORT, HOST, () => {
  const addr = server.address()
  console.log(`[todo-relay] listening on ${HOST}:${addr.port}`)
  console.log('[todo-relay] lan:', lanAddresses().map((a) => `${a.address}:${addr.port}`).join(', ') || '(none)')
  const code = store.pairCode()
  console.log(`[todo-relay] pair code: ${code.code} (5 分钟内有效)`)
})

// 每分钟做一次墓碑清理；退出前把内存状态刷盘
const purgeTimer = setInterval(() => {
  try {
    store.purgeTombstones()
  } catch (e) {
    console.error('[store] 清理失败:', e.message)
  }
}, 60 * 1000)
purgeTimer.unref()

function shutdown(sig) {
  console.log('[todo-relay] shutting down:', sig)
  store.flush()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 1500)
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('uncaughtException', (e) => console.error('[todo-relay] uncaught:', e))
