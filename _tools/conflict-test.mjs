import { chromium } from 'playwright'
const B = 'http://127.0.0.1:47821'
const WEB = 'http://127.0.0.1:8100/index.html'
const post = (p, b) => fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json())
const state = () => fetch(B + '/api/admin/state').then(r => r.json())

function hostTime(d = new Date()) {
  const p = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.000`
}

const st0 = await state()
const code = st0.pairCode
const b = await chromium.launch({ channel: 'msedge' })
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
const p = await ctx.newPage()
const errs = []
p.on('pageerror', e => errs.push('PAGEERROR ' + e.message))
await p.goto(WEB, { waitUntil: 'networkidle' })
await p.click('.tab[data-tab="sync"]')
await p.fill('#in-host', '127.0.0.1:47821')
await p.fill('#in-code', code)
await p.click('#btn-pair')
await p.waitForTimeout(2500)
await p.click('.tab[data-tab="list"]')
await p.waitForTimeout(500)
console.log('paired, todos:', await p.$$eval('.todo', e => e.length))

// 1. 手机离线改「写周报」
await ctx.setOffline(true)
await p.waitForTimeout(200)
const item = p.locator('.todo', { hasText: '写周报' }).first()
await item.click()
await p.waitForTimeout(300)
await p.fill('#f-title', '写周报（手机改）')
await p.click('#btn-save')
await p.waitForTimeout(500)
await p.screenshot({ path: 'and-7-offline-edit.png' })
console.log('offline edit done; dirty =', await p.evaluate(() => document.getElementById('kv-dirty').textContent))

// 2. 电脑侧同时改同一条（版本号 +1）
const st1 = await state()
const rows = st1.records.filter(r => r.hostId != null).map(r => ({
  id: r.hostId, title: r.title, done: r.done ? 1 : 0, priority: r.priority,
  due_at: r.dueAt, description: r.description, pinned: r.pinned ? 1 : 0,
  version: Date.now(), updated_at: hostTime(),
}))
rows.find(r => r.title.includes('写周报') || r.id === 1).title = '写周报（电脑改）'
await new Promise(r => setTimeout(r, 1500))
const ing = await post('/api/local/ingest', { records: rows, full: true })
console.log('pc ingest:', ing)

// 3. 恢复网络，手机同步
await ctx.setOffline(false)
await p.click('.tab[data-tab="sync"]')
await p.waitForTimeout(300)
await p.click('#btn-sync')
await p.waitForTimeout(2500)
await p.screenshot({ path: 'and-8-conflict.png' })

const st2 = await state()
console.log('winner title:', st2.records.find(r => r.hostId === 1)?.title)
console.log('conflicts:', st2.conflicts.length, st2.conflicts[0]?.fields)
console.log('phone shows:', await p.$$eval('.todo .t', els => els.map(e => e.textContent)))
console.log(errs.join('\n') || '(no page errors)')
await b.close()
