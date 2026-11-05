import { chromium } from 'playwright'

const b = await chromium.launch({ channel: 'msedge' })
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark' })
const p = await ctx.newPage()
const errs = []
p.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message))
p.on('console', (m) => { if (m.type() === 'error') errs.push('ERR ' + m.text()) })

// 模拟原生桥
await p.addInitScript(() => {
  window.__clip = '把季度复盘材料整理成三条结论'
  window.__notified = []
  window.__written = []
  window.Android = {
    deviceName: () => 'Test Phone',
    readClipboard: () => window.__clip,
    writeClipboard: (t) => window.__written.push(t),
    notify: (title, body) => window.__notified.push(title + ' | ' + body),
    vibrate: () => {},
    openUrl: (u) => window.__written.push('OPEN:' + u),
  }
})

await p.goto('http://127.0.0.1:8100/index.html', { waitUntil: 'networkidle' })
await p.waitForTimeout(800)

// ---------- 1. 底栏磨砂 + 滑动指示器 ----------
const tabInfo = await p.evaluate(() => {
  const bar = document.getElementById('tabbar')
  const cs = getComputedStyle(bar)
  return {
    backdrop: cs.backdropFilter || cs.webkitBackdropFilter,
    bg: cs.backgroundColor,
    indicator: !!document.getElementById('tab-indicator'),
    i: bar.style.getPropertyValue('--tab-i'),
  }
})
console.log('[底栏]', JSON.stringify(tabInfo))

await p.click('.tab[data-route="notes"]')
await p.waitForTimeout(500)
const afterTab = await p.evaluate(() => {
  const bar = document.getElementById('tabbar')
  const ind = document.getElementById('tab-indicator')
  return {
    i: bar.style.getPropertyValue('--tab-i'),
    transform: getComputedStyle(ind).transform,
    active: document.querySelector('.tab.on')?.getAttribute('data-route'),
  }
})
console.log('[底栏切页]', JSON.stringify(afterTab))
await p.screenshot({ path: 'v23-1-notes.png' })

// ---------- 2. AI 配置：测试连通 + 获取模型 ----------
await p.evaluate(() => (location.hash = '#/ai'))
await p.waitForTimeout(500)
await p.click('.btn.primary')
await p.waitForTimeout(500)
// 直接按字段位置写值（面板里 text input 只有「接口地址」「模型名」两个）
await p.evaluate(() => {
  const set = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })) }
  const texts = [...document.querySelectorAll('#sheet-body input[type="text"]')]
  set(texts[0], 'http://127.0.0.1:48999/v1')
  set(texts[1], 'mock-small')
  set(document.querySelector('#sheet-body input[type="password"]'), 'sk-mock')
})
await p.click('#btn-test')
await p.waitForTimeout(1800)
const testResult = await p.evaluate(() => document.getElementById('test-result')?.textContent)
console.log('[测试连通]', testResult)
await p.screenshot({ path: 'v23-2-test.png' })

await p.click('#btn-models')
await p.waitForTimeout(1800)
const picker = await p.evaluate(() => ({
  title: document.querySelector('.pick-head b')?.textContent,
  items: [...document.querySelectorAll('.pick-item')].map((x) => x.textContent),
}))
console.log('[获取模型]', JSON.stringify(picker))
await p.screenshot({ path: 'v23-3-models.png' })

await p.evaluate(() => {
  const it = [...document.querySelectorAll('.pick-item')].find((x) => x.textContent === 'mock-large')
  it.click()
})
await p.waitForTimeout(400)
console.log('[选模型后]', await p.evaluate(() => document.getElementById('test-result')?.textContent))
await p.screenshot({ path: 'v23-4-picked.png' })

// 保存并对话（不配对电脑，纯手机直连）
await p.click('#btn-save')
await p.waitForTimeout(600)
await p.evaluate(() => (location.hash = '#/ai'))
await p.waitForTimeout(400)
await p.fill('.chat-input', '你好')
await p.click('.send-btn')
await p.waitForTimeout(2500)
const chat = await p.evaluate(() => [...document.querySelectorAll('.msg .bubble')].map((x) => x.textContent))
console.log('[独立对话]', JSON.stringify(chat))
console.log('[配对状态]', await p.evaluate(async () => {
  const m = await import('/lib/core.js')
  return { paired: !!m.S.meta.token, model: m.S.meta.aiModel, base: m.S.meta.aiBase }
}))
await p.screenshot({ path: 'v23-5-chat.png' })

