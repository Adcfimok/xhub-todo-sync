import { chromium } from 'playwright'
const url = process.argv[2]
const out = process.argv[3]
const w = Number(process.argv[4] || 1280)
const h = Number(process.argv[5] || 800)
const b = await chromium.launch({ channel: 'msedge' })
const p = await b.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2 })
const logs = []
p.on('console', m => logs.push(m.type() + ': ' + m.text()))
p.on('pageerror', e => logs.push('PAGEERROR: ' + e.message))
await p.goto(url, { waitUntil: 'networkidle' })
await p.waitForTimeout(1200)
await p.screenshot({ path: out, fullPage: false })
console.log(logs.slice(0, 30).join('\n') || '(no console)')
await b.close()
