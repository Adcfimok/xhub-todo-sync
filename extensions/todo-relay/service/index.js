'use strict'
/**
 * 待办同步 · 局域网中枢（多集合 + 扩展宿主）
 *
 * 三块职责：
 * 1. 给手机端提供同步接口（/api/v1/*）
 * 2. 给本机页面提供桥接接口（/api/local/*）与扩展宿主（/ext/*）
 * 3. 把变更实时推给已连接设备（SSE）
 *
 * 不直接读写宿主数据库——宿主数据由扩展前端经 window.xhub 桥搬进搬出。
 */

const http = require('http')
const os = require('os')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { Store, COLLECTIONS, normalizeRecord } = require('./store')
const { FileHub, MAX_CHUNK_BODY } = require('./files')

const PORT = parseInt(process.env.PORT || '47821', 10)
const HOST = process.env.XHUB_LISTEN_HOST || '0.0.0.0'
const APP = 'xhub-todo-relay'
const PROTO = 2
const BODY_LIMIT = 2 * 1024 * 1024
const LOCAL_ONLY = ['/api/local', '/api/admin']
const EXT_ROOT = path.join(__dirname, '..', '..')
const KV_FILE = path.join(__dirname, '..', '.data', 'kv.json')
const DATA_DIR = process.env.RELAY_DATA_DIR
  ? path.resolve(process.env.RELAY_DATA_DIR)
  : path.join(__dirname, '..', '.data')

const netinfo = require('./netinfo')
const store = new Store(os.hostname())
const sseClients = new Set()
const bridgeWaiters = new Map()
let lastLocalPoll = 0

store.onChange((event, payload) => broadcast(event, payload))

// 文件传输：与同步共用配对令牌，但走独立的二进制通道
const files = new FileHub(DATA_DIR)
files.onEvent = (payload) => broadcast('file', payload)

function broadcast(event, payload) {
  // 带 id 才能让 EventSource 在重连时自动回传 Last-Event-ID，断线期间的变更可精确补齐
  const idLine = payload && Number.isFinite(payload.seq) ? `id: ${payload.seq}\n` : ''
  const chunk = `${idLine}event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
  for (const res of sseClients) {
    try {
      res.write(chunk)
    } catch (_) {
      sseClients.delete(res)
    }
  }
}

/**
 * 挂一条 SSE 连接。PC 页面与手机端共用同一套推送，
 * 区别只在鉴权方式（PC 走本机来源校验，手机走 Bearer 令牌）。
 * 若请求带了 Last-Event-ID，先把断线期间的变更补发，再进入实时流。
 */
function attachStream(req, res, url, device) {
  res.writeHead(200, Object.assign({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  }, res._cors || {}))

  const lastId = Number(req.headers['last-event-id'] || url.searchParams.get('lastEventId') || 0)
  let catchup = []
  if (lastId > 0) {
    const gap = store.changesSince(lastId, 500, null)
    catchup = gap.changes
  }
  res.write(`event: hello\ndata: ${JSON.stringify({
    seq: store.state.seq,
    serverTime: Date.now(),
    catchup: catchup.length,
  })}\n\n`)
  for (const rec of catchup) {
    res.write(`id: ${rec.seq}\nevent: change\ndata: ${JSON.stringify({ seq: rec.seq, id: rec.id, col: rec.col })}\n\n`)
  }

  sseClients.add(res)
  const hb = setInterval(() => {
    try {
      res.write(`event: ping\ndata: ${JSON.stringify({ serverTime: Date.now() })}\n\n`)
      if (device) store.touch(device.id)
    } catch (_) {}
  }, 25000)
  hb.unref?.()
  req.on('close', () => {
    clearInterval(hb)
    sseClients.delete(res)
  })
}

// ---------- 工具 ----------

function send(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  }, res._cors || {}))
  res.end(body)
}

/** 本机接口允许的来源：扩展页面自身（同源），以及 localhost 别名 */
function allowedOrigin(port) {
  return new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`])
}

/**
 * 判定跨站请求。
 *
 * 依据浏览器强制写入、页面脚本无法伪造的两个头：
 *   - `Sec-Fetch-Site`：跨源一定是 `cross-site`，同源是 `same-origin` / `none`
 *   - `Origin`：跨源请求必带，值为对方来源
 *
 * 为什么不用「强制自定义头」：宿主（x-hub）转发 `service.request` 时是否透传
 * 自定义头并不确定，一旦不透传，扩展页面所有请求都会被 403 打死。
 * 而 Origin / Sec-Fetch-Site 由浏览器直接写入，既拦得住 CSRF，又不依赖宿主行为。
 * 自定义头仍然接受（带了不冲突），只是不再作为必要条件。
 */
function isCrossSite(req, port) {
  const site = req.headers['sec-fetch-site']
  if (site === 'cross-site') return true
  const origin = req.headers.origin
  if (!origin) return false
  return !allowedOrigin(port).has(origin)
}

/**
 * 按路径分流 CORS：
 * - /api/v1/* 是手机端用的，靠 Authorization 里的 Bearer 令牌鉴权、不依赖 Cookie，
 *   因此允许任意来源（手机页面 origin 是它自己的 127.0.0.1:47xxx，必须跨源）；
 * - 其余（/api/local、/api/admin、静态资源）一律按同源收紧，返回 null 表示应当拒绝。
 */
