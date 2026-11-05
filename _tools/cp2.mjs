import { chromium } from 'playwright'
const b = await chromium.launch({ channel: 'msedge' })
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'light' })
const p = await ctx.newPage()
const errs = []
p.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message))
p.on('console', (m) => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) errs.push('ERR ' + m.text()) })
await p.goto('http://127.0.0.1:8100/index.html', { waitUntil: 'networkidle' })
await p.waitForTimeout(600)
await p.evaluate(async () => {
  const m = await import('/lib/core.js')
  m.colRecords('todos').forEach((r) => { r.deleted = true })
  const now = Date.now()
  for (let i = 0; i < 6; i++) {
    m.newRecord('todos', { title: '待办事项 ' + (i + 1) + '：把今天的事情按优先级排好', dueAt: now + (i + 1) * 3600e3, priority: i % 3, description: '', done: 0 })
  }
  await m.saveMeta('aiBase', 'http://127.0.0.1:48999/v1')
  await m.saveMeta('aiModel', 'mock-agent')
  await m.saveMeta('aiKey', 'sk-mock')
  await new Promise((r) => setTimeout(r, 150))
})
await p.evaluate(() => (location.hash = '#/todos'))
await p.waitForTimeout(500)
await p.screenshot({ path: 'cp-7-light.png' })
// 滚动到底，看内容是否被胶囊遮住
await p.evaluate(() => { const s = document.querySelector('.scroll'); s.scrollTop = s.scrollHeight })
await p.waitForTimeout(400)
const lastVisible = await p.evaluate(() => {
  const cards = [...document.querySelectorAll('.todo')]
  const last = cards[cards.length - 1].getBoundingClientRect()
  const bar = document.getElementById('tabbar').getBoundingClientRect()
  return { lastBottom: Math.round(last.bottom), barTop: Math.round(bar.top), clear: last.bottom <= bar.top }
})
console.log('[滚到底]', JSON.stringify(lastVisible), lastVisible.clear ? '✓ 最后一条完全露出' : '✗ 被遮')
await p.screenshot({ path: 'cp-8-bottom.png' })

// AI 页输入区位置
await p.evaluate(() => (location.hash = '#/ai'))
await p.waitForTimeout(700)
const ai = await p.evaluate(() => {
  const c = document.querySelector('.composer')?.getBoundingClientRect()
  const bar = document.getElementById('tabbar').getBoundingClientRect()
  return c ? { gap: Math.round(bar.top - c.bottom), bottom: Math.round(c.bottom), barTop: Math.round(bar.top), statsH: document.getElementById('composer-stats')?.getBoundingClientRect().height } : 'no composer'
})
console.log('[AI 输入区]', JSON.stringify(ai), ai !== 'no composer' && ai.gap >= 0 ? '✓ 不重叠' : '✗')
await p.screenshot({ path: 'cp-9-ai.png' })

// 尺寸复核
const geo = await p.evaluate(() => {
  const bar = document.getElementById('tabbar').getBoundingClientRect()
  const add = document.getElementById('btn-quick-add').getBoundingClientRect()
  const pill = document.getElementById('tab-indicator').getBoundingClientRect()
  const cs = getComputedStyle(document.getElementById('tab-indicator'))
  return {
    barH: Math.round(bar.height), addW: Math.round(add.width), addH: Math.round(add.height),
    addTop: Math.round(add.top - bar.top), pillH: Math.round(pill.height),
    pillColor: cs.backgroundColor, pillBorder: cs.borderColor,
    iconSize: getComputedStyle(document.querySelector('.tab svg')).width,
    labelSize: getComputedStyle(document.querySelector('.tab span')).fontSize,
  }
})
console.log('[尺寸]', JSON.stringify(geo))
console.log('errs:', errs.join('; ') || 'none')
await b.close()
