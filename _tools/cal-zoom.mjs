import { chromium } from 'playwright'
const B = 'http://127.0.0.1:47821'
const code = (await (await fetch(B + '/api/admin/state')).json()).pairCode
const b = await chromium.launch({ channel: 'msedge' })
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true })
const p = await ctx.newPage()
const failed = []
p.on('requestfailed', (r) => failed.push(r.url() + ' ' + r.failure()?.errorText))
p.on('response', (r) => { if (r.status() >= 400) failed.push(r.status() + ' ' + r.url()) })
await p.goto('http://127.0.0.1:8100/index.html', { waitUntil: 'networkidle' })
await p.evaluate(() => (location.hash = '#/settings'))
await p.waitForTimeout(300)
await p.fill('#pair-card input[inputmode="url"]', '127.0.0.1:47821')
await p.fill('#pair-card input[inputmode="numeric"]', code)
await p.click('#pair-card .btn.primary')
await p.waitForTimeout(2200)
await p.evaluate(() => (location.hash = '#/home'))
await p.waitForTimeout(600)
await p.locator('.cal-card').screenshot({ path: 'zoom-card.png' })
console.log('today dot color:', await p.evaluate(() => {
  const i = document.querySelector('.cal-card .dcell.today .d i')
  if (!i) return 'no dot'
  const cs = getComputedStyle(i)
  return cs.backgroundColor + ' / w=' + cs.width
}))
await p.evaluate(() => (location.hash = '#/calendar'))
await p.waitForTimeout(600)
await p.locator('.cal-wrap').screenshot({ path: 'zoom-grid.png' })
await p.click('#btn-back')
await p.waitForTimeout(500)
console.log('back ->', await p.evaluate(() => location.hash))
console.log('failed:', failed.join('\n') || '(none)')
await b.close()
