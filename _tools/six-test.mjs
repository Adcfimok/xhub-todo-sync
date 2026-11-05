import { chromium } from 'playwright'
const b = await chromium.launch({ channel: 'msedge' })
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
const p = await ctx.newPage()
const errs = []
p.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message))
p.on('console', (m) => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) errs.push('ERR ' + m.text()) })
await p.goto('http://127.0.0.1:8100/index.html', { waitUntil: 'networkidle' })
await p.waitForTimeout(600)
await p.evaluate(async () => {
  const m = await import('/lib/core.js')
  await m.saveMeta('aiBase', 'http://127.0.0.1:48999/v1')
  await m.saveMeta('aiModel', 'mock')
  await m.saveMeta('aiKey', 'sk-mock')
})
const ok = (n, c) => console.log((c ? '✓ ' : '✗ ') + n)

const geo = await p.evaluate(() => {
  const bar = document.getElementById('tabbar').getBoundingClientRect()
  const add = document.getElementById('btn-quick-add').getBoundingClientRect()
  const ind = document.getElementById('tab-indicator').getBoundingClientRect()
  return {
    bar: { y: Math.round(bar.y), h: Math.round(bar.height), bottomGap: Math.round(innerHeight - bar.bottom), w: Math.round(bar.width) },
    add: { w: Math.round(add.width), h: Math.round(add.height), cx: Math.round(add.x + add.width / 2), barCx: Math.round(bar.x + bar.width / 2) },
    indW: Math.round(ind.width),
    tabs: [...document.querySelectorAll('.tab')].map((t) => t.getAttribute('data-route') + ':' + Math.round(t.getBoundingClientRect().width)),
    slots: [...document.getElementById('tabbar').children].filter((el) => el.classList.contains('tab') || el.classList.contains('tab-add')).length,
    labelW: [...document.querySelectorAll('.tab span')].map((s) => s.textContent + ':' + Math.round(s.getBoundingClientRect().width)),
  }
})
console.log('[几何]', JSON.stringify(geo))
ok('底栏距屏幕底部 22px', geo.bar.bottomGap === 22)
ok('六格等宽（5 个 Tab + 中央按钮 = 6 格，每格约 60px）', geo.slots === 6 && geo.tabs.length === 5 && geo.tabs.every((t) => Math.abs(Number(t.split(':')[1]) - 60) <= 2))
ok('笔记格回来了', geo.tabs.some((t) => t.startsWith('notes:')))
ok('中央 + 尺寸 54×42', geo.add.w === 54 && geo.add.h === 42)

// 槽位
for (const [route, slot] of [['todos', '1'], ['notes', '2'], ['ai', '4'], ['more', '5'], ['home', '0']]) {
  await p.click(`.tab[data-route="${route}"]`)
  await p.waitForTimeout(380)
  const s = await p.evaluate(() => document.getElementById('tabbar').style.getPropertyValue('--tab-i'))
  ok(`切到 ${route} 高亮第 ${slot} 格`, s === slot)
}
ok('笔记页不再有返回键', await p.evaluate(() => document.getElementById('btn-back').hidden))

// 拖拽：从笔记(2) 向右拖一格 → 应跳过 + 落到 AI(4)
await p.click('.tab[data-route="notes"]')
await p.waitForTimeout(300)
const box = await p.locator('#tabbar').boundingBox()
const unit = (box.width - 12) / 6
const y = box.y + box.height / 2
const x0 = box.x + 6 + unit * 2.5
await p.mouse.move(x0, y)
await p.mouse.down()
await p.mouse.move(x0 + unit * 0.7, y, { steps: 5 })
const drag = await p.evaluate(() => ({
  d: document.getElementById('tabbar').style.getPropertyValue('--drag'),
  tr: getComputedStyle(document.getElementById('tab-indicator')).transitionDuration,
}))
await p.mouse.move(x0 + unit, y, { steps: 5 })
await p.mouse.up()
await p.waitForTimeout(550)
const land = await p.evaluate(() => location.hash)
ok(`拖拽跟手（${drag.d}, ${drag.tr}）`, parseFloat(drag.d) > 30 && drag.tr === '0s')
ok('跳过中央 + 落到 AI', land === '#/ai')

// 笔记页 + 仍新建笔记
await p.click('.tab[data-route="notes"]')
await p.waitForTimeout(350)
await p.click('#btn-quick-add')
await p.waitForTimeout(400)
ok('笔记页 + = 新建笔记', (await p.evaluate(() => document.getElementById('sheet-title')?.textContent)) === '新建笔记')
await p.click('#btn-cancel')
await p.waitForTimeout(250)

// 遮挡检查
for (const r of ['home', 'todos', 'notes', 'more', 'settings', 'calendar']) {
  await p.evaluate((rr) => (location.hash = '#/' + rr), r)
  await p.waitForTimeout(400)
  const info = await p.evaluate(() => {
    const sc = document.querySelector('.scroll')
    if (sc) sc.scrollTop = sc.scrollHeight
    return new Promise((res) => setTimeout(() => {
      const bar = document.getElementById('tabbar').getBoundingClientRect()
      const kids = [...(sc ? sc.children : [])].filter((el) => !/list-pad|list-bignav/.test(el.className))
      const last = kids.length ? kids[kids.length - 1].getBoundingClientRect() : null
      res({ overlap: last ? last.bottom > bar.top : false, gap: last ? Math.round(bar.top - last.bottom) : null })
    }, 250))
  })
  ok(`${r} 内容不被遮（余 ${info.gap}px）`, !info.overlap)
}

// AI 输入区
await p.evaluate(() => (location.hash = '#/ai'))
await p.waitForTimeout(500)
const ai = await p.evaluate(() => {
  const c = document.querySelector('.composer')?.getBoundingClientRect()
  const bar = document.getElementById('tabbar').getBoundingClientRect()
  return c ? Math.round(bar.top - c.bottom) : null
})
ok(`AI 输入区余量 ${ai}px`, ai !== null && ai >= 8)

console.log('errs:', errs.join('; ') || 'none')
await p.screenshot({ path: 'six-light.png' })
await b.close()
