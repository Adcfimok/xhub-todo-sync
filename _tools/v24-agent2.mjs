import { chromium } from 'playwright'

const b = await chromium.launch({ channel: 'msedge' })
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
const p = await ctx.newPage()
const errs = []
p.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message))

await p.addInitScript(() => {
  window.Android = { deviceName: () => 'T', readClipboard: () => '', writeClipboard: () => {}, notify: () => {}, vibrate: () => {}, openUrl: () => {} }
})

await p.goto('http://127.0.0.1:8100/index.html', { waitUntil: 'networkidle' })
await p.waitForTimeout(700)

// 预置模型配置
await p.evaluate(async () => {
  const m = await import('/lib/core.js')
  await m.saveMeta('aiBase', 'http://127.0.0.1:48999/v1')
  await m.saveMeta('aiModel', 'mock-agent')
  await m.saveMeta('aiKey', 'sk-mock')
  await m.saveMeta('aiPlatform', '')
})
await p.evaluate(() => (location.hash = '#/ai'))
await p.waitForTimeout(600)

// 1. 建一条待办
await p.fill('.chat-input', '帮我建一条明天下午三点的待办，标题是交房租')
await p.click('.send-btn')
await p.waitForTimeout(2600)
console.log('[建]', await p.evaluate(() => [...document.querySelectorAll('.tool-chip')].map((x) => x.textContent)))

// 2. 标成紧急
await p.fill('.chat-input', '把交房租标成紧急')
await p.click('.send-btn')
await p.waitForTimeout(2600)
console.log('[改]', await p.evaluate(async () => {
  const m = await import('/lib/core.js')
  const t = m.colRecords('todos')[0]
  return { chips: [...document.querySelectorAll('.tool-chip')].map((x) => x.textContent), pri: t && t.priority }
}))

// 3. 删除（会弹确认）
await p.fill('.chat-input', '删掉交房租')
await p.click('.send-btn')
await p.waitForTimeout(1800)
const confirmShown = await p.evaluate(() => {
  const m = document.querySelector('.modal')
  return m ? m.textContent : null
})
console.log('[删除确认框]', confirmShown)
await p.screenshot({ path: 'v24-6-confirm.png' })
await p.click('.modal .btn.danger')
await p.waitForTimeout(2200)
console.log('[删]', await p.evaluate(async () => {
  const m = await import('/lib/core.js')
  return {
    chips: [...document.querySelectorAll('.tool-chip')].map((x) => x.textContent),
    alive: m.colRecords('todos').length,
    tomb: m.S.records.filter((r) => r.col === 'todos' && r.deleted).length,
  }
}))
await p.screenshot({ path: 'v24-7-deleted.png' })

// 4. 拒绝删除时不该动手
await p.fill('.chat-input', '删掉第二条')
await p.click('.send-btn')
await p.waitForTimeout(1600)
const before = await p.evaluate(async () => (await import('/lib/core.js')).colRecords('todos').length)
if (await p.locator('.modal').count()) {
  await p.click('.modal .btn:not(.danger)')
}
await p.waitForTimeout(1800)
console.log('[拒绝删除]', { before, after: await p.evaluate(async () => (await import('/lib/core.js')).colRecords('todos').length) }, await p.evaluate(() => [...document.querySelectorAll('.tool-chip')].map((x) => x.textContent)))

console.log('errs:', errs.join('\n') || '(none)')
await b.close()
