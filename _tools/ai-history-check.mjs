/**
 * AI 历史对话管理端到端回归（Playwright + 本地静态服务 + 模拟模型接口）。
 *
 * 覆盖：懒创建、自动保存、新建不影响历史、查看并继续、单条删除确认、
 *       批量删除确认、当前会话状态区分、旧版 aiMessages 迁移、刷新后持久化。
 *
 * 运行：node _tools/ai-history-check.mjs
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

let replySeq = 0
function mockReply(text) {
  replySeq += 1
  return JSON.stringify({
    choices: [{ message: { role: 'assistant', content: text || '模拟回复 ' + replySeq } }],
    usage: { prompt_tokens: 12, completion_tokens: 6 },
  })
}

/** 把 AI 配置写进 IndexedDB 的 meta store，再 reload 让 boot 读到 */
async function seedMeta(page, port, extra) {
  await page.evaluate(
    async ({ port, extra }) => {
      const pairs = Object.assign(
        {
          aiBase: 'http://127.0.0.1:' + port,
          aiKey: 'test-key',
          aiModel: 'mock-model',
          aiPlatform: '',
          nickname: '测试员',
        },
        extra || {}
      )
      await new Promise((resolve, reject) => {
        const req = indexedDB.open('todolink', 2)
        req.onsuccess = () => {
          const tx = req.result.transaction('meta', 'readwrite')
          const st = tx.objectStore('meta')
          Object.keys(pairs).forEach((k) => st.put({ k, v: pairs[k] }))
          tx.oncomplete = resolve
          tx.onerror = () => reject(tx.error)
        }
        req.onerror = () => reject(req.error)
      })
    },
    { port, extra }
  )
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(700)
}

const historyCount = (page) =>
  page.evaluate(() => {
    const b = document.getElementById('btn-chat-history')
    if (!b) return -1
    const m = /历史\s*(\d+)/.exec(b.textContent)
    return m ? Number(m[1]) : -1
  })

const sessionTag = (page) => page.textContent('.chat-session-tag').catch(() => '')

async function sendMsg(page, text) {
  const before = await page.locator('.msg.ai .bubble').count()
  await page.fill('#chat-input', text)
  await page.click('#btn-send')
  // 等「新出现的那条 AI 气泡拿到模拟回复」，比等按钮状态可靠：
  // 切回旧会话时页面上本来就有旧气泡，只看文本会立刻误判为完成
  await page.waitForFunction(
    (n) => {
      const els = document.querySelectorAll('.msg.ai .bubble')
      return els.length > n && els[els.length - 1].textContent.indexOf('收到：') >= 0
    },
    before,
    { timeout: 8000 }
  )
  await page.waitForTimeout(220)
}

