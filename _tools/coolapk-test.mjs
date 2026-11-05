import { chromium } from 'playwright'

const WEB = 'http://127.0.0.1:8100/index.html'
const b = await chromium.launch({ channel: 'msedge' })

async function ctxFor(scheme) {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: scheme })
  return ctx
}

const ctx = await ctxFor('light')
const p = await ctx.newPage()
const errs = []
p.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message))
p.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.text())) errs.push('ERR ' + m.text()) })

await p.goto(WEB, { waitUntil: 'networkidle' })
await p.waitForTimeout(700)

// 造点内容，方便看玻璃背后有没有东西
await p.evaluate(async () => {
  const m = await import('/lib/core.js')
  m.colRecords('todos').forEach((r) => { r.deleted = true })
  const now = Date.now()
  for (let i = 0; i < 6; i++) {
    m.newRecord('todos', { title: '待办事项 ' + (i + 1) + '：把今天的事情按优先级排好', dueAt: now + (i + 1) * 3600e3, priority: i % 3, description: '', done: 0 })
  }
  await new Promise((r) => setTimeout(r, 150))
})
await p.evaluate(() => (location.hash = '#/todos'))
await p.waitForTimeout(600)
await p.screenshot({ path: 'cp-1-todos-light.png' })

const geo = await p.evaluate(() => {
  const bar = document.getElementById('tabbar')
  const r = bar.getBoundingClientRect()
  const cs = getComputedStyle(bar)
  const add = document.getElementById('btn-quick-add').getBoundingClientRect()
  const ind = document.getElementById('tab-indicator').getBoundingClientRect()
  return {
    bar: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(innerHeight - r.bottom) },
    radius: cs.borderRadius,
    blur: cs.backdropFilter,
    bg: cs.backgroundColor,
    shadowLayers: cs.boxShadow.split('),').length,
    add: { w: Math.round(add.width), h: Math.round(add.height), radius: getComputedStyle(document.getElementById('btn-quick-add')).borderRadius },
    indicator: { x: Math.round(ind.x), w: Math.round(ind.width), h: Math.round(ind.height) },
    tabs: [...document.querySelectorAll('.tab')].map((t) => t.getAttribute('data-route') + ':' + Math.round(t.getBoundingClientRect().width)),
  }
})
console.log('[几何]', JSON.stringify(geo))

// 点 tab 切换 + 指示器位置
async function tabCheck(route, expectSlot) {
  await p.click(`.tab[data-route="${route}"]`)
  await p.waitForTimeout(500)
  const r = await p.evaluate(() => ({
    hash: location.hash,
    slot: document.getElementById('tabbar').style.getPropertyValue('--tab-i'),
    on: document.querySelector('.tab.on')?.getAttribute('data-route'),
    title: document.getElementById('page-title').textContent,
  }))
  console.log(`[切 ${route}]`, JSON.stringify(r), r.slot === String(expectSlot) ? '✓' : '✗ 期望槽位 ' + expectSlot)
  return r
}
await tabCheck('todos', 1)
await tabCheck('ai', 3)
await tabCheck('more', 4)
await tabCheck('home', 0)
await p.screenshot({ path: 'cp-2-home-light.png' })

// 中央 + 新建待办
await p.click('#btn-quick-add')
await p.waitForTimeout(500)
const sheet = await p.evaluate(() => ({
  open: !document.getElementById('sheet').hidden,
  title: document.getElementById('sheet-title').textContent,
  hasTitleField: !!document.querySelector('#sheet-body textarea'),
}))
console.log('[中央 +]', JSON.stringify(sheet))
await p.screenshot({ path: 'cp-3-quickadd.png' })
await p.click('#btn-cancel')
await p.waitForTimeout(300)

// 拖拽：从待办槽向右拖 2 格，应落在 AI（跳过中央 +）
await p.click('.tab[data-route="todos"]')
await p.waitForTimeout(400)
const box = await p.locator('#tabbar').boundingBox()
const unit = (box.width - 12) / 5
const startX = box.x + 6 + unit * 1.5
const y = box.y + box.height / 2
await p.mouse.move(startX, y)
await p.mouse.down()
await p.mouse.move(startX + unit, y, { steps: 6 })
const mid = await p.evaluate(() => ({
  drag: document.getElementById('tabbar').style.getPropertyValue('--drag'),
  dragging: document.getElementById('tabbar').classList.contains('dragging'),
  trans: getComputedStyle(document.getElementById('tab-indicator')).transitionDuration,
}))
await p.mouse.move(startX + unit * 2, y, { steps: 6 })
await p.mouse.up()
await p.waitForTimeout(600)
const after = await p.evaluate(() => ({ hash: location.hash, slot: document.getElementById('tabbar').style.getPropertyValue('--tab-i'), drag: document.getElementById('tabbar').style.getPropertyValue('--drag') }))
console.log('[拖拽中]', JSON.stringify(mid))
console.log('[松手]', JSON.stringify(after), after.hash === '#/ai' ? '✓ 跳过中央 + 落到 AI' : '✗')

// AI 页：输入框不能被胶囊压住
await p.waitForTimeout(400)
const aiGeom = await p.evaluate(() => {
  const c = document.querySelector('.composer')?.getBoundingClientRect()
  const bar = document.getElementById('tabbar').getBoundingClientRect()
  return c ? { composerBottom: Math.round(c.bottom), barTop: Math.round(bar.top), gap: Math.round(bar.top - c.bottom) } : null
})
console.log('[AI 输入区]', JSON.stringify(aiGeom), aiGeom && aiGeom.gap >= 0 ? '✓ 不重叠' : '✗ 重叠')
await p.screenshot({ path: 'cp-4-ai.png' })

// 我的 → 笔记 → 返回应回「我的」
await p.click('.tab[data-route="more"]')
await p.waitForTimeout(500)
const menu = await p.evaluate(() => ({
  title: document.getElementById('page-title').textContent,
  items: [...document.querySelectorAll('.menu-item .mi-t')].map((x) => x.textContent),
}))
console.log('[我的]', JSON.stringify(menu))
await p.screenshot({ path: 'cp-5-more.png' })
await p.evaluate(() => {
  const it = [...document.querySelectorAll('.menu-item')].find((x) => x.textContent.includes('笔记'))
  it.click()
})
await p.waitForTimeout(500)
console.log('[进笔记]', await p.evaluate(() => ({ hash: location.hash, back: !document.getElementById('btn-back').hidden })))
await p.click('#btn-back')
await p.waitForTimeout(500)
console.log('[返回]', await p.evaluate(() => location.hash), (await p.evaluate(() => location.hash)) === '#/more' ? '✓ 回到我的' : '✗')

// 深色
const ctx2 = await ctxFor('dark')
const p2 = await ctx2.newPage()
await p2.goto(WEB, { waitUntil: 'networkidle' })
await p2.waitForTimeout(600)
await p2.evaluate(() => (location.hash = '#/todos'))
await p2.waitForTimeout(500)
await p2.screenshot({ path: 'cp-6-dark.png' })
console.log('errs:', errs.join('; ') || 'none')
await b.close()
