/** 2.8.0 冒烟：页面能起、底栏/笔记栏在、设置页版本正确、无脚本错误 */
import { chromium } from 'playwright'

const BASE = 'http://127.0.0.1:8100/index.html'
const b = await chromium.launch({ channel: 'msedge' })
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
const p = await ctx.newPage()
const errs = []
p.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message))
p.on('console', (m) => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text().slice(0, 120)) })

const ok = (n, c, extra) => console.log((c ? '✓ ' : '✗ ') + n + (c ? '' : ' → ' + JSON.stringify(extra)))

await p.goto(BASE, { waitUntil: 'networkidle' })
await p.waitForTimeout(1800)

const home = await p.evaluate(() => {
  const bar = document.querySelector('.tabbar') || document.querySelector('.dock')
  const r = bar ? bar.getBoundingClientRect() : null
  return {
    cards: document.querySelectorAll('.card').length,
    barTop: r ? Math.round(r.top) : null,
    barBottom: r ? Math.round(r.bottom) : null,
    barPos: bar ? getComputedStyle(bar).position : null,
    notesRail: !!document.querySelector('[data-rail], .rail, .note-rail'),
    route: location.hash,
  }
})
ok('首页卡片渲染', home.cards >= 3, home)
ok('底栏在视口内且不贴底', home.barTop > 640 && home.barBottom <= 844, home)

await p.evaluate(() => (location.hash = '#/settings'))
await p.waitForTimeout(600)
const st = await p.evaluate(() => ({
  ver: (document.body.innerText.match(/2\.\d+\.\d+/) || [''])[0],
  pair: !!document.querySelector('#pair-card'),
  inputs: document.querySelectorAll('#pair-card input').length,
}))
ok('设置页有配对卡', st.pair && st.inputs >= 2, st)
ok('版本号已是 2.8.0', st.ver === '2.8.0', st.ver)
await p.screenshot({ path: 'smoke-280-settings.png' })

await p.evaluate(() => (location.hash = '#/home'))
await p.waitForTimeout(700)
await p.screenshot({ path: 'smoke-280-home.png' })

console.log('errs:', errs.join(' | ') || 'none')
await b.close()
