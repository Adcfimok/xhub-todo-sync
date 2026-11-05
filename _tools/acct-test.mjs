import { chromium } from 'playwright'
const B = 'http://127.0.0.1:47821'
const code = (await (await fetch(B + '/api/admin/state')).json()).pairCode
const b = await chromium.launch({ channel: 'msedge' })
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
const p = await ctx.newPage()
const errs = []
p.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message))
p.on('console', (m) => { if (m.type() === 'error') errs.push('ERR ' + m.text()) })

await p.goto('http://127.0.0.1:8100/index.html', { waitUntil: 'networkidle' })
// 配对（AI 自备模式需要；账号页本身不需要）
await p.evaluate(() => (location.hash = '#/settings'))
await p.waitForTimeout(300)
await p.fill('#pair-card input[inputmode="url"]', '127.0.0.1:47821')
await p.fill('#pair-card input[inputmode="numeric"]', code)
await p.click('#pair-card .btn.primary')
await p.waitForTimeout(2000)

// 1. 账号页（未登录）
await p.evaluate(() => (location.hash = '#/account'))
await p.waitForTimeout(600)
await p.screenshot({ path: 'acct-1-login.png' })
console.log('account title:', await p.evaluate(() => document.getElementById('page-title').textContent))
console.log('login boxes:', await p.evaluate(() => ({
  hasEmail: !!document.querySelector('.login-box'),
  inputs: [...document.querySelectorAll('.login-box input')].map((i) => i.placeholder),
  hasGithub: [...document.querySelectorAll('.login-box .btn')].map((b) => b.textContent),
})))

// 2. 发送验证码到真实平台（验证 CORS 真实链路；假邮箱会被服务端拒绝，但能证明请求通了）
await p.fill('.login-box input[inputmode="email"]', 'test@example.com')
await p.click('.login-box .btn.primary')
await p.waitForTimeout(4000)
const emailResult = await p.evaluate(() => {
  const err = document.querySelector('.login-box .err')
  return err && !err.hidden ? 'err: ' + err.textContent : 'no error shown'
})
console.log('email send result:', emailResult)
await p.screenshot({ path: 'acct-2-email.png' })

// 3. AI 配置面板
await p.evaluate(() => (location.hash = '#/ai'))
await p.waitForTimeout(500)
await p.screenshot({ path: 'acct-3-ai-empty.png' })
await p.click('.btn.primary')  // 配置接口
await p.waitForTimeout(600)
await p.screenshot({ path: 'acct-4-ai-config.png' })
console.log('ai config:', await p.evaluate(() => ({
  switchText: document.querySelector('.switch-title')?.textContent,
  chips: [...document.querySelectorAll('.preset-chip')].map((c) => c.textContent),
  hasToggle: !!document.querySelector('.toggle input'),
})))

// 4. 点预设芯片，看是否填充地址
await p.click('.preset-chip')  // DeepSeek
await p.waitForTimeout(300)
console.log('after preset:', await p.evaluate(() => {
  const addr = document.querySelector('.field input[type="text"]')
  return { addr: addr && addr.value, link: document.querySelector('.field-link')?.textContent, note: document.querySelector('.field-note')?.textContent }
}))
await p.screenshot({ path: 'acct-5-preset.png' })

// 5. 切平台额度开关
await p.locator('.toggle').click()
await p.waitForTimeout(400)
await p.screenshot({ path: 'acct-6-platform.png' })
console.log('platform mode:', await p.evaluate(() => document.querySelector('.field-note')?.textContent))

console.log('errs:', errs.length ? errs.join('\n') : '(none)')
await b.close()