const { srv, port } = await serve()
const browser = await chromium.launch({ channel: 'msedge' })
let ctx
try {
  ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
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
    window.Android = {
      originPort: () => 47830,
      appVersion: () => '3.3.0',
      deviceName: () => 'test',
      readClipboard: () => '',
      writeClipboard: () => {},
      vibrate: () => {},
      toast: () => {},
      openUrl: () => {},
    }
  })
  // 模拟 OpenAI 兼容接口：返回完整 JSON（agent.js 也支持这种非流式响应）
  await page.route('**/chat/completions', (route) => {
    const body = (() => {
      try {
        return JSON.parse(route.request().postData() || '{}')
      } catch (e) {
        return {}
      }
    })()
    const last = body.messages && body.messages[body.messages.length - 1]
    const q = last && last.content ? String(last.content).slice(0, 12) : ''
    return route.fulfill({ status: 200, contentType: 'application/json', body: mockReply('收到：' + q) })
  })

  await page.goto('http://127.0.0.1:' + port + '/index.html', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(700)
  await seedMeta(page, port)
  await page.evaluate(() => (location.hash = '#/ai'))
  await page.waitForTimeout(400)

  // ---------- 1. 初始态：新对话与历史清晰区分 ----------
  check('进入 AI 页且模型已配置', (await page.$('#btn-send')) !== null)
  check('初始状态条标为「新对话」', (await sessionTag(page)).includes('新对话'), await sessionTag(page))
  check('初始历史条数为 0', (await historyCount(page)) === 0, String(await historyCount(page)))

  // ---------- 2. 第一条消息：懒创建并自动保存 ----------
  await sendMsg(page, '帮我建一条交房租的待办')
  check('发出第一条消息后自动建立 1 条历史', (await historyCount(page)) === 1, String(await historyCount(page)))
  check('状态条切换为「历史对话」', (await sessionTag(page)).includes('历史对话'), await sessionTag(page))
  check('回复已写入消息气泡', (await page.textContent('.msg.ai .bubble')).includes('收到：'))
  check('会话标题取首条提问', (await page.textContent('.chat-session-name')).includes('帮我建一条交房租'))

  await page.click('#btn-chat-history')
  await page.waitForTimeout(200)
  check('历史面板列出 1 条', (await page.locator('.hist-row').count()) === 1)
  check('历史面板显示预览', (await page.locator('.hist-preview').first().textContent()).includes('收到：'))
  check('当前会话有「当前」标记', (await page.locator('.hist-cur').count()) === 1)
  await page.click('.hist-head .mini')

  // ---------- 3. 新建对话不影响历史 ----------
  await page.click('#btn-new-chat')
  await page.waitForTimeout(220)
  check('新建后状态条回到「新对话」', (await sessionTag(page)).includes('新对话'), await sessionTag(page))
  check('新建后历史仍是 1 条', (await historyCount(page)) === 1, String(await historyCount(page)))
  await sendMsg(page, '再聊一个完全不同的话题')
  check('第二个话题落成第 2 条历史', (await historyCount(page)) === 2, String(await historyCount(page)))

  // ---------- 4. 查看并继续旧会话 ----------
  await page.click('#btn-chat-history')
  await page.waitForTimeout(200)
  const rows = page.locator('.hist-row')
  check('历史面板按时间倒序列出 2 条', (await rows.count()) === 2)
  // 第 2 行是最早那条（交房租）
  await rows.nth(1).locator('.hist-main').click()
  await page.waitForTimeout(300)
  check('切换到旧会话后展示原有消息', (await page.textContent('#chat-scroll')).includes('帮我建一条交房租的待办'))
  check('切换后状态条仍是「历史对话」', (await sessionTag(page)).includes('历史对话'))
  await sendMsg(page, '继续刚才那条，再加个备注')
  check('继续提问后历史总数不变', (await historyCount(page)) === 2, String(await historyCount(page)))
  check('继续的消息追加进同一会话', (await page.textContent('#chat-scroll')).includes('继续刚才那条'))

  // ---------- 5. 单条删除：先确认，取消不删 ----------
  await page.click('#btn-chat-history')
  await page.waitForTimeout(200)
  await page.locator('.hist-row').nth(1).locator('.mini.danger').click()
  await page.waitForTimeout(150)
  const confirmText = await page.textContent('.modal-text')
  check('单条删除弹出确认且带对话标题', /删除对话/.test(confirmText) && /不可恢复/.test(confirmText), confirmText)
  await page.click('.modal-btns .btn:first-child') // 取消
  await page.waitForTimeout(150)
  check('取消确认后不删除', (await page.locator('.hist-row').count()) === 2)
  await page.locator('.hist-row').nth(1).locator('.mini.danger').click()
  await page.waitForTimeout(150)
  await page.click('.modal-btns .btn.danger') // 确认
  await page.waitForTimeout(300)
  check('确认后删除 1 条', (await historyCount(page)) === 1, String(await historyCount(page)))

  // ---------- 6. 批量删除：全选 + 确认条数 ----------
  // 先显式新建，否则这次提问会继续写进当前那条历史会话，凑不出第二条
  await page.click('#btn-new-chat')
  await page.waitForTimeout(160)
  await sendMsg(page, '再来一个话题凑两条')
  check('新建并发送后历史回到 2 条', (await historyCount(page)) === 2, String(await historyCount(page)))
  await page.click('#btn-chat-history')
  await page.waitForTimeout(200)
  await page.locator('.hist-tools .mini').first().click() // 批量选择
  await page.waitForTimeout(120)
  check('进入批量选择后出现复选框', (await page.locator('.hist-check').count()) >= 2)
  await page.locator('.hist-tools .mini').nth(1).click() // 全选
  await page.waitForTimeout(120)
  const delBtn = page.locator('.hist-tools .mini.danger')
  check('删除按钮显示选中条数', /删除选中（2）/.test(await delBtn.textContent()), await delBtn.textContent())
  await delBtn.click()
  await page.waitForTimeout(150)
  const bulkText = await page.textContent('.modal-text')
  check('批量删除确认写明条数', /选中的 2 条/.test(bulkText), bulkText)
  await page.click('.modal-btns .btn.danger')
  await page.waitForTimeout(300)
  check('批量删除后历史清零', (await historyCount(page)) === 0, String(await historyCount(page)))
  check('历史面板已关闭', (await page.locator('.hist-panel').count()) === 0)
  check('回到新对话草稿态', (await sessionTag(page)).includes('新对话'))

  // ---------- 7. 刷新后持久化（新会话） ----------
  await sendMsg(page, '刷新后还应该记得我')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(800)
  await page.evaluate(() => (location.hash = '#/ai'))
  await page.waitForTimeout(350)
  check('刷新后历史仍在', (await historyCount(page)) === 1, String(await historyCount(page)))
  check('刷新后自动续上原会话', (await page.textContent('#chat-scroll')).includes('刷新后还应该记得我'))

  // ---------- 8. 旧版 aiMessages 迁移（独立上下文） ----------
  const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const page2 = await ctx2.newPage()
  const errors2 = []
  page2.on('pageerror', (e) => errors2.push(String(e.message || e)))
  await page2.addInitScript(() => {
    window.Android = { originPort: () => 47830, appVersion: () => '3.3.0', readClipboard: () => '', writeClipboard: () => {}, vibrate: () => {}, toast: () => {}, openUrl: () => {} }
  })
  await page2.goto('http://127.0.0.1:' + port + '/index.html', { waitUntil: 'domcontentloaded' })
  await page2.waitForTimeout(600)
  await seedMeta(page2, port, { aiMessages: [{ role: 'user', content: '升级前的老对话' }, { role: 'assistant', content: '老回复' }] })
  await page2.evaluate(() => (location.hash = '#/ai'))
  await page2.waitForTimeout(400)
  check('旧 aiMessages 迁移成 1 条历史', (await historyCount(page2)) === 1, String(await historyCount(page2)))
  check('迁移后自动续上老对话', (await page2.textContent('#chat-scroll')).includes('升级前的老对话'))
  check('迁移上下文无脚本错误', errors2.length === 0, errors2.slice(0, 2).join(' | '))
  await ctx2.close()

  check('主流程无脚本错误', errors.length === 0, errors.slice(0, 2).join(' | '))
} finally {
  if (ctx) await ctx.close()
  await browser.close()
  srv.close()
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
if (fail) {
  failures.forEach((f) => console.error(' - ' + f))
  process.exit(1)
}