function corsFor(req, pathname, port) {
  if (pathname.startsWith('/api/v1/')) {
    // 手机端跨源访问，但诊断接口含内网信息，仍按同源处理
    if (pathname === '/api/v1/diag') {
      return isCrossSite(req, port) ? null : {}
    }
    return { 'Access-Control-Allow-Origin': '*' }
  }
  if (isCrossSite(req, port)) return null
  const origin = req.headers.origin
  return origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}
}

function fail(res, status, code, extra) {
  send(res, status, Object.assign({ code, message: code }, extra || {}))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    let aborted = false
    const chunks = []
    req.on('data', (c) => {
      if (aborted) return
      size += c.length
      if (size > BODY_LIMIT) {
        // 不能直接 destroy：socket 一断，外层就没法把 413 写回去，
        // 客户端只会看到 ECONNRESET。改为丢弃剩余数据、让请求正常结束。
        aborted = true
        chunks.length = 0
        req.removeAllListeners('data')
        req.resume()
        reject(Object.assign(new Error('payload too large'), { code: 'PAYLOAD_TOO_LARGE' }))
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (aborted) return
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

/** 二进制体读取：文件块专用，超限与 JSON 接口同样返回 413 而不是断连接 */
function readBinary(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0
    let aborted = false
    const chunks = []
    req.on('data', (c) => {
      if (aborted) return
      size += c.length
      if (size > limit) {
        aborted = true
        chunks.length = 0
        req.removeAllListeners('data')
        req.resume()
        reject(Object.assign(new Error('payload too large'), { code: 'PAYLOAD_TOO_LARGE' }))
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (!aborted) resolve(Buffer.concat(chunks))
    })
    req.on('error', reject)
  })
}

const FILE_STATUS = {
  NOT_FOUND: 404, BAD_ID: 400, BAD_SIZE: 400, BAD_CHUNK: 400, BAD_INDEX: 416,
  BAD_STATE: 409, OFFSET: 409, INCOMPLETE: 409, HASH_MISMATCH: 422,
  TOO_LARGE: 413, QUOTA_FULL: 507, NO_SPACE: 507, EXPIRED: 410, DECRYPT_FAIL: 400,
}

function fileFail(res, r) {
  return fail(res, FILE_STATUS[r.code] || 400, r.code, r)
}

function sendBinary(res, buf, headers) {
  res.writeHead(200, Object.assign({
    'Content-Type': 'application/octet-stream',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
    'Access-Control-Expose-Headers': 'X-File-Name, X-Chunks, X-Total, X-Sha256, X-Chunk-Index, X-Chunk-Size',
  }, res._cors || {}, headers || {}))
  res.end(buf)
}

/** 滑动窗口限流：按「来源 + 路径前缀」计数，超限返回 429 */
const rateBuckets = new Map()
function rateLimit(key, max, windowMs) {
  const now = Date.now()
  let b = rateBuckets.get(key)
  if (!b || now > b.reset) {
    b = { n: 0, reset: now + windowMs }
    rateBuckets.set(key, b)
  }
  b.n += 1
  return b.n <= max
}
setInterval(() => {
  const now = Date.now()
  for (const [k, b] of rateBuckets) if (now > b.reset) rateBuckets.delete(k)
}, 60000).unref?.()

/** 每类接口的阈值：配对最容易被打，给得最紧 */
function limitFor(pathname) {
  if (pathname === '/api/v1/pair') return { max: 10, windowMs: 60000, bucket: 'pair' }
  if (pathname.startsWith('/api/v1/files/')) return { max: 900, windowMs: 60000, bucket: 'files' }
  if (pathname.startsWith('/api/local/files/')) return { max: 900, windowMs: 60000, bucket: 'files' }
  if (pathname.startsWith('/api/v1/sync')) return { max: 120, windowMs: 60000, bucket: 'sync' }
  if (pathname.startsWith('/api/v1/')) return { max: 240, windowMs: 60000, bucket: 'v1' }
  return { max: 600, windowMs: 60000, bucket: 'local' }
}

function isLocal(req) {
  const a = req.socket.remoteAddress || ''
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'
}

function tokenOf(req, url) {
  const h = req.headers['authorization'] || ''
  if (h.startsWith('Bearer ')) return h.slice(7)
  return url.searchParams.get('token') || ''
}

/**
 * 当前默认路由出口地址（手机能连上的那张网卡）。
 * 启动时探一次，之后每 30 秒刷新——切换 Wi-Fi / 插网线 / 开 VPN 都能跟上。
 */
let primaryIp = ''
let primaryAt = 0
function refreshPrimary() {
  netinfo
    .probeDefaultRoute()
    .then((ip) => {
      if (ip) primaryIp = ip
      primaryAt = Date.now()
    })
    .catch(() => {
      primaryAt = Date.now()
    })
}
refreshPrimary()
setInterval(refreshPrimary, 30000)

function lanAddresses() {
  return netinfo.rankAddresses(netinfo.listIPv4(os), primaryIp)
}

/** 当前的主地址（可能是空串：完全没有局域网连接） */
function primaryAddress() {
  const list = lanAddresses()
  const hit = list.find((x) => x.primary)
  return hit ? hit.address : ''
}

function parseCols(v) {
  if (!v) return null
  const list = String(v)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => COLLECTIONS.indexOf(s) >= 0)
  return list.length ? list : null
}

// ---------- 扩展宿主 ----------

function scanExtensions() {
  const out = []
  let dirs = []
  try {
    dirs = fs.readdirSync(EXT_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory())
  } catch (e) {
    return { items: [], root: EXT_ROOT, readable: false }
  }
  for (const d of dirs) {
    const dir = path.join(EXT_ROOT, d.name)
    const mf = path.join(dir, 'manifest.json')
    if (!fs.existsSync(mf)) continue
    try {
      const m = JSON.parse(fs.readFileSync(mf, 'utf8'))
      if (!m || !m.id) continue
      out.push({
        dir: d.name,
        id: m.id,
        name: m.name || m.id,
        version: m.version || '',
        description: m.description || '',
        author: m.author || '',
        runtime: m.runtime || 'web',
        icon: m.icon ? '/ext/' + m.id + '/' + String(m.icon).replace(/^\.?\//, '') : '',
        entry: m.entry || {},
        surfaces: m.surfaces || [],
      })
    } catch (e) {
      /* 坏清单跳过，不让一台机器上的所有扩展都打不开 */
    }
  }
  const self = out.findIndex((x) => x.id === 'com.zhou.todo-relay')
  if (self >= 0) out.splice(self, 1)
  out.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
  return { items: out, root: EXT_ROOT, readable: true }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
}

/** 扩展页面里注入的桥接垫片：把 window.xhub 映射到中枢接口 */
function shimJs(extId, token) {
  return `/* x-hub bridge shim (Android host) */
(function(){
  if (window.xhub && window.xhub.__shim) return;
  var BASE='', EXT=${JSON.stringify(extId)}, TOKEN=${JSON.stringify(token)};
  function req(path, opts){
    opts=opts||{};
    var h={'Content-Type':'application/json'};
    if(TOKEN) h['Authorization']='Bearer '+TOKEN;
    if(opts.headers) for(var k in opts.headers) h[k]=opts.headers[k];
    return fetch(BASE+path,{method:opts.method||'GET',headers:h,body:opts.body})
      .then(function(r){return r.json().then(function(d){
        if(r.status>=400){var e=new Error((d&&(d.message||d.code))||('HTTP '+r.status));e.code=d&&d.code;throw e;}
        return d;})});
  }
  function bridge(method,args){
    return req('/api/ext/'+encodeURIComponent(EXT)+'/bridge',{method:'POST',body:JSON.stringify({method:method,args:args||{}})})
      .then(function(r){ if(r && r.error) throw new Error(r.error); return r.result; });
  }
  function kv(action){ return {
    get:function(k){return req('/api/ext/'+encodeURIComponent(EXT)+'/kv/'+encodeURIComponent(k)).then(function(r){return r.value===undefined?null:r.value;})},
    set:function(k,v){return req('/api/ext/'+encodeURIComponent(EXT)+'/kv/'+encodeURIComponent(k),{method:'POST',body:JSON.stringify({value:v})}).then(function(){})},
    remove:function(k){return req('/api/ext/'+encodeURIComponent(EXT)+'/kv/'+encodeURIComponent(k),{method:'DELETE'}).then(function(){})},
    clear:function(){return req('/api/ext/'+encodeURIComponent(EXT)+'/kv',{method:'DELETE'}).then(function(){})}
  }[action]; }
  var data={};
  ['notes','todos','stickies','detachedStickies','resources','snippets','tags','todoTags'].forEach(function(ns){
    data[ns]={};
    ['list','get','create','update','delete','toggle','schedule','setDescription','setPinned','setRepeat','setTags','togglePin','save','ofNote','setNoteTags','links'].forEach(function(fn){
      data[ns][fn]=function(a){ return bridge('data.'+ns+'.'+fn, a); };
    });
  });
  window.xhub={
    __shim:true,
    runtime:{
      info:function(){return req('/api/ext/'+encodeURIComponent(EXT)+'/info');},
      open:function(){},
      callExtension:function(){return Promise.reject(new Error('Android 端不支持跨扩展调用'))}
    },
    data:data,
    storage:kv('get')?{get:kv('get'),set:kv('set'),remove:kv('remove'),clear:kv('clear')}:{},
    config:{all:function(){return req('/api/ext/'+encodeURIComponent(EXT)+'/config')},
            get:function(k){return req('/api/ext/'+encodeURIComponent(EXT)+'/config/'+encodeURIComponent(k)).then(function(r){return r.value;})},
            set:function(k,v){return req('/api/ext/'+encodeURIComponent(EXT)+'/config/'+encodeURIComponent(k),{method:'POST',body:JSON.stringify({value:v})}).then(function(){})},
            remove:function(){}},
    service:{request:function(){return Promise.reject(new Error('扩展的 Node 后端在 Android 端不可用，仅前端逻辑可运行'))}},
    theme:{get:function(){return req('/api/ext/'+encodeURIComponent(EXT)+'/info').then(function(i){return {mode:i.theme||'dark',tokens:{}}})}},
    events:{on:function(){return function(){}},emit:function(){}},
    ui:{notify:function(t,b){return bridge('ui.notify',{title:t,body:b})},toast:function(){}},
    openPermissions:function(){},
    openExternal:function(u){window.open(u,'_blank')},
    fs:{saveText:function(){return Promise.reject(new Error('Android 端不支持直接写文件'))}}
  };
  var t=window.xhub.theme.get().then(function(x){
    document.documentElement.setAttribute('data-xhub-theme', x.mode||'dark');
  }).catch(function(){});
})();`
}

/** 按 manifest.id 找目录：安装目录名不一定等于扩展 id（开发期直挂目录尤其如此） */
function extDirById(extId) {
  const hit = scanExtensions().items.find((x) => x.id === extId)
  return hit && hit.dir ? path.join(EXT_ROOT, hit.dir) : null
}

function serveExtAsset(req, res, url, extId, rel, token) {
  if (!/^[A-Za-z0-9._/-]+$/.test(rel) || rel.indexOf('..') >= 0) return fail(res, 400, 'BAD_PATH')
  const base = extDirById(extId)
  if (!base) return fail(res, 404, 'EXT_NOT_FOUND')
  const file = path.join(base, rel)
  if (!file.startsWith(path.resolve(base))) return fail(res, 400, 'BAD_PATH')
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return fail(res, 404, 'NOT_FOUND')

  const ext = path.extname(file).toLowerCase()
  let body = fs.readFileSync(file)
  if (ext === '.html' || ext === '.htm') {
    let html = body.toString('utf8')
    const dir = path.posix.dirname('/' + rel.replace(/\\/g, '/'))
    const baseHref = '/ext/r/' + encodeURIComponent(token) + '/' + extId + (dir === '/' ? '/' : dir + '/')
    const inject =
      '<base href="' + baseHref + '">' +
      '<script src="/ext-shim.js?e=' + encodeURIComponent(extId) + '&t=' + encodeURIComponent(token) + '"></script>'
    if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, (m) => m + inject)
    else html = inject + html
    body = Buffer.from(html, 'utf8')
  }
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  })
  res.end(body)
}

