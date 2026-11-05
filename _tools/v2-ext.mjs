import { chromium } from 'playwright'
const B = 'http://127.0.0.1:47821'
const WEB = 'http://127.0.0.1:8100/index.html'
const code = (await (await fetch(B + '/api/admin/state')).json()).pairCode
const b = await chromium.launch({ channel: 'msedge' })
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
const p = await ctx.newPage()
const errs = []
p.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message))
await p.goto(WEB, { waitUntil: 'networkidle' })
await p.evaluate(() => (location.hash = '#/settings'))
await p.waitForTimeout(300)
await p.fill('#pair-card input[inputmode="url"]', '127.0.0.1:47821')
await p.fill('#pair-card input[inputmode="numeric"]', code)
await p.click('#pair-card .btn.primary')
await p.waitForTimeout(2200)
await p.evaluate(() => (location.hash = '#/ext'))
await p.waitForTimeout(900)
await p.screenshot({ path: 'v2-12-ext-list.png' })
const cards = await p.$$('.ext')
console.log('ext cards:', cards.length)
if (cards.length) {
  await cards[0].click()
  await p.waitForTimeout(2000)
  await p.screenshot({ path: 'v2-13-ext-open.png' })
  console.log('frames:', p.frames().length)
  const f = p.frames().find((x) => x.url().includes('/ext/r/'))
  if (f) {
    const title = await f.title().catch(() => '?')
    console.log('iframe url ok, title=', title)
  }
}
await p.evaluate(() => (location.hash = '#/more'))
await p.waitForTimeout(500)
await p.screenshot({ path: 'v2-7-more.png' })
await p.evaluate(() => (location.hash = '#/stickies'))
await p.waitForTimeout(500)
await p.screenshot({ path: 'v2-8-stickies.png' })
await p.evaluate(() => (location.hash = '#/snippets'))
await p.waitForTimeout(500)
await p.screenshot({ path: 'v2-10-snippets.png' })
console.log('errs:', errs.join('\n') || '(none)')
await b.close()
