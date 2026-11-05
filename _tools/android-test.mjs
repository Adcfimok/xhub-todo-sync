import { chromium } from 'playwright'

const B = 'http://127.0.0.1:47821'
const WEB = 'http://127.0.0.1:8100/index.html'

const st = await (await fetch(B + '/api/admin/state')).json()
const code = st.pairCode
console.log('pair code', code, 'records', st.records.length)

const b = await chromium.launch({ channel: 'msedge' })
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
const p = await ctx.newPage()
const logs = []
p.on('console', m => { if (m.type() === 'error') logs.push('ERR ' + m.text()) })
p.on('pageerror', e => logs.push('PAGEERROR ' + e.message))

await p.goto(WEB, { waitUntil: 'networkidle' })
await p.waitForTimeout(600)
await p.screenshot({ path: 'and-1-empty.png' })

// 切到同步页
await p.click('.tab[data-tab="sync"]')
await p.waitForTimeout(400)
await p.screenshot({ path: 'and-2-sync.png' })

// 配对
await p.fill('#in-host', '127.0.0.1:47821')
await p.fill('#in-code', code)
await p.click('#btn-pair')
await p.waitForTimeout(2500)
await p.screenshot({ path: 'and-3-paired.png' })

// 回待办页
await p.click('.tab[data-tab="list"]')
await p.waitForTimeout(600)
await p.screenshot({ path: 'and-4-list.png' })

const count = await p.$$eval('.todo', els => els.length)
console.log('todo nodes:', count)

// 新建一条
await p.click('#btn-add')
await p.waitForTimeout(400)
await p.fill('#f-title', '从手机添加的待办')
await p.screenshot({ path: 'and-5-editor.png' })
await p.click('#btn-save')
await p.waitForTimeout(1500)
await p.screenshot({ path: 'and-6-after-add.png' })

const s2 = await (await fetch(B + '/api/admin/state')).json()
console.log('hub records now:', s2.records.map(r => r.title))
console.log(logs.join('\n') || '(no errors)')
await b.close()
