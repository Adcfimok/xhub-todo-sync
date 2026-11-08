/**
 * 3.2.0 底栏手势与引号 / 教务入口回归。
 *
 * 用真实 pointer 事件（Playwright mouse 会派发 pointerdown/move/up）走一遍：
 *   - 拖拽跟手、松手立即把高亮块送到目标格（不先弹回再跳）
 *   - 手势切页不叠加点按脉冲、拖拽期关闭背景模糊（窗口闪动的两个根因）
 *   - 轻扫灵敏度、切页后滚动位置保持
 *   - 每日一句引号成对、教务一键导入不再是占位框架
 *
 * 运行：node _tools/tab-gesture-check.mjs
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

/** 从底栏左侧第 1 格起手，横向拖 dx 像素；stepGap 控制事件间隔以模拟慢拖 / 轻扫 */
async function drag(page, dx, stepGap) {
  const box = await page.locator('#tabbar').boundingBox()
  const x = box.x + box.width * 0.16
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  const n = 6
  for (let i = 1; i <= n; i++) {
    await page.mouse.move(x + (dx * i) / n, y)
    if (stepGap) await page.waitForTimeout(stepGap)
  }
  return page.mouse.up()
}

const state = (page) =>
  page.evaluate(() => {
    const bar = document.getElementById('tabbar')
    const inner = bar.querySelector('.tab-indicator > i')
    const cs = getComputedStyle(inner)
    return {
      tabI: bar.style.getPropertyValue('--tab-i').trim(),
      drag: bar.style.getPropertyValue('--drag').trim(),
      dragging: bar.classList.contains('dragging'),
      snapping: bar.classList.contains('snapping'),
      switching: bar.classList.contains('switching'),
      innerFilter: cs.backdropFilter || cs.webkitBackdropFilter || 'none',
      barFilter: getComputedStyle(bar).backdropFilter || getComputedStyle(bar).webkitBackdropFilter || 'none',
      hash: location.hash,
      scrollTop: document.querySelector('#page .scroll') ? document.querySelector('#page .scroll').scrollTop : -1,
    }
  })

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
      appVersion: () => '3.4.0',
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
  // 首次启动的强制称呼弹窗
  try {
    await page.waitForSelector('.nick-gate', { timeout: 4000 })
    await page.fill('.nick-input', '测试员')
    await page.click('.nick-save')
    await page.waitForTimeout(350)
  } catch (e) {
    /* 已有本地数据时不会弹 */
  }

  // ---------- 1. 闪动根因：模糊层只在合成层之外保留一份 ----------
  const init = await state(page)
  check('初始高亮块落在首页格', init.tabI === '0', `--tab-i=${init.tabI}`)
  check('高亮块内层不再有 backdrop-filter（拖动时不重采样背景）', init.innerFilter === 'none', `filter=${init.innerFilter}`)

  // ---------- 2. 拖拽跟手 ----------
  const box = await page.locator('#tabbar').boundingBox()
  const x = box.x + box.width * 0.16
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + 8, y) // 8px 就能起手（旧阈值 6px，现 3px）
  await page.waitForTimeout(40)
  const during = await state(page)
  check('起手 8px 即进入拖拽', during.dragging === true)
  check('拖拽位移已写入 --drag', parseFloat(during.drag) > 0, `--drag=${during.drag}`)
  check('拖拽期间胶囊背景模糊关闭', during.barFilter === 'none', `filter=${during.barFilter}`)
  for (let i = 2; i <= 6; i++) {
    await page.mouse.move(x + (90 * i) / 6, y)
    await page.waitForTimeout(18)
  }
  await page.mouse.up()

  // ---------- 3. 松手立即吸附，不等 hashchange ----------
  const snapped = await state(page)
  check('松手瞬间 --tab-i 已送到目标格（不先弹回再跳）', snapped.tabI === '1', `--tab-i=${snapped.tabI}`)
  check('吸附期带弹性过渡', snapped.snapping === true)
  check('手势切页不叠加点按脉冲', snapped.switching === false)
  await page.waitForTimeout(260)
  const after = await state(page)
  check('路由切到待办页', after.hash === '#/todos', after.hash)
  check('高亮块最终停在待办格', after.tabI === '1', `--tab-i=${after.tabI}`)

  // ---------- 4. 滚动位置保持 ----------
  await page.evaluate(() => (location.hash = '#/home'))
  await page.waitForTimeout(240)
  await page.evaluate(() => {
    const s = document.querySelector('#page .scroll')
    if (s) s.scrollTop = 120
  })
  await drag(page, 90, 18)
  await page.waitForTimeout(240)
  const onTodos = await state(page)
  check('从首页拖到待办页', onTodos.hash === '#/todos', onTodos.hash)
  await drag(page, -90, 18)
  await page.waitForTimeout(260)
  const backHome = await state(page)
  check('拖回首页', backHome.hash === '#/home', backHome.hash)
  check('切回首页时滚动位置还原', Math.abs(backHome.scrollTop - 120) <= 2, `scrollTop=${backHome.scrollTop}`)

  // ---------- 5. 轻扫灵敏度 ----------
  await drag(page, 26, 0) // 快速轻扫，只有 26px 位移
  await page.waitForTimeout(260)
  const flicked = await state(page)
  check('26px 快速轻扫也能翻一格', flicked.tabI === '1', `--tab-i=${flicked.tabI}`)

  // ---------- 6. 每日一句引号成对 ----------
  const marks = await page.evaluate(() => {
    const el = document.querySelector('.hc[data-card="quote"]')
    if (!el) return []
    return [...el.querySelectorAll('.hq-mark')].map((x) => x.textContent.trim())
  })
  await page.evaluate(() => (location.hash = '#/home'))
  await page.waitForTimeout(240)
  const marks2 = await page.evaluate(() => [...document.querySelectorAll('.hc[data-card="quote"] .hq-mark')].map((x) => x.textContent.trim()))
  check('每日一句左右引号成对', marks2.length === 2 && marks2[0] === '“' && marks2[1] === '”', JSON.stringify(marks2.length ? marks2 : marks))

  // ---------- 7. 教务一键导入不再是占位框架 ----------
  await page.evaluate(() => (location.hash = '#/timetable'))
  await page.waitForTimeout(300)
  await page.click('.act-grid .btn:nth-child(2)') // 「导入」
  await page.waitForTimeout(200)
  const opts = await page.evaluate(() => [...document.querySelectorAll('.imp-opt b')].map((x) => x.textContent))
  check('导入选项包含「教务系统一键导入」', opts.includes('教务系统一键导入'), JSON.stringify(opts))
  await page.click('.imp-opt:first-child')
  await page.waitForTimeout(200)
  const edu = await page.evaluate(() => {
    const card = [...document.querySelectorAll('.lib-card')].pop()
    return {
      text: card ? card.textContent : '',
      hasUrl: !!(card && card.querySelector('input[type="url"]')),
      chips: card ? card.querySelectorAll('.edu-chip').length : 0,
    }
  })
  check('教务弹窗有网址输入框', edu.hasUrl)
  check('教务弹窗内置教务类型选项', edu.chips >= 5, `${edu.chips} 个`)
  check('教务弹窗不再写「暂未内置」', !edu.text.includes('暂未内置') && edu.text.includes('打开教务系统'))
  check('教务弹窗说明账号密码不经过本 App', edu.text.includes('不读取'))

  check('全程无脚本错误', errors.length === 0, errors.slice(0, 2).join(' | '))
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
