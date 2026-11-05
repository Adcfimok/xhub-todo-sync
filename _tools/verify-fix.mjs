import { chromium } from 'playwright'

const HUB = 'http://127.0.0.1:47899'
const VIEW = 'http://127.0.0.1:8099/view/index.html?theme=dark&hub=127.0.0.1:47899'
const diag = await (await fetch(HUB + '/api/v1/diag')).json()
const LAN = diag.primary + ':' + diag.port
console.log('主地址（服务端结论）:', LAN)

const b = await chromium.launch({ channel: 'msedge' })
const ok = (n, c) => console.log((c ? '✓ ' : '✗ ') + n)

// ---------- 1. PC 页：地址 / 二维码 / 数据范围 ----------
const ctx = await b.newContext({ viewport: { width: 1280, height: 880 } })
const p = await ctx.newPage()
const errs = []
p.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message))

await p.goto(VIEW, { waitUntil: 'networkidle' })
await p.waitForTimeout(3000)

const pc = await p.evaluate(() => ({
  primary: document.getElementById('primary-addr')?.textContent,
  tags: [...document.querySelectorAll('#primary-tag .badge')].map((x) => x.textContent),
  warn: (() => { const w = document.getElementById('net-warn'); return w && !w.hidden ? w.textContent : '' })(),
  addrs: [...document.querySelectorAll('#addrs li')].map((li) => li.innerText.replace(/\n/g, ' | ')),
  payload: document.getElementById('qr')?.dataset.payload || '',
  scope: document.getElementById('scope-line')?.textContent || '',
}))
console.log('[PC]', JSON.stringify({ primary: pc.primary, tags: pc.tags, payload: pc.payload.slice(0, 60) + '…', warn: pc.warn }, null, 0))
ok('主地址是默认路由网卡', pc.primary === LAN)
ok('标注「默认路由」', pc.tags.includes('默认路由'))
ok('二维码是 v3 且带主地址', pc.payload.startsWith('xhub://3/') && pc.payload.includes(LAN))
ok('虚拟网卡有标记', pc.addrs.some((x) => x.includes('虚拟')))
ok('无红条告警', !pc.warn)
ok('数据范围说明可见', pc.scope.includes('读取') && pc.scope.includes('写回'))

await p.waitForTimeout(4000)
const st = await (await fetch(HUB + '/api/admin/state')).json()
const live = Object.fromEntries(Object.entries(st.stats.byCol).map(([k, v]) => [k, v.live]))
console.log('[中枢]', JSON.stringify(live))
ok('五类数据全部读入且数量正确', live.todos === 4 && live.notes === 2 && live.stickies === 2 && live.resources === 3 && live.snippets === 2)
ok('无待回写积压', st.stats.pendingHost === 0)
await p.screenshot({ path: 'verify-pc.png' })

// ---------- 2. 权限缺失 ----------
const p2 = await ctx.newPage()
await p2.goto(VIEW + '&deny=1', { waitUntil: 'networkidle' })
await p2.waitForTimeout(2500)
const d = await p2.evaluate(() => ({
  cls: document.getElementById('scope-line')?.className,
  text: document.getElementById('scope-line')?.textContent.slice(0, 40),
  perm: !document.getElementById('btn-perm')?.hidden,
}))
ok('权限缺失：红字 + 打开权限按钮', /bad/.test(d.cls || '') && d.perm)
await p2.screenshot({ path: 'verify-denied.png' })
await p2.close()

// ---------- 3. 手机：扫码载荷 → 配对 → 取数 ----------
const code = (await (await fetch(HUB + '/api/admin/state')).json()).pairCode
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
  return { host: m.S.meta.host, paired: !!m.S.meta.token, status: m.S.status, by, todo: (m.colRecords('todos')[0] || {}).title }
})
console.log('[手机]', JSON.stringify(phone))
ok('配对成功', phone.paired && phone.host === LAN)
ok('拿到待办/笔记/便签/速达/提示词', ['todos', 'notes', 'stickies', 'resources', 'snippets'].every((k) => phone.by[k] > 0))
await p3.screenshot({ path: 'verify-phone.png' })

console.log('errs:', [...errs, ...errs3].join('; ') || 'none')
await b.close()
