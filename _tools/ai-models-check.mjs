/**
 * AI 多模型选择端到端回归（Playwright + 本地静态服务 + 模拟平台）。
 *
 * 覆盖：平台内置清单、默认模型、切换自备/平台、即时生效、刷新后保留、
 *       平台下架正在用的模型、请求 400 model_not_allowed 的自愈重试、
 *       退出登录后的回退、不可用模型禁止确认。
 *
 * 运行：node _tools/ai-models-check.mjs
 */

import { createRequire } from 'node:module'
import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(path.join(path.dirname(fileURLToPath(import.meta.url)), 'node_modules/'))
const { chromium } = require('playwright')

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WWW = path.resolve(HERE, '../android/app/src/main/assets/www')
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
}

let pass = 0
let fail = 0
const failures = []
function check(name, ok, detail) {
  if (ok) {
    pass++
    console.log('✓ ' + name + (detail ? ' — ' + detail : ''))
  } else {
    fail++
    failures.push(name + (detail ? ' — ' + detail : ''))
    console.log('✗ ' + name + (detail ? ' — ' + detail : ''))
  }
}

function serve() {
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x')
    const rel = u.pathname === '/' ? '/index.html' : u.pathname
    const file = path.join(WWW, decodeURIComponent(rel))
    if (!file.startsWith(WWW)) return res.writeHead(403).end()
    try {
      const body = await fs.readFile(file)
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' })
      res.end(body)
    } catch (e) {
      res.writeHead(404).end('not found')
    }
  })
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port })))
}

const { srv, port } = await serve()
const browser = await chromium.launch({ channel: 'msedge' })
let ctx
let platformList = ['xhub-chat', 'xhub-vision']
let platformCalls = 0