// ---------- KV（扩展 storage/config） ----------

let kvCache = null
let kvFatal = null
function kvLoad() {
  if (kvCache) return kvCache
  try {
    kvCache = JSON.parse(fs.readFileSync(KV_FILE, 'utf8'))
  } catch (e) {
    if (e.code === 'ENOENT') {
      kvCache = {}
    } else {
      // 与状态库同样处理：隔离坏文件，不静默重置后被下一次 kvSave 覆盖
      const bad = `${KV_FILE}.corrupt-${Date.now()}`
      try {
        fs.renameSync(KV_FILE, bad)
        console.error(`[kv] 配置损坏，已隔离到 ${bad}：${e.message}`)
      } catch (renameErr) {
        console.error('[kv] 配置损坏且隔离失败:', renameErr.message)
      }
      kvCache = {}
      kvFatal = { code: 'KV_CORRUPT', message: `扩展配置损坏，已隔离为 ${bad}`, at: Date.now() }
    }
  }
  return kvCache
}
function kvSave() {
  try {
    fs.mkdirSync(path.dirname(KV_FILE), { recursive: true })
    const tmp = KV_FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(kvCache || {}))
    fs.renameSync(tmp, KV_FILE)
  } catch (e) {
    console.error('[kv] 落盘失败:', e.message)
  }
}

