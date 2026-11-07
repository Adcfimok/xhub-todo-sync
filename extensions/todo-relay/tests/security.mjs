/**
 * 安全与可靠性回归：每条断言对应审计修复方案里的一项 P0/P1/P2。
 * 运行：node tests/security.mjs
 *
 * 分两组：
 *   A. HTTP 层 —— spawn 真实后端，模拟恶意网页/异常客户端
 *   B. 单元层 —— 直接驱动 Store / Clock，验证落盘、坏库、时钟、去重、字段上限
 *
 * 设计原则：每条断言都能在**修复前**失败、修复后通过。
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVICE = join(HERE, '..', 'service', 'index.js')
const PORT = 47911
const BASE = `http://127.0.0.1:${PORT}`
const DATA = mkdtempSync(join(tmpdir(), 'relay-sec-'))
const UNIT = mkdtempSync(join(tmpdir(), 'relay-unit-'))

let pass = 0
let fail = 0
const failures = []

function ok(name, cond, extra) {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    failures.push(name)
    console.log(`  ✗ ${name}${extra !== undefined ? ' → ' + JSON.stringify(extra).slice(0, 240) : ''}`)
  }
}

const LOCAL = { 'X-Hub-Local': '1' }

async function req(path, opts = {}) {
  const r = await fetch(BASE + path, opts)
  const text = await r.text()
  let body = null
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: r.status, body, headers: r.headers }
}

const post = (path, data, headers) =>
  req(path, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
    body: typeof data === 'string' ? data : JSON.stringify(data),
  })

const child = spawn(process.execPath, [SERVICE], {
  env: Object.assign({}, process.env, {
    PORT: String(PORT),
    XHUB_LISTEN_HOST: '127.0.0.1',
    RELAY_DATA_DIR: DATA,
  }),
  stdio: ['ignore', 'pipe', 'pipe'],
})
child.stdout.on('data', () => {})
child.stderr.on('data', (d) => {
  const s = d.toString().trim()
  if (/uncaught|未处理异常/.test(s)) console.error('[svc]', s)
})

async function waitReady() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(BASE + '/healthz')
      if (r.ok) return true
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  return false
}

function close() {
  try {
    child.kill()
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// B. 单元层：先把数据目录指到 UNIT，再加载 Store（模块加载时会读这个环境变量）
// ---------------------------------------------------------------------------
process.env.RELAY_DATA_DIR = UNIT
const storeUrl = pathToFileURL(join(HERE, '..', 'service', 'store.js')).href
const hlcUrl = pathToFileURL(join(HERE, '..', 'service', 'hlc.js')).href

async function unitTests() {
  const { Clock, fmt } = await import(hlcUrl)
  const { Store } = await import(storeUrl)

  console.log('\n[B] 单元层：时钟与持久化')

  // B1 时钟：未来时间戳必须拒收
  const clock = new Clock('unit')
  const future = fmt(Date.now() + 86400000, 0, 'dead')
  const r1 = clock.observe(future)
  ok('未来 24h 的时间戳被拒收', r1.rejected === true && r1.reason === 'FUTURE_DRIFT', r1)
  ok('拒收后本地时钟未被推偏', clock.t < Date.now() + 5000, clock.t)

  // B2 时钟：本地回拨时仍单调
  const c2 = new Clock('unit2')
  const a = c2.next(1000000)
  const b = c2.next(500000) // 模拟系统时间回拨
  ok('系统时间回拨时键仍递增', b > a, { a, b })

  // B3 去重：同一记录改两次，增量只返回一条
  const s = new Store('unit')
  const mk = (seq, title) => ({
    id: 'todos:h1',
    col: 'todos',
    title,
    hlc: fmt(Date.now() + seq, seq, 'aaaa'),
    deleted: false,
  })
  s.merge(mk(1, '第一版'), 'dev-a')
  s.merge(mk(2, '第二版'), 'dev-a')
  const delta = s.changesSince(0, 100, null)
  ok('changesSince 对同一 id 去重', delta.changes.length === 1, delta.changes.length)
  ok('去重后保留最新版本', delta.changes[0] && delta.changes[0].title === '第二版')

  // B4 字段上限：长备注不再被截到 200
  const longText = '备'.repeat(1500)
  const s2 = new Store('unit2')
  s2.merge(
    {
      id: 'todos:h2',
      col: 'todos',
      title: '长备注',
      description: longText,
      hlc: fmt(Date.now(), 0, 'bbbb'),
      deleted: false,
    },
    'dev-a'
  )
  const kept = s2.get('todos:h2')
  ok('长备注完整保留（1500 字）', kept && kept.description.length === 1500, kept && kept.description.length)

  // B5 落盘失败：dirty 不清空、进入重试
  const fsmod = await import('node:fs')
  const realWrite = fsmod.promises.writeFile
  fsmod.promises.writeFile = () => Promise.reject(Object.assign(new Error('EACCES mock'), { code: 'EACCES' }))
  const s3 = new Store('unit3')
  s3.dirty = true
  await s3.flush()
  fsmod.promises.writeFile = realWrite
  ok('落盘失败后 dirty 仍为真', s3.dirty === true)
  ok('落盘失败计数增加', s3.saveFails >= 1, s3.saveFails)

  // B6 坏库隔离：坏文件被改名，进程转只读而非静默空库
  const badDir = mkdtempSync(join(tmpdir(), 'relay-bad-'))
  writeFileSync(join(badDir, 'hub.json'), '{"records": {broken', 'utf8')
  const prevDir = process.env.RELAY_DATA_DIR
  process.env.RELAY_DATA_DIR = badDir
  // 换目录需要重新加载模块（DATA_DIR 是模块级常量），用独立子进程做
  const probe = spawn(process.execPath, ['-e', `
    const { Store } = require(${JSON.stringify(join(HERE, '..', 'service', 'store.js'))});
    const s = new Store('probe');
    console.log(JSON.stringify({ readOnly: s.readOnly, fatal: s.fatal && s.fatal.code, records: Object.keys(s.state.records).length }));
  `], { env: Object.assign({}, process.env, { RELAY_DATA_DIR: badDir }), stdio: ['ignore', 'pipe', 'pipe'] })
  let probeOut = ''
  probe.stdout.on('data', (d) => { probeOut += d.toString() })
  await new Promise((r) => probe.on('close', r))
  process.env.RELAY_DATA_DIR = prevDir
  let probeJson = null
  try {
    probeJson = JSON.parse(probeOut.trim().split('\n').pop())
  } catch {
    /* ignore */
  }
  ok('坏库启动为只读并带 fatal', probeJson && probeJson.readOnly === true && probeJson.fatal === 'STATE_CORRUPT', probeJson)
  const badFiles = readdirSync(badDir).filter((f) => f.includes('.corrupt-'))
  ok('坏文件被隔离（.corrupt-*）', badFiles.length === 1, badFiles)
  ok('坏库未被静默重置成空库', probeJson && probeJson.records === 0 && badFiles.length === 1)
  rmSync(badDir, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// A. HTTP 层
// ---------------------------------------------------------------------------
async function httpTests() {
  console.log('\n[A] HTTP 层：跨站、SSRF、配对、限流、异常体')

  // A1 跨站来源被拒（带着恶意 Origin 的简单请求）
  let r = await req('/api/admin/state', { headers: { Origin: 'https://evil.example', 'X-Hub-Local': '1' } })
  ok('跨站 Origin 被拒（403 BAD_ORIGIN）', r.status === 403 && r.body && r.body.code === 'BAD_ORIGIN', r.body)

  // A2 跨站 CORS 预检也不再无条件放行
  r = await req('/api/admin/state', {
    method: 'OPTIONS',
    headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET' },
  })
  ok('跨站预检被拒', r.status === 403, r.status)

  // A3 本机接口缺自定义头被拒（CSRF 的第三道闸）
  r = await req('/api/admin/state')
  ok('本机接口缺 X-Hub-Local 被拒', r.status === 403 && r.body.code === 'LOCAL_HEADER_REQUIRED', r.body)

  // A4 正常本机访问（同源、无 Origin）照常工作
  r = await req('/api/admin/state', { headers: LOCAL })
  ok('本机页面正常读取状态', r.status === 200 && typeof r.body.pairCode === 'string')
  const pairCode = r.body.pairCode

  // A5 白名单 Origin（同源）也放行
  r = await req('/api/admin/state', {
    headers: { Origin: `http://127.0.0.1:${PORT}`, 'X-Hub-Local': '1' },
  })
  ok('同源 Origin 放行且回显具体来源', r.status === 200 && r.headers.get('access-control-allow-origin') === `http://127.0.0.1:${PORT}`)

  // A6 SSRF 端点已下线
  r = await post('/api/ai/chat', { baseURL: 'http://169.254.169.254', apiKey: 'x', model: 'y' })
  ok('SSRF 端点已下线（404）', r.status === 404, r.status)

  // A7 diag 同样要求本机头（含内网地址，不能给跨站读）
  r = await req('/api/v1/diag')
  ok('diag 缺本机头被拒', r.status === 403 && r.body.code === 'LOCAL_HEADER_REQUIRED', r.body)
  r = await req('/api/v1/diag', { headers: LOCAL })
  ok('diag 带本机头可读', r.status === 200 && typeof r.body.verdict === 'string')

  // A8 配对码：连错 5 次后当前码作废，正确的码也不再接受
  for (let i = 0; i < 5; i++) {
    await post('/api/v1/pair', { code: '000000', device: { id: 'atk-' + i } })
  }
  r = await post('/api/v1/pair', { code: pairCode, device: { id: 'atk-final' } })
  // 429 是「尝试过多」的正确语义；code 与限流的 RATE_LIMITED 区分开，便于前端分别提示
  ok('超限后即使码正确也被拒', r.status === 429 && r.body.code === 'TOO_MANY_ATTEMPTS', { status: r.status, ...r.body })

  // A9 换码后可以正常配对（证明封禁只作用于旧码，不锁死功能）
  r = await req('/api/admin/rotate-code', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, LOCAL) })
  const newCode = r.body && r.body.code
  r = await post('/api/v1/pair', { code: newCode, device: { id: 'dev-ok', name: '正常设备' } })
  ok('换码后可正常配对', r.status === 200 && typeof r.body.token === 'string', r.body && r.body.code)
  const token = r.body && r.body.token
  const H = { Authorization: 'Bearer ' + token }

  // A10 时钟异常：未来时间戳的记录被拒，并留下 clock-anomaly 审计
  const futureHlc = (await import(hlcUrl)).fmt(Date.now() + 86400000, 0, 'eeee')
  r = await post('/api/v1/sync', {
    deviceId: 'dev-ok',
    sinceSeq: 0,
    changes: [{ id: 'todos:clock1', col: 'todos', title: '来自未来', deleted: false, hlc: futureHlc }],
    cols: ['todos'],
  }, H)
  const rej = (r.body.rejected || []).find((x) => x.id === 'todos:clock1')
  ok('未来时间戳记录被拒（CLOCK_ANOMALY）', rej && rej.reason === 'CLOCK_ANOMALY', rej)
  r = await req('/api/admin/audit?limit=10', { headers: LOCAL })
  ok('时钟异常写入审计日志', r.status === 200 && (r.body.items || []).some((x) => x.action === 'clock-anomaly'), r.body)

  // A11 413 真的能返回（旧实现直接断连接，客户端只看到 ECONNRESET）
  const big = JSON.stringify({ col: 'todos', records: [], pad: 'x'.repeat(3 * 1024 * 1024) })
  r = await post('/api/local/ingest', big, LOCAL)
  ok('超限请求体返回 413 而非断连', r.status === 413 && r.body.code === 'PAYLOAD_TOO_LARGE', { status: r.status, body: r.body })

  // A12 限流：配对接口连打超过阈值后 429
  let saw429 = false
  for (let i = 0; i < 14; i++) {
    const x = await post('/api/v1/pair', { code: '111111', device: { id: 'r' + i } })
    if (x.status === 429) {
      saw429 = true
      break
    }
  }
  ok('配对接口触发限流（429）', saw429)

  // A13 本机 SSE 通道可用，且带 hello 事件
  const sseOk = await new Promise((resolve) => {
    const reqSse = http.get(`${BASE}/api/local/stream`, { headers: LOCAL }, (res) => {
      let got = ''
      res.on('data', (c) => {
        got += c.toString()
        if (got.includes('event: hello')) {
          res.destroy()
          resolve(true)
        }
      })
      setTimeout(() => {
        res.destroy()
        resolve(false)
      }, 2000)
    })
    reqSse.on('error', () => resolve(false))
  })
  ok('本机 SSE 通道返回 hello', sseOk)

  // A14 审计接口可读
  r = await req('/api/admin/audit?limit=5', { headers: LOCAL })
  ok('审计接口返回条目', r.status === 200 && Array.isArray(r.body.items))
}

// ---------------------------------------------------------------------------

const ready = await waitReady()
if (!ready) {
  console.error('服务未就绪，中止')
  close()
  process.exit(1)
}

try {
  await httpTests()
  await unitTests()
} catch (e) {
  console.error('执行异常：', e)
  fail++
} finally {
  close()
  rmSync(DATA, { recursive: true, force: true })
  rmSync(UNIT, { recursive: true, force: true })
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail) {
  console.log('失败项：' + failures.join('、'))
  process.exitCode = 1
}
