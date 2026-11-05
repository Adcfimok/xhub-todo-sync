import { chromium } from 'playwright'
const B = 'http://127.0.0.1:47821'
const code = (await (await fetch(B + '/api/admin/state')).json()).pairCode
const b = await chromium.launch({ channel: 'msedge' })
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })

// 1) 电脑端页面（模拟 x-hub 内的整页，由它应答扩展的 data.* 调用）
const pc = await ctx.newPage()
await pc.setViewportSize({ width: 1280, height: 820 })
await pc.goto('http://127.0.0.1:8099/view/index.html?theme=dark', { waitUntil: 'networkidle' })
await pc.waitForTimeout(1500)
console.log('pc page bridge online:', await pc.evaluate(() => true))

// 2) 手机端
const p = await ctx.newPage()
await p.setViewportSize({ width: 390, height: 844 })
const errs = []
p.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message))
await p.goto('http://127.0.0.1:8100/index.html', { waitUntil: 'networkidle' })
await p.evaluate(() => (location.hash = '#/settings'))
await p.waitForTimeout(300)
await p.fill('#pair-card input[inputmode="url"]', '127.0.0.1:47821')
await p.fill('#pair-card input[inputmode="numeric"]', code)
await p.click('#pair-card .btn.primary')
await p.waitForTimeout(2200)
await p.evaluate(() => (location.hash = '#/ext'))
await p.waitForTimeout(900)
const cards = await p.$$('.ext')
if (cards.length) {
  await cards[0].click()
  await p.waitForTimeout(3500)
  await p.screenshot({ path: 'v2-14-ext-bridged.png' })
  const f = p.frames().find((x) => x.url().includes('/ext/r/'))
  if (f) {
    const txt = await f.evaluate(() => document.body.innerText).catch(() => '')
    console.log('--- iframe text ---')
    console.log(txt.slice(0, 400))
  }
}
console.log('errs:', errs.join('\n') || '(none)')
await b.close()