// ---------- 3. 更多页出品方 + 复制 ----------
await p.evaluate(() => (location.hash = '#/more'))
await p.waitForTimeout(600)
const credit = await p.evaluate(() => {
  const c = document.querySelector('.credit-card')
  return c ? { text: c.innerText.replace(/\n/g, ' | '), hasCopy: !!c.querySelector('.wx-copy') } : null
})
console.log('[出品方]', JSON.stringify(credit))
await p.click('.wx-copy')
await p.waitForTimeout(300)
console.log('[复制调用]', await p.evaluate(() => window.__written))
await p.screenshot({ path: 'v23-6-more.png' })

// ---------- 4. 番茄钟 ----------
await p.evaluate(() => (location.hash = '#/ext'))
await p.waitForTimeout(700)
console.log('[内置工具]', await p.evaluate(() => document.querySelector('.builtin-row')?.innerText.replace(/\n/g, ' | ')))
await p.evaluate(() => document.querySelector('.builtin-row').click())
await p.waitForTimeout(600)
console.log('[番茄钟]', await p.evaluate(() => ({
  route: location.hash,
  clock: document.getElementById('pomo-clock')?.textContent,
  label: document.getElementById('pomo-label')?.textContent,
  btn: document.querySelector('.pomo-actions .btn.primary')?.textContent,
})))
await p.click('.pomo-actions .btn.primary')
await p.waitForTimeout(1500)
console.log('[番茄钟运行]', await p.evaluate(() => ({
  clock: document.getElementById('pomo-clock')?.textContent,
  label: document.getElementById('pomo-label')?.textContent,
})))
await p.screenshot({ path: 'v23-7-pomodoro.png' })

// 触发到点：把 endAt 改到 1 秒后
await p.evaluate(async () => {
  const m = await import('/lib/core.js')
  const s = Object.assign({}, m.S.meta.pomState, { running: true, endAt: Date.now() + 800 })
  await m.saveMeta('pomState', s)
})
await p.waitForTimeout(2200)
console.log('[番茄钟到点]', await p.evaluate(() => ({
  notified: window.__notified,
  clock: document.getElementById('pomo-clock')?.textContent,
  state: null,
})))
await p.screenshot({ path: 'v23-8-pomo-done.png' })

// ---------- 5. 主题 ----------
await p.evaluate(() => (location.hash = '#/settings'))
await p.waitForTimeout(600)
const themeUI = await p.evaluate(() => ({
  seg: [...document.querySelectorAll('.seg button')].map((x) => x.textContent),
  dots: [...document.querySelectorAll('.accent-dot')].length,
  accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
  notifyToggle: !!document.querySelector('.switch-row .toggle'),
}))
console.log('[主题UI]', JSON.stringify(themeUI))
await p.evaluate(() => {
  const dot = document.querySelectorAll('.accent-dot')[3]
  dot.click()
})
await p.waitForTimeout(400)
console.log('[换色后]', await p.evaluate(() => ({
  accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
  saved: null,
})))
await p.evaluate(() => {
  const btns = [...document.querySelectorAll('.seg button')]
  btns.find((x) => x.textContent === '浅色').click()
})
await p.waitForTimeout(500)
console.log('[切浅色]', await p.evaluate(() => ({
  attr: document.documentElement.getAttribute('data-theme'),
  accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
})))
await p.screenshot({ path: 'v23-9-settings-light.png' })

// ---------- 6. 剪贴板写待办 ----------
await p.evaluate(() => (location.hash = '#/todos'))
await p.waitForTimeout(600)
await p.click('.fab')
await p.waitForTimeout(500)
await p.click('.field-act')
await p.waitForTimeout(300)
console.log('[粘贴]', await p.evaluate(() => document.querySelector('#sheet-body textarea')?.value))
await p.screenshot({ path: 'v23-10-paste.png' })
await p.click('#btn-save')
await p.waitForTimeout(1200)
console.log('[新待办]', await p.evaluate(() => [...document.querySelectorAll('.todo .t')].map((x) => x.textContent).slice(0, 3)))

console.log('errs:', errs.length ? errs.join('\n') : '(none)')
await b.close()
