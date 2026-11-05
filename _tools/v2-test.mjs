import { chromium } from 'playwright'
const B = 'http://127.0.0.1:47821'
const WEB = 'http://127.0.0.1:8100/index.html'
const st = await fetch(B + '/api/admin/state').then((r) => r.json())
const code = st.pairCode

const b = await chromium.launch({ channel: 'msedge' })
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
const p = await ctx.newPage()
const errs = []
p.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message))
p.on('console', (m) => { if (m.type() === 'error') errs.push('ERR ' + m.text()) })

await p.goto(WEB, { waitUntil: 'networkidle' })
await p.waitForTimeout(500)
await p.screenshot({ path: 'v2-1-home-empty.png' })

// 去设置配对
await p.evaluate(() => (location.hash = '#/settings'))
await p.waitForTimeout(300)
await p.fill('#pair-card input[inputmode="url"]', '127.0.0.1:47821')
await p.fill('#pair-card input[inputmode="numeric"]', code)
await p.click('#pair-card .btn.primary')
await p.waitForTimeout(2500)
await p.screenshot({ path: 'v2-2-paired.png' })

for (const [route, file] of [
  ['home', 'v2-3-home.png'],
  ['todos', 'v2-4-todos.png'],
  ['notes', 'v2-5-notes.png'],
  ['ai', 'v2-6-ai.png'],
  ['more', 'v2-7-more.png'],
  ['stickies', 'v2-8-stickies.png'],
  ['resources', 'v2-9-resources.png'],
  ['snippets', 'v2-10-snippets.png'],
  ['ext', 'v2-11-ext.png'],
]) {
  await p.evaluate((r) => (location.hash = '#/' + r), route)
  await p.waitForTimeout(450)
  await p.screenshot({ path: file })
}

const counts = await p.evaluate(() => ({
  records: window.__counts || null,
}))
console.log('errors:', errs.length ? errs.join('\n') : '(none)')
console.log('hub:', (await fetch(B + '/api/admin/state').then((r) => r.json())).stats.byCol)
await b.close()
