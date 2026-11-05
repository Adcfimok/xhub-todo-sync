/**
 * 中枢端到端自检：spawn 一个真实后端进程，走完整 HTTP 流程。
 * 运行：node tests/e2e.mjs
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

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
    console.log(`  ✗ ${name}${extra ? ' → ' + JSON.stringify(extra) : ''}`)
  }
}

const req = async (path, opts = {}) => {
  const r = await fetch(BASE + path, opts)
  let body = null
  const text = await r.text()
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

try {
  const ready = await waitReady()
  ok('服务在 3 秒内就绪', ready)
  if (!ready) throw new Error('服务未启动')

  console.log('\n[1] 基础与鉴权')
  let r = await req('/api/v1/ping')
  ok('ping 免鉴权可用', r.status === 200 && r.body.app === 'xhub-todo-relay')
  ok('初始 needsPair = true', r.body.needsPair === true)

  r = await req('/api/v1/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  ok('未带令牌的 sync 返回 401', r.status === 401 && r.body.code === 'UNAUTHORIZED')

  const st = await req('/api/admin/state')
  const code = st.body.pairCode
  r = await post('/api/v1/pair', { code: '000000', device: { id: 'and-e2e', name: 'E2E' } })
  ok('错误配对码被拒', r.status === 400 && r.body.code === 'INVALID_CODE')

  r = await post('/api/v1/pair', { code, device: { id: 'and-e2e', name: 'E2E 设备', platform: 'android' } })
  ok('正确配对码换到令牌', r.status === 200 && typeof r.body.token === 'string' && r.body.token.length === 64)
  const token = r.body.token
  const H = { Authorization: 'Bearer ' + token }

  r = await req('/api/v1/ping', { headers: H })
  ok('带令牌 ping 识别为已授权', r.body.authorized === true)
  r = await post('/api/v1/pair', { code, device: { id: 'and-x' } })
  ok('配对码一次性', r.status === 400)

  console.log('\n[2] 宿主快照入库')
  r = await post('/api/local/ingest', {
    records: [
      { id: 1, title: '写周报', done: 0, priority: 1, due_at: 1793900000000, version: 0, created_at: '2026-11-05 09:00:00.000', updated_at: '2026-11-05 09:00:00.000', description: '', pinned: 0, repeat_mode: 'once' },
      { id: 2, title: '买牛奶', done: 0, priority: 0, due_at: null, version: 0, created_at: '2026-11-05 09:10:00.000', updated_at: '2026-11-05 09:10:00.000', description: '', pinned: 0, repeat_mode: 'once' },
    ],
  })
  ok('首次 ingest 建 2 条', r.status === 200 && r.body.created === 2)
  r = await post('/api/local/ingest', {
    records: [
      { id: 1, title: '写周报', done: 0, version: 0, updated_at: '2026-11-05 09:00:00.000' },
      { id: 2, title: '买牛奶', done: 0, version: 0, updated_at: '2026-11-05 09:10:00.000' },
    ],
  })
  ok('版本号未变时幂等（不重复建）', r.body.created === 0 && r.body.updated === 0)

  console.log('\n[3] 手机端推送')
  const now = Date.now()
  r = await post('/api/v1/sync', { sinceSeq: 0, changes: [{ id: 'a:aaa1', title: '手机端待办', done: false, priority: 0, createdAt: now, updatedAt: now, hlc: hlc(now, 0, 'aa01'), deleted: false }] }, H)
  ok('新记录被接受', r.status === 200 && r.body.applied === 1)
  const seqAfterPush = r.body.seq

  r = await req('/api/local/outbound')
  ok('新记录进入宿主回写队列', r.body.items.length === 1 && r.body.items[0].id === 'a:aaa1')
  const cursor = r.body.cursor
  r = await post('/api/local/ack', { cursor, applied: [{ id: 'a:aaa1', hostId: 3, hostVersion: 0 }] })
  ok('ack 清空队列', r.status === 200)
  r = await req('/api/local/outbound')
  ok('ack 后队列为空', r.body.items.length === 0)

  console.log('\n[4] 冲突与 LWW')
  const t1 = now + 1000
  r = await post('/api/v1/sync', { sinceSeq: seqAfterPush, changes: [{ id: 'h:1', title: '写周报（手机改）', done: false, priority: 1, createdAt: now, updatedAt: t1, hlc: hlc(t1, 0, 'aa01'), deleted: false }] }, H)
  ok('覆盖宿主记录被接受', r.body.applied === 1)
  const seq1 = r.body.seq

  const t2 = now + 2000
  r = await post('/api/v1/sync', { sinceSeq: seq1, changes: [{ id: 'h:1', title: '写周报（旧版本）', done: false, priority: 1, createdAt: now, updatedAt: now, hlc: hlc(now, 0, 'aa01'), deleted: false }] }, H)
  ok('旧 HLC 被拒为 STALE', r.body.applied === 0 && r.body.rejected[0].reason === 'STALE')

  // 宿主侧（物理时间更晚）+ 手机侧同一条记录 → 应产生冲突日志且时间晚者胜
  r = await post('/api/local/ingest', {
    full: true,
    records: [
      { id: 1, title: '写周报（PC 改）', done: 0, priority: 1, version: 1, updated_at: '2026-11-05 12:00:00.000' },
      { id: 2, title: '买牛奶', done: 0, priority: 0, version: 0, updated_at: '2026-11-05 09:10:00.000' },
      { id: 3, title: '手机端待办', done: 0, priority: 0, version: 0, updated_at: '2026-11-05 10:00:00.000' },
    ],
  })
  ok('宿主版本变化被识别', r.body.updated === 1 && r.body.created === 0)
  const st2 = await req('/api/admin/state')
  ok('产生冲突日志', st2.body.conflicts.length >= 1)
  ok('胜方是 pc-host', st2.body.conflicts[0].winner === 'pc-host')
  ok('记录最终为 PC 版本', st2.body.records.find((x) => x.id === 'h:1').title === '写周报（PC 改）')

  console.log('\n[5] 增量拉取')
  r = await post('/api/v1/sync', { sinceSeq: 0, changes: [] }, H)
  ok('sinceSeq=0 拉到全量', r.body.changes.length >= 3)
  const head = r.body.seq
  r = await post('/api/v1/sync', { sinceSeq: head, changes: [] }, H)
  ok('sinceSeq=head 拉到 0 条', r.body.changes.length === 0)

  console.log('\n[6] 删除与墓碑')
  r = await post('/api/v1/sync', { sinceSeq: head, changes: [{ id: 'h:2', title: '买牛奶', done: false, priority: 0, createdAt: now, updatedAt: now, hlc: hlc(now + 5000, 0, 'aa01'), deleted: true }] }, H)
  ok('墓碑被接受', r.body.applied === 1)
  const st3 = await req('/api/admin/state')
  ok('墓碑不出现在设备列表视图', !st3.body.records.some((x) => x.id === 'h:2'))
  ok('统计里 deleted = 1', st3.body.stats.deleted === 1)
  r = await req('/api/v1/snapshot', { headers: H })
  const tomb = r.body.records.find((x) => x.id === 'h:2')
  ok('快照保留近期墓碑（供重装客户端收敛）', !!tomb && tomb.deleted === true)

  console.log('\n[7] 设备管理')
  r = await post('/api/admin/revoke', { deviceId: 'and-e2e' })
  ok('吊销设备成功', r.status === 200)
  r = await post('/api/v1/sync', { sinceSeq: 0, changes: [] }, H)
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
