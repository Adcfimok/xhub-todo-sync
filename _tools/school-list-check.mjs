/**
 * 内置学校列表端到端回归：教务导入弹窗 → 学校选择器 → 搜索 / 翻页 / 自动填网址。
 *
 * 运行：node _tools/school-list-check.mjs
 * 数据可追溯复核：node _tools/extract-wakeup-schools.mjs --check
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
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json',
}
let pass = 0, fail = 0
const failures = []
function check(name, ok, detail) {
  if (ok) { pass++; console.log('✓ ' + name + (detail ? ' — ' + detail : '')) }
  else { fail++; failures.push(name + (detail ? ' — ' + detail : '')); console.log('✗ ' + name + (detail ? ' — ' + detail : '')) }
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
    } catch (e) { res.writeHead(404).end('not found') }
  })
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port })))
}

const { srv, port } = await serve()
const browser = await chromium.launch({ channel: 'msedge' })
let ctx
try {
  ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark' })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e.message || e)))
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/i.test(m.text())) errors.push(m.text()) })
  await page.addInitScript(() => {
    window.Android = {
      originPort: () => 47830, appVersion: () => '3.7.0', deviceName: () => 'test',
      readClipboard: () => '', writeClipboard: () => {}, vibrate: () => {}, toast: () => {}, openUrl: () => {},
    }
  })
  await page.goto('http://127.0.0.1:' + port + '/index.html', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(700)
  try {
    await page.waitForSelector('.nick-gate', { timeout: 4000 })
    await page.fill('.nick-input', '测试员')
    await page.click('.nick-save')
    await page.waitForTimeout(350)
  } catch (e) { /* 已有数据 */ }

  await page.evaluate(() => (location.hash = '#/timetable'))
  await page.waitForTimeout(300)
  await page.click('.act-grid .btn:nth-child(2)')
  await page.waitForTimeout(180)
  await page.locator('.imp-opt', { hasText: '教务系统一键导入' }).click()
  await page.waitForTimeout(180)

  const btnText = await page.textContent('.school-pick-btn')
  check('教务弹窗提供「从学校列表选择」入口', /学校列表选择/.test(btnText), btnText)
  check('入口标明带网址的学校数量', /3091/.test(btnText), btnText)
  const srcText = await page.textContent('.lib-card')
  check('弹窗注明数据来自 WakeUp课程表 6.5.2', /WakeUp课程表 6\.5\.2/.test(srcText))
  check('弹窗注明共 3570 条', /3570/.test(srcText))

  await page.click('.school-pick-btn')
  await page.waitForTimeout(220)
  check('学校选择器打开', (await page.locator('.school-panel').count()) === 1)
  const cnt = await page.textContent('.school-count')
  check('默认列出 3091 所带网址学校', /3091/.test(cnt), cnt)
  const first = await page.locator('.school-row').count()
  check('首屏只渲染 60 条（3570 条不一次铺开）', first === 60, String(first))

  await page.click('.school-panel .btn.block')
  await page.waitForTimeout(180)
  const second = await page.locator('.school-row').count()
  check('「加载更多」再追加 60 条', second === 120, String(second))

  await page.fill('.school-search', '北京大学')
  await page.waitForTimeout(180)
  const hits = await page.locator('.school-row').count()
  check('搜索「北京大学」有结果', hits > 0, String(hits))
  const firstName = await page.locator('.school-row b').first().textContent()
  check('结果首条是北京大学的条目', /北京大学/.test(firstName), firstName)

  await page.locator('.school-row').first().click()
  await page.waitForTimeout(180)
  check('选完学校后选择器关闭', (await page.locator('.school-panel').count()) === 0)
  const urlVal = await page.inputValue('.lib-card input[type="url"]')
  check('教务网址自动填入输入框', /^https?:\/\//.test(urlVal), urlVal)
  const hintText = await page.textContent('.lib-card .lib-hint:nth-of-type(2)').catch(() => '')
  const cardText = await page.textContent('.lib-card')
  check('弹窗提示已选学校与教务类型', /已选「/.test(cardText) && /教务类型/.test(cardText), hintText.slice(0, 60))

  // 多行备选网址的学校：只取第一行
  await page.click('.school-pick-btn')
  await page.waitForTimeout(180)
  await page.fill('.school-search', '河南工业和信息化职业学院')
  await page.waitForTimeout(180)
  await page.locator('.school-row').first().click()
  await page.waitForTimeout(150)
  const multiUrl = await page.inputValue('.lib-card input[type="url"]')
  check('多备选网址只取第一行且不含换行', !/[\r\n]/.test(multiUrl) && /^https?:\/\//.test(multiUrl), multiUrl)

  // 源数据里「成都东软学院」的网址字段是「是」这类脏值：不该塞进地址栏
  await page.click('.school-pick-btn')
  await page.waitForTimeout(180)
  await page.fill('.school-search', '成都东软学院')
  await page.waitForTimeout(180)
  await page.locator('.school-row').first().click()
  await page.waitForTimeout(150)
  const badUrl = await page.inputValue('.lib-card input[type="url"]')
  const badText = await page.textContent('.lib-card')
  check('源数据脏网址不会填进地址栏', badUrl === '', JSON.stringify(badUrl))
  check('提示用户手动填写网址', /手动填写学校教务网址/.test(badText))

  check('全程无脚本错误', errors.length === 0, errors.slice(0, 2).join(' | '))
} finally {
  if (ctx) await ctx.close()
  await browser.close()
  srv.close()
}
console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
if (fail) { failures.forEach((f) => console.error(' - ' + f)); process.exit(1) }
