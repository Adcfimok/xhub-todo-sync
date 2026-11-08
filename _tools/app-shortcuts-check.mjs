/**
 * 速达「手机应用 / 电脑同步」两个独立个体的端到端回归。
 *
 * 验证：两区数据隔离、真实系统图标（非统一占位）、点击拉起应用、
 *       小图标网格自动换行且不越界、PC 程序只读、新建表单不再有程序类型。
 *
 * 运行：node _tools/app-shortcuts-check.mjs
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
// 1×1 PNG：让「系统图标 URL」真的能加载，测试里断言的是 URL 来源而不是图片内容
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4//8/AwAI/AL+X6Q0ugAAAABJRU5ErkJggg==', 'base64')

let pass = 0, fail = 0
const failures = []
function check(name, ok, detail) {
  if (ok) { pass++; console.log('✓ ' + name + (detail ? ' — ' + detail : '')) }
  else { fail++; failures.push(name + (detail ? ' — ' + detail : '')); console.log('✗ ' + name + (detail ? ' — ' + detail : '')) }
}
function serve() {
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x')
    const p = u.pathname
    if (p.startsWith('/__appicon/')) {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': PNG.length })
      res.end(PNG)
      return
    }
    const rel = p === '/' ? '/index.html' : p
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

const APPS = [
  { pkg: 'com.tencent.mm', label: '微信', icon: '/__appicon/0001.png' },
  { pkg: 'com.eg.android.AlipayGphone', label: '支付宝', icon: '/__appicon/0002.png' },
  { pkg: 'com.tencent.mobileqq', label: 'QQ', icon: '/__appicon/0003.png' },
  { pkg: 'com.ss.android.ugc.aweme', label: '抖音', icon: '/__appicon/0004.png' },
  { pkg: 'com.baidu.BaiduMap', label: '百度地图', icon: '/__appicon/0005.png' },
  { pkg: 'com.autonavi.minimap', label: '高德地图', icon: '/__appicon/0006.png' },
  { pkg: 'com.netease.cloudmusic', label: '网易云音乐', icon: '/__appicon/0007.png' },
  { pkg: 'com.xingin.xhs', label: '小红书', icon: '/__appicon/0008.png' },
  { pkg: 'com.taobao.taobao', label: '淘宝', icon: '/__appicon/0009.png' },
  { pkg: 'com.jingdong.app.mall', label: '京东', icon: '/__appicon/0010.png' },
  { pkg: 'com.sina.weibo', label: '微博', icon: '/__appicon/0011.png' },
  { pkg: 'com.example.calendar', label: '日历', icon: '/__appicon/0012.png' },
]

const { srv, port } = await serve()
const browser = await chromium.launch({ channel: 'msedge' })
let ctx
try {
  ctx = await browser.newContext({ viewport: { width: 360, height: 740 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark' })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e.message || e)))
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/i.test(m.text())) errors.push(m.text()) })
  await page.addInitScript((apps) => {
    window.__launched = []
    window.Android = {
      originPort: () => 47830, appVersion: () => '3.7.0', deviceName: () => 'test',
      readClipboard: () => '', writeClipboard: () => {}, vibrate: () => {}, toast: () => {}, openUrl: () => {},
      installedApps: () => JSON.stringify(apps),
      appIconFor: (pkg) => '/__appicon/' + pkg + '.png',
      launchApp: (pkg) => { window.__launched.push(pkg); return true },
    }
  }, APPS)

  await page.goto('http://127.0.0.1:' + port + '/index.html', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(700)
  // 预置：跳过称呼弹窗 + 两条来自电脑同步的 resources 记录（网页 / PC 程序）
  await page.evaluate(async () => {
    await new Promise((resolve, reject) => {
      const req = indexedDB.open('todolink', 2)
      req.onsuccess = () => {
        const db = req.result
        const tx = db.transaction(['meta', 'records'], 'readwrite')
        tx.objectStore('meta').put({ k: 'nickname', v: '测试员' })
        const now = Date.now()
        const base = { deleted: false, dirty: 0, hlc: '000001a1ab3437a9-0000-d750', updatedAt: now, createdAt: now, hostId: 1 }
        tx.objectStore('records').put(Object.assign({}, base, { id: 'resources:h1', col: 'resources', title: 'GitHub', name: 'GitHub', kind: 'web', target: 'https://github.com' }))
        tx.objectStore('records').put(Object.assign({}, base, { id: 'resources:h3', col: 'resources', title: 'VS Code', name: 'VS Code', kind: 'app', target: 'code.exe' }))
        tx.oncomplete = resolve
        tx.onerror = () => reject(tx.error)
      }
      req.onerror = () => reject(req.error)
    })
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(800)
  await page.evaluate(() => (location.hash = '#/resources'))
  await page.waitForTimeout(300)

  // ---------- 1. 两个个体：默认手机应用，PC 数据不串进来 ----------
  const tabs = await page.locator('.res-tab').allTextContents()
  check('速达有两个独立分区', tabs.length === 2 && /手机应用/.test(tabs[0]) && /电脑同步/.test(tabs[1]), JSON.stringify(tabs))
  check('默认停在「手机应用」', (await page.locator('.res-tab.on').textContent()).includes('手机应用'))
  const phoneText = await page.textContent('.res-scroll')
  check('PC 同步的 VS Code / GitHub 不出现在手机应用区', !/VS Code|GitHub/.test(phoneText))
  check('手机应用区明确标注不与电脑同步', /不与电脑同步/.test(phoneText))

  // ---------- 2. 添加应用：列表用系统真实图标 ----------
  await page.click('.res-section .btn.mini')
  await page.waitForTimeout(180)
  check('添加应用选择器打开', (await page.locator('.app-pick-panel').count()) === 1)
  const rows = await page.locator('.app-pick-row').count()
  check('列出本机已安装应用', rows === APPS.length, String(rows))
  const pickIcon = await page.locator('.app-pick-row img').first().getAttribute('src')
  check('候选应用图标是系统图标 URL，不是统一占位', /^\/__appicon\//.test(pickIcon || ''), pickIcon)
  check('不同应用图标 URL 不同', (await page.locator('.app-pick-row img').nth(1).getAttribute('src')) !== pickIcon)

  // 逐个添加（选完会关闭面板，需重开）
  async function addOne(i) {
    if ((await page.locator('.app-pick-panel').count()) === 0) {
      await page.click('.res-section .btn.mini')
      await page.waitForTimeout(120)
    }
    await page.locator('.app-pick-row').nth(i).click()
    await page.waitForTimeout(110)
  }
  await addOne(0)
  check('添加后网格出现 1 个小图标', (await page.locator('.app-tile').count()) === 1)
  const tileIcon = await page.locator('.app-tile img').first().getAttribute('src')
  check('已添加应用沿用系统真实图标', tileIcon === APPS[0].icon, String(tileIcon))
  check('图标不是字母占位', (await page.locator('.app-fallback').count()) === 0)

  // ---------- 3. 点击图标拉起应用 ----------
  await page.locator('.app-tile .app-btn').first().click()
  await page.waitForTimeout(120)
  const launched = await page.evaluate(() => window.__launched)
  check('点图标调用原生启动且包名正确', launched.length === 1 && launched[0] === APPS[0].pkg, JSON.stringify(launched))

  // ---------- 4. 图标网格：自动换行、不越界 ----------
  for (let i = 1; i < APPS.length; i++) await addOne(i)
  const geo = await page.evaluate(() => {
    const grid = document.querySelector('.app-grid')
    const gr = grid.getBoundingClientRect()
    const tiles = [...document.querySelectorAll('.app-tile')]
    const tops = [...new Set(tiles.map((t) => Math.round(t.getBoundingClientRect().top)))]
    const overflow = tiles.filter((t) => {
      const r = t.getBoundingClientRect()
      return r.left < gr.left - 1 || r.right > gr.right + 1
    }).length
    const scroll = document.querySelector('.res-scroll').getBoundingClientRect()
    return { count: tiles.length, rows: tops.length, overflow, gridRight: gr.right, scrollRight: scroll.right }
  })
  check('12 个应用全部落入网格', geo.count === APPS.length, String(geo.count))
  check('超出一行时自动换行', geo.rows >= 2, '行数 ' + geo.rows)
  check('所有图标都不超出页面边界', geo.overflow === 0 && geo.gridRight <= geo.scrollRight + 1, JSON.stringify(geo))

  // ---------- 5. 数据隔离：手机应用只写 meta，不写 records ----------
  const store = await page.evaluate(() => new Promise((resolve) => {
    const req = indexedDB.open('todolink', 2)
    req.onsuccess = () => {
      const tx = req.result.transaction(['meta', 'records'], 'readonly')
      const m = tx.objectStore('meta').get('phoneApps')
      const r = tx.objectStore('records').getAll()
      tx.oncomplete = () => resolve({ apps: m.result ? m.result.v.length : -1, records: r.result.length, pc: r.result.filter((x) => x.col === 'resources').length })
    }
  }))
  check('手机应用存在 meta.phoneApps', store.apps === APPS.length, JSON.stringify(store))
  check('没有往同步 records 里写任何应用', store.records === 2 && store.pc === 2, JSON.stringify(store))

  // ---------- 6. 移除手机应用不影响 PC 数据 ----------
  await page.locator('.app-tile .app-del').first().click()
  await page.waitForTimeout(120)
  check('移除前有确认提示', /从速达移除/.test(await page.textContent('.modal-text')))
  await page.click('.modal-btns .btn.danger')
  await page.waitForTimeout(160)
  check('移除后图标少一个', (await page.locator('.app-tile').count()) === APPS.length - 1)
  const pcCountAfter = await page.evaluate(() => new Promise((resolve) => {
    const req = indexedDB.open('todolink', 2)
    req.onsuccess = () => {
      const rq = req.result.transaction('records', 'readonly').objectStore('records').getAll()
      rq.onsuccess = () => resolve(rq.result.filter((x) => x.col === 'resources').length)
    }
  }))
  check('移除手机应用不影响电脑同步数据', pcCountAfter === 2, String(pcCountAfter))

  // ---------- 7. PC 端程序：只读，取消原有打开方案 ----------
  await page.locator('.res-tab').nth(1).click()
  await page.waitForTimeout(200)
  const pcText = await page.textContent('.res-scroll')
  check('电脑同步分区展示 PC 程序与网页', /VS Code/.test(pcText) && /GitHub/.test(pcText))
  check('PC 程序标注「电脑端 · 只读」语义', /只读/.test(pcText))
  check('PC 程序是不可点击的只读卡片', (await page.locator('.res-readonly').count()) === 1)
  check('PC 程序没有编辑入口', (await page.locator('.res-readonly').first().locator('..').locator('.res-more').count()) === 0)
  check('网页入口仍可打开', (await page.locator('.res-item button.res').count()) === 1)

  // ---------- 8. 新建表单不再提供「程序」类型 ----------
  await page.click('.filterbar .add-btn')
  await page.waitForTimeout(180)
  const formText = await page.textContent('#sheet')
  check('新建表单只有网页入口', /网页/.test(formText) && !/程序|文件/.test(formText))
  check('新建表单没有类型下拉', (await page.locator('#sheet-body select').count()) === 0)
  await page.click('#btn-cancel')

  check('全程无脚本错误', errors.length === 0, errors.slice(0, 2).join(' | '))
} finally {
  if (ctx) await ctx.close()
  await browser.close()
  srv.close()
}
console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
if (fail) { failures.forEach((f) => console.error(' - ' + f)); process.exit(1) }
