import { chromium } from 'playwright'
const b = await chromium.launch({ channel: 'msedge' })
for (const scheme of ['light', 'dark']) {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: scheme })
  const p = await ctx.newPage()
  await p.goto('http://127.0.0.1:8100/index.html', { waitUntil: 'networkidle' })
  await p.waitForTimeout(600)
  await p.evaluate(async () => {
    const m = await import('/lib/core.js')
    m.colRecords('todos').forEach((r) => { r.deleted = true })
    const now = Date.now()
    for (let i = 0; i < 5; i++) m.newRecord('todos', { title: '第 ' + (i + 1) + ' 条：把今天的事情按优先级排好', dueAt: now + (i + 1) * 3600e3, priority: i % 3, description: '', done: 0 })
    await new Promise((r) => setTimeout(r, 150))
  })
  for (const r of ['home', 'todos', 'notes']) {
    await p.evaluate((rr) => (location.hash = '#/' + rr), r)
    await p.waitForTimeout(450)
    await p.screenshot({ path: `six-${r}-${scheme}.png` })
  }
  await ctx.close()
}
await b.close()
