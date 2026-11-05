import { chromium } from 'playwright'
const B = 'http://127.0.0.1:47821'
const code = (await (await fetch(B + '/api/admin/state')).json()).pairCode
const b = await chromium.launch({ channel: 'msedge' })

for (const theme of ['dark', 'light']) {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: theme })
  const p = await ctx.newPage()
  await p.goto('http://127.0.0.1:8100/index.html', { waitUntil: 'networkidle' })
  await p.evaluate(() => (location.hash = '#/settings'))
  await p.waitForTimeout(300)
  await p.fill('#pair-card input[inputmode="url"]', '127.0.0.1:47821')
  await p.fill('#pair-card input[inputmode="numeric"]', code)
  await p.click('#pair-card .btn.primary')
  await p.waitForTimeout(2200)
  await p.evaluate(() => (location.hash = '#/home'))
  await p.waitForTimeout(700)
  await p.screenshot({ path: `cal-home-${theme}.png` })
  await p.evaluate(() => (location.hash = '#/calendar'))
  await p.waitForTimeout(700)
  await p.screenshot({ path: `cal-page-${theme}.png` })
  await ctx.close()
}
console.log('done')
await b.close()
