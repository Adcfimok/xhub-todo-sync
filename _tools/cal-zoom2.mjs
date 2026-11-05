import { chromium } from 'playwright'
const B = 'http://127.0.0.1:47821'
const code = (await (await fetch(B + '/api/admin/state')).json()).pairCode
const b = await chromium.launch({ channel: 'msedge' })
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true })
const p = await ctx.newPage()
await p.goto('http://127.0.0.1:8100/index.html', { waitUntil: 'networkidle' })
await p.evaluate(() => (location.hash = '#/settings'))
await p.waitForTimeout(300)
await p.fill('#pair-card input[inputmode="url"]', '127.0.0.1:47821')
await p.fill('#pair-card input[inputmode="numeric"]', code)
await p.click('#pair-card .btn.primary')
await p.waitForTimeout(2200)
await p.evaluate(() => (location.hash = '#/calendar'))
await p.waitForTimeout(600)
await p.locator('.cal-day').screenshot({ path: 'zoom-day.png' })
await p.evaluate(() => (location.hash = '#/calendar'))
await p.click('.cal-head .cal-nav >> nth=1')
await p.waitForTimeout(400)
await p.screenshot({ path: 'cal-8-empty-month.png' })
console.log('done row check:', await p.evaluate(() => {
  const r = document.querySelector('.cal-day .mini-row.done')
  if (!r) return 'none'
  const cs = getComputedStyle(r.querySelector('.box'), '::after')
  return { w: cs.width, h: cs.height, bl: cs.borderLeftColor, content: cs.content }
}))
await b.close()
