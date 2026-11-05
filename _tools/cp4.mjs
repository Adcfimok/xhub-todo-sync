import { chromium } from 'playwright'
const b = await chromium.launch({ channel: 'msedge' })
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
const p = await ctx.newPage()
const errs = []
p.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message))
await p.goto('http://127.0.0.1:8100/index.html', { waitUntil: 'networkidle' })
await p.waitForTimeout(600)
await p.evaluate(async () => {
  const m = await import('/lib/core.js')
  const now = Date.now()
  if (!m.colRecords('notes').length) {
    m.newRecord('notes', { title: '周会纪要', content: '同步方案定稿', createdAt: now, updatedAt: now })
    m.newRecord('notes', { title: '读书笔记', content: '信息密度不是越多越好', createdAt: now, updatedAt: now })
  }
})

const routes = ['home', 'todos', 'notes', 'ai', 'more', 'calendar', 'settings', 'account', 'ext', 'pomodoro', 'stickies', 'resources', 'snippets']
for (const r of routes) {
  await p.evaluate((rr) => (location.hash = '#/' + rr), r)
  await p.waitForTimeout(500)
  const info = await p.evaluate(() => {
    const bar = document.getElementById('tabbar').getBoundingClientRect()
    const scroller = document.querySelector('.scroll')
    if (scroller) scroller.scrollTop = scroller.scrollHeight
    const fab = document.querySelector('.fab')
    const fabR = fab ? fab.getBoundingClientRect() : null
    return new Promise((res) => setTimeout(() => {
      const last = scroller && scroller.lastElementChild ? scroller.lastElementChild.getBoundingClientRect() : null
      res({
        hasScroll: !!scroller,
        fabOverlapsBar: fabR ? fabR.bottom > bar.top && fabR.top < bar.bottom : false,
        fabAboveBar: fabR ? Math.round(bar.top - fabR.bottom) : null,
        lastBottom: last ? Math.round(last.bottom) : null,
        barTop: Math.round(bar.top),
        barOverlapsLast: last ? last.bottom > bar.top && last.top < bar.bottom : false,
        docOverflowX: document.documentElement.scrollWidth > innerWidth + 1,
      })
    }, 250))
  })
  console.log(`[${r}]`, JSON.stringify(info))
}
console.log('errs:', errs.join('; ') || 'none')
await b.close()
