/**
 * 安卓「文件传输」页回归：静态托管 www + 模拟原生桥 + 模拟中枢。
 * 覆盖：待接收列表、接收、选文件、发送、进度、完成态、脚本错误。
 *
 * 运行：node _tools/android-transfer-check.mjs [--shots]
 */
import { createRequire } from 'node:module'
import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'

const require = createRequire('C:/Users/zhou/WorkBuddy/xhub/_tools/node_modules/')
const { chromium } = require('playwright')

const WWW = 'C:/Users/zhou/WorkBuddy/xhub/android/app/src/main/assets/www'
const SHOTS = process.argv.includes('--shots')
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
}
const HOST_PORT = 47894
const OFFER_ID = 'abcdef0123456789abcdef01'

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

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}

const hub = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors)
    return res.end()
  }
  const u = new URL(req.url, 'http://x')
  if (u.pathname === '/api/v1/files/pending') {
    const body = JSON.stringify({
      offers: [
        { id: OFFER_ID, name: '季度周报.pdf', size: 2_400_000, kind: 'doc', risk: 'normal', at: Date.now(), sha256: 'a'.repeat(64) },
      ],
      maxFile: 536870912,
    })
    res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, cors))
    return res.end(body)
  }
  if (u.pathname === '/api/v1/files/history') {
    res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, cors))
    return res.end(JSON.stringify({ items: [], maxFile: 536870912 }))
  }
  if (u.pathname === '/api/v1/stream') {
    res.writeHead(200, Object.assign({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }, cors))
    res.write('event: hello\ndata: {}\n\n')
    return
  }
  res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, cors))
  res.end('{}')
})

const view = http.createServer(async (req, res) => {
  const rel = new URL(req.url, 'http://x').pathname
  try {
    const body = await fs.readFile(path.join(WWW, rel === '/' ? '/index.html' : rel))
    res.writeHead(200, { 'Content-Type': MIME[path.extname(rel)] || 'application/octet-stream' })
    res.end(body)
  } catch (e) {
    res.writeHead(404).end('not found')
  }
})

const ANDROID_STUB = `
  window.__calls = []
  window.Android = {
    originPort: () => 47999,
    appVersion: () => '3.0.0',
    deviceName: () => '测试机',
    originChanged: () => false,
    readClipboard: () => '',
    writeClipboard: () => {},
    vibrate: () => {},
    toast: () => {},
    openUrl: () => {},
    notify: () => {},
    setAlarms: () => {},
    cancelAlarms: () => {},
    pickFile: (id) => {
      window.__lastPick = id
      setTimeout(() => window.__nativeEmit('pick', JSON.stringify({
        id, ok: true, uri: 'content://demo/1', name: '一段录音.m4a', size: 3 * 1024 * 1024, mime: 'audio/mp4',
      })), 30)
    },
    startUpload: (reqId, uri, name, size, mime, host, token, resumeId, sha) => {
      window.__calls.push({ kind: 'upload', reqId, uri, name, size, mime, host, token, resumeId, sha })
    },
    startDownload: (reqId, fileId, name, size, sha, host, token) => {
      window.__calls.push({ kind: 'download', reqId, fileId, name, size, sha, host, token })
    },
    cancelTransfer: (reqId) => window.__calls.push({ kind: 'cancel', reqId }),
  }
`

