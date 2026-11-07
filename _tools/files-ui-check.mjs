/**
 * 扩展「文件传输」面板的界面回归：
 * 起真实服务 → 用宿主 stub 打开扩展页 → 选一个 3MiB 文件 → 断言分块上传落到待接收。
 *
 * 运行：node _tools/files-ui-check.mjs [--shots]
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'

const require = createRequire('C:/Users/zhou/WorkBuddy/xhub/_tools/node_modules/')
const { chromium } = require('playwright')

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const ENTRY = join(ROOT, 'extensions', 'todo-relay', 'service', 'index.js')
const PORT = 47893
const BASE = `http://127.0.0.1:${PORT}`
const DATA = mkdtempSync(join(tmpdir(), 'relay-files-ui-'))
const SHOTS = process.argv.includes('--shots')
const VIEW = join(ROOT, 'extensions', 'todo-relay', 'view')
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' }

let pass = 0
let fail = 0
function check(name, cond, extra) {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.log(`  ✗ ${name}${extra !== undefined ? ' → ' + JSON.stringify(extra).slice(0, 240) : ''}`)
  }
}

const child = spawn(process.execPath, [ENTRY], {
  env: Object.assign({}, process.env, { PORT: String(PORT), XHUB_LISTEN_HOST: '127.0.0.1', RELAY_DATA_DIR: DATA }),
  stdio: ['ignore', 'pipe', 'pipe'],
})
child.stderr.on('data', (d) => {
  const s = String(d)
  if (s.includes('未处理异常')) console.error('[server]', s.slice(0, 300))
})

async function waitReady() {
  const t0 = Date.now()
  while (Date.now() - t0 < 8000) {
    try {
      const r = await fetch(BASE + '/healthz')
      if (r.ok) return
    } catch (e) {}
    await new Promise((r) => setTimeout(r, 120))
  }
  throw new Error('server not ready')
}

const HOST_STUB = `
  const empty = () => Promise.resolve([])
  const noop = () => Promise.resolve({})
  const col = { list: empty, create: noop, update: noop, delete: noop, togglePin: noop }
  window.xhub = {
    service: { request: (path, init) => fetch(path, init) },
    data: { todos: col, notes: col, resources: col, snippets: col, stickies: { list: empty, save: noop } },
    ui: { notify: () => Promise.resolve() },
    openExternal: () => Promise.resolve(),
    config: { all: () => Promise.resolve({}) },
  }
`

async function main() {
  await waitReady()
  const browser = await chromium.launch({ channel: 'msedge' })
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 900 }, deviceScaleFactor: 2 })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => {
    const t = m.text()
    // favicon 之类与功能无关的 404 不计入
    if (m.type() === 'error' && !/favicon|Failed to load resource/i.test(t)) errors.push('console: ' + t)
  })
  // 扩展页在真实宿主里由本地资源服务托管；这里起一个只读静态服务，把 /api/* 反代到中枢，
  // 这样页面里的相对路径请求与生产一致，又不用依赖宿主注入。
  const proxy = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x')
    if (u.pathname.startsWith('/api/')) {
      const chunks = []
      for await (const c of req) chunks.push(c)
      const up = await fetch(BASE + req.url, {
        method: req.method,
        headers: { 'Content-Type': req.headers['content-type'] || 'application/json', 'X-Hub-Local': '1' },
        body: chunks.length ? Buffer.concat(chunks) : undefined,
      })
      const body = Buffer.from(await up.arrayBuffer())
      res.writeHead(up.status, { 'Content-Type': up.headers.get('content-type') || 'application/json', 'Content-Length': body.length })
      return res.end(body)
    }
    const rel = u.pathname === '/' ? '/index.html' : u.pathname
    try {
      const body = await readFile(join(VIEW, rel))
      res.writeHead(200, { 'Content-Type': MIME[rel.slice(rel.lastIndexOf('.'))] || 'application/octet-stream' })
      res.end(body)
    } catch (e) {
      res.writeHead(404).end('not found')
    }
  })
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r))
  const viewPort = proxy.address().port
  const adm = await (await fetch(BASE + '/api/admin/state')).json()
  await page.addInitScript(HOST_STUB)
  await page.goto(`http://127.0.0.1:${viewPort}/index.html`)
  await page.waitForTimeout(900)

  check('面板已渲染', await page.isVisible('#files-panel'))
  const quota = await page.textContent('#files-quota')
  check('显示配额与单文件上限', /512 MB/.test(quota || '') && /GB|MB/.test(quota || ''), quota)
  check('空态提示可见', await page.isVisible('#file-in-empty'))

  // 走真实 UI：隐藏 input 注入 3MiB 文件，验证分块 + 进度 + 落盘
  const buf = crypto.randomBytes(3 * 1024 * 1024 + 17)
  await page.setInputFiles('#file-input', { name: '演示视频.mp4', mimeType: 'video/mp4', buffer: buf })
  // 轮询服务端状态，等分块上传真正 finish（不要用页面内异步断言，容易读到 Promise 本身）
  const deadline = Date.now() + 30000
  let st = null
  while (Date.now() < deadline) {
    st = await (await fetch(BASE + '/api/local/files/state')).json()
    if ((st.out || []).some((x) => x.name === '演示视频.mp4' && x.state === 'pending')) break
    await new Promise((r) => setTimeout(r, 150))
  }
  await page.waitForTimeout(300)
  const item = (st.out || []).find((x) => x.name === '演示视频.mp4')
  check('分块上传后进入待接收', !!item && item.state === 'pending' && item.size === buf.length, item)
  check('识别为视频类型', item && item.kind === 'video', item && item.kind)
  check('列表渲染出文件', (await page.$$('#file-out .file')).length >= 1)
  check('待接收计数为 1', (await page.textContent('#out-count')) === '1')
  check('没有脚本错误', errors.length === 0, errors.slice(0, 3))

  if (SHOTS) await page.screenshot({ path: join(ROOT, '_tools', 'files-panel.png') })

  // 删除按钮可用
  await page.click('#file-out .file .revoke:last-child')
  await page.waitForTimeout(500)
  const st2 = await (await fetch(BASE + '/api/local/files/state')).json()
  check('删除后列表清空', (st2.out || []).length === 0, st2.out)

  await browser.close()
  proxy.close()
}

main()
  .catch((e) => {
    fail++
    console.error('  ✗ 异常:', e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n') : e)
  })
  .finally(async () => {
    child.kill()
    rmSync(DATA, { recursive: true, force: true })
    console.log(`\n文件面板：${pass} 通过 / ${fail} 失败`)
    process.exit(fail ? 1 : 0)
  })
