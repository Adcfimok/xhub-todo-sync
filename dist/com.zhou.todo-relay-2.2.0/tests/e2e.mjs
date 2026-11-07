/**
 * 中枢端到端自检（多集合版）：spawn 一个真实后端进程，走完整 HTTP 流程。
 * 运行：node tests/e2e.mjs
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ENTRY = join(HERE, '..', 'service', 'index.js')
const PORT = 47899
const BASE = `http://127.0.0.1:${PORT}`
const DATA = mkdtempSync(join(tmpdir(), 'relay-e2e-'))

let pass = 0
let fail = 0
function ok(name, cond, extra) {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.log(`  ✗ ${name}${extra ? ' → ' + JSON.stringify(extra).slice(0, 300) : ''}`)
  }
}

const req = async (path, opts = {}) => {
  const r = await fetch(BASE + path, opts)
  const text = await r.text()
  let body = null
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: r.status, body }
}
const post = (path, data, headers) =>
  req(path, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
    body: JSON.stringify(data),
  })

const child = spawn(process.execPath, [ENTRY], {
  env: Object.assign({}, process.env, { PORT: String(PORT), XHUB_LISTEN_HOST: '127.0.0.1', RELAY_DATA_DIR: DATA }),
  stdio: ['ignore', 'pipe', 'pipe'],
})
child.stdout.on('data', () => {})
child.stderr.on('data', (d) => console.error('[svc]', d.toString().trim()))

async function waitReady() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await req('/healthz')
      if (r.status === 200) return true
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  return false
}

const hlc = (t, c, node) => t.toString(16).padStart(16, '0') + '-' + c.toString(16).padStart(4, '0') + '-' + node
const hostTime = (ms) => {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.000`
}

try {
  const ready = await waitReady()
  ok('服务在 3 秒内就绪', ready)
  if (!ready) throw new Error('服务未启动')

  console.log('\n[1] 基础与鉴权')
  let r = await req('/api/v1/ping')
  ok('ping 免鉴权可用', r.status === 200 && r.body.app === 'xhub-todo-relay')
  ok('协议版本为 2', r.body.proto === 2)
  ok('声明五类集合', Array.isArray(r.body.collections) && r.body.collections.length === 5)
  ok('初始 needsPair = true', r.body.needsPair === true)

  r = await req('/api/v1/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  ok('未带令牌的 sync 返回 401', r.status === 401 && r.body.code === 'UNAUTHORIZED')

  r = await req('/ext/list')
  ok('扩展列表需要鉴权', r.status === 401)

  const st = await req('/api/admin/state')
  const code = st.body.pairCode
  r = await post('/api/v1/pair', { code: '000000', device: { id: 'and-e2e', name: 'E2E' } })
  ok('错误配对码被拒', r.status === 400 && r.body.code === 'INVALID_CODE')

  r = await post('/api/v1/pair', { code, device: { id: 'and-e2e', name: 'E2E 设备', platform: 'android' } })
  ok('正确配对码换到令牌', r.status === 200 && typeof r.body.token === 'string' && r.body.token.length === 64)
  const token = r.body.token
  const H = { Authorization: 'Bearer ' + token }

  r = await post('/api/v1/pair', { code, device: { id: 'and-x' } })
  ok('配对码一次性', r.status === 400)

  console.log('\n[2] 多集合入库')
  const now = Date.now()
  r = await post('/api/local/ingest', {
    col: 'todos',
    records: [
      { id: 1, title: '写周报', done: 0, priority: 1, due_at: now + 3600e3, version: 0, created_at: hostTime(now), updated_at: hostTime(now), description: '', pinned: 0, repeat_mode: 'once' },
      { id: 2, title: '买牛奶', done: 0, priority: 0, due_at: null, version: 0, created_at: hostTime(now), updated_at: hostTime(now), description: '', pinned: 0, repeat_mode: 'once' },
    ],
  })
  ok('待办首次入库 2 条', r.body.created === 2)

  r = await post('/api/local/ingest', {
    col: 'notes',
    records: [{ id: 1, title: '周会纪要', content: '三条结论', created_at: hostTime(now), updated_at: hostTime(now) }],
  })
  ok('笔记入库 1 条', r.body.created === 1)

  r = await post('/api/local/ingest', {
    col: 'resources',
    records: [{ id: 1, kind: 'web', name: 'GitHub', target: 'https://github.com', created_at: hostTime(now), updated_at: hostTime(now) }],
  })
  ok('速达入库 1 条', r.body.created === 1)

  r = await post('/api/local/ingest', {
    col: 'todos',
    records: [
      { id: 1, title: '写周报', done: 0, version: 0, updated_at: hostTime(now) },
      { id: 2, title: '买牛奶', done: 0, version: 0, updated_at: hostTime(now) },
    ],
  })
  ok('版本号未变时幂等', r.body.created === 0 && r.body.updated === 0)

  console.log('\n[3] 手机端推送（跨集合）')
  r = await post('/api/v1/sync', { sinceSeq: 0, cols: ['todos', 'notes', 'stickies', 'resources', 'snippets'], changes: [
    { id: 'todos:aaa1', col: 'todos', title: '手机端待办', done: false, priority: 0, createdAt: now, updatedAt: now, hlc: hlc(now, 0, 'aa01'), deleted: false },
    { id: 'notes:bbb1', col: 'notes', title: '手机端笔记', content: '正文', createdAt: now, updatedAt: now, hlc: hlc(now, 1, 'aa01'), deleted: false },
  ] }, H)
  ok('两条跨集合记录都被接受', r.status === 200 && r.body.applied === 2)

  r = await req('/api/local/outbound')
  const cols = r.body.items.map((x) => x.col).sort()
  ok('回写队列带集合标记', cols.join(',') === 'notes,todos', cols)

  const cursor = r.body.cursor
  r = await post('/api/local/ack', { cursor, applied: [
    { id: 'todos:aaa1', hostId: 3, hostVersion: 0 },
    { id: 'notes:bbb1', hostId: 2, hostVersion: 0 },
  ] })
  ok('ack 成功', r.status === 200)
  r = await req('/api/local/outbound')
  ok('ack 后队列清空', r.body.items.length === 0)

  console.log('\n[4] 冲突与 LWW')
  const t1 = now + 1000
  r = await post('/api/v1/sync', { changes: [{ id: 'todos:h1', col: 'todos', title: '写周报（手机改）', done: false, priority: 1, createdAt: now, updatedAt: t1, hlc: hlc(t1, 0, 'aa01'), deleted: false }] }, H)
  ok('覆盖宿主记录被接受', r.body.applied === 1)

  r = await post('/api/v1/sync', { changes: [{ id: 'todos:h1', col: 'todos', title: '写周报（旧）', done: false, priority: 1, createdAt: now, updatedAt: now, hlc: hlc(now, 0, 'aa01'), deleted: false }] }, H)
  ok('旧 HLC 被拒为 STALE', r.body.applied === 0 && r.body.rejected[0].reason === 'STALE')

  r = await post('/api/local/ingest', {
    col: 'todos',
    full: true,
    records: [
      { id: 1, title: '写周报（PC 改）', done: 0, priority: 1, version: 1, updated_at: hostTime(now + 5000) },
      { id: 2, title: '买牛奶', done: 0, priority: 0, version: 0, updated_at: hostTime(now) },
      { id: 3, title: '手机端待办', done: 0, priority: 0, version: 0, updated_at: hostTime(now) },
    ],
  })
  ok('宿主版本变化被识别', r.body.updated === 1 && r.body.created === 0)

  const st2 = await req('/api/admin/state')
  ok('产生冲突日志', st2.body.conflicts.length >= 1)
  ok('冲突带集合名', st2.body.conflicts[0].col === 'todos')
  ok('胜方是 pc-host', st2.body.conflicts[0].winner === 'pc-host')
  ok('记录最终为 PC 版本', st2.body.records.find((x) => x.id === 'todos:h1').title === '写周报（PC 改）')

  console.log('\n[5] 增量与集合过滤')
  r = await post('/api/v1/sync', { sinceSeq: 0, changes: [] }, H)
  ok('全量至少 5 条（含 5 类中的 3 类）', r.body.changes.length >= 5)
  const head = r.body.seq
  r = await post('/api/v1/sync', { sinceSeq: head, changes: [] }, H)
  ok('游标到头部时无增量', r.body.changes.length === 0)

  r = await req('/api/v1/snapshot?cols=notes', { headers: H })
  ok('快照可按集合过滤', r.body.records.length >= 2 && r.body.records.every((x) => x.col === 'notes'))

  console.log('\n[6] 删除与墓碑')
  r = await post('/api/v1/sync', { changes: [{ id: 'todos:h2', col: 'todos', title: '买牛奶', done: false, priority: 0, createdAt: now, updatedAt: now, hlc: hlc(now + 9000, 0, 'aa01'), deleted: true }] }, H)
  ok('墓碑被接受', r.body.applied === 1)
  const st3 = await req('/api/admin/state')
  ok('墓碑不出现在列表视图', !st3.body.records.some((x) => x.id === 'todos:h2'))
  ok('统计里 deleted = 1', st3.body.stats.deleted === 1)
  ok('按集合统计正确', st3.body.stats.byCol.notes.live === 2)

  console.log('\n[6.5] 空快照保护')
  // 页面刚载入 / 某类读失败都可能送来 rows=[]，不能当「全删了」
  r = await post('/api/local/ingest', { col: 'notes', records: [], full: true })
  ok('空快照默认不打墓碑', r.body.prunedSkipped === true && r.body.updated === 0, r.body)
  let stEmpty = await req('/api/admin/state')
  ok('空快照后笔记仍是 2 条', stEmpty.body.stats.byCol.notes.live === 2)
  r = await post('/api/local/ingest', { col: 'notes', records: [], full: true, allowEmpty: true })
  stEmpty = await req('/api/admin/state')
  ok('显式 allowEmpty 才真删', r.body.prunedSkipped !== true && stEmpty.body.stats.byCol.notes.live === 0)

  console.log('\n[7] AI 中转（流式透传）')
  const fake = http.createServer((rq, rs) => {
    if (!rq.url.endsWith('/chat/completions')) return rs.writeHead(404).end()
    rs.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const parts = ['你好', '，这是', '流式返回。']
    let i = 0
    const timer = setInterval(() => {
      if (i >= parts.length) {
        rs.write('data: [DONE]\n\n')
        rs.end()
        clearInterval(timer)
        return
      }
      rs.write('data: ' + JSON.stringify({ choices: [{ delta: { content: parts[i++] } }] }) + '\n\n')
    }, 40)
  })
  await new Promise((r) => fake.listen(48998, '127.0.0.1', r))

  const aiRes = await fetch(BASE + '/api/ai/chat', {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, H),
    body: JSON.stringify({
      baseURL: 'http://127.0.0.1:48998/v1',
      apiKey: 'sk-test',
      model: 'fake',
      messages: [{ role: 'user', content: 'hi' }],
    }),
  })
  ok('AI 中转返回 SSE', aiRes.status === 200 && /text\/event-stream/.test(aiRes.headers.get('content-type') || ''))
  const reader = aiRes.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let acc = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    for (const line of buf.split('\n')) {
      if (!line.startsWith('data:')) continue
      const d = line.slice(5).trim()
      if (!d || d === '[DONE]') continue
      try {
        acc += JSON.parse(d).choices[0].delta.content || ''
      } catch {
        /* 忽略半包 */
      }
    }
    buf = ''
  }
  ok('逐块拼接后内容完整', acc === '你好，这是流式返回。', acc)
  fake.close()

  r = await req('/api/ai/chat', { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, H), body: '{}' })
  ok('缺参数被拒', r.status === 400)

  console.log('\n[8] 设备与扩展')
  r = await req('/ext/list', { headers: H })
  ok('带令牌可读扩展列表', r.status === 200 && Array.isArray(r.body.items))
  ok('扩展列表不含本扩展自身', !r.body.items.some((x) => x.id === 'com.zhou.todo-relay'))

  r = await post('/api/admin/revoke', { deviceId: 'and-e2e' })
  ok('吊销设备成功', r.status === 200)
  r = await post('/api/v1/sync', { changes: [] }, H)
  ok('吊销后令牌失效', r.status === 401)
} catch (e) {
  fail++
  console.error('异常:', e)
} finally {
  child.kill()
  await new Promise((r) => setTimeout(r, 300))
  try {
    rmSync(DATA, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  process.exit(fail ? 1 : 0)
}
