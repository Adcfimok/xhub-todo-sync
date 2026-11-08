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

/** 首次启动会弹强制称呼弹窗：填一个测试称呼并提交，避免挡住后续断言 */
async function dismissNickname(page, vname) {
  try {
    await page.waitForSelector('.nick-gate', { timeout: 4000 })
    check(`${vname} 首次启动弹称呼弹窗`, true)
    await page.fill('.nick-input', '测试员')
    await page.click('.nick-save')
    await page.waitForTimeout(400)
    check(`${vname} 提交称呼后弹窗消失`, (await page.$('.nick-gate')) === null)
  } catch (e) {
    check(`${vname} 首次启动弹称呼弹窗`, false, '未出现弹窗')
  }
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
      appVersion: () => '3.2.0',
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

  // 首次启动会弹「希望我怎么称呼你」强制弹窗：填一个测试称呼并提交，顺便验证弹窗能走通
  await dismissNickname(page, v.name)

  // ---------- 1. 秒级时钟 ----------
  const t1 = await page.textContent('#home-clock')
  check(`${v.name} 时钟格式 HH:MM:SS`, /^\d{2}:\d{2}:\d{2}$/.test((t1 || '').trim()), t1)
  await page.waitForTimeout(1300)
  const t2 = await page.textContent('#home-clock')
  check(`${v.name} 时钟逐秒跳动`, t1 !== t2, `${t1} → ${t2}`)

  // ---------- 2. 卡片渲染 ----------
  const cards = await page.$$eval('.home-grid .hc', (els) => els.map((e) => e.getAttribute('data-card')))
  check(`${v.name} 默认 9 张卡片`, cards.length === 9, cards.join(','))
  check(
    `${v.name} 含名言/统计/课表/倒数日/日历/节日`,
    ['quote', 'stats', 'timetable', 'countdown', 'calendar', 'holidays'].every((id) => cards.includes(id)),
    cards.join(',')
  )

  // 统计卡与「每日一句」必须同宽同高，且四个数字一个都不能被裁掉
  const statsGeo = await page.evaluate(() => {
    const card = document.querySelector('.hc[data-card="stats"]')
    const quote = document.querySelector('.hc[data-card="quote"]')
    if (!card || !quote) return null
    const a = card.getBoundingClientRect()
    const b = quote.getBoundingClientRect()
    const cells = [...card.querySelectorAll('.stat')].map((el) => {
      const r = el.getBoundingClientRect()
      const bEl = el.querySelector('b')
      const sEl = el.querySelector('span')
      const bb = bEl.getBoundingClientRect()
      const sb = sEl.getBoundingClientRect()
      return {
        label: (sEl.textContent || '').trim(),
        // 文字框必须完整落在格子内，且格子不能出现滚动溢出
        inside: bb.top >= r.top - 0.5 && sb.bottom <= r.bottom + 0.5 && bb.left >= r.left - 0.5 && sb.right <= r.right + 0.5,
        clipped: el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1,
      }
    })
    const body = card.querySelector('.hc-body')
    return {
      w: Math.round(a.width * 10) / 10,
      h: Math.round(a.height * 10) / 10,
      qw: Math.round(b.width * 10) / 10,
      qh: Math.round(b.height * 10) / 10,
      cells,
      bodyOverflow: body ? body.scrollHeight > body.clientHeight + 1 : true,
      split: document.querySelectorAll('[data-card^="stat:"]').length,
    }
  })
  check(
    `${v.name} 统计卡与每日一句同宽同高`,
    !!statsGeo && Math.abs(statsGeo.w - statsGeo.qw) < 1 && Math.abs(statsGeo.h - statsGeo.qh) < 1,
    statsGeo ? `统计 ${statsGeo.w}×${statsGeo.h} / 名言 ${statsGeo.qw}×${statsGeo.qh}` : '未找到卡片'
  )
  check(
    `${v.name} 四个统计格完整不裁切`,
    !!statsGeo &&
      statsGeo.cells.length === 4 &&
      statsGeo.split === 0 &&
      !statsGeo.bodyOverflow &&
      statsGeo.cells.every((c) => c.inside && !c.clipped),
    statsGeo ? statsGeo.cells.map((c) => `${c.label}:${c.inside && !c.clipped ? 'ok' : 'FAIL'}`).join(' ') : '未找到格子'
  )

  // 卡片之间不能留空行：每张卡的正上方必须有邻居（y=0 除外），否则就是收高/删卡留下的缝
  const gaps = await page.evaluate(() => {
    const parse = (s) => {
      const m = /^(\d+)\s*\/\s*span\s+(\d+)$/.exec(s || '')
      return m ? { a: Number(m[1]), n: Number(m[2]) } : null
    }
    const cards = [...document.querySelectorAll('.home-grid .hc')].map((el) => {
      const r = parse(el.style.gridRow)
      const c = parse(el.style.gridColumn)
      return {
        id: el.getAttribute('data-card'),
        x: c ? c.a - 1 : 0,
        w: c ? c.n : 1,
        y: r ? r.a - 1 : 0,
        h: r ? r.n : 1,
      }
    })
    const used = new Set()
    cards.forEach((c) => {
      for (let i = 0; i < c.w; i++) for (let j = 0; j < c.h; j++) used.add(c.x + i + ',' + (c.y + j))
    })
    const floating = cards
      .filter((c) => {
        if (c.y === 0) return false
        for (let i = 0; i < c.w; i++) if (used.has(c.x + i + ',' + (c.y - 1))) return false
        return true
      })
      .map((c) => c.id)
    return { floating, count: cards.length }
  })
  check(`${v.name} 卡片之间没有空行`, gaps.count > 0 && gaps.floating.length === 0, gaps.floating.join(',') || 'ok')

  // 时间与问好必须落在同一行：水平相邻 + 垂直重叠
  const heroGeo = await page.evaluate(() => {
    const t = document.getElementById('home-clock').getBoundingClientRect()
    const g = document.getElementById('home-greet').getBoundingClientRect()
    const line = document.querySelector('.hero-line').getBoundingClientRect()
    return { t: { l: t.left, r: t.right, t: t.top, b: t.bottom }, g: { l: g.left, r: g.right, t: g.top, b: g.bottom }, line: { r: line.right, b: line.bottom } }
  })
  check(
    `${v.name} 时间与问好同一行`,
    heroGeo.g.l >= heroGeo.t.r - 1 && heroGeo.g.t < heroGeo.t.b - 4 && heroGeo.g.b > heroGeo.t.t + 4,
    `clock ${Math.round(heroGeo.t.l)}→${Math.round(heroGeo.t.r)} / greet ${Math.round(heroGeo.g.l)}→${Math.round(heroGeo.g.r)}`
  )
  check(
    `${v.name} 问好未溢出容器`,
    heroGeo.g.r <= heroGeo.line.r + 0.5,
    `greet.right ${Math.round(heroGeo.g.r)} / line.right ${Math.round(heroGeo.line.r)}`
  )

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
  check(`${v.name} 拖动后位置已落盘`, !!item && item.y === 13, JSON.stringify(item))

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
  check(`${v.name} 卡片库列出全部卡片`, libRows === 12, String(libRows))
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
  check(`${v.name} 移除卡片生效`, afterRemove === 8, String(afterRemove))
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

  // --well 是标签/按压反馈的底色 token，曾被引用却未定义（=全透明），这里守住
  const tagBg = await page.evaluate(() => {
    const el = document.querySelector('.hd-tag')
    return el ? getComputedStyle(el).backgroundColor : null
  })
  check(`${v.name} 节日标签有底色（--well 已定义）`, !!tagBg && tagBg !== 'rgba(0, 0, 0, 0)', tagBg)

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

// ---------- 7. 我的：一键添加所有节日 ----------
function readBulk(page) {
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open('todolink', 2)
        req.onsuccess = () => {
          const g = req.result.transaction('meta', 'readonly').objectStore('meta').get('holidayBulk')
          g.onsuccess = () => resolve(g.result ? g.result.v : null)
          g.onerror = () => resolve(null)
        }
        req.onerror = () => resolve(null)
      })
  )
}

