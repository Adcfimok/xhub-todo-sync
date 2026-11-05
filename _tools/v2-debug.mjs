import { chromium } from 'playwright'
const B = 'http://127.0.0.1:47821'
const code = (await (await fetch(B + '/api/admin/state')).json()).pairCode
const b = await chromium.launch({ channel: 'msedge' })
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
const p = await ctx.newPage()
p.on('console', (m) => console.log('[page]', m.type(), m.text()))
p.on('pageerror', (e) => console.log('[pageerror]', e.message))
await p.goto('http://127.0.0.1:8100/index.html', { waitUntil: 'networkidle' })
await p.evaluate(() => (location.hash = '#/settings'))
await p.waitForTimeout(300)
await p.fill('#pair-card input[inputmode="url"]', '127.0.0.1:47821')
await p.fill('#pair-card input[inputmode="numeric"]', code)
await p.click('#pair-card .btn.primary')
await p.waitForTimeout(1500)

const before = await p.evaluate(async () => {
  const m = await import('/lib/core.js')
  return { status: m.S.status, token: !!m.S.meta.token, recs: m.S.records.length, dirty: m.S.records.filter(r => r.dirty).length }
})
console.log('before', before)

await p.evaluate(() => (location.hash = '#/stickies'))
await p.waitForTimeout(400)
const ta = (await p.$$('.sticky-area'))[0]
await ta.click()
await ta.fill('手机改写的便签内容')
await p.waitForTimeout(3000)

const after = await p.evaluate(async () => {
  const m = await import('/lib/core.js')
  const s = m.S.records.find(r => r.col === 'stickies' && r.slot === 1)
  return { status: m.S.status, lastErr: m.S.lastErr, dirty: m.S.records.filter(r => r.dirty).length, sticky: s && s.content, hlc: s && s.hlc }
})
console.log('after', after)
await b.close()
