import { chromium } from 'playwright'

const VIEW = 'http://127.0.0.1:8099/view/index.html?theme=dark'
const HUB = 'http://127.0.0.1:47821'
const LAN = '10.31.67.56:47821'

const b = await chromium.launch({ channel: 'msedge' })

// ---------- 1. PC 端：地址选择 + 数据读取 ----------
const ctx = await b.newContext({ viewport: { width: 1280, height: 860 } })
const p = await ctx.newPage()
const errs = []
p.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message))
p.on('console', (m) => { if (m.type() === 'error') errs.push('ERR ' + m.text()) })

await p.goto(VIEW, { waitUntil: 'networkidle' })
await p.waitForTimeout(2500)

const pc = await p.evaluate(() => ({
  primary: document.getElementById('primary-addr')?.textContent,
  tags: [...document.querySelectorAll('#primary-tag .badge')].map((x) => x.textContent),
  warn: (() => { const w = document.getElementById('net-warn'); return w && !w.hidden ? w.textContent : '' })(),
  addrs: [...document.querySelectorAll('#addrs li')].map((li) => li.innerText.replace(/\n/g, ' | ')),
  code: document.getElementById('pair-code')?.textContent,
  scope: document.getElementById('scope-line')?.textContent,
  hint: document.getElementById('content-hint')?.textContent,
}))
console.log('[PC 配对卡]', JSON.stringify(pc, null, 1))
console.log((pc.primary === LAN ? '✓' : '✗') + ' 主地址是默认路由的 WLAN 地址')
console.log((pc.tags.includes('默认路由') ? '✓' : '✗') + ' 标注「默认路由」')
console.log((pc.addrs.some((x) => x.includes('虚拟')) ? '✓' : '✗') + ' 虚拟网卡有标注')
console.log((!pc.warn ? '✓' : '✗') + ' 无红条告警')

// 中枢里有没有收到五类数据
const stats = await (await fetch(HUB + '/api/admin/state')).json()
const cols = Object.fromEntries(Object.entries(stats.stats.byCol).map(([k, v]) => [k, v.live]))
console.log('[中枢 byCol]', JSON.stringify(cols))
const allIn = ['todos', 'notes', 'stickies', 'resources', 'snippets'].every((k) => cols[k] > 0)
console.log((allIn ? '✓' : '✗') + ' 五类内容都已从宿主读入')

await p.screenshot({ path: 'fix-pc-pair.png' })

// ---------- 2. 权限被拒时的提示 ----------
const p2 = await ctx.newPage()
await p2.goto('http://127.0.0.1:8099/view/index.html?theme=dark&deny=1', { waitUntil: 'networkidle' })
await p2.waitForTimeout(2200)
const denied = await p2.evaluate(() => ({
  scopeClass: document.getElementById('scope-line')?.className,
  scopeText: document.getElementById('scope-line')?.textContent,
  permVisible: !document.getElementById('btn-perm')?.hidden,
}))
console.log('[权限拒绝]', JSON.stringify(denied))
console.log((/bad/.test(denied.scopeClass || '') && denied.permVisible ? '✓' : '✗') + ' 权限缺失时给出可操作入口')
await p2.screenshot({ path: 'fix-pc-denied.png' })
await p2.close()

// ---------- 3. 手机端：用 LAN 地址配对 ----------
const st = await (await fetch(HUB + '/api/admin/state')).json()
const code = st.pairCode
const ctx2 = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
const p3 = await ctx2.newPage()
const errs3 = []
p3.on('pageerror', (e) => errs3.push('PAGEERROR ' + e.message))
await p3.goto('http://127.0.0.1:8100/index.html', { waitUntil: 'networkidle' })
await p3.waitForTimeout(600)
await p3.evaluate(() => (location.hash = '#/settings'))
await p3.waitForTimeout(500)
await p3.fill('#pair-card input[inputmode="url"]', LAN)
await p3.fill('#pair-card input[inputmode="numeric"]', code)
await p3.click('#pair-card .btn.primary')
await p3.waitForTimeout(3500)

const phone = await p3.evaluate(async () => {
  const m = await import('/lib/core.js')
  const by = {}
  m.S.records.filter((r) => !r.deleted).forEach((r) => (by[r.col] = (by[r.col] || 0) + 1))
  return {
    host: m.S.meta.host,
    paired: !!m.S.meta.token,
    status: m.S.status,
    by,
    firstTodo: (m.colRecords('todos')[0] || {}).title,
    firstNote: (m.colRecords('notes')[0] || {}).title,
  }
})
console.log('[手机配对后]', JSON.stringify(phone))
console.log((phone.paired && phone.host === LAN ? '✓' : '✗') + ' 配对成功且地址正确')
console.log((phone.by.todos > 0 && phone.by.notes > 0 ? '✓' : '✗') + ' 配对后拿到待办与笔记')
await p3.screenshot({ path: 'fix-phone-paired.png' })

console.log('errs:', [...errs, ...errs3].join('; ') || 'none')
await b.close()
