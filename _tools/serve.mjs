/**
 * 预览服务器：把扩展目录当静态站点托管，并在 HTML 里注入假桥，
 * 这样 view / module 页面能够在普通浏览器里跑起来（脱离 x-hub）。
 *
 *   node _tools/serve.mjs [port]
 *   http://127.0.0.1:8099/view/index.html?theme=dark
 */
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, extname, normalize } from 'node:path'

const ROOT = join(process.cwd(), 'extensions', 'todo-relay')
const MOCK = join(process.cwd(), 'dev', 'mock-bridge.js')
const PORT = Number(process.argv[2] || 8099)

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  let path = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '')

  if (path === '__mock.js') {
    res.writeHead(200, { 'Content-Type': TYPES['.js'] })
    res.end(await readFile(MOCK, 'utf8'))
    return
  }
  if (path === '__cards') {
    res.writeHead(200, { 'Content-Type': TYPES['.html'] })
    res.end(cardsPage())
    return }
  if (!path) path = 'view/index.html'

  const file = join(ROOT, path)
  try {
    let body = await readFile(file)
    const ext = extname(file)
    if (ext === '.html') {
      let html = body.toString('utf8')
      if (/<script\s+src=/i.test(html)) {
        html = html.replace(/<script\s+src=/i, '<script src="/__mock.js"></script>\n  <script src=')
      } else {
        html = html.replace(/<script>/i, '<script src="/__mock.js"></script>\n  <script>')
      }
      res.writeHead(200, { 'Content-Type': TYPES['.html'] })
      res.end(html)
      return
    }
    res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('not found: ' + path)
  }
})

server.listen(PORT, '127.0.0.1', () => console.log('preview http://127.0.0.1:' + PORT + '/view/index.html'))

/** 卡片适配验收台：把 module 入口塞进真实尺寸的格子里 */
function cardsPage() {
  const sizes = [
    ['2×2 有表头（最坏情况）', 153, 88, 'compact'],
    ['2×2 无表头', 153, 58, 'compact'],
    ['3×2', 221, 88, 'standard'],
    ['4×3 标准', 289, 140, 'standard'],
    ['4×6', 289, 296, 'standard'],
    ['6×4', 426, 192, 'standard'],
  ]
  const cells = sizes
    .map(
      ([label, w, h, v]) => `
    <figure class="cell">
      <figcaption>${label} · ${w}×${h}</figcaption>
      <div class="shell" style="width:${w}px;height:${h}px">
        <div class="head"><span class="ico"></span><span>待办同步</span></div>
        <iframe src="/module/index.html?xhub-variant=${v}" style="height:${h - 30}px"></iframe>
      </div>
    </figure>`
    )
    .join('')
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>卡片适配验收台</title>
<style>
 body{margin:0;padding:24px;background:#12131b;color:#e8e9f0;font:13px system-ui,sans-serif}
 h1{font-size:14px;margin:0 0 16px;font-weight:600;color:#a2a7b8}
 .row{display:flex;flex-wrap:wrap;gap:24px;align-items:flex-start}
 .cell{margin:0}
 figcaption{font-size:11px;color:#767c8f;margin-bottom:6px}
 .shell{background:linear-gradient(150deg,rgba(255,255,255,.14),rgba(255,255,255,.08));border:1px solid rgba(255,255,255,.55);border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,.3);display:flex;flex-direction:column;overflow:hidden}
 .head{height:30px;display:flex;align-items:center;gap:6px;padding:12px 12px 0;font-size:13px;font-weight:600;flex:none;box-sizing:border-box}
 .ico{width:14px;height:14px;border-radius:4px;background:#8b8bff}
 iframe{width:100%;border:0;background:transparent;display:block}
</style></head><body><h1>工作台卡片适配验收台（含 30px 宿主表头）</h1><div class="row">${cells}</div></body></html>`
}
