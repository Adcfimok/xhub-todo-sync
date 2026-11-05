import { chromium } from 'playwright'
const b = await chromium.launch({ channel: 'msedge' })
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true })
const p = await ctx.newPage()
const errs = []
p.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message))

await p.addInitScript(() => {
  window.__notified = []
  window.Android = {
    deviceName: () => 'Test Phone',
    readClipboard: () => '',
    writeClipboard: () => {},
    notify: (t, b) => window.__notified.push(t + ' | ' + b),
    vibrate: () => {},
    openUrl: () => {},
  }
})

await p.goto('http://127.0.0.1:8100/index.html', { waitUntil: 'networkidle' })
await p.waitForTimeout(800)

// 建三条待办：10 分钟后（应提醒）、2 小时后（不该）、已过期 3 小时（不该）
const res = await p.evaluate(async () => {
  const core = await import('/lib/core.js')
  const alerts = await import('/lib/alerts.js')
  const now = Date.now()
  const mk = (title, dueAt) => core.newRecord('todos', { title, dueAt, priority: 0, description: '' })
  mk('十分钟后开会', now + 10 * 60 * 1000)
  mk('两小时后交稿', now + 120 * 60 * 1000)
  mk('早已过期的事', now - 180 * 60 * 1000)
  await new Promise((r) => setTimeout(r, 200))
  alerts.sweepNow()
  await new Promise((r) => setTimeout(r, 1200))
  return window.__notified
})
console.log('[临期通知]', JSON.stringify(res))

// 再扫一次，确认不重复提醒
const again = await p.evaluate(async () => {
  const alerts = await import('/lib/alerts.js')
  alerts.sweepNow()
  await new Promise((r) => setTimeout(r, 600))
  return window.__notified.length
})
console.log('[二次扫描条数]', again)

// 关掉开关后不该再提醒
const off = await p.evaluate(async () => {
  const core = await import('/lib/core.js')
  const alerts = await import('/lib/alerts.js')
  await core.saveMeta('notifyTodo', '0')
  core.newRecord('todos', { title: '关闭后新增的十分钟任务', dueAt: Date.now() + 9 * 60 * 1000 })
  await new Promise((r) => setTimeout(r, 200))
  alerts.sweepNow()
  await new Promise((r) => setTimeout(r, 600))
  return window.__notified.length
})
console.log('[关闭开关后条数]', off)

console.log('errs:', errs.join('\n') || '(none)')
await b.close()
