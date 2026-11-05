import { chromium } from 'playwright'
const b = await chromium.launch({ channel: 'msedge' })
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'light' })
const p = await ctx.newPage()
await p.goto('http://127.0.0.1:8100/index.html', { waitUntil: 'networkidle' })
await p.waitForTimeout(600)
for (const r of ['home', 'notes', 'more', 'calendar']) {
  await p.evaluate((rr) => (location.hash = '#/' + rr), r)
  await p.waitForTimeout(500)
  await p.screenshot({ path: `cp-11-${r}.png` })
}
await b.close()
