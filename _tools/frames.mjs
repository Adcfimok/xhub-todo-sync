import { chromium } from 'playwright'

const b = await chromium.launch({ channel: 'msedge' })
const p = await b.newPage({ viewport: { width: 900, height: 700 } })
await p.goto('http://127.0.0.1:8101/', { waitUntil: 'domcontentloaded' })
await p.setContent(`<style>body{margin:0;background:#222}video{width:900px;display:block}</style>
<video id="v" src="http://127.0.0.1:8101/ref.mp4" muted playsinline></video>`)

const meta = await p.evaluate(async () => {
  const v = document.getElementById('v')
  await new Promise((res, rej) => {
    if (v.readyState >= 1) return res()
    v.onloadedmetadata = res
    v.onerror = () => rej(new Error('load error ' + (v.error && v.error.code)))
    setTimeout(() => rej(new Error('timeout')), 8000)
  })
  return { d: v.duration, w: v.videoWidth, h: v.videoHeight }
})
console.log('meta', JSON.stringify(meta))

const n = 8
for (let i = 0; i < n; i++) {
  const t = (meta.d * i) / (n - 1)
  await p.evaluate(async (tt) => {
    const v = document.getElementById('v')
    v.currentTime = Math.min(tt, v.duration - 0.05)
    await new Promise((r) => (v.onseeked = r))
  }, t)
  await p.waitForTimeout(150)
  await p.locator('#v').screenshot({ path: `frame-${i}.png` })
}
console.log('done')
await b.close()