async function readTodos(page) {
  const all = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open('todolink', 2)
        req.onsuccess = () => {
          const g = req.result.transaction('records', 'readonly').objectStore('records').getAll()
          g.onsuccess = () => resolve(g.result || [])
          g.onerror = () => resolve([])
        }
        req.onerror = () => resolve([])
      })
  )
  return all.filter((r) => r.col === 'todos' && !r.deleted)
}

async function waitBulk(page, pred, timeout = 20000) {
  const t0 = Date.now()
  for (;;) {
    const v = await readBulk(page)
    if (pred(v)) return v
    if (Date.now() - t0 > timeout) return v
    await page.waitForTimeout(120)
  }
}

{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e.message || e)))
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/i.test(m.text())) errors.push(m.text())
  })
  await page.addInitScript(() => {
    window.Android = {
      originPort: () => 47830,
      appVersion: () => '3.2.0',
      deviceName: () => 'test',
      readClipboard: () => '',
      writeClipboard: () => {},
      vibrate: () => {},
      toast: () => {},
      openUrl: () => {},
    }
  })
  await page.goto('http://127.0.0.1:' + port + '/index.html', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(800)
  await dismissNickname(page, '我的页')
  await page.evaluate(() => (location.hash = '#/more'))
  await page.waitForTimeout(500)

  const rowText = (await page.textContent('.menu-sub')) || ''
  check('我的页出现「一键添加所有节日」', /一键添加所有节日/.test(rowText), rowText.replace(/\s+/g, ' ').slice(0, 70))
  check('开关位于「节日」条目下方', (await page.$('.menu-item.no-sep + .menu-sub')) !== null)

  const before = (await readTodos(page)).length
  await page.click('.menu-sub .toggle')
  await waitBulk(page, (v) => !!(v && v.ids && v.ids.length))
  const after = (await readTodos(page)).length
  const bulk = await readBulk(page)
  check('勾选后批量写入节日待办', after - before >= 30, `${before} → ${after}`)
  check('批量 id 全部落盘', !!(bulk && bulk.ids && bulk.ids.length === after - before), bulk && String(bulk.ids.length))
  check('开关保持勾选', (await page.isChecked('.menu-sub .toggle input')) === true)
  const subOn = (await page.textContent('.menu-sub .switch-sub')) || ''
  check('开关下方显示已加条数', /已批量加入 \d+ 条/.test(subOn), subOn)

  // 取消勾选：先确认，再只删这一批
  await page.click('.menu-sub .toggle')
  await page.waitForTimeout(350)
  const danger = await page.$('.modal-btns .btn.danger')
  check('取消勾选先弹确认框', danger !== null)
  if (danger) await danger.click()
  await waitBulk(page, (v) => !v || !v.ids || !v.ids.length)
  await page.waitForTimeout(500)
  const restored = (await readTodos(page)).length
  check('确认后批量待办被移除', restored === before, `${after} → ${restored}`)
  check('开关回到未勾选', (await page.isChecked('.menu-sub .toggle input')) === false)
  check('我的页无脚本错误', errors.length === 0, errors.slice(0, 3).join(' | '))

  if (shots) await page.screenshot({ path: path.join(HERE, `home-more-bulk-${dark ? 'dark' : 'light'}.png`) })
  await ctx.close()
}

