/**
 * 通知链路端到端回归（浏览器里跑真实页面 + 模拟原生桥）。
 *
 * 覆盖这次修复的四个点：
 *   1) 计划全量下发（不再只给 3 条）           → setAlarms 收到的条目数
 *   2) 关掉提醒时真的把闹钟撤掉                 → cancelAlarms 被调用
 *   3) 原生日志对账：已经在后台响过的不再重复弹 → notifiedMap + 无弹窗
 *   4) 关机期间错过的（late）在 12 小时内补发   → 弹窗带「补发」
 * 外加设置页「通知自检」的四行状态与三个补救按钮。
 *
 * 运行：node _tools/notify-check.mjs
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
  const tail = detail ? ' — ' + detail : ''
  if (ok) {
    pass++
    console.log('✓ ' + name + tail)
  } else {
    fail++
    failures.push(name + tail)
    console.log('✗ ' + name + tail)
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

/** 模拟原生桥：记录调用，状态可随时改 */
function bridge() {
  window.__calls = []
  window.__alarms = []
  window.__notifies = []
  window.__state = {
    exact: true,
    notify: true,
    channel: true,
    plan: 3,
    armed: 3,
    next: Date.now() + 3600000,
    lastFire: Date.now() - 60000,
    lastDelay: 420,
  }
  window.Android = {
    originPort: () => 47830,
    appVersion: () => '3.8.0',
    deviceName: () => 'test',
    readClipboard: () => '',
    writeClipboard: () => {},
    vibrate: () => {},
    toast: () => {},
    openUrl: () => {},
    notify: (t, b) => window.__notifies.push([t, b]),
    setAlarms: (json) => window.__alarms.push(JSON.parse(json)),
    cancelAlarms: () => {
      window.__calls.push('cancelAlarms')
      window.__alarms.push([])
    },
    takeAlarmEvents: () => JSON.stringify(window.__events || []),
    alarmState: () => JSON.stringify(Object.assign({ ok: true }, window.__state)),
    testAlarm: (s) => window.__calls.push('testAlarm:' + s),
    openExactAlarmSettings: () => window.__calls.push('exact'),
    openNotificationSettings: () => window.__calls.push('notif'),
    requestNotifyPermission: () => window.__calls.push('reqperm'),
  }
}

/** 预置待办：page.evaluate 里跑，参数是待办数组 */
function seedTodos(list) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('todolink', 2)
    req.onsuccess = () => {
      const db = req.result
      const tx = db.transaction(['meta', 'records'], 'readwrite')
      tx.objectStore('meta').put({ k: 'nickname', v: '测试员' })
      const now = Date.now()
      const base = { deleted: false, dirty: 0, hlc: '000001a1ab3437a9-0000-d750', updatedAt: now, createdAt: now, hostId: 1 }
      for (const t of list) {
        tx.objectStore('records').put(Object.assign({}, base, { col: 'todos', done: false }, t))
      }
      tx.oncomplete = resolve
      tx.onerror = () => reject(tx.error)
    }
    req.onerror = () => reject(req.error)
  })
}

async function readMeta(page, key) {
  return page.evaluate(
    (k) =>
      new Promise((resolve) => {
        const req = indexedDB.open('todolink', 2)
        req.onsuccess = () => {
          const db = req.result
          const tx = db.transaction(['meta'], 'readonly')
          const g = tx.objectStore('meta').get(k)
          g.onsuccess = () => resolve(g.result ? g.result.v : null)
          g.onerror = () => resolve(null)
        }
        req.onerror = () => resolve(null)
      }),
    key
  )
}

const MIN = 60 * 1000
const { srv, port } = await serve()
const browser = await chromium.launch({ channel: 'msedge' })

