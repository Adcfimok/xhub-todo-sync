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
const info = await p.evaluate(() => {
  const r = document.querySelector('.cal-day .mini-row.done')
  if (!r) return 'NO DONE ROW; rows=' + [...document.querySelectorAll('.cal-day .mini-row')].map(x => x.className).join(',')
  const box = r.querySelector('.box')
  const base = getComputedStyle(box)
  const after = getComputedStyle(box, '::after')
  return {
    boxBg: base.backgroundColor,
    afterContent: after.content,
    afterW: after.width, afterH: after.height,
    afterBL: after.borderLeftWidth + ' ' + after.borderLeftColor,
    afterBB: after.borderBottomWidth + ' ' + after.borderBottomColor,
    title: r.querySelector('.mini-t').textContent,
    titleDeco: getComputedStyle(r.querySelector('.mini-t')).textDecorationLine,
  }
})
console.log(JSON.stringify(info, null, 2))
await b.close()
