import { chromium } from 'playwright'
const b = await chromium.launch({ channel: 'msedge' })
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
const p = await ctx.newPage()
const errs = []
p.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message))

// 模拟原生桥：记录 openUrl 调用
await p.addInitScript(() => {
  window.__opened = []
  window.Android = { openUrl: (u) => window.__opened.push(u), deviceName: () => 'Test Phone' }
})

await p.goto('http://127.0.0.1:8100/index.html', { waitUntil: 'networkidle' })
await p.evaluate(() => (location.hash = '#/ai'))
await p.waitForTimeout(500)
await p.click('.btn.primary')          // 配置接口
await p.waitForTimeout(500)

// 逐个点预设，读链接文案
const rows = []
for (const name of ['DeepSeek', 'OpenAI', 'Moonshot 月之暗面', '阿里云百炼', 'Ollama（本机）']) {
  await p.evaluate((n) => {
    const chip = [...document.querySelectorAll('.preset-chip')].find((c) => c.textContent === n)
    chip.click()
  }, name)
  await p.waitForTimeout(200)
  const info = await p.evaluate(() => {
    const a = document.querySelector('.field-link')
    return {
      text: a ? a.textContent.trim() : null,
      href: a ? a.getAttribute('href') : null,
      hasSvg: a ? !!a.querySelector('svg') : false,
    }
  })
  rows.push({ name, ...info })
}
console.log(JSON.stringify(rows, null, 2))

// 点 DeepSeek 的链接，验证走原生 openUrl
await p.evaluate(() => {
  const chip = [...document.querySelectorAll('.preset-chip')].find((c) => c.textContent === 'DeepSeek')
  chip.click()
})
await p.waitForTimeout(200)
await p.click('.field-link')
await p.waitForTimeout(300)
console.log('opened:', await p.evaluate(() => window.__opened))

await p.screenshot({ path: 'keylink.png' })
console.log('errs:', errs.join('\n') || '(none)')
await b.close()
