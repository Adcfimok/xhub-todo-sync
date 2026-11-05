import { chromium } from 'playwright'
const b = await chromium.launch({ channel: 'msedge' })
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
const p = await ctx.newPage()
const errs = []
p.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message))
p.on('console', (m) => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) errs.push('ERR ' + m.text()) })
await p.goto('http://127.0.0.1:8100/index.html', { waitUntil: 'networkidle' })
await p.waitForTimeout(600)

const ok = (n, c) => console.log((c ? '✓ ' : '✗ ') + n)

// 1. 四页切换 + 中央 + 不误触
for (const [route, slot] of [['todos', '1'], ['ai', '3'], ['more', '4'], ['home', '0']]) {
  await p.click(`.tab[data-route="${route}"]`)
  await p.waitForTimeout(400)
  const s = await p.evaluate(() => document.getElementById('tabbar').style.getPropertyValue('--tab-i'))
  ok(`切到 ${route} 高亮在第 ${slot} 格`, s === slot)
}
ok('中央 + 存在且不参与高亮', await p.evaluate(() => !document.getElementById('btn-quick-add').classList.contains('tab')))

// 2. 拖拽跟手 + 跳过中央
await p.click('.tab[data-route="todos"]')
await p.waitForTimeout(350)
const box = await p.locator('#tabbar').boundingBox()
const unit = (box.width - 12) / 5
const y = box.y + box.height / 2
const x0 = box.x + 6 + unit * 1.5
await p.mouse.move(x0, y)
await p.mouse.down()
await p.mouse.move(x0 + unit * 0.8, y, { steps: 5 })
const drag = await p.evaluate(() => ({
  d: document.getElementById('tabbar').style.getPropertyValue('--drag'),
  tr: getComputedStyle(document.getElementById('tab-indicator')).transitionDuration,
  dragging: document.getElementById('tabbar').classList.contains('dragging'),
}))
await p.mouse.move(x0 + unit * 2, y, { steps: 5 })
await p.mouse.up()
await p.waitForTimeout(550)
const land = await p.evaluate(() => location.hash)
ok(`拖拽跟手（${drag.d}，过渡 ${drag.tr}）`, parseFloat(drag.d) > 40 && drag.tr === '0s' && drag.dragging)
ok('松手跳过中央 + 落到 AI', land === '#/ai')

// 3. 首页「最近笔记 → 全部」仍可进笔记
await p.evaluate(() => (location.hash = '#/home'))
await p.waitForTimeout(450)
const wentNotes = await p.evaluate(() => {
  const btn = [...document.querySelectorAll('.mini.right')].find((x) => x.textContent === '全部' && x.closest('.card')?.textContent.includes('最近笔记'))
  if (!btn) return 'no-btn'
  btn.click()
  return 'clicked'
})
await p.waitForTimeout(450)
ok(`首页「最近笔记 全部」进笔记（${wentNotes}）`, (await p.evaluate(() => location.hash)) === '#/notes')
await p.click('#btn-back')
await p.waitForTimeout(350)
ok('笔记返回首页', (await p.evaluate(() => location.hash)) === '#/home')

// 4. 面板盖住胶囊
await p.click('#btn-quick-add')
await p.waitForTimeout(400)
const hit = await p.evaluate(() => {
  const r = document.getElementById('tabbar').getBoundingClientRect()
  const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
  return { tag: el?.tagName, cls: el?.className }
})
ok('面板打开时胶囊被盖住', hit.cls !== 'tabbar' && hit.cls !== 'tab-add')
await p.click('#btn-cancel')

// 5. 各页 + 动作
for (const [route, expect] of [['notes', '笔记'], ['resources', '速达'], ['snippets', '提示词']]) {
  await p.evaluate((r) => (location.hash = '#/' + r), route)
  await p.waitForTimeout(350)
  await p.click('#btn-quick-add')
  await p.waitForTimeout(350)
  const t = await p.evaluate(() => document.getElementById('sheet-title').textContent)
  ok(`${route} 的 + = ${t}`, t.includes(expect))
  await p.click('#btn-cancel')
  await p.waitForTimeout(250)
}

console.log('errs:', errs.join('; ') || 'none')
await b.close()
