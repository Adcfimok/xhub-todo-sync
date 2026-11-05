import { chromium } from 'playwright'
const b = await chromium.launch({ channel: 'msedge' })
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
const p = await ctx.newPage()
await p.goto('http://127.0.0.1:8100/index.html', { waitUntil: 'networkidle' })
await p.waitForTimeout(500)
const step = async (hash) => { await p.evaluate((h) => (location.hash = h), hash); await p.waitForTimeout(350) }

await step('#/more'); await step('#/notes')
let r = await p.evaluate(() => { const h = window.__handleBack(); return { h, hash: location.hash } })
console.log('[我的 → 笔记 → 返回]', JSON.stringify(r), r.hash === '#/more' ? '✓' : '✗')

await step('#/home'); await step('#/notes')
r = await p.evaluate(() => { const h = window.__handleBack(); return { h, hash: location.hash } })
console.log('[首页 → 笔记 → 返回]', JSON.stringify(r), r.hash === '#/home' ? '✓' : '✗')

await step('#/calendar')
r = await p.evaluate(() => { const h = window.__handleBack(); return { h, hash: location.hash } })
console.log('[日历 → 返回]', JSON.stringify(r), r.hash === '#/home' ? '✓' : '✗')

await step('#/todos')
r = await p.evaluate(() => { const h = window.__handleBack(); return { h, hash: location.hash } })
console.log('[待办 → 返回]', JSON.stringify(r), r.hash === '#/home' ? '✓' : '✗')
await b.close()
