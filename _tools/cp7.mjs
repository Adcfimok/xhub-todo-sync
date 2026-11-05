import { chromium } from 'playwright'
const b = await chromium.launch({ channel: 'msedge' })
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
const p = await ctx.newPage()
const errs = []
p.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message))
await p.goto('http://127.0.0.1:8100/index.html', { waitUntil: 'networkidle' })
await p.waitForTimeout(600)

async function quick(route) {
  await p.evaluate((r) => (location.hash = '#/' + r), route)
  await p.waitForTimeout(450)
  const fab = await p.$$eval('.fab', (els) => els.length)
  await p.click('#btn-quick-add')
  await p.waitForTimeout(450)
  const info = await p.evaluate(() => ({
    open: !document.getElementById('sheet').hidden,
    title: document.getElementById('sheet-title').textContent,
    fields: [...document.querySelectorAll('#sheet-body .field')].map((f) => f.querySelector('.field-label-text')?.textContent || ''),
    dateVal: (document.querySelector('#sheet-body input[type="date"]') || {}).value || null,
  }))
  await p.click('#btn-cancel').catch(() => {})
  await p.waitForTimeout(300)
  console.log(`[${route}] fab=${fab}`, JSON.stringify(info))
  return { fab, ...info }
}

const notes = await quick('notes')
const res = await quick('resources')
const snip = await quick('snippets')
const cal = await quick('calendar')
const home = await quick('home')
const todos = await quick('todos')

console.log('---')
console.log('笔记页无 FAB:', notes.fab === 0 ? '✓' : '✗')
console.log('笔记页 + = 新建笔记:', /笔记/.test(notes.title) ? '✓' : '✗ ' + notes.title)
console.log('速达页 + = 新增速达:', /速达|网页|入口/.test(res.title) ? '✓' : '✗ ' + res.title)
console.log('提示词页 + = 新增:', /提示|话术/.test(snip.title) ? '✓' : '✗ ' + snip.title)
console.log('日历页 + 带日期:', cal.dateVal ? '✓ ' + cal.dateVal : '✗ 无日期')
console.log('首页 + 回落到新建待办:', /待办/.test(home.title) ? '✓' : '✗ ' + home.title)
console.log('待办页 + = 新建待办:', /待办/.test(todos.title) ? '✓' : '✗ ' + todos.title)
console.log('errs:', errs.join('; ') || 'none')

// 截图笔记页（无 FAB）
await p.evaluate(() => (location.hash = '#/notes'))
await p.waitForTimeout(500)
await p.screenshot({ path: 'cp-12-notes-nofab.png' })
await b.close()
