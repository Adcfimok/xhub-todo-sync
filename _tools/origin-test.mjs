import { chromium } from 'playwright'
const b = await chromium.launch({ channel: 'msedge' })

async function run(changed) {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true })
  const p = await ctx.newPage()
  const errs = []
  p.on('pageerror', (e) => errs.push(e.message))
  await p.addInitScript((chg) => {
    window.Android = {
      deviceName: () => 'T', readClipboard: () => '', writeClipboard: () => {},
      notify: () => {}, vibrate: () => {}, openUrl: () => {},
      originChanged: () => chg, originPort: () => 47830,
    }
  }, changed)
  await p.goto('http://127.0.0.1:8100/index.html', { waitUntil: 'networkidle' })
  await p.waitForTimeout(800)
  const info = await p.evaluate(() => {
    const banner = document.querySelector('.banner.warn')
    return {
      hasWarn: !!banner,
      text: banner ? banner.innerText.replace(/\n/g, ' | ') : null,
      errs: null,
    }
  })
  await p.screenshot({ path: changed ? 'origin-warn.png' : 'origin-normal.png' })
  console.log(changed ? '[端口变化]' : '[端口未变]', JSON.stringify(info), 'errs:', errs.join(';') || 'none')
  await ctx.close()
}

await run(true)
await run(false)
await b.close()
