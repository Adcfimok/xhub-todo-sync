import { chromium } from 'playwright'
const B = 'http://127.0.0.1:47821'
const code = (await (await fetch(B + '/api/admin/state')).json()).pairCode
const b = await chromium.launch({ channel: 'msedge' })
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
const p = await ctx.newPage()
const errs = []
p.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message))
await p.goto('http://127.0.0.1:8100/index.html', { waitUntil: 'networkidle' })
await p.evaluate(() => (location.hash = '#/settings'))
await p.waitForTimeout(300)
await p.fill('#pair-card input[inputmode="url"]', '127.0.0.1:47821')
await p.fill('#pair-card input[inputmode="numeric"]', code)
await p.click('#pair-card .btn.primary')
await p.waitForTimeout(2000)

// 便签改写
await p.evaluate(() => (location.hash = '#/stickies'))
await p.waitForTimeout(400)
const ta = (await p.$$('.sticky-area'))[0]
await ta.click()
await ta.fill('手机改写的便签内容')
await p.waitForTimeout(2500)

// 新建笔记
await p.evaluate(() => (location.hash = '#/notes'))
await p.waitForTimeout(400)
await p.click('.fab')
await p.waitForTimeout(400)
await p.fill('#sheet-body input.input', '手机新建的笔记')
await p.fill('#sheet-body textarea', '这是从手机写的正文，应该能同步到电脑。')
await p.click('#btn-save')
await p.waitForTimeout(2500)

const st = await (await fetch(B + '/api/admin/state')).json()
console.log('sticky1:', (st.records.find((r) => r.id === 'stickies:h1') || {}).content)
console.log('notes:', st.records.filter((r) => r.col === 'notes').map((r) => r.title))
console.log('byCol:', st.stats.byCol)
console.log('errs:', errs.join('\n') || '(none)')
await p.screenshot({ path: 'v2-15-after-write.png' })
await b.close()