// ---------- 路由 ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const pathname = url.pathname
  const port = server.address() ? server.address().port : PORT

  // 任何路径先过来源判定：不在白名单的跨源请求连 CORS 头都拿不到，响应也读不出去
  const cors = corsFor(req, pathname, port)
  if (cors === null) return fail(res, 403, 'BAD_ORIGIN')
  res._cors = cors

  if (req.method === 'OPTIONS') {
    res.writeHead(204, Object.assign({
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Hub-Device, X-Hub-Proto, X-Hub-Local',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Max-Age': '600',
    }, cors))
    res.end()
    return
  }

  for (const prefix of LOCAL_ONLY) {
    if (!pathname.startsWith(prefix)) continue
    if (!isLocal(req)) return fail(res, 403, 'LOCAL_ONLY')
    // 跨站请求一律拒绝（浏览器写死的 Sec-Fetch-Site / Origin，页面脚本改不了）。
    // 同源页面与不带 Origin 的本地客户端放行——不能要求宿主一定透传自定义头。
    if (isCrossSite(req, port)) return fail(res, 403, 'CROSS_SITE')
    break
  }

  // 限流：healthz 是宿主探活，不能拦；其余按类别计数
  if (pathname !== '/healthz') {
    const lim = limitFor(pathname)
    const key = (req.socket.remoteAddress || '?') + '|' + lim.bucket
    if (!rateLimit(key, lim.max, lim.windowMs)) {
      res.setHeader('Retry-After', '60')
      return fail(res, 429, 'RATE_LIMITED')
    }
  }

  try {
    // ---- 公共 ----
    if (pathname === '/healthz') return send(res, 200, { ok: true, app: APP, proto: PROTO })

    if (pathname === '/api/v1/ping') {
      const auth = store.auth(tokenOf(req, url))
      const ext = scanExtensions()
      return send(res, 200, {
        app: APP,
        proto: PROTO,
        hubId: store.state.hubId,
        hubName: store.state.hubName,
        needsPair: store.deviceCount() === 0,
        recordCount: store.stats().total,
        collections: COLLECTIONS,
        extensionCount: ext.items.length,
        seq: store.state.seq,
        serverTime: Date.now(),
        authorized: !!auth,
      })
    }

    // 本机自检：给扩展页面排查「为什么手机连不上」用（只允许本机页面访问）
    if (pathname === '/api/v1/diag') {
      // 跨站已在 corsFor 里拦掉（该接口含内网地址，不能给外部页面读）
      if (!isLocal(req)) return fail(res, 403, 'LOCAL_ONLY')
      const addrs = lanAddresses()
      return send(res, 200, {
        app: APP,
        proto: PROTO,
        port: server.address() ? server.address().port : PORT,
        listenHost: HOST,
        lanEnabled: HOST !== '127.0.0.1' && HOST !== '::1' && HOST !== 'localhost',
        primary: primaryAddress(),
        defaultRoute: primaryIp,
        probedAt: primaryAt,
        addresses: addrs,
        // 一眼能看懂的结论，页面直接展示
        verdict: !(HOST !== '127.0.0.1' && HOST !== '::1' && HOST !== 'localhost')
          ? '后端只监听本机，手机无法连接：检查 network 权限是否被关闭'
          : addrs.some((x) => x.primary && !x.virtual)
            ? '正常：主地址走默认路由的物理网卡'
            : '没找到走默认路由的物理网卡：可能只连了 VPN，或全部是虚拟网卡',
        counts: store.stats().byCol,
        uptimeSec: Math.round(process.uptime()),
        node: process.version,
      })
    }

    if (pathname === '/api/v1/pair' && req.method === 'POST') {
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

    // ---------------------------------------------------------------- 文件传输（手机侧）
    // 与同步共用 Bearer 令牌；每台设备另有 allowFiles 开关，关掉后连枚举都不给。
    if (pathname.startsWith('/api/v1/files/')) {
      const dev = store.auth(tokenOf(req, url))
      if (!dev) return fail(res, 401, 'UNAUTHORIZED')
      if (dev.allowFiles === false) return fail(res, 403, 'FILE_FORBIDDEN')
      store.touch(dev.id)
      await files.ready
      const id = url.searchParams.get('id') || ''
      const idx = Number(url.searchParams.get('i'))

      if (pathname === '/api/v1/files/offer' && req.method === 'POST') {
        const r = await files.createUpload(dev, await readBody(req))
        if (r.code) return fileFail(res, r)
        return send(res, 200, Object.assign({ ok: true, proto: 1 }, r))
      }

      if (pathname === '/api/v1/files/chunk' && req.method === 'POST') {
        if (!Number.isInteger(idx) || idx < 0) return fail(res, 400, 'BAD_INDEX')
        const body = await readBinary(req, MAX_CHUNK_BODY)
        const r = await files.appendUpload(id, idx, tokenOf(req, url), body)
        if (r.code) return fileFail(res, r)
        return send(res, 200, r)
      }

      if (pathname === '/api/v1/files/finish' && req.method === 'POST') {
        const b = await readBody(req)
        const r = await files.finishUpload(b.id, tokenOf(req, url), b.sha256)
        if (r.code) return fileFail(res, r)
        // 电脑上的落盘路径不回传给手机，避免泄露主机目录结构
        store.audit('file-receive', { col: 'files', id: r.id, title: r.name }, dev.id)
        return send(res, 200, { ok: true, id: r.id, name: r.name, size: r.size, sha256: r.sha256, at: r.at, risk: r.risk })
      }

      if (pathname === '/api/v1/files/status' && req.method === 'GET') {
        const st = files.status(id)
        if (!st) return fail(res, 404, 'NOT_FOUND')
        if (st.dir === 'in' && files.items.get(id).deviceId !== dev.id) return fail(res, 403, 'FORBIDDEN')
        return send(res, 200, st)
      }

      if (pathname === '/api/v1/files/abort' && req.method === 'POST') {
        const b = await readBody(req)
        const ok = await files.abort(b.id, dev.id)
        return ok ? send(res, 200, { ok: true }) : fail(res, 404, 'NOT_FOUND')
      }

      if (pathname === '/api/v1/files/pending' && req.method === 'GET') {
        return send(res, 200, {
          offers: files.pendingFor(dev.id),
          stats: files.stats(),
          maxFile: files.maxFile,
          chunkSize: 2 * 1024 * 1024,
        })
      }

      if (pathname === '/api/v1/files/history' && req.method === 'GET') {
        return send(res, 200, { items: files.history(dev.id), maxFile: files.maxFile })
      }

      if (pathname === '/api/v1/files/decline' && req.method === 'POST') {
        const b = await readBody(req)
        const ok = await files.decline(b.id, dev.id)
        return ok ? send(res, 200, { ok: true }) : fail(res, 404, 'NOT_FOUND')
      }

      if (pathname === '/api/v1/files/pull' && req.method === 'GET') {
        if (!Number.isInteger(idx) || idx < 0) return fail(res, 400, 'BAD_INDEX')
        const r = await files.pullChunk(id, idx, tokenOf(req, url))
        if (r.code) return fileFail(res, r)
        return sendBinary(res, r.buf, {
          'X-File-Name': encodeURIComponent(r.name),
          'X-Chunks': String(r.chunks),
          'X-Total': String(r.total),
          'X-Sha256': r.sha256,
          'X-Chunk-Index': String(r.index),
          'X-Chunk-Size': String(Math.min(2 * 1024 * 1024, r.total - r.index * 2 * 1024 * 1024)),
        })
      }

      if (pathname === '/api/v1/files/pull/finish' && req.method === 'POST') {
        const b = await readBody(req)
        const r = await files.finishPull(b.id, b.sha256, dev.id)
        if (r.code) return fileFail(res, r)
        store.audit('file-send', { col: 'files', id: r.id, title: r.name }, dev.id)
        return send(res, 200, Object.assign({ ok: true }, r))
      }

      return fail(res, 404, 'NOT_FOUND')
    }

    if (pathname === '/api/v1/snapshot') {
      const dev = store.auth(tokenOf(req, url))
      if (!dev) return fail(res, 401, 'UNAUTHORIZED')
      store.touch(dev.id)
      const snap = store.snapshot(parseCols(url.searchParams.get('cols')))
      return send(res, 200, Object.assign({ serverTime: Date.now(), hubId: store.state.hubId }, snap))
    }

    if (pathname === '/api/v1/sync' && req.method === 'POST') {
      const dev = store.auth(tokenOf(req, url))
      if (!dev) return fail(res, 401, 'UNAUTHORIZED')
      store.touch(dev.id)

      const body = await readBody(req)
      const limit = Math.min(1000, Math.max(1, Number(body.limit) || 500))
      const sinceSeq = Number(body.sinceSeq) || 0
      const changes = Array.isArray(body.changes) ? body.changes.slice(0, 2000) : []
      const cols = parseCols(body.cols)

      let applied = 0
      const rejected = []
      const conflicts = []
      for (const raw of changes) {
        const out = store.merge(raw, dev.id)
        if (out.accepted) applied++
        else if (out.reason !== 'DUPLICATE') {
          // 把胜出版本一并回传：手机端要据此算出「哪几个字段被覆盖」，
          // 只给一个 winnerHlc 的话，冲突详情只能是空白
          rejected.push({
            id: raw.id,
            reason: out.reason,
            winnerHlc: out.winnerHlc,
            winner: store.get(raw.id),
          })
        }
        if (out.conflict) {
          conflicts.push({
            id: out.conflict.id,
            col: out.conflict.col,
            title: out.conflict.title,
            fields: out.conflict.fields,
            winner: out.conflict.winner.device,
            loser: out.conflict.loser.device,
          })
        }
      }

      const minSeq = store.minSeq()
      const resyncRequired = sinceSeq > 0 && sinceSeq < minSeq - 1
      const pulled = resyncRequired
        ? { changes: store.snapshot(cols).records, hasMore: false }
        : store.changesSince(sinceSeq, limit, cols)

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

    if (pathname === '/api/v1/stream') {
      const dev = store.auth(tokenOf(req, url))
      if (!dev) return fail(res, 401, 'UNAUTHORIZED')
      store.touch(dev.id)
      return attachStream(req, res, url, dev)
    }

    // 本机页面用的推送通道：同源（无 Origin）或白名单来源才能连，
    // 跨站 EventSource 会带自己的 Origin，在上面的 corsFor 就被拒了
    if (pathname === '/api/local/stream') {
      return attachStream(req, res, url, null)
    }

    // ---- 仅本机：宿主桥接 ----

    if (pathname === '/api/local/ingest' && req.method === 'POST') {
      const body = await readBody(req)
      const col = String(body.col || 'todos')
      const rows = Array.isArray(body.records) ? body.records : []
      if (process.env.DEBUG_INGEST === '1') {
        console.log('[ingest]', col, 'rows=' + rows.length, 'ids=' + rows.map((r) => r && r.id).join(','), 'ua=' + String(req.headers['user-agent'] || '').slice(0, 24) + ' origin=' + String(req.headers.origin || '-') + ' ref=' + String(req.headers.referer || '-').slice(0, 40))
      }
      const out = store.applyHostSnapshot(col, rows, Date.now(), {
        full: body.full !== false,
        allowEmpty: body.allowEmpty === true,
      })
      return send(res, 200, Object.assign({ ok: true, col }, out))
    }

    if (pathname === '/api/local/outbound') {
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50))
      const cols = parseCols(url.searchParams.get('cols'))
      return send(res, 200, store.outbound(limit, cols))
    }

    if (pathname === '/api/local/ack' && req.method === 'POST') {
      const body = await readBody(req)
      store.ackHost(body.cursor, body.applied)
      return send(res, 200, { ok: true })
    }

    // 扩展桥接信箱：页面轮询 → 执行 → 回填
    if (pathname === '/api/local/bridge/pending') {
      lastLocalPoll = Date.now()
      const out = []
      for (const [id, w] of bridgeWaiters) {
        if (w.taken) continue
        w.taken = true
        out.push({ id, extId: w.extId, method: w.method, args: w.args })
        if (out.length >= 8) break
      }
      return send(res, 200, { items: out })
    }

    if (pathname === '/api/local/bridge/result' && req.method === 'POST') {
      lastLocalPoll = Date.now()
      const body = await readBody(req)
      const w = bridgeWaiters.get(String(body.id || ''))
      if (!w) return send(res, 200, { ok: false })
      bridgeWaiters.delete(w.id)
      clearTimeout(w.timer)
      if (body.error) w.reject(new Error(String(body.error)))
      else w.resolve(body.result === undefined ? null : body.result)
      return send(res, 200, { ok: true })
    }

    // ---------------------------------------------------------------- 文件传输（本机页面）
    if (pathname.startsWith('/api/local/files/')) {
      await files.ready

      if (pathname === '/api/local/files/state' && req.method === 'GET') {
        return send(res, 200, {
          inbox: files.listInbox(),
          out: files.listOut(),
          stats: files.stats(),
          maxFile: files.maxFile,
          chunkSize: 2 * 1024 * 1024,
          devices: store.deviceList(),
        })
      }

      if (pathname === '/api/local/files/send/init' && req.method === 'POST') {
        const r = await files.createOutgoing(await readBody(req))
        if (r.code) return fileFail(res, r)
        return send(res, 200, Object.assign({ ok: true }, r))
      }

      if (pathname === '/api/local/files/send/chunk' && req.method === 'POST') {
        const id = url.searchParams.get('id') || ''
        const ct = String(req.headers['content-type'] || '')
        let body = null
        const offRaw = url.searchParams.get('off')
        let offset = offRaw == null || offRaw === '' ? NaN : Number(offRaw)
        if (ct.indexOf('application/json') === 0) {
          // 宿主的扩展 iframe 只能发字符串：小块 base64 走这里
          const j = await readBody(req)
          body = Buffer.from(String(j.data || ''), 'base64')
          if (j.off != null) offset = Number(j.off)
        } else {
          body = await readBinary(req, MAX_CHUNK_BODY)
        }
        if (!Number.isInteger(offset) || offset < 0) {
          const idx = Number(url.searchParams.get('i'))
          offset = Number.isInteger(idx) && idx >= 0 ? idx * 2 * 1024 * 1024 : -1
        }
        const r = await files.appendLocal(id, offset, body)
        if (r.code) return fileFail(res, r)
        return send(res, 200, r)
      }

      if (pathname === '/api/local/files/send/finish' && req.method === 'POST') {
        const b = await readBody(req)
        const r = await files.finishOutgoing(b.id)
        if (r.code) return fileFail(res, r)
        return send(res, 200, Object.assign({ ok: true }, r))
      }

      if (pathname === '/api/local/files/remove' && req.method === 'POST') {
        const b = await readBody(req)
        const ok = await files.remove(b.id)
        return ok ? send(res, 200, { ok: true }) : fail(res, 404, 'NOT_FOUND')
      }

      if (pathname === '/api/local/files/clear' && req.method === 'POST') {
        const b = await readBody(req)
        const n = await files.clear(b.scope === 'out' ? 'out' : b.scope === 'in' ? 'in' : '')
        return send(res, 200, { ok: true, removed: n })
      }

      if (pathname === '/api/local/files/allow' && req.method === 'POST') {
        const b = await readBody(req)
        const ok = store.setDeviceFlag(b.deviceId, 'allowFiles', !!b.allow)
        return ok ? send(res, 200, { ok: true }) : fail(res, 404, 'NOT_FOUND')
      }

      return fail(res, 404, 'NOT_FOUND')
    }

    if (pathname === '/api/admin/state') {
      const pair = store.pairCode()
      const cols = parseCols(url.searchParams.get('cols'))
      const snap = store.snapshot(cols)
      return send(res, 200, {
        hubId: store.state.hubId,
        hubName: store.state.hubName,
        proto: PROTO,
        port: server.address() ? server.address().port : PORT,
        listenHost: HOST,
        // 手机能不能连：只有对 0.0.0.0 / 局域网地址监听才谈得上配对
        lanEnabled: HOST !== '127.0.0.1' && HOST !== '::1' && HOST !== 'localhost',
        addresses: lanAddresses(),
        primary: primaryAddress(),
        primaryProbedAt: primaryAt,
        pairCode: pair.code,
        pairExpiresAt: pair.expiresAt,
        devices: store.deviceList(),
        stats: store.stats(),
        collections: COLLECTIONS,
        pcPageOnline: Date.now() - lastLocalPoll < 12000,
        // 可靠性告警：页面据此显示红条，而不是让用户蒙在鼓里
        fatal: store.fatal || kvFatal || null,
        readOnly: store.readOnly,
        saveFails: store.saveFails || 0,
        conflicts: store.state.conflicts.slice(0, 60).map((c) => ({
          at: c.at,
          col: c.col,
          id: c.id,
          title: c.title,
          fields: c.fields,
          winner: c.winner.device,
          loser: c.loser.device,
        })),
        records: snap.records.filter((r) => !r.deleted).slice(0, 2000),
        serverTime: Date.now(),
      })
    }

    if (pathname === '/api/admin/rotate-code' && req.method === 'POST') {
      const p = store.rotateCode()
      return send(res, 200, { code: p.code, expiresAt: p.expiresAt })
    }

    if (pathname === '/api/admin/revoke' && req.method === 'POST') {
      const body = await readBody(req)
      const ok = store.revoke(String(body.deviceId || ''))
      return send(res, ok ? 200 : 404, { ok })
    }

    if (pathname === '/api/admin/restore' && req.method === 'POST') {
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

    if (pathname === '/api/admin/clear-conflicts' && req.method === 'POST') {
      store.state.conflicts = []
      store.scheduleSave()
      return send(res, 200, { ok: true })
    }

    if (pathname === '/api/admin/purge' && req.method === 'POST') {
      return send(res, 200, { removed: store.purgeTombstones() })
    }

    // 审计日志：谁在何时改了哪条（只读，本机接口）
    if (pathname === '/api/admin/audit' && req.method === 'GET') {
      return send(res, 200, {
        items: store.auditLog(url.searchParams.get('limit')),
        total: store.state.audit.length,
      })
    }

    // ---- 扩展宿主 ----

    if (pathname === '/ext-shim.js') {
      const body = Buffer.from(shimJs(url.searchParams.get('e') || '', url.searchParams.get('t') || ''), 'utf8')
      res.writeHead(200, { 'Content-Type': MIME['.js'], 'Content-Length': body.length, 'Cache-Control': 'no-store' })
      return res.end(body)
    }

    if (pathname === '/ext/list') {
      const dev = store.auth(tokenOf(req, url))
      if (!dev) return fail(res, 401, 'UNAUTHORIZED')
      return send(res, 200, scanExtensions())
    }

    // 资源前缀带设备令牌：iframe 内的相对路径会继承它，子资源无需再带 Authorization
    if (pathname.startsWith('/ext/r/')) {
      const rest = pathname.slice('/ext/r/'.length).split('/')
      const token = decodeURIComponent(rest.shift() || '')
      const dev = store.auth(token)
      if (!dev) return fail(res, 401, 'UNAUTHORIZED')
      const extId = decodeURIComponent(rest.shift() || '')
      const rel = decodeURIComponent(rest.join('/') || '') || (url.searchParams.get('entry') || 'view/index.html')
      return serveExtAsset(req, res, url, extId, rel, token)
    }

    if (pathname.startsWith('/ext/')) {
      return fail(res, 404, 'NOT_FOUND')
    }

    // ---- 扩展桥接（转发给本机页面执行）----
    if (pathname.startsWith('/api/ext/') && pathname.endsWith('/bridge') && req.method === 'POST') {
      const dev = store.auth(tokenOf(req, url))
      if (!dev) return fail(res, 401, 'UNAUTHORIZED')
      const payload = await readBody(req)
      if (Date.now() - lastLocalPoll > 12000) {
        return send(res, 200, { error: '电脑端页面未打开，扩展的 data.* 接口暂时不可用' })
      }
      const id = crypto.randomBytes(6).toString('hex')
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          bridgeWaiters.delete(id)
          send(res, 200, { error: '电脑端响应超时' })
          resolve()
        }, 8000)
        bridgeWaiters.set(id, {
          id,
          extId: decodeURIComponent(pathname.slice('/api/ext/'.length).split('/')[0] || ''),
          method: String(payload.method || ''),
          args: payload.args || {},
          taken: false,
          timer,
          resolve: (result) => { send(res, 200, { result }); resolve() },
          reject: (err) => { send(res, 200, { error: String(err && err.message ? err.message : err) }); resolve() },
        })
      })
    }

    // ---- 扩展的 storage / config ----

    if (pathname.startsWith('/api/ext/')) {
      const dev = store.auth(tokenOf(req, url))
      if (!dev) return fail(res, 401, 'UNAUTHORIZED')
      const rest = pathname.slice('/api/ext/'.length).split('/')
      const extId = decodeURIComponent(rest[0] || '')
      const action = rest[1] || ''
      const key = rest[2] ? decodeURIComponent(rest[2]) : ''
      const kv = kvLoad()
      const ns = (kv[extId] = kv[extId] || { storage: {}, config: {} })

      if (action === 'info') {
        const m = scanExtensions().items.find((x) => x.id === extId) || {}
        return send(res, 200, { id: extId, name: m.name || extId, version: m.version || '', runtime: m.runtime || 'web', serviceReady: true, capabilities: [], theme: 'dark' })
      }
      if (action === 'config' && !key) return send(res, 200, ns.config)
      if (action === 'kv' && !key && req.method === 'DELETE') {
        kv[extId] = { storage: {}, config: {} }
        kvSave()
        return send(res, 200, { ok: true })
      }
      if (!key) return fail(res, 404, 'NOT_FOUND')

      const box = action === 'config' ? ns.config : ns.storage
      if (req.method === 'GET') return send(res, 200, { value: box[key] === undefined ? null : box[key] })
      if (req.method === 'DELETE') {
        delete box[key]
        kvSave()
        return send(res, 200, { ok: true })
      }
      if (req.method === 'POST') {
        const body = await readBody(req)
        box[key] = body.value
        kvSave()
        return send(res, 200, { ok: true })
      }
      return fail(res, 405, 'METHOD_NOT_ALLOWED')
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

// 慢连接防护：半截请求头 / 长期不结束的请求都要能自动回收
server.headersTimeout = 15000
server.requestTimeout = 30000
server.keepAliveTimeout = 5000
server.maxConnections = 64
server.on('clientError', (err, socket) => {
  if (socket.writable) {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
  } else {
    socket.destroy()
  }
})

files.ready.then(() => {
  const st = files.stats()
  console.log(`[todo-relay] files: ${(st.inbox / 1048576).toFixed(1)}MiB in / ${(st.out / 1048576).toFixed(1)}MiB out, quota ${(st.quota / 1048576).toFixed(0)}MiB`)
}).catch((e) => console.error('[files] init failed:', e.message))

server.listen(PORT, HOST, () => {
  const addr = server.address()
  console.log(`[todo-relay] listening on ${HOST}:${addr.port} (proto ${PROTO})`)
  console.log('[todo-relay] lan:', lanAddresses().map((a) => `${a.address}:${addr.port}`).join(', ') || '(none)')
  const ext = scanExtensions()
  console.log(`[todo-relay] extensions: ${ext.items.length} from ${ext.root}`)
  const code = store.pairCode()
  console.log(`[todo-relay] pair code: ${code.code} (5 分钟内有效)`)
})

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
  try {
    store.flushSync()
    files.saveSync()
  } catch (e) {
    console.error('[todo-relay] 退出前落盘失败:', e.message)
  }
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 1500)
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('uncaughtException', (e) => {
  // 异常后进程状态已不可信：先把内存状态落盘，再退出交给宿主拉起
  console.error('[todo-relay] uncaught:', e)
  try {
    store.flushSync()
  } catch (_) {}
  server.close(() => process.exit(1))
  setTimeout(() => process.exit(1), 1500)
})
process.on('unhandledRejection', (e) => {
  console.error('[todo-relay] unhandledRejection:', e)
})
