import { chromium } from 'playwright'
const b = await chromium.launch({ channel: 'msedge' })
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark' })
const p = await ctx.newPage()
const errs = []
p.on('pageerror', (e) => errs.push(e.message))
await p.goto('http://127.0.0.1:8100/index.html', { waitUntil: 'networkidle' })
await p.waitForTimeout(600)
await p.evaluate(async () => {
  const m = await import('/lib/core.js')
  m.colRecords('todos').forEach((r) => { r.deleted = true })
  const now = Date.now()
  m.newRecord('todos', { title: '买牛奶', dueAt: now + 3600e3, priority: 0, description: '', done: 0 })
  m.newRecord('todos', {
    title: '把第三季度的复盘材料按「业务结果 / 关键动作 / 遗留风险」三个维度整理成一份不超过两页的文档',
    dueAt: now + 7200e3, priority: 2,
    description: '背景：上季度复盘只写了结论，缺少数据支撑。\n要求：每条结论后面补一个数字。', done: 0,
  })
  await new Promise((r) => setTimeout(r, 120))
})
await p.evaluate(() => (location.hash = '#/todos'))
await p.waitForTimeout(700)
await p.screenshot({ path: 'fit-dark.png' })
// 首页也看一下紧凑行换行
await p.evaluate(() => (location.hash = '#/home'))
await p.waitForTimeout(700)
const home = await p.evaluate(() => {
  const rows = [...document.querySelectorAll('.mini-row')]
  const over = rows.filter((r) => r.scrollWidth > r.clientWidth + 1).length
  return { rows: rows.length, over, heights: rows.map((r) => Math.round(r.getBoundingClientRect().height)) }
})
console.log('home rows:', JSON.stringify(home))
await p.screenshot({ path: 'fit-home-dark.png' })
console.log('errs:', errs.join(';') || 'none')
await b.close()