async function main() {
  await new Promise((r) => hub.listen(HOST_PORT, '127.0.0.1', r))
  await new Promise((r) => view.listen(0, '127.0.0.1', r))
  const viewPort = view.address().port

  const browser = await chromium.launch({ channel: 'msedge' })
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push('console: ' + m.text())
  })
  await page.addInitScript(ANDROID_STUB)
  await page.goto(`http://127.0.0.1:${viewPort}/index.html`)
  await page.waitForTimeout(700)

  // 写入配对信息后重载（走真实 boot 流程，而不是绕过它）
  await page.evaluate(
    (host) =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('todolink', 2)
        req.onupgradeneeded = () => {
          const db = req.result
          if (!db.objectStoreNames.contains('records')) db.createObjectStore('records', { keyPath: 'id' })
          if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'k' })
        }
        req.onerror = () => reject(req.error)
        req.onsuccess = () => {
          const db = req.result
          const tx = db.transaction('meta', 'readwrite')
          const st = tx.objectStore('meta')
          st.put({ k: 'host', v: host })
          st.put({ k: 'token', v: 'a'.repeat(64) })
          st.put({ k: 'deviceId', v: 'and-test' })
          st.put({ k: 'deviceName', v: '测试机' })
          tx.oncomplete = () => resolve()
          tx.onerror = () => reject(tx.error)
        }
      }),
    '127.0.0.1:' + HOST_PORT
  )
  await page.reload()
  await page.waitForTimeout(900)
  await page.evaluate(() => (location.hash = '#/transfer'))
  await page.waitForTimeout(1200)

  check('传输页可打开', (await page.textContent('#page-title')) === '文件传输')
  check('显示电脑地址', ((await page.textContent('.status-title')) || '').includes('127.0.0.1'))
  check('待接收列出 1 个文件', (await page.$$('#xfer-active .xfer')).length === 0 && (await page.$$('.xfer-n')).length >= 1)
  check('文件信息完整', ((await page.textContent('.xfer-list')) || '').includes('季度周报.pdf'))

  // 接收 → 原生 startDownload
  await page.click('.xfer-btns .mini.on')
  await page.waitForTimeout(300)
  const calls = await page.evaluate(() => window.__calls)
  const down = calls.find((c) => c.kind === 'download')
  check('点击接收调用原生下载', !!down && down.fileId === OFFER_ID && down.size === 2_400_000, down)
  check('下载参数带令牌与哈希', !!down && down.token.length === 64 && down.sha.length === 64, down && { token: down.token.length, sha: down.sha.length })

  // 选文件 → 确认 → 发送
  await page.click('button:has-text("选择文件")')
  await page.waitForTimeout(300)
  check('选择后出现待发送行', (await page.locator('text=一段录音.m4a').count()) >= 1)
  await page.click('button:has-text("发送")')
  await page.waitForTimeout(300)
  const calls2 = await page.evaluate(() => window.__calls)
  const up = calls2.find((c) => c.kind === 'upload')
  check('点击发送调用原生上传', !!up && up.uri === 'content://demo/1' && up.size === 3 * 1024 * 1024, up)
  check('上传走已配对地址', !!up && up.host === '127.0.0.1:' + HOST_PORT, up && up.host)
  check('首次发送不带断点', !!up && up.resumeId === '' && up.sha === '')

  // 原生进度 → 进度条
  const rid = up.reqId
  await page.evaluate(
    ({ id }) =>
      window.__nativeEmit(
        'transfer',
        JSON.stringify({ id, name: '一段录音.m4a', size: 3145728, sent: 1572864, pct: 50, state: 'uploading' })
      ),
    { id: rid }
  )
  await page.waitForTimeout(250)
  const barW = await page.evaluate(() => {
    const row = [...document.querySelectorAll('#xfer-active .xfer')].find((el) => (el.textContent || '').includes('一段录音'))
    const el = row && row.querySelector('.xfer-bar i')
    return el ? el.style.width : ''
  })
  check('进度条走到 50%', barW === '50%', barW)
  check('状态文字含已传大小', ((await page.textContent('#xfer-active')) || '').includes('1.5 MB'))

  // 完成态
  await page.evaluate(
    ({ id }) =>
      window.__nativeEmit(
        'transfer',
        JSON.stringify({ id, name: '一段录音.m4a', size: 3145728, sent: 3145728, pct: 100, state: 'done' })
      ),
    { id: rid }
  )
  await page.waitForTimeout(500)
  check(
    '完成后进度条满格',
    (await page.evaluate(() => {
      const row = [...document.querySelectorAll('#xfer-active .xfer')].find((el) => (el.textContent || '').includes('一段录音'))
      return row && row.querySelector('.xfer-bar.done i') ? row.querySelector('.xfer-bar.done i').style.width : ''
    })) === '100%'
  )
  check('完成后显示已发到电脑', ((await page.textContent('#xfer-active')) || '').includes('已发到电脑'))
  check('没有脚本错误', errors.length === 0, errors.slice(0, 4))

  if (SHOTS) await page.screenshot({ path: 'C:/Users/zhou/WorkBuddy/xhub/_tools/android-transfer.png' })

  await browser.close()
  hub.close()
  view.close()
}

main()
  .catch((e) => {
    fail++
    console.error('  ✗ 异常:', e && e.stack ? e.stack.split('\n').slice(0, 5).join('\n') : e)
  })
  .finally(() => {
    console.log(`\n安卓传输页：${pass} 通过 / ${fail} 失败`)
    process.exit(fail ? 1 : 0)
  })
