import { chromium } from 'playwright'
const b = await chromium.launch({ channel: 'msedge' })
const ctx = await b.newContext({ viewport: { width: 320, height: 720 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
const p = await ctx.newPage()
const errs = []
p.on('pageerror', (e) => errs.push(e.message))
await p.goto('http://127.0.0.1:8100/index.html', { waitUntil: 'networkidle' })
await p.waitForTimeout(600)
await p.evaluate(async () => {
  const m = await import('/lib/core.js')
  m.colRecords('todos').forEach((r) => { r.deleted = true })
  const now = Date.now()
  m.newRecord('todos', { title: 'x'.repeat(220), dueAt: now + 3600e3, priority: 0, description: '', done: 0 })
  m.newRecord('todos', {
    title: '超长描述压力测试', dueAt: now + 7200e3, priority: 1,
    description: '这是一段很长的备注。'.repeat(60) + '\n' + 'A'.repeat(300),
    done: 0,
  })
  m.newRecord('todos', { title: '短', dueAt: null, priority: 0, description: '', done: 0 })
  await new Promise((r) => setTimeout(r, 150))
})
await p.evaluate(() => (location.hash = '#/todos'))
await p.waitForTimeout(700)
const info = await p.evaluate(() => {
  const cards = [...document.querySelectorAll('.todo')]
  return {
    docOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    cards: cards.map((c) => ({
      h: Math.round(c.getBoundingClientRect().height),
      overflowX: c.scrollWidth > c.clientWidth + 1,
      clipped: c.scrollHeight > c.clientHeight + 1,
      right: Math.round(c.getBoundingClientRect().right),
      vw: window.innerWidth,
    })),
  }
})
console.log(JSON.stringify(info, null, 1))
await p.screenshot({ path: 'fit-320-extreme.png' })
console.log('errs:', errs.join(';') || 'none')
await b.close()