try {
  ctx = await browser.newContext({
    viewport: { width: 380, height: 780 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    colorScheme: 'dark',
  })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e.message || e)))
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/i.test(m.text())) errors.push(m.text())
  })

  await page.addInitScript(() => {
    window.__reqs = []
    window.__chat = { reply: '好的', failModel: '' }
    window.Android = {
      originPort: () => 47830,
      appVersion: () => '3.8.0',
      deviceName: () => 'test',
      readClipboard: () => '',
      writeClipboard: () => {},
      vibrate: () => {},
      toast: () => {},
      openUrl: () => {},
      startKeepAlive: () => {},
      stopKeepAlive: () => {},
      // 模型的 HTTP 响应：记录请求体，支持指定模型返回 400 model_not_allowed
      httpStream: (id, method, url, headers, body) => {
        let parsed = {}
        try {
          parsed = JSON.parse(body || '{}')
        } catch (e) {
          parsed = {}
        }
        const req = { id, method, url, headers: JSON.parse(headers || '{}'), body: parsed }
        window.__reqs.push(req)
        setTimeout(() => {
          if (window.__chat.failModel && parsed.model === window.__chat.failModel) {
            window.__nativeEmit('error', JSON.stringify({ id, code: 400, body: JSON.stringify({ error: 'model_not_allowed', message: 'model_not_allowed' }) }))
            return
          }
          const text = JSON.stringify({ choices: [{ message: { role: 'assistant', content: window.__chat.reply || '好的' } }] })
          window.__nativeEmit('chunk', JSON.stringify({ id, text }))
          window.__nativeEmit('done', JSON.stringify({ id }))
        }, 20)
      },
    }
  })

  // 平台接口：GET /api/v1/ai/models（Authorization 会触发预检）
  await page.route('https://x-hub.xfactor.top/**', async (route) => {
    const req = route.request()
    const headers = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'authorization,content-type',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'content-type': 'application/json',
    }
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers })
    if (req.url().includes('/api/v1/ai/models')) {
      platformCalls++
      return route.fulfill({ status: 200, headers, body: JSON.stringify({ models: platformList }) })
    }
    return route.fulfill({ status: 404, headers, body: '{}' })
  })

  async function seedMeta(pairs) {
    await page.evaluate(async (entries) => {
      await new Promise((resolve, reject) => {
        const req = indexedDB.open('todolink', 2)
        req.onsuccess = () => {
          const tx = req.result.transaction('meta', 'readwrite')
          const st = tx.objectStore('meta')
          entries.forEach(([k, v]) => st.put({ k, v }))
          tx.oncomplete = resolve
          tx.onerror = () => reject(tx.error)
        }
        req.onerror = () => reject(req.error)
      })
    }, Object.entries(pairs))
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(900)
  }

  const readMeta = (key) =>
    page.evaluate(
      (k) =>
        new Promise((resolve, reject) => {
          const req = indexedDB.open('todolink', 2)
          req.onsuccess = () => {
            const g = req.result.transaction('meta', 'readonly').objectStore('meta').get(k)
            g.onsuccess = () => resolve(g.result ? g.result.v : null)
            g.onerror = () => reject(g.error)
          }
          req.onerror = () => reject(req.error)
        }),
      key
    )

  async function gotoAi() {
    await page.evaluate(() => (location.hash = '#/ai'))
    await page.waitForTimeout(450)
  }

  async function openPicker() {
    await page.locator('#btn-chat-model').click()
    await page.waitForSelector('.mdl-card', { timeout: 3000 })
    await page.waitForTimeout(350) // 等静默对账（若触发）结束
  }

  async function pickRow(text) {
    await page.locator('.mdl-row', { hasText: text }).first().click()
    await page.waitForTimeout(120)
  }

  async function confirmPick() {
    await page.locator('#mdl-ok').click()
    await page.waitForTimeout(300)
  }

  async function sendMsg(text) {
    const before = await page.locator('.msg.ai .bubble').count()
    await page.fill('#chat-input', text)
    await page.click('#btn-send')
    await page.waitForFunction(
      (n) => {
        const els = document.querySelectorAll('.msg.ai .bubble')
        return els.length > n && (els[els.length - 1].textContent || '').trim().length > 0
      },
      before,
      { timeout: 5000 }
    )
    await page.waitForTimeout(200)
  }

  await page.goto('http://127.0.0.1:' + port + '/index.html', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(600)

  // ---------- 1. 登录后首次：平台清单 → 默认第一条 ----------
  await seedMeta({ nickname: '测试员', ptToken: 'tok-test', timetable: { termStart: '', courses: [] } })
  await gotoAi()
  await page.waitForFunction(() => {
    const el = document.querySelector('#btn-chat-model .cm-name')
    return el && el.textContent.trim()
  }, { timeout: 6000 })
  const chip = (await page.textContent('#btn-chat-model .cm-name')).trim()
  check('登录后默认使用 x-hub 内置模型清单第一条', chip === 'xhub-chat', chip)
  check('默认选择已落盘（aiSelected）', (await readMeta('aiSelected')) === 'pl:xhub-chat', await readMeta('aiSelected'))
  check('平台清单请求带上账号 token', platformCalls >= 1, '调用 ' + platformCalls + ' 次')

  // ---------- 2. 选择器展示分组、当前项与生效范围 ----------
  await openPicker()
  const groups = await page.locator('.mdl-sect > b').allTextContents()
  check('选择器分组包含 x-hub 内置与自备', /x-hub 内置/.test(groups[0] || '') && /自备/.test(groups[1] || ''), JSON.stringify(groups))
  check('列出全部平台模型', (await page.locator('.mdl-row', { hasText: 'xhub-' }).count()) === 2)
  check('当前模型有「已选」标记', (await page.locator('.mdl-row.on', { hasText: 'xhub-chat' }).count()) === 1)
  const pickerText = await page.textContent('.mdl-card')
  check('说明切换立即生效且全局共用', /立即生效/.test(pickerText) && /AI 助手/.test(pickerText))
  await page.locator('.mdl-card .lib-head .mini', { hasText: '取消' }).click()
  await page.waitForTimeout(200)

  // ---------- 3. 切到另一个平台模型：请求立即用新模型 ----------
  await openPicker()
  await pickRow('xhub-vision')
  await confirmPick()
  check('切换后写盘', (await readMeta('aiSelected')) === 'pl:xhub-vision', await readMeta('aiSelected'))
  await page.evaluate(() => (window.__reqs = []))
  await sendMsg('你好')
  let req = await page.evaluate(() => window.__reqs[0])
  check('平台模型请求走平台 /v1', !!req && req.url === 'https://x-hub.xfactor.top/v1/chat/completions', req && req.url)
  check('请求体使用新选中的模型名', !!req && req.body.model === 'xhub-vision', req && req.body.model)
  check('平台请求用账号 token 而不是自备 Key', !!req && /^Bearer tok-test$/.test(req.headers.Authorization || ''))

  // ---------- 4. 设置里新增自备模型并立即生效 ----------
  await page.locator('.chat-tools .mini', { hasText: '⚙' }).click()
  await page.waitForTimeout(700)
  check('设置面板标题为「模型设置」', (await page.textContent('#sheet-title')) === '模型设置')
  await page.locator('.mdl-sect .mini', { hasText: '添加' }).click()
  await page.waitForTimeout(200)
  const inputs = page.locator('.mdl-form input')
  await inputs.nth(0).fill('我的 DeepSeek')
  await inputs.nth(1).fill('https://api.deepseek.com/v1')
  await inputs.nth(2).fill('deepseek-chat')
  await inputs.nth(3).fill('sk-mine')
  await page.locator('#btn-save-model').click()
  await page.waitForTimeout(500)
  const customId = await readMeta('aiSelected')
  check('添加自备模型后自动切过去', String(customId).indexOf('cu:') === 0, String(customId))
  check('旧键同步（aiModel/aiBase/aiKey）', (await readMeta('aiModel')) === 'deepseek-chat' && (await readMeta('aiKey')) === 'sk-mine')
  check('列表里出现自备模型且标为使用中', (await page.locator('.mdl-row.on', { hasText: '我的 DeepSeek' }).count()) === 1)
  await page.locator('#btn-save').click()
  await page.waitForTimeout(250)
  check('顶部入口显示当前自备模型', /我的 DeepSeek/.test(await page.textContent('#btn-chat-model')))

  await page.evaluate(() => (window.__reqs = []))
  await sendMsg('帮我看看')
  req = await page.evaluate(() => window.__reqs[0])
  check('对话立即打到自备接口', !!req && req.url === 'https://api.deepseek.com/v1/chat/completions', req && req.url)
  check('自备请求用自己的 Key 与模型名', !!req && req.headers.Authorization === 'Bearer sk-mine' && req.body.model === 'deepseek-chat')

  // ---------- 5. 刷新后保留选择 ----------
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(900)
  await gotoAi()
  check('刷新后仍是上次选择', /我的 DeepSeek/.test(await page.textContent('#btn-chat-model')))
  check('刷新后 aiSelected 未丢', (await readMeta('aiSelected')) === customId)

  // ---------- 6. 平台下架正在用的模型：刷新后自动落盘新默认 ----------
  await openPicker()
  await pickRow('xhub-chat')
  await confirmPick()
  check('先切回 xhub-chat', (await readMeta('aiSelected')) === 'pl:xhub-chat')
  platformList = ['xhub-vision'] // 服务端下架 xhub-chat
  await openPicker()
  await page.locator('.mdl-card .mini', { hasText: '刷新' }).click()
  await page.waitForTimeout(700)
  check('下架的模型从列表消失', (await page.locator('.mdl-row', { hasText: 'xhub-chat' }).count()) === 0)
  const afterRemoval = await readMeta('aiSelected')
  check('当前模型被下架时自动切到剩余平台模型并落盘', afterRemoval === 'pl:xhub-vision', String(afterRemoval))
  await page.locator('.mdl-card .lib-head .mini', { hasText: '取消' }).click()
  await page.waitForTimeout(200)

  // ---------- 7. 请求撞 model_not_allowed：对账 + 重试一次 ----------
  platformList = ['xhub-new']
  await page.evaluate(() => {
    window.__reqs = []
    window.__chat.failModel = 'xhub-vision'
  })
  await sendMsg('再试一次')
  const reqs = await page.evaluate(() => window.__reqs)
  check('第一次请求用旧模型并失败', reqs.length >= 2 && reqs[0].body.model === 'xhub-vision', JSON.stringify(reqs.map((r) => r.body.model)))
  check('自动重试改用对账后的新模型', reqs.length >= 2 && reqs[1].body.model === 'xhub-new', reqs[1] && reqs[1].body.model)
  check('自愈后选择写盘', (await readMeta('aiSelected')) === 'pl:xhub-new', await readMeta('aiSelected'))
  check('重试成功后拿到回复', /好的/.test(await page.textContent('.msg.ai:last-child .bubble')))

  // ---------- 8. 退出登录：平台模型回退到自备并明确提示 ----------
  await page.evaluate(() => {
    window.__chat.failModel = ''
  })
  await seedMeta({ ptToken: '' })
  await gotoAi()
  check('未登录时回退到自备模型', /我的 DeepSeek/.test(await page.textContent('#btn-chat-model')))
  await openPicker()
  const banner = await page.textContent('.mdl-banner')
  check('选择器说明原模型为何不可用', /原模型已不可用/.test(banner) && /需要登录/.test(banner), banner)
  await page.locator('.mdl-card .lib-head .mini', { hasText: '取消' }).click()
  await page.waitForTimeout(200)
  await page.evaluate(() => (window.__reqs = []))
  await sendMsg('还在吗')
  req = await page.evaluate(() => window.__reqs[0])
  check('回退后对话确实走自备接口', !!req && req.url === 'https://api.deepseek.com/v1/chat/completions', req && req.url)

  // ---------- 9. 缺 Key 的模型不可确认 ----------
  const models = JSON.stringify([
    { id: 'cu:bad', kind: 'custom', model: 'bad-model', label: '缺 Key 的模型', base: 'https://bad.test/v1', key: '' },
    { id: 'cu:ok', kind: 'custom', model: 'ok-model', label: '可用的自备模型', base: 'https://ok.test/v1', key: 'sk-ok' },
  ])
  await seedMeta({ ptToken: '', aiModels: models, aiSelected: 'cu:bad' })
  await gotoAi()
  await openPicker()
  const badRow = page.locator('.mdl-row', { hasText: '缺 Key 的模型' })
  check('不可用模型在列表里标出原因', /缺少 API Key/.test(await badRow.textContent()))
  await badRow.click()
  await page.waitForTimeout(150)
  check('选中不可用模型时确认按钮禁用', await page.locator('#mdl-ok').isDisabled())
  const tip = await page.textContent('.mdl-tip')
  check('禁用时说明原因', /缺少 API Key/.test(tip), tip)

  check('全程无脚本错误', errors.length === 0, errors.slice(0, 2).join(' | '))
} finally {
  if (ctx) await ctx.close()
  await browser.close()
  srv.close()
}

console.log('')
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项')
if (fail) {
  console.log('失败项：')
  failures.forEach((f) => console.log(' - ' + f))
  process.exitCode = 1
}
