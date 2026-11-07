/**
 * 首页三件套回归：秒级时钟、名言卡片、可自定义卡片布局（拖动 / 缩放 / 卡片库）。
 *
 * 用法：
 *   node _tools/home-check.mjs            # 断言
 *   node _tools/home-check.mjs --shots    # 同时输出截图到 _tools/home-*.png
 *
 * 与 nav-v5-check 一样用 Playwright + 本地静态服务，不依赖真实设备：
 * 页面里注入一个最小 Android 桥，避免 boot 卡在原生能力上。
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
const shots = process.argv.includes('--shots')
const dark = process.argv.includes('--dark')

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
    if (!file.startsWith(WWW)) {
      res.writeHead(403).end()
      return
    }
    try {
      const body = await fs.readFile(file)
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' })
      res.end(body)
    } catch (e) {
      res.writeHead(404).end('not found')
    }
  })
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }))
  })
}

async function readLayout(page) {
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open('todolink', 2)
        req.onsuccess = () => {
          const g = req.result.transaction('meta', 'readonly').objectStore('meta').get('homeLayout')
          // meta 存的是 { k, v }，值在 v 里
          g.onsuccess = () => resolve(g.result ? g.result.v : null)
          g.onerror = () => resolve(null)
        }
        req.onerror = () => resolve(null)
      })
  )
}

const VIEWPORTS = [
  { name: 'small-360', width: 360, height: 740 },
  { name: 'iphone-390', width: 390, height: 844 },
  { name: 'large-430', width: 430, height: 932 },
]

const { srv, port } = await serve()
const browser = await chromium.launch({ channel: 'msedge' })

for (const v of VIEWPORTS) {
  const ctx = await browser.newContext({
    viewport: { width: v.width, height: v.height },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    colorScheme: dark ? 'dark' : 'light',
  })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e.message || e)))
  page.on('console', (m) => {
    // 只关心脚本错误；静态资源 404（浏览器自带的 favicon 请求）不算
    if (m.type() === 'error' && !/Failed to load resource/i.test(m.text())) errors.push(m.text())
  })

  await page.addInitScript(() => {
    window.Android = {
      originPort: () => 47830,
      appVersion: () => '2.11.0',
      deviceName: () => 'test',
      readClipboard: () => '',
      writeClipboard: () => {},
      vibrate: () => {},
      toast: () => {},
      openUrl: () => {},
    }
  })

  await page.goto('http://127.0.0.1:' + port + '/index.html', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(900)

  // ---------- 1. 秒级时钟 ----------
  const t1 = await page.textContent('#home-clock')
  check(`${v.name} 时钟格式 HH:MM:SS`, /^\d{2}:\d{2}:\d{2}$/.test((t1 || '').trim()), t1)
  await page.waitForTimeout(1300)
  const t2 = await page.textContent('#home-clock')
  check(`${v.name} 时钟逐秒跳动`, t1 !== t2, `${t1} → ${t2}`)

  // ---------- 2. 卡片渲染 ----------
  const cards = await page.$$eval('.home-grid .hc', (els) => els.map((e) => e.getAttribute('data-card')))
  check(`${v.name} 默认 7 张卡片`, cards.length === 7, cards.join(','))
  check(`${v.name} 含名言/统计/日历/节日`, ['quote', 'stats', 'calendar', 'holidays'].every((id) => cards.includes(id)), cards.join(','))

  const quote = await page.textContent('.hq-text')
  const from = await page.textContent('.hc-quote-from')
  check(`${v.name} 名言有正文与出处`, !!(quote || '').trim() && (from || '').includes('——'), `${quote} ${from}`)

  const before = quote
  await page.click('.hc-quote')
  await page.waitForTimeout(350)
  const after = await page.textContent('.hq-text')
  check(`${v.name} 点击换一条且不重复`, before !== after, `${before} → ${after}`)

  if (shots) {
    await page.screenshot({ path: path.join(HERE, `home-${v.name}-${dark ? 'dark' : 'light'}.png`), fullPage: false })
  }

  // ---------- 3. 编辑态：拖动 ----------
  await page.click('.hero-edit')
  await page.waitForTimeout(300)
  check(`${v.name} 进入编辑态显示工具栏`, (await page.$('.editbar')) !== null)
  check(`${v.name} 卡片显示抓手与缩放手柄`, (await page.$('.hc-drag')) !== null && (await page.$('.hc-resize')) !== null)

  const gridBox = await page.$eval('.home-grid', (el) => {
    const r = el.getBoundingClientRect()
    const gap = parseFloat(getComputedStyle(el).columnGap) || 10
    return { width: r.width, gap }
  })
  const cell = (gridBox.width - gridBox.gap * 3) / 4 + gridBox.gap

  // 默认布局排得比较满，选「速达」卡往下拖两行：目标 (2,10) 是空的，能稳定验证移动
  const dragCard = 'resources'
  const handle = await page.$(`.hc[data-card="${dragCard}"] .hc-drag`)
  await page.evaluate((id) => {
    const card = document.querySelector(`.hc[data-card="${id}"]`)
    const sc = document.querySelector('.scroll')
    if (card && sc) sc.scrollTop += card.getBoundingClientRect().top - 220
  }, dragCard)
  await page.waitForTimeout(250)
  const hb = await handle.boundingBox()
  const rowH = 78 + 10
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2)
  await page.mouse.down()
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2 + rowH * 2, { steps: 10 })
  await page.mouse.up()
  await page.waitForTimeout(450)

  const moved = await readLayout(page)
  const item = moved && moved.items.filter((i) => i.id === dragCard)[0]
  check(`${v.name} 拖动后位置已落盘`, !!item && item.y === 10, JSON.stringify(item))

  // ---------- 4. 缩放 ----------
  // 笔记卡 2 宽、最小 2：向右拖一格加到 3 宽（位置可能被顺延，宽度必须变）
  const rz = await page.$('.hc[data-card="notes"] .hc-resize')
  await page.evaluate(() => {
    const card = document.querySelector('.hc[data-card="notes"]')
    const sc = document.querySelector('.scroll')
    if (card && sc) sc.scrollTop += card.getBoundingClientRect().top - 220
  })
  await page.waitForTimeout(250)
  const rb = await rz.boundingBox()
  const colW = (gridBox.width - gridBox.gap * 3) / 4 + gridBox.gap
  await page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2)
  await page.mouse.down()
  await page.mouse.move(rb.x + rb.width / 2 + colW, rb.y + rb.height / 2, { steps: 10 })
  await page.mouse.up()
  await page.waitForTimeout(450)
  const resized = await readLayout(page)
  const note2 = resized && resized.items.filter((i) => i.id === 'notes')[0]
  check(`${v.name} 缩放改变宽度并落盘`, !!note2 && note2.w === 3, JSON.stringify(note2))

  // ---------- 5. 卡片库 ----------
  await page.click('.editbar .btn:nth-of-type(1)')
  await page.waitForTimeout(300)
  const libRows = await page.$$eval('.lib-row', (els) => els.length)
  const libTags = await page.$$eval('.lib-tag', (els) => els.map((e) => e.textContent))
  check(`${v.name} 卡片库列出全部卡片`, libRows === 10, String(libRows))
  check(`${v.name} 扩展五个集合标注来源`, libTags.length === 5, libTags.join(','))

  if (shots) {
    await page.screenshot({ path: path.join(HERE, `home-${v.name}-library-${dark ? 'dark' : 'light'}.png`) })
  }
  await page.click('.lib-head .mini')
  await page.waitForTimeout(200)

  // 移除一张再确认能加回来
  await page.click('.hc[data-card="quote"] .hc-del')
  await page.waitForTimeout(350)
  const afterRemove = await page.$$eval('.home-grid .hc', (els) => els.length)
  check(`${v.name} 移除卡片生效`, afterRemove === 6, String(afterRemove))
  await page.click('.editbar .btn:nth-of-type(1)')
  await page.waitForTimeout(300)
  const addBtn = await page.$('.lib-row:last-child .btn')
  if (addBtn) await addBtn.click()
  await page.waitForTimeout(350)

  // ---------- 6. 节日页 ----------
  await page.evaluate(() => (location.hash = '#/holidays'))
  await page.waitForTimeout(500)
  const hRows = await page.$$eval('.holiday-row', (els) => els.length)
  const hFirst = await page.textContent('.hd-name')
  check(`${v.name} 节日页有列表`, hRows > 20, `${hRows} 行，首条 ${hFirst}`)
  const cats = await page.$$eval('.filterbar .chip', (els) => els.map((e) => e.textContent))
  check(`${v.name} 节日分类齐全`, cats.length === 4, cats.join(' | '))

  await page.click('.filterbar .chip:nth-child(3)')
  await page.waitForTimeout(300)
  const termOnly = await page.$$eval('.holiday-row', (els) => els.length)
  check(`${v.name} 可切到二十四节气`, termOnly > 10, `${termOnly} 行`)

  if (shots) {
    await page.screenshot({ path: path.join(HERE, `home-${v.name}-holidays-${dark ? 'dark' : 'light'}.png`), fullPage: false })
    await page.evaluate(() => (location.hash = '#/home'))
    await page.waitForTimeout(500)
    await page.screenshot({ path: path.join(HERE, `home-${v.name}-after-${dark ? 'dark' : 'light'}.png`) })
    // 前面可能还停在编辑态，这里按实际状态决定是否需要点一下，避免把编辑态又关掉
    if (!(await page.$('.editbar'))) {
      await page.click('.hero-edit')
      await page.waitForTimeout(300)
    }
    await page.screenshot({ path: path.join(HERE, `home-${v.name}-edit-${dark ? 'dark' : 'light'}.png`) })
  }

  check(`${v.name} 无脚本错误`, errors.length === 0, errors.slice(0, 3).join(' | '))
  await ctx.close()
}

// ---------- 7. 强提醒：到点弹窗 + 系统通知 ----------
// 单独开一个上下文：写入一条「1 分钟前就该提醒」的待办，重载后由 initAlerts 的首次 sweep 触发
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e.message || e)))
  await page.addInitScript(() => {
    window.__notified = []
    window.__vibrated = 0
    window.Android = {
      originPort: () => 47830,
      appVersion: () => '2.11.0',
      deviceName: () => 'test',
      readClipboard: () => '',
      writeClipboard: () => {},
      vibrate: () => { window.__vibrated++ },
      toast: () => {},
      openUrl: () => {},
      notify: (t, b) => { window.__notified.push([t, b]) },
      setAlarms: (json) => { window.__alarms = json },
    }
  })
  await page.goto('http://127.0.0.1:' + port + '/index.html', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(900)

  await page.evaluate(() => {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('todolink', 2)
      req.onupgradeneeded = () => {
        const d = req.result
        if (!d.objectStoreNames.contains('records')) d.createObjectStore('records', { keyPath: 'id' })
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'k' })
      }
      req.onsuccess = () => {
        const db = req.result
        const rec = {
          id: 'todos:remind-test',
          col: 'todos',
          title: '该喝水了',
          done: false,
          dueAt: Date.now() + 3600000,
          remindLead: 30,
          remindAt: Date.now() - 60000,
          deleted: false,
          dirty: 0,
          hlc: '00000000000000000000000009',
          updatedAt: Date.now(),
          createdAt: Date.now(),
        }
        // 再放一条 10 分钟后要提醒的：用来验证「未来提醒被交给系统闹钟」
        const future = Object.assign({}, rec, {
          id: 'todos:alarm-test',
          title: '十分钟后开会',
          remindAt: Date.now() + 10 * 60000,
        })
        const tx = db.transaction('records', 'readwrite')
        tx.objectStore('records').put(rec)
        tx.objectStore('records').put(future)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      }
      req.onerror = () => reject(req.error)
    })
  })

  await page.reload({ waitUntil: 'domcontentloaded' })
  // 首屏后 4 秒才做第一次 sweep，留足余量
  await page.waitForTimeout(5600)

  const notified = await page.evaluate(() => window.__notified)
  const card = await page.$('.remind-card')
  const cardText = card ? await card.textContent() : ''
  const alarms = await page.evaluate(() => window.__alarms || '')

  check('到点发出系统通知', Array.isArray(notified) && notified.length >= 1, JSON.stringify(notified))
  check('到点弹出应用内提醒', !!card && /该喝水了/.test(cardText), cardText.replace(/\s+/g, ' ').slice(0, 60))
  check('弹窗提供「稍后」与「完成」', /稍后/.test(cardText) && /完成/.test(cardText), cardText.replace(/\s+/g, ' ').slice(0, 60))
  check('已把未来提醒交给系统闹钟', /todos:alarm-test/.test(alarms), alarms ? alarms.slice(0, 80) : '未调用 setAlarms')
  check('强提醒无脚本错误', errors.length === 0, errors.slice(0, 2).join(' | '))
  await ctx.close()
}

await browser.close()
srv.close()

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项')
if (fail) {
  console.log('失败项：\n- ' + failures.join('\n- '))
  process.exit(1)
}
