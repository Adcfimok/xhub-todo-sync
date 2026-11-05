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
    for (let i = 0; i < 12; i++) {
      m.newRecord('todos', { title: '第 ' + (i + 1) + ' 条：把今天的事情按优先级排好', dueAt: now + (i + 1) * 3600e3, priority: i % 3, description: '', done: 0 })
    }
    await new Promise((r) => setTimeout(r, 150))
  })
  await p.evaluate(() => (location.hash = '#/todos'))
  await p.waitForTimeout(500)
  // 让一张卡片正好压在胶囊后面
  const pos = await p.evaluate(() => {
    const s = document.querySelector('.scroll')
    s.scrollTop = 190
    return s.scrollTop
  })
  await p.waitForTimeout(400)
  const overlap = await p.evaluate(() => {
    const bar = document.getElementById('tabbar').getBoundingClientRect()
    const cards = [...document.querySelectorAll('.todo')].map((c) => c.getBoundingClientRect())
    const behind = cards.filter((c) => c.top < bar.bottom && c.bottom > bar.top).length
    return { behindCards: behind, barTop: Math.round(bar.top) }
  })
  console.log(`[${scheme}] 压住卡数=${overlap.behindCards}`)
  await p.screenshot({ path: `cp-10-scroll-${scheme}.png` })
  await ctx.close()
}
await b.close()
