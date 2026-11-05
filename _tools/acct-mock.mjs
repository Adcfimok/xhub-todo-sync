import { chromium } from 'playwright'
const b = await chromium.launch({ channel: 'msedge' })
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
const p = await ctx.newPage()
const errs = []
p.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message))

// 拦截 /me 返回假登录态，其余放行（真实平台）
await p.route('**/me', (route) => route.fulfill({
  status: 200, contentType: 'application/json',
  body: JSON.stringify({
    username: 'demo', role: 'developer', invite_redeemed: true, developer_status: 'approved', can_apply_developer: false,
    quota: { total: 100, remaining: 42 }, credits: { total: 500, remaining: 300 },
  }),
}))

await p.goto('http://127.0.0.1:8100/index.html', { waitUntil: 'networkidle' })
// 注入假账号 token 再进账号页
await p.evaluate(async () => {
  const m = await import('/lib/core.js')
  await m.saveMeta('ptToken', 'fake-token-for-ui-test')
})
await p.evaluate(() => (location.hash = '#/account'))
await p.waitForTimeout(1200)
await p.screenshot({ path: 'acct-7-loggedin.png' })

const info = await p.evaluate(() => ({
  h2s: [...document.querySelectorAll('.card h2')].map((x) => x.textContent),
  profile: document.querySelector('.status-title')?.textContent,
  sub: document.querySelector('.status-sub')?.textContent,
  kv: [...document.querySelectorAll('.kv b')].map((x) => x.textContent),
  hasRedeem: !!document.querySelector('.card input[placeholder="输入邀请码"]'),
  devText: document.querySelector('.card .muted')?.textContent,
}))
console.log(JSON.stringify(info, null, 2))
console.log('errs:', errs.join('\n') || '(none)')
await b.close()