try {
  // ============================================================ 场景 1：计划全量下发 + 对账 + 自检面板
  {
    const ctx = await browser.newContext({ viewport: { width: 360, height: 760 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark' })
    const page = await ctx.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(String(e.message || e)))
    page.on('console', (m) => {
      if (m.type() === 'error' && !/Failed to load resource/i.test(m.text())) errors.push(m.text())
    })
    await page.addInitScript(bridge)
    await page.goto('http://127.0.0.1:' + port + '/index.html', { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(500)

    const now = Date.now()
    const firedAt = now - 60 * 1000
    // 记录 id 与真实一致（`todos:<uuid 片段>`），原生 tag 会在前面再加 `todo-`
    const X = 'todos:ax'
    // 5 条未来待办：老实现只会下发前 3 条
    await page.evaluate(seedTodos, [
      { id: 'todos:a1', title: '写周报', remindAt: now + 10 * MIN },
      { id: 'todos:a2', title: '回邮件', remindAt: now + 20 * MIN },
      { id: 'todos:a3', title: '交材料', remindAt: now + 30 * MIN },
      { id: 'todos:a4', title: '取快递', remindAt: now + 40 * MIN },
      { id: 'todos:a5', title: '开会', remindAt: now + 50 * MIN },
      { id: X, title: '喝水', remindAt: firedAt }, // 已在后台由原生响过
    ])
    // 原生回报：喝水这条已经弹过通知（late=false）。用 initScript 注入，
    // 这样每次导航都会在页面脚本之前就绪（普通 evaluate 会被 reload 清掉）
    await page.addInitScript(
      (ev) => {
        window.__events = ev
      },
      [{ tag: 'todo-' + X, at: firedAt, ts: firedAt + 800, late: false }]
    )
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(900)

    const plans = await page.evaluate(() => window.__alarms)
    const full = plans.filter((p) => p.length === 5).pop()
    check('下发完整计划而不是只给 3 条', !!full, '历次下发条数 ' + JSON.stringify(plans.map((p) => p.length)))
    const plan = full || []
    check(
      '每条都带原生去重用的 tag',
      plan.length > 0 && plan.every((p) => /^todo-/.test(p.tag)),
      plan.map((p) => p.tag).join(',')
    )
    check('计划按时间升序', plan.every((p, i) => i === 0 || plan[i - 1].at <= p.at))
    check('已到点的那条不进计划（交给补发逻辑）', !plan.some((p) => p.tag === 'todo-' + X))

    // 对账：原生响过的写进 notifiedMap，页面不再重复弹
    const notified = await readMeta(page, 'notifiedMap')
    check('原生已响过的提醒写进 notifiedMap', !!(notified && notified[X + '@' + firedAt]))
    await page.waitForTimeout(4200) // 等首次 sweep（4 秒）跑完
    check('对账后不再重复弹窗', (await page.locator('.remind-card').count()) === 0)
    check(
      '也不再重复发系统通知',
      (await page.evaluate(() => window.__notifies.filter((n) => /喝水/.test(n[0])).length)) === 0
    )

    // ---------- 设置页：通知自检
    await page.evaluate(() => (location.hash = '#/settings'))
    await page.waitForTimeout(400)
    check('设置页有「通知自检」区块', (await page.locator('.self-check').count()) === 1)
    const rowNames = await page.locator('.self-check .check-name').allTextContents()
    check(
      '自检四行：权限 / 精确闹钟 / 渠道 / 已排',
      rowNames.slice(0, 4).join(',') === '通知权限,精确闹钟,提醒渠道,已排提醒',
      rowNames.join(',')
    )
    check('全部正常时指示灯为绿', (await page.locator('.self-check .check-dot[data-ok="1"]').count()) >= 4)
    check('全部正常时不出现补救按钮', (await page.locator('.self-check .mini').count()) === 0)
    const armedText = await page.locator('.self-check .check-val').nth(3).textContent()
    check('已排提醒显示下一条时间', /3 条.*下一条/.test(armedText || ''), armedText)
    const lastText = await page.locator('.self-check .check-val').nth(4).textContent()
    check('显示上次提醒的实测延迟', /延迟 晚 420 毫秒/.test(lastText || ''), lastText)

    await page.locator('.self-check .check-actions .btn').click()
    await page.waitForTimeout(150)
    check(
      '「10 秒后测试提醒」调用原生 testAlarm(10)',
      (await page.evaluate(() => window.__calls)).includes('testAlarm:10')
    )

    // ---------- 异常态：三项为否 → 出现补救入口
    await page.evaluate(() => {
      window.__state = Object.assign({}, window.__state, { notify: false, exact: false, channel: false })
    })
    await page.evaluate(() => (location.hash = '#/home'))
    await page.waitForTimeout(250)
    await page.evaluate(() => (location.hash = '#/settings'))
    await page.waitForTimeout(400)
    check('未开启时出现 3 个补救按钮', (await page.locator('.self-check .mini').count()) === 3)
    check('异常项文案点明后果', /收不到任何通知/.test(await page.textContent('.self-check')))
    await page.locator('.self-check .check-row').nth(0).locator('.mini').click()
    await page.waitForTimeout(150)
    check('「去开启」优先走运行时权限申请', (await page.evaluate(() => window.__calls)).includes('reqperm'))
    await page.locator('.self-check .check-row').nth(1).locator('.mini').click()
    await page.waitForTimeout(150)
    check('「去允许」跳精确闹钟设置页', (await page.evaluate(() => window.__calls)).includes('exact'))

    // ---------- 关掉提醒开关 → 撤掉系统闹钟
    await page.evaluate(() => (window.__alarms.length = 0))
    await page.locator('.card:has-text("待办临期提醒") .toggle input').click()
    await page.waitForTimeout(600)
    check('关闭提醒开关会撤掉已排闹钟', (await page.evaluate(() => window.__calls)).includes('cancelAlarms'))
    const after = await page.evaluate(() => window.__alarms[window.__alarms.length - 1])
    check('撤销后计划为空', Array.isArray(after) && after.length === 0, JSON.stringify(after))

    check('整个流程无 JS 报错', errors.length === 0, errors.join(' | '))
    await ctx.close()
  }

  // ============================================================ 场景 2：关机期间错过的提醒要补发
  {
    const ctx = await browser.newContext({ viewport: { width: 360, height: 760 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark' })
    const page = await ctx.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(String(e.message || e)))
    await page.addInitScript(bridge)
    await page.goto('http://127.0.0.1:' + port + '/index.html', { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(500)

    const lateAt = Date.now() - 2 * 3600 * 1000 // 2 小时前：超过 15 分钟常规宽限，但在 12 小时补发窗口内
    const Y = 'todos:ay'
    await page.evaluate(seedTodos, [{ id: Y, title: '交房租', remindAt: lateAt }])
    await page.addInitScript(
      (ev) => {
        window.__events = ev
      },
      [{ tag: 'todo-' + Y, at: lateAt, ts: lateAt, late: true }]
    )
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(5200)

    check('关机期间错过的提醒会补发', (await page.locator('.remind-card').count()) === 1)
    const sub = await page.textContent('.remind-card .remind-s')
    check('补发的提醒明确标注「补发」', /补发/.test(sub || ''), sub)
    check('补发同时发一条系统通知', (await page.evaluate(() => window.__notifies.length)) >= 1)
    const map = await readMeta(page, 'notifiedMap')
    check('补发后写入 notifiedMap，不会重复', !!(map && map[Y + '@' + lateAt]))
    check('场景 2 无 JS 报错', errors.length === 0, errors.join(' | '))
    await ctx.close()
  }

  // ============================================================ 场景 3：空计划不能当成"取消全部提醒"
  // 回归：锁屏 / 切后台都会触发 scheduleAlarms()。此时若算出的计划为空，
  // 老实现调用 cancelAlarms() → 原生 clearPlan() → 把「通知自检」这类原生独有条目
  // 连同整份计划一起撤掉，于是「点自检 → 锁屏 → 到点什么都不响」。
  {
    const ctx = await browser.newContext({ viewport: { width: 360, height: 760 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark' })
    const page = await ctx.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(String(e.message || e)))
    await page.addInitScript(bridge)
    await page.goto('http://127.0.0.1:' + port + '/index.html', { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(900)
    await page.waitForFunction(() => typeof window.__flushAlarms === 'function', null, { timeout: 4000 }).catch(() => {})

    check('原生 onPause 的 flush 钩子已挂上', await page.evaluate(() => typeof window.__flushAlarms === 'function'))

    // 没有任何待办 → 计划必然为空；模拟息屏时原生发起的 flush
    await page.evaluate(() => {
      window.__calls.length = 0
      window.__alarms.length = 0
      window.__flushAlarms()
    })
    await page.waitForTimeout(200)

    const calls = await page.evaluate(() => window.__calls)
    const plans = await page.evaluate(() => window.__alarms)
    check('空计划不再调用 cancelAlarms（否则会撤掉原生自检提醒）', !calls.includes('cancelAlarms'), calls.join(',') || '(无调用)')
    check(
      '空计划改为下发 setAlarms([])，由原生按差量撤槽位',
      plans.some((p) => Array.isArray(p) && p.length === 0),
      JSON.stringify(plans)
    )
    check('场景 3 无 JS 报错', errors.length === 0, errors.join(' | '))
    await ctx.close()
  }
} finally {
  await browser.close()
  srv.close()
}

console.log('\n' + pass + '/' + (pass + fail) + ' ok' + (fail ? ' · 失败：\n - ' + failures.join('\n - ') : ''))
process.exit(fail ? 1 : 0)
