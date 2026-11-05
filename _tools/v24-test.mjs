import { chromium } from 'playwright'

const b = await chromium.launch({ channel: 'msedge' })
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark' })
const p = await ctx.newPage()
const errs = []
p.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message))
p.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.text())) errs.push('ERR ' + m.text()) })

await p.addInitScript(() => {
  window.__notified = []
  window.__written = []
  window.Android = {
    deviceName: () => 'Test Phone',
    readClipboard: () => '',
    writeClipboard: (t) => window.__written.push(t),
    notify: (t, b) => window.__notified.push(t + ' | ' + b),
    vibrate: () => {},
    openUrl: (u) => window.__written.push('OPEN:' + u),
  }
})

await p.goto('http://127.0.0.1:8100/index.html', { waitUntil: 'networkidle' })
await p.waitForTimeout(700)

// ---------- 1. 底栏玻璃 + 跟手拖拽 ----------
const glass = await p.evaluate(() => {
  const bar = document.getElementById('tabbar')
  const cs = getComputedStyle(bar)
  const ind = getComputedStyle(document.getElementById('tab-indicator'))
  return {
    blur: cs.backdropFilter || cs.webkitBackdropFilter,
    bg: cs.backgroundColor,
    shadows: cs.boxShadow.split('),').length,
    indBg: ind.backgroundImage.slice(0, 40),
    indTransition: ind.transitionDuration,
  }
})
console.log('[玻璃]', JSON.stringify(glass))

// 拖拽：从 x=120 拖到 x=250（右滑一页）
const box = await p.locator('#tabbar').boundingBox()
await p.mouse.move(box.x + 120, box.y + 24)
await p.mouse.down()
await p.mouse.move(box.x + 175, box.y + 24, { steps: 5 })
const midDrag = await p.evaluate(() => ({
  drag: document.getElementById('tabbar').style.getPropertyValue('--drag'),
  dragging: document.getElementById('tabbar').classList.contains('dragging'),
  trans: getComputedStyle(document.getElementById('tab-indicator')).transitionDuration,
}))
await p.mouse.move(box.x + 250, box.y + 24, { steps: 5 })
const midDrag2 = await p.evaluate(() => document.getElementById('tabbar').style.getPropertyValue('--drag'))
await p.screenshot({ path: 'v24-1-drag.png' })
await p.mouse.up()
await p.waitForTimeout(700)
const afterDrag = await p.evaluate(() => ({
  route: location.hash,
  tabI: document.getElementById('tabbar').style.getPropertyValue('--tab-i'),
  drag: document.getElementById('tabbar').style.getPropertyValue('--drag'),
}))
console.log('[拖拽中]', JSON.stringify(midDrag), '→', midDrag2)
console.log('[松手后]', JSON.stringify(afterDrag))

// ---------- 2. AI 配置 ----------
await p.evaluate(() => (location.hash = '#/ai'))
await p.waitForTimeout(500)
await p.click('.btn.primary')
await p.waitForTimeout(400)
await p.evaluate(() => {
  const set = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })) }
  const texts = [...document.querySelectorAll('#sheet-body input[type="text"]')]
  set(texts[0], 'http://127.0.0.1:48999/v1')
  set(texts[1], 'mock-agent')
  set(document.querySelector('#sheet-body input[type="password"]'), 'sk-mock')
})
await p.click('#btn-save')
await p.waitForTimeout(600)

// ---------- 3. 新建对话 / 三点动画 / 工具调用 ----------
const ui = await p.evaluate(() => ({
  hasNewChat: !!document.getElementById('btn-new-chat'),
  composer: !!document.querySelector('.composer'),
  composerBlur: getComputedStyle(document.querySelector('.composer')).backdropFilter,
  radius: getComputedStyle(document.querySelector('.composer')).borderRadius,
}))
console.log('[输入区]', JSON.stringify(ui))
await p.screenshot({ path: 'v24-2-empty.png' })

// 发一条会触发 create_todo 的消息
await p.fill('.chat-input', '帮我建一条明天下午三点的待办，标题是交房租')
await p.click('.send-btn')
await p.waitForTimeout(120)
const typing = await p.evaluate(() => ({
  dots: document.querySelectorAll('.msg.ai .typing i').length,
  sending: document.querySelector('.send-btn').textContent,
}))
console.log('[三点动画]', JSON.stringify(typing))
await p.screenshot({ path: 'v24-3-typing.png' })

await p.waitForTimeout(3500)
const result = await p.evaluate(() => ({
  bubbles: [...document.querySelectorAll('.msg .bubble')].map((x) => x.textContent),
  chips: [...document.querySelectorAll('.tool-chip')].map((x) => x.textContent),
  stats: document.getElementById('composer-stats').textContent,
}))
console.log('[对话结果]', JSON.stringify(result, null, 2))
await p.screenshot({ path: 'v24-4-created.png' })

// 待办是否真的建了
const todos = await p.evaluate(async () => {
  const m = await import('/lib/core.js')
  return m.colRecords('todos').map((t) => ({ title: t.title, due: t.dueAt, pri: t.priority, done: t.done }))
})
console.log('[待办库]', JSON.stringify(todos))

// ---------- 4. 查待办 ----------
await p.fill('.chat-input', '我有什么待办')
await p.click('.send-btn')
await p.waitForTimeout(3000)
console.log('[查询结果]', await p.evaluate(() => ({
  chips: [...document.querySelectorAll('.tool-chip')].map((x) => x.textContent),
  last: [...document.querySelectorAll('.msg.ai .bubble')].pop()?.textContent,
})))

// ---------- 5. 新对话 ----------
await p.click('#btn-new-chat')
await p.waitForTimeout(400)
await p.click('.modal .btn.danger')
await p.waitForTimeout(500)
console.log('[新对话]', await p.evaluate(() => ({
  msgs: document.querySelectorAll('.msg').length,
  empty: !!document.querySelector('.chat-empty'),
  stats: document.getElementById('composer-stats')?.textContent,
})))
await p.screenshot({ path: 'v24-5-newchat.png' })

console.log('errs:', errs.length ? errs.join('\n') : '(none)')
await b.close()