// ---------- 8. 老布局升级：统计收高后不能留空行 ----------
// 复现用户截图：2.12.2 收高后写回的 v2 存档里，统计在 y1、日历还在 y3，中间空一整行
{
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    colorScheme: dark ? 'dark' : 'light',
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
      appVersion: () => '3.2.0',
      deviceName: () => 'test',
      readClipboard: () => '',
      writeClipboard: () => {},
      vibrate: () => {},
      toast: () => {},
      openUrl: () => {},
    }
  })
  await page.goto('http://127.0.0.1:' + port + '/index.html', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(700)
  await dismissNickname(page, '老布局升级')

  await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('todolink', 2)
        req.onupgradeneeded = () => {
          const d = req.result
          if (!d.objectStoreNames.contains('records')) d.createObjectStore('records', { keyPath: 'id' })
          if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'k' })
        }
        req.onsuccess = () => {
          const db = req.result
          const tx = db.transaction('meta', 'readwrite')
          tx.objectStore('meta').put({
            k: 'homeLayout',
            v: {
              v: 2,
              rows: 8,
              items: [
                { id: 'quote', x: 0, y: 0, w: 4, h: 1 },
                { id: 'stats', x: 0, y: 1, w: 4, h: 1 },
                { id: 'calendar', x: 0, y: 3, w: 4, h: 3 },
                { id: 'today', x: 0, y: 6, w: 2, h: 2 },
                { id: 'holidays', x: 2, y: 6, w: 2, h: 2 },
              ],
            },
          })
          tx.oncomplete = () => resolve()
          tx.onerror = () => reject(tx.error)
        }
        req.onerror = () => reject(req.error)
      })
  )
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(800)

  const after = await page.evaluate(() => {
    const rowStart = (id) => {
      const el = document.querySelector(`.hc[data-card="${id}"]`)
      if (!el) return null
      const m = /^(\d+)/.exec(el.style.gridRow || '')
      return m ? Number(m[1]) - 1 : null
    }
    return { quote: rowStart('quote'), stats: rowStart('stats'), calendar: rowStart('calendar') }
  })
  check('升级后日历紧贴统计卡（不留空行）', after.calendar === 2, `stats y${after.stats} / calendar y${after.calendar}`)

  const saved = await readLayout(page)
  check('升级后的布局已回写为 v3', !!saved && saved.v === 3, saved ? 'v=' + saved.v : '未写入')
  check(
    '回写的坐标也已压实',
    !!saved && (saved.items.find((i) => i.id === 'calendar') || {}).y === 2,
    JSON.stringify(saved && saved.items.map((i) => `${i.id}:${i.y}`))
  )
  check('升级过程无脚本错误', errors.length === 0, errors.slice(0, 3).join(' | '))
  await ctx.close()
}

// ---------- 9. 强提醒：到点弹窗 + 系统通知 ----------
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
      appVersion: () => '3.2.0',
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
  await dismissNickname(page, '强提醒')

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
