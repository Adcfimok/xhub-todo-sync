import { chromium } from 'playwright'
const b = await chromium.launch({ channel: 'msedge' })
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
const p = await ctx.newPage()
await p.goto('http://127.0.0.1:8100/index.html', { waitUntil: 'networkidle' })
await p.waitForTimeout(600)
const routes = ['home', 'todos', 'notes', 'more', 'settings', 'calendar', 'pomodoro', 'stickies']
for (const r of routes) {
  await p.evaluate((rr) => (location.hash = '#/' + rr), r)
  await p.waitForTimeout(450)
  const info = await p.evaluate(() => {
    const scroller = document.querySelector('.scroll')
    if (scroller) scroller.scrollTop = scroller.scrollHeight
    return new Promise((res) => setTimeout(() => {
      const bar = document.getElementById('tabbar').getBoundingClientRect()
      const kids = [...(scroller ? scroller.children : [])].filter((el) => !/list-pad|list-bignav/.test(el.className))
      const last = kids.length ? kids[kids.length - 1].getBoundingClientRect() : null
      res({
        lastContent: last ? Math.round(last.bottom) : null,
        barTop: Math.round(bar.top),
        overlap: last ? last.bottom > bar.top : false,
        canScroll: scroller ? scroller.scrollHeight > scroller.clientHeight + 1 : false,
      })
    }, 250))
  })
  console.log(`[${r}]`, JSON.stringify(info), info.overlap ? '✗ 内容被遮' : '✓')
}
await ctx.close()
await b.close()
