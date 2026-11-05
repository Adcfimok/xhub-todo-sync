import { chromium } from 'playwright'
const b = await chromium.launch({ channel: 'msedge' })
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true })
const p = await ctx.newPage()
p.on('pageerror', (e) => console.log('[pageerror]', e.message))
await p.addInitScript(() => {
  window.Android = { deviceName: () => 'T', readClipboard: () => '', writeClipboard: () => {}, notify: () => {}, vibrate: () => {}, openUrl: () => {} }
})
await p.goto('http://127.0.0.1:8100/index.html', { waitUntil: 'networkidle' })
await p.waitForTimeout(700)
await p.evaluate(async () => {
  const m = await import('/lib/core.js')
  await m.saveMeta('aiBase', 'http://127.0.0.1:48999/v1')
  await m.saveMeta('aiModel', 'mock-agent')
  await m.saveMeta('aiKey', 'sk-mock')
  await m.saveMeta('aiPlatform', '')
  m.newRecord('todos', { title: '交房租', dueAt: Date.now() + 86400000, priority: 0, description: '' })
})
await p.evaluate(() => (location.hash = '#/ai'))
await p.waitForTimeout(600)

await p.fill('.chat-input', '删掉交房租')
await p.click('.send-btn')
await p.waitForTimeout(1600)
console.log('confirm:', await p.evaluate(() => document.querySelector('.modal')?.textContent))
// 点「取消」
await p.click('.modal .btn:not(.danger)')
await p.waitForTimeout(2200)
console.log('拒绝后:', await p.evaluate(async () => {
  const m = await import('/lib/core.js')
  return {
    chips: [...document.querySelectorAll('.tool-chip')].map((x) => x.textContent),
    alive: m.colRecords('todos').length,
    tomb: m.S.records.filter((r) => r.col === 'todos' && r.deleted).length,
  }
}))
await p.screenshot({ path: 'v24-8-reject.png' })
await b.close()
