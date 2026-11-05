import { chromium } from 'playwright'
const b = await chromium.launch({ channel: 'msedge' })
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
const p = await ctx.newPage()
await p.goto('http://127.0.0.1:8100/index.html', { waitUntil: 'networkidle' })
await p.waitForTimeout(600)
await p.click('#btn-quick-add')
await p.waitForTimeout(500)
const z = await p.evaluate(() => {
  const at = (x, y) => {
    const el = document.elementFromPoint(x, y)
    return el ? el.className || el.tagName : null
  }
  const bar = document.getElementById('tabbar').getBoundingClientRect()
  const mask = document.getElementById('sheet-mask')
  return {
    barZ: getComputedStyle(document.getElementById('tabbar')).zIndex,
    sheetZ: getComputedStyle(document.getElementById('sheet')).zIndex,
    maskZ: getComputedStyle(mask).zIndex,
    hitAtBar: String(at(bar.x + bar.width / 2, bar.y + bar.height / 2)),
    sheetVisible: !document.getElementById('sheet').hidden,
  }
})
console.log('[层级]', JSON.stringify(z))
await p.screenshot({ path: 'cp-13-sheet.png' })
await b.close()
