import { chromium } from 'playwright'

const B = 'http://127.0.0.1:47821'
const WEB = 'http://127.0.0.1:8100/index.html'
const code = (await (await fetch(B + '/api/admin/state')).json()).pairCode

const b = await chromium.launch({ channel: 'msedge' })
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
const p = await ctx.newPage()
const errs = []
p.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message))
p.on('console', (m) => { if (m.type() === 'error') errs.push('ERR ' + m.text()) })

await p.goto(WEB, { waitUntil: 'networkidle' })
await p.evaluate(() => (location.hash = '#/settings'))
await p.waitForTimeout(300)
await p.fill('#pair-card input[inputmode="url"]', '127.0.0.1:47821')
await p.fill('#pair-card input[inputmode="numeric"]', code)
await p.click('#pair-card .btn.primary')
await p.waitForTimeout(2200)

await p.evaluate(() => (location.hash = '#/home'))
await p.waitForTimeout(700)
await p.screenshot({ path: 'cal-1-home.png' })

const cardInfo = await p.evaluate(() => {
  const card = document.querySelector('.cal-card')
  if (!card) return null
  const cells = [...card.querySelectorAll('.dcell')]
  const withDots = cells.filter((c) => c.querySelectorAll('.d i').length)
  return {
    title: card.querySelector('h2')?.innerText.replace(/\n/g, ' | '),
    cells: cells.length,
    daysWithDots: withDots.length,
    dotCounts: withDots.slice(0, 8).map((c) => c.querySelector('.dn').textContent + ':' + c.querySelectorAll('.d i').length),
    today: (card.querySelector('.dcell.today .dn') || {}).textContent,
    h: Math.round(card.getBoundingClientRect().height),
    visible: card.getBoundingClientRect().top < 844,
  }
})
console.log('home card:', cardInfo)

// 点某一天（今天 +3）进日历
const target = await p.evaluate(() => {
  const d = new Date()
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 3).getTime()
})
await p.evaluate((ms) => {
  const el = document.querySelector(`.cal-card [data-ms="${ms}"]`)
  el.scrollIntoView({ block: 'center' })
  el.click()
}, target)
await p.waitForTimeout(800)
await p.screenshot({ path: 'cal-2-page.png' })

const pageInfo = await p.evaluate(() => ({
  route: location.hash,
  title: document.getElementById('page-title').textContent,
  backVisible: !document.getElementById('btn-back').hidden,
  activeTab: document.querySelector('.tab.on')?.getAttribute('data-route'),
  month: document.querySelector('.cal-head b')?.textContent,
  selDay: document.querySelector('.dcell.sel .dn')?.textContent,
  dayTitle: document.querySelector('.cal-day h2')?.innerText.replace(/\n/g, ' '),
  rows: [...document.querySelectorAll('.cal-day .mini-row')].map((r) => r.innerText.replace(/\n/g, ' ')),
  nodate: document.querySelector('.cal-nodate')?.innerText.replace(/\n/g, ' '),
  scrollH: document.documentElement.scrollHeight,
}))
console.log('calendar page:', pageInfo)

// 翻月
await p.click('.cal-head .cal-nav >> nth=1')
await p.waitForTimeout(400)
console.log('after next month:', await p.evaluate(() => document.querySelector('.cal-head b').textContent + ' / sel=' + document.querySelector('.dcell.sel .dn')?.textContent))
await p.screenshot({ path: 'cal-3-nextmonth.png' })
await p.click('.cal-head .mini')
await p.waitForTimeout(400)
console.log('after today:', await p.evaluate(() => document.querySelector('.cal-head b').textContent + ' / sel=' + document.querySelector('.dcell.sel .dn')?.textContent))

// 勾选一条
const before = await p.evaluate(() => document.querySelectorAll('.cal-day .mini-row.done').length)
await p.evaluate(() => {
  const row = [...document.querySelectorAll('.cal-day .mini-row')].find((r) => !r.classList.contains('done'))
  row.querySelector('.box').click()
})
await p.waitForTimeout(1600)
const after = await p.evaluate(() => ({
  done: document.querySelectorAll('.cal-day .mini-row.done').length,
  rows: [...document.querySelectorAll('.cal-day .mini-row')].map((r) => r.className + ' / ' + r.innerText.replace(/\n/g, ' ')),
}))
console.log('toggle:', before, '->', after.done, after.rows)
await p.screenshot({ path: 'cal-4-toggled.png' })

// FAB 新建：日期应预填到选中日
await p.click('.fab')
await p.waitForTimeout(500)
const prefill = await p.evaluate(() => {
  const ins = [...document.querySelectorAll('#sheet-body input, #sheet-body textarea')]
  return { date: ins[1]?.value, time: ins[2]?.value, title: ins[0]?.value }
})
console.log('form prefill:', prefill)
await p.screenshot({ path: 'cal-5-form.png' })
await p.fill('#sheet-body textarea', '从日历新建的待办')
await p.click('#btn-save')
await p.waitForTimeout(1800)
const created = await p.evaluate(() => [...document.querySelectorAll('.cal-day .mini-row')].map((r) => r.innerText.replace(/\n/g, ' ')))
console.log('after create:', created)
await p.screenshot({ path: 'cal-6-created.png' })

// 返回
await p.click('#btn-back')
await p.waitForTimeout(600)
console.log('back to:', await p.evaluate(() => location.hash))

// 主题
await p.evaluate(async () => {
  const m = await import('/lib/core.js')
  await m.saveMeta('themeMode', 'light')
  document.documentElement.setAttribute('data-theme', 'light')
})
await p.waitForTimeout(500)
await p.evaluate(() => (location.hash = '#/home'))
await p.waitForTimeout(700)
await p.screenshot({ path: 'cal-7-home-light.png' })

console.log('errs:', errs.length ? errs.join('\n') : '(none)')
console.log('hub todos:', (await (await fetch(B + '/api/admin/state')).json()).stats.byCol.todos)
await b.close()
