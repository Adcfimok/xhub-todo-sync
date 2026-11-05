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

await p.evaluate(async () => {
  const m = await import('/lib/core.js')
  await m.saveMeta('aiBase', 'https://api.deepseek.com/v1')
  await m.saveMeta('aiModel', 'deepseek-chat')
  await m.saveMeta('aiKey', 'sk-demo-not-real')
  await m.saveMeta('aiMessages', [
    { role: 'user', content: '帮我把今天的待办整理成三条重点' },
    { role: 'assistant', content: '1. 12:47 前交周报，把本周进展压成三条结论；\n2. 今天先处理逾期的房租，避免滞纳金；\n3. 牛奶明天到期，顺路买即可。' },
  ])
})
await p.evaluate(() => (location.hash = '#/ai'))
await p.waitForTimeout(800)
await p.screenshot({ path: 'v2-16-ai-chat.png' })
console.log('errs:', errs.join('\n') || '(none)')
await b.close()
