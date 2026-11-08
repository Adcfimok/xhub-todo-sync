/**
 * 文件传输协议自检：spawn 真实后端，走完整分块 / 断点 / 校验 / 拉取流程。
 * 运行：node tests/files.mjs
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'

const require = createRequire(import.meta.url)
const F = require('../service/files.js')

const HERE = dirname(fileURLToPath(import.meta.url))
const ENTRY = join(HERE, '..', 'service', 'index.js')
const PORT = 47898
const BASE = `http://127.0.0.1:${PORT}`
const DATA = mkdtempSync(join(tmpdir(), 'relay-files-'))

let pass = 0
let fail = 0
function ok(name, cond, extra) {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.log(`  ✗ ${name}${extra !== undefined ? ' → ' + JSON.stringify(extra).slice(0, 300) : ''}`)
  }
}

async function req(path, opts = {}) {
  const r = await fetch(BASE + path, opts)
  const ct = r.headers.get('content-type') || ''
  if (ct.indexOf('application/octet-stream') === 0) {
    return { status: r.status, headers: r.headers, body: Buffer.from(await r.arrayBuffer()) }
  }
  const text = await r.text()
  let body = null
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: r.status, headers: r.headers, body }
}
const postJson = (path, obj, headers) =>
  req(path, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
    body: JSON.stringify(obj || {}),
  })

let child = null
function start() {
  child = spawn(process.execPath, [ENTRY], {
    env: Object.assign({}, process.env, { PORT: String(PORT), XHUB_LISTEN_HOST: '127.0.0.1', RELAY_DATA_DIR: DATA }),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', () => {})
  child.stderr.on('data', (d) => {
    const s = String(d)
    if (s.indexOf('未处理异常') >= 0) console.error('[server]', s.slice(0, 400))
  })
  return new Promise((resolve, reject) => {
    const t0 = Date.now()
    const tick = async () => {
      try {
        const r = await fetch(BASE + '/healthz')
        if (r.ok) return resolve()
      } catch (e) {}
      if (Date.now() - t0 > 8000) return reject(new Error('server timeout'))
      setTimeout(tick, 120)
    }
    tick()
  })
}
async function stop() {
  if (!child) return
  const c = child
  child = null
  c.kill('SIGTERM')
  await new Promise((r) => c.once('exit', r))
}

// ---------------------------------------------------------------- 加解密（与手机端同一套推导）
const keyOf = (token, id) => F.keyFor(token, id)
function sealChunk(token, id, index, size, plain) {
  return F.seal(keyOf(token, id), F.nonceFor(id, index), F.aadFor(id, index, size), plain)
}

function sha(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

const CHUNK = 2 * 1024 * 1024

async function main() {
  await start()

  // ---------- 1. 配对 ----------
  const st = await req('/api/admin/state')
  ok('admin state 可读', st.status === 200 && !!st.body.pairCode, st.status)
  const paired = await postJson('/api/v1/pair', {
    code: st.body.pairCode,
    device: { id: 'dev-file-test', name: '测试手机', platform: 'android', appVersion: '3.6.0' },
  })
  ok('配对成功拿到令牌', paired.status === 200 && /^[a-f0-9]{64}$/.test(paired.body.token || ''), paired.body)
  const token = paired.body.token
  const auth = { Authorization: 'Bearer ' + token }

  // ---------- 2. 参数与策略 ----------
  const unauth = await req('/api/v1/files/pending')
  ok('未配对访问文件接口 → 401', unauth.status === 401, unauth.status)

  const big = await postJson('/api/v1/files/offer', { name: 'huge.iso', size: 600 * 1024 * 1024 }, auth)
  ok('超过 512MiB 被拒 → 413', big.status === 413 && big.body.code === 'TOO_LARGE', big.body)

  const empty = await postJson('/api/v1/files/offer', { name: 'a.txt', size: 0 }, auth)
  ok('空文件被拒 → 400', empty.status === 400 && empty.body.code === 'BAD_SIZE', empty.body)

  ok('文件名清洗挡住路径穿越', F.safeName('../../etc/passwd') === '.._.._etc_passwd' || !F.safeName('../../etc/passwd').includes('/'), F.safeName('../../etc/passwd'))
  ok('Windows 保留名被改写', F.safeName('CON.txt') === '_CON.txt', F.safeName('CON.txt'))
  ok('非法字符被替换', F.safeName('a<b>c:d.txt') === 'a_b_c_d.txt', F.safeName('a<b>c:d.txt'))
  ok('可执行文件标记为高风险', F.riskOf('setup.EXE') === 'high' && F.riskOf('photo.jpg') === 'normal')
  ok('分块数计算', F.chunksOf(1) === 1 && F.chunksOf(CHUNK) === 1 && F.chunksOf(CHUNK + 1) === 2)

  // ---------- 3. 手机 → 电脑：分块 + 断点 ----------
  const payload = crypto.randomBytes(2 * CHUNK + 12345)
  const total = payload.length
  const expectSha = sha(payload)
  const off = await postJson('/api/v1/files/offer', { name: '旅行照片.zip', size: total, mime: 'application/zip' }, auth)
  ok(
    '创建上传任务',
    off.status === 200 && off.body.chunks === 3 && off.body.chunkSize === CHUNK,
    off.body
  )
  const id = off.body.id

  const c0 = payload.subarray(0, CHUNK)
  const up0 = await req(`/api/v1/files/chunk?id=${id}&i=0`, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/octet-stream' }, auth),
    body: sealChunk(token, id, 0, total, c0),
  })
  ok('第 0 块落盘', up0.status === 200 && up0.body.received === CHUNK, up0.body)

  const skip = await req(`/api/v1/files/chunk?id=${id}&i=2`, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/octet-stream' }, auth),
    body: sealChunk(token, id, 2, total, payload.subarray(2 * CHUNK)),
  })
  ok('跳块被拒并告知期望块', skip.status === 409 && skip.body.code === 'OFFSET' && skip.body.expected === 1, skip.body)

  // 篡改一个字节：GCM 认证失败，且不能污染已落盘内容
  const bad = Buffer.from(sealChunk(token, id, 1, total, payload.subarray(CHUNK, 2 * CHUNK)))
  bad[100] = bad[100] ^ 0xff
  const tamper = await req(`/api/v1/files/chunk?id=${id}&i=1`, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/octet-stream' }, auth),
    body: bad,
  })
  const mid = await req(`/api/v1/files/status?id=${id}`, { headers: auth })
  ok('篡改块被 GCM 拒绝', tamper.status === 400 && tamper.body.code === 'DECRYPT_FAIL', tamper.body)
  ok('拒绝后已收字节不回退', mid.body.received === CHUNK, mid.body)

  // 断点：杀进程重启，按 .part 长度恢复
  // Windows 上 SIGTERM 不可捕获，先等过快照去抖（400ms），模拟真实退出前的落盘窗口
  await new Promise((r) => setTimeout(r, 700))
  await stop()
  await start()
  const resumed = await req(`/api/v1/files/status?id=${id}`, { headers: auth })
  ok('重启后断点仍在', resumed.status === 200 && resumed.body.received === CHUNK, resumed.body)

  const c1 = payload.subarray(CHUNK, 2 * CHUNK)
  const up1 = await req(`/api/v1/files/chunk?id=${id}&i=1`, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/octet-stream' }, auth),
    body: sealChunk(token, id, 1, total, c1),
  })
  ok('续传第 1 块', up1.status === 200 && up1.body.received === 2 * CHUNK, up1.body)
  const up2 = await req(`/api/v1/files/chunk?id=${id}&i=2`, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/octet-stream' }, auth),
    body: sealChunk(token, id, 2, total, payload.subarray(2 * CHUNK)),
  })
  ok('第 2 块完成', up2.status === 200 && up2.body.done === true, up2.body)

  const wrong = await postJson('/api/v1/files/finish', { id, sha256: 'x'.repeat(64) }, auth)
  ok('整文件哈希不符 → 422', wrong.status === 422 && wrong.body.code === 'HASH_MISMATCH', wrong.body)
  const afterBad = await req(`/api/v1/files/status?id=${id}`, { headers: auth })
  ok('哈希不符后清空待重传', afterBad.body.received === 0, afterBad.body)

  for (let i = 0; i < 3; i++) {
    const slice = payload.subarray(i * CHUNK, Math.min((i + 1) * CHUNK, total))
    const r = await req(`/api/v1/files/chunk?id=${id}&i=${i}`, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/octet-stream' }, auth),
      body: sealChunk(token, id, i, total, slice),
    })
    if (r.status !== 200) throw new Error('re-upload failed at ' + i)
  }
  const fin = await postJson('/api/v1/files/finish', { id, sha256: expectSha }, auth)
  ok('校验通过并落到收件箱', fin.status === 200 && fin.body.sha256 === expectSha, fin.body)
  ok('手机侧拿不到电脑路径', fin.status === 200 && fin.body.path === undefined, fin.body)

  const inbox = await req('/api/local/files/state')
  const hit = (inbox.body.inbox || []).find((x) => x.id === id)
  ok('本机收件箱可见', !!hit && hit.name === '旅行照片.zip' && hit.size === total, hit)
  ok('收件箱按类型标注', hit && hit.kind === 'archive', hit && hit.kind)

  // ---------- 4. 电脑 → 手机：发送 / 拉取 / 校验 ----------
  const outPayload = crypto.randomBytes(CHUNK + 777)
  const init = await postJson('/api/local/files/send/init', { name: '会议纪要.pdf', size: outPayload.length, mime: 'application/pdf' })
  ok('本机创建发送任务', init.status === 200 && init.body.chunks === 2, init.body)
  const oid = init.body.id
  for (let i = 0; i < init.body.chunks; i++) {
    const slice = outPayload.subarray(i * CHUNK, Math.min((i + 1) * CHUNK, outPayload.length))
    const r = await req(`/api/local/files/send/chunk?id=${oid}&i=${i}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: slice,
    })
    if (r.status !== 200) throw new Error('local chunk failed: ' + JSON.stringify(r.body))
  }
  const ofin = await postJson('/api/local/files/send/finish', { id: oid })
  ok('发送任务进入待接收', ofin.status === 200 && ofin.body.sha256 === sha(outPayload), ofin.body)

  const pending = await req('/api/v1/files/pending', { headers: auth })
  ok('手机看到待接收', pending.status === 200 && pending.body.offers.some((x) => x.id === oid), pending.body.offers)

  const parts = []
  for (let i = 0; i < 2; i++) {
    const r = await req(`/api/v1/files/pull?id=${oid}&i=${i}`, { headers: auth })
    const plain = F.open(keyOf(token, oid), F.nonceFor(oid, i), F.aadFor(oid, i, outPayload.length), r.body)
    parts.push(plain)
    if (i === 0) ok('拉取响应带总长与哈希', r.headers.get('x-total') === String(outPayload.length) && /^[a-f0-9]{64}$/.test(r.headers.get('x-sha256') || ''), Object.fromEntries(r.headers))
  }
  const got = Buffer.concat(parts)
  ok('拉取内容与原文一致', got.equals(outPayload), { got: got.length, want: outPayload.length })

  const badPull = await postJson('/api/v1/files/pull/finish', { id: oid, sha256: 'y'.repeat(64) }, auth)
  ok('手机回报错误哈希 → 422', badPull.status === 422, badPull.body)
  const pullOk = await postJson('/api/v1/files/pull/finish', { id: oid, sha256: sha(outPayload) }, auth)
  ok('手机确认接收', pullOk.status === 200 && pullOk.body.ok === true, pullOk.body)

  const outList = await req('/api/local/files/state')
  const oitem = (outList.body.out || []).find((x) => x.id === oid)
  ok('电脑侧标记已送达', oitem && oitem.state === 'delivered', oitem)

  // 拒收
  const init2 = await postJson('/api/local/files/send/init', { name: 'b.txt', size: 4 })
  await req(`/api/local/files/send/chunk?id=${init2.body.id}&i=0`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: Buffer.from('abcd'),
  })
  await postJson('/api/local/files/send/finish', { id: init2.body.id })
  const dec = await postJson('/api/v1/files/decline', { id: init2.body.id }, auth)
  const pending2 = await req('/api/v1/files/pending', { headers: auth })
  ok('拒收后不再出现在待接收', dec.status === 200 && !pending2.body.offers.some((x) => x.id === init2.body.id))

  // ---------- 5. 权限开关 ----------
  const deny = await postJson('/api/local/files/allow', { deviceId: 'dev-file-test', allow: false })
  const denied = await req('/api/v1/files/pending', { headers: auth })
  ok('关闭文件权限后 → 403', deny.status === 200 && denied.status === 403 && denied.body.code === 'FILE_FORBIDDEN', denied.body)
  await postJson('/api/local/files/allow', { deviceId: 'dev-file-test', allow: true })
  const reAllowed = await req('/api/v1/files/pending', { headers: auth })
  ok('重新打开后恢复', reAllowed.status === 200)

  // ---------- 6. 删除与统计 ----------
  const before = await req('/api/local/files/state')
  const rm = await postJson('/api/local/files/remove', { id })
  const after = await req('/api/local/files/state')
  ok('删除收件箱条目', rm.status === 200 && !after.body.inbox.some((x) => x.id === id))
  ok('统计随之下降', after.body.stats.inbox === before.body.stats.inbox - total, {
    before: before.body.stats.inbox,
    after: after.body.stats.inbox,
  })

  await stop()
}

main()
  .catch((e) => {
    fail++
    console.error('  ✗ 异常:', e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n') : e)
  })
  .finally(async () => {
    await stop()
    rmSync(DATA, { recursive: true, force: true })
    console.log(`\n文件传输：${pass} 通过 / ${fail} 失败`)
    process.exit(fail ? 1 : 0)
  })
