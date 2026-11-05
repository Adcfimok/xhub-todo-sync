import { chromium } from 'playwright'
const HUB = 'http://127.0.0.1:47821'
const b = await chromium.launch({ channel: 'msedge' })
const ctx = await b.newContext({ viewport: { width: 1280, height: 860 } })

async function stats(label) {
  const d = await (await fetch(HUB + '/api/admin/state?cols=notes')).json()
  const live = d.records.filter((r) => r.col === 'notes' && !r.deleted).map((r) => r.title)
  console.log(label, JSON.stringify(live))
}

async function page(url, ms, label) {
  const p = await ctx.newPage()
  const logs = []
  p.on('console', (m) => logs.push(m.type() + ':' + m.text()))
  await p.goto(url, { waitUntil: 'networkidle' })
  await p.waitForTimeout(ms)
  const api = await p.evaluate(() => ({
    scope: document.getElementById('scope-line')?.textContent.slice(0, 30),
  }))
  console.log(label, 'page:', JSON.stringify(api))
  return p
}

await page('http://127.0.0.1:8099/view/index.html?theme=dark', 3500, '[normal]')
await stats('[normal 后]')

await page('http://127.0.0.1:8099/view/index.html?theme=dark&deny=1', 3500, '[deny]')
await stats('[deny 后]')

await b.close()
