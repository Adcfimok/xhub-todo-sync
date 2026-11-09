/**
 * 课表「AI 识别 PDF 导入」端到端回归。
 *
 * 覆盖：入口与配置引导、文本层识别、无文本层时改走图片识别、
 *       待确认字段提示、逐条校正后导入、模型输出不可解析、空结果、粘贴文字入口。
 *
 * 原生 PDF 能力（PdfRenderer / 文本抽取）在浏览器里不存在，这里用 window.Android
 * 的 mock 顶替（pdfInfo/pdfText/pdfRender），模型的 HTTP 响应也由 mock 返回 ——
 * 验证的是「页面把什么发给模型、拿到结果后怎么处理和写入」，不是 Android 渲染本身。
 *
 * 运行：node _tools/pdf-ai-check.mjs
 */

import { createRequire } from 'node:module'
import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(path.join(path.dirname(fileURLToPath(import.meta.url)), 'node_modules/'))
const { chromium } = require('playwright')

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WWW = path.resolve(HERE, '../android/app/src/main/assets/www')
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
}
// 随便一段字节：页面只把它 base64 进请求体，不解码，测试断言的是「内联成 data URL」这件事
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9])

let pass = 0
let fail = 0
const failures = []
function check(name, ok, detail) {
  if (ok) {
    pass++
    console.log('✓ ' + name + (detail ? ' — ' + detail : ''))
  } else {
    fail++
    failures.push(name + (detail ? ' — ' + detail : ''))
    console.log('✗ ' + name + (detail ? ' — ' + detail : ''))
  }
}

function serve() {
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x')
    const p = u.pathname
    if (p.startsWith('/__pdfpage/')) {
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': JPG.length })
      res.end(JPG)
      return
    }
    const rel = p === '/' ? '/index.html' : p
    const file = path.join(WWW, decodeURIComponent(rel))
    if (!file.startsWith(WWW)) return res.writeHead(403).end()
    try {
      const body = await fs.readFile(file)
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' })
      res.end(body)
    } catch (e) {
      res.writeHead(404).end('not found')
    }
  })
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port })))
}

const TEXT_REPLY = JSON.stringify({
  termStart: '2026-09-01',
  courses: [
    { name: '高等数学', day: 1, start: 1, end: 2, weeks: '1-16', location: '教3-201', teacher: '张老师' },
    { name: '大学英语', day: 2, start: 3, end: 4, weeks: '1-16周(单)', location: '外语楼302' },
    { name: '体育', start: 5, end: 6 },
  ],
})
const VISION_REPLY = JSON.stringify({
  courses: [
    { name: '线性代数', day: 3, start: 3, end: 4, weeks: '1-16', location: 'B201' },
    { name: '中国近现代史纲要', day: 5, start: 7, end: 8, weeks: '1-8', location: '文1-101' },
  ],
})

const { srv, port } = await serve()
const browser = await chromium.launch({ channel: 'msedge' })
let ctx
try {
  ctx = await browser.newContext({ viewport: { width: 380, height: 780 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark' })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e.message || e)))
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/i.test(m.text())) errors.push(m.text())
  })

  await page.addInitScript(() => {
    window.__reqs = []
    window.__pdfCleared = 0
    // 原生 PDF 预处理的可控替身：默认「文本层可用、1 页」
    window.__pdf = {
      info: { ok: true, pages: 1, width: 595, height: 842, maxPages: 4 },
      text: { ok: true, text: '高等数学 周一 第1-2节 1-16周 张老师 教3-201\n大学英语 周二 第3-4节 1-16单周 外语楼302\n体育 第5-6节', chars: 72, cjk: 46, quality: 0.96, pages: 1 },
      reply: '',
    }
    window.Android = {
      originPort: () => 47830,
      appVersion: () => '3.8.0',
      deviceName: () => 'test',
      readClipboard: () => '',
      writeClipboard: () => {},
      vibrate: () => {},
      toast: () => {},
      openUrl: () => {},
      pickFileTyped: (id, mime) => {
        window.__pickMime = mime
        setTimeout(() => {
          window.__nativeEmit(
            'pick',
            JSON.stringify({ id, ok: true, uri: 'content://test/kb.pdf', name: '2026秋季课表.pdf', size: 20480, mime: 'application/pdf' })
          )
        }, 15)
      },
      pdfInfo: () => JSON.stringify(window.__pdf.info),
      pdfText: () => JSON.stringify(window.__pdf.text),
      pdfRender: (uri, pageNo) => JSON.stringify({ ok: true, page: pageNo, total: 2, url: '/__pdfpage/abcdef0123456789_p' + pageNo + '.jpg', width: 1190, height: 1684 }),
      pdfClear: () => {
        window.__pdfCleared++
      },
      // 模型的 HTTP 响应：走原生桥就不必处理 CORS，且能精确记录请求体
      httpStream: (id, method, url, headers, body) => {
        window.__reqs.push({ id, method, url, headers: JSON.parse(headers || '{}'), body: JSON.parse(body || '{}') })
        const reply = window.__pdf.reply || ''
        setTimeout(() => {
          window.__nativeEmit('chunk', JSON.stringify({ id, text: JSON.stringify({ choices: [{ message: { role: 'assistant', content: reply } }] }) }))
          window.__nativeEmit('done', JSON.stringify({ id }))
        }, 30)
      },
    }
  })

  async function seed(meta) {
    await page.evaluate(async (pairs) => {
      await new Promise((resolve, reject) => {
        const req = indexedDB.open('todolink', 2)
        req.onsuccess = () => {
          const db = req.result
          const tx = db.transaction(['meta'], 'readwrite')
          pairs.forEach(([k, v]) => tx.objectStore('meta').put({ k, v }))
          tx.oncomplete = resolve
          tx.onerror = () => reject(tx.error)
        }
        req.onerror = () => reject(req.error)
      })
    }, Object.entries(meta))
  }

  await page.goto('http://127.0.0.1:' + port + '/index.html', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(600)
  // 先只放称呼，不放 AI 配置：验证「没配模型」的引导
  await seed({ nickname: '测试员', timetable: { termStart: '', courses: [] } })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(700)
  await page.evaluate(() => (location.hash = '#/timetable'))
  await page.waitForTimeout(350)

  async function openImport() {
    await page.locator('.act-grid .btn', { hasText: /^导入$/ }).click()
    await page.waitForTimeout(150)
  }
  /** 新版流程：进 AI 识别先弹模型选择，确认后才选文件 / 发请求 */
  async function confirmModel() {
    await page.waitForSelector('.mdl-card', { timeout: 4000 })
    await page.locator('#mdl-ok').click()
    await page.waitForTimeout(180)
  }
  async function closeMasks() {
    await page.evaluate(() => document.querySelectorAll('.lib-mask, .modal-mask, .modal').forEach((m) => m.remove()))
  }

  // ---------- 1. 入口与配置引导 ----------
  await openImport()
  const options = await page.locator('.imp-opt b').allTextContents()
  check('导入弹窗出现「AI 识别 PDF 课表」入口', options.some((x) => /AI 识别 PDF/.test(x)), JSON.stringify(options))

  await page.locator('.imp-opt', { hasText: 'AI 识别 PDF 课表' }).click()
  await page.waitForTimeout(200)
  const hintText = await page.textContent('.lib-card')
  check('未配置模型时给出明确引导，而不是静默失败', /AI 识别还差一步/.test(hintText) && /AI 助手/.test(hintText))
  check('引导卡提供「去配置 / 去登录」按钮', (await page.locator('.lib-card .btn', { hasText: /去配置|去登录/ }).count()) === 1)
  await closeMasks()

  // ---------- 2. 文本层识别 ----------
  await seed({ aiPlatform: '0', aiBase: 'https://ai.test/v1', aiKey: 'sk-test', aiModel: 'gpt-4o-mini' })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(700)
  await page.evaluate(() => (location.hash = '#/timetable'))
  await page.waitForTimeout(300)
  await page.evaluate((r) => (window.__pdf.reply = r), TEXT_REPLY)
  await page.evaluate(() => (window.__reqs = []))

  await openImport()
  await page.locator('.imp-opt', { hasText: 'AI 识别 PDF 课表' }).click()
  await page.waitForSelector('.mdl-card', { timeout: 4000 })
  const mdlTitle = await page.textContent('.mdl-card .lib-head b')
  check('识别前先弹出模型选择，而不是直接发请求', /选择识别模型/.test(mdlTitle), mdlTitle)
  const mdlText = await page.textContent('.mdl-card')
  check('选择器点名当前模型与生效范围', /gpt-4o-mini/.test(mdlText) && /立即生效/.test(mdlText))
  check('确认之前不会发出识别请求', (await page.evaluate(() => window.__reqs.length)) === 0)
  await page.locator('#mdl-ok').click()
  await page.waitForTimeout(1100) // 选文件 15ms + 请求 30ms + 渲染
  const req = await page.evaluate(() => window.__reqs[0])
  check('按 application/pdf 过滤系统文件选择器', (await page.evaluate(() => window.__pickMime)) === 'application/pdf')
  check('请求打到配置的接口', !!req && req.url === 'https://ai.test/v1/chat/completions', req && req.url)
  check('带上 Bearer 鉴权与模型名', !!req && /^Bearer sk-test$/.test(req.headers.Authorization || '') && req.body.model === 'gpt-4o-mini')
  const content = req && req.body.messages && req.body.messages[1] && req.body.messages[1].content
  check('文本层可用时按文本模式发送（content 是字符串）', typeof content === 'string')
  check('文本内容包含 PDF 抽出的课程文字', typeof content === 'string' && /高等数学/.test(content))
  check('system 提示要求只输出 JSON', /只输出一个 JSON 对象/.test(req.body.messages[0].content))

  const title = await page.textContent('.lib-card .lib-head b')
  check('预览显示识别条数', /识别到 3 条课程/.test(title), title)
  check('预览逐条渲染成可编辑行', (await page.locator('.ai-row').count()) === 3)
  const stat = await page.textContent('.ai-stat')
  check('统计待确认条数（缺星期/周次的那条）', /待确认/.test(stat), stat)
  check('待确认字段在行内标黄', (await page.locator('.ai-row.has-warn').count()) >= 1)
  check('缺地点/教师只是灰字提示，不算待确认', (await page.locator('.ai-issue.info').count()) >= 1)

  // ---------- 3. 校正后导入 ----------
  await page.locator('.ai-name').first().fill('高等数学A')
  await page.locator('.ai-row-grid select').first().selectOption('6') // 第 1 条改成周六
  await page.waitForTimeout(120)
  await page.locator('.lib-card .btn.primary', { hasText: '覆盖导入' }).click()
  await page.waitForTimeout(200)
  const confirmVisible = (await page.locator('.modal').count()) === 1
  check('仍有待确认项时导入前二次确认', confirmVisible)
  if (confirmVisible) {
    await page.locator('.modal .btn.danger').click()
    await page.waitForTimeout(400)
  }
  const weekText = await page.textContent('.page, body')
  check('改名后的课程已写入课表', /高等数学A/.test(weekText))
  check('单双周信息保留（大学英语单周）', /单周/.test(weekText))
  const courseCount = await page.locator('.course').count()
  check('三条课程全部导入', courseCount === 3, String(courseCount))
  check('导入后清理 PDF 页面图缓存', (await page.evaluate(() => window.__pdfCleared)) >= 1)

  // ---------- 4. 无文本层 → 图片识别 ----------
  await page.evaluate(() => {
    window.__pdf.text = { ok: true, text: '', chars: 0, cjk: 0, quality: 0, pages: 2 }
    window.__pdf.info = { ok: true, pages: 2, width: 595, height: 842, maxPages: 4 }
    window.__pdf.reply = ''
    window.__reqs = []
  })
  await page.evaluate((r) => (window.__pdf.reply = r), VISION_REPLY)
  await openImport()
  await page.locator('.imp-opt', { hasText: 'AI 识别 PDF 课表' }).click()
  await confirmModel()
  await page.waitForTimeout(1300)
  const vreq = await page.evaluate(() => window.__reqs[0])
  const vcontent = vreq && vreq.body.messages[1].content
  check('没有文本层时改走图片模式（content 是数组）', Array.isArray(vcontent))
  const imgs = Array.isArray(vcontent) ? vcontent.filter((x) => x.type === 'image_url') : []
  check('按页渲染后内联成 data URL（模型访问不到 127.0.0.1）', imgs.length === 2 && /^data:image\/jpeg;base64,/.test(imgs[0].image_url.url))
  check('图片模式不把本地 URL 直接发给模型', !JSON.stringify(vcontent).includes('/__pdfpage/'))
  check('图片模式预览同样可校正', (await page.locator('.ai-row').count()) === 2)
  await page.locator('.ai-card .lib-head .mini').click()
  await page.waitForTimeout(200)

  // ---------- 5. 模型输出不可解析 ----------
  await page.evaluate(() => {
    window.__pdf.text = { ok: true, text: '高等数学 周一 1-2 节 1-16 周', chars: 40, cjk: 20, quality: 0.9, pages: 1 }
    window.__pdf.reply = ''
    window.__reqs = []
  })
  await page.evaluate(() => (window.__pdf.reply = '抱歉，这张课表太模糊，我无法识别。'))
  await openImport()
  await page.locator('.imp-opt', { hasText: 'AI 识别 PDF 课表' }).click()
  await confirmModel()
  await page.waitForTimeout(1000)
  const failText = await page.textContent('.lib-card')
  check('模型返回非 JSON 时明确告知，不写入课表', /不是可解析的 JSON/.test(failText))
  check('失败时给出替代方案', /粘贴文字|教务系统一键导入/.test(failText))
  await closeMasks()

  // ---------- 6. 空结果 ----------
  await page.evaluate(() => (window.__pdf.reply = '{"courses":[]}'))
  await openImport()
  await page.locator('.imp-opt', { hasText: 'AI 识别 PDF 课表' }).click()
  await confirmModel()
  await page.waitForTimeout(1000)
  const emptyText = await page.textContent('.lib-card')
  check('识别到 0 条时提示「没有识别到课程」', /没有识别到课程/.test(emptyText))
  await closeMasks()

  // ---------- 7. 粘贴文字入口（无 PDF 时的等价链路） ----------
  await page.evaluate(() => {
    window.__pdf.reply = JSON.stringify({ courses: [{ name: '马克思主义基本原理', day: 4, start: 1, end: 2, weeks: '1-16', location: 'A305' }] })
    window.__reqs = []
  })
  await openImport()
  await page.locator('.imp-opt', { hasText: '粘贴文字让 AI 识别' }).click()
  await page.waitForTimeout(200)
  await page.locator('.lib-card textarea').fill('马克思主义基本原理 周四 第1-2节 1-16周 A305')
  await page.locator('.lib-card .btn.primary', { hasText: '开始识别' }).click()
  await confirmModel()
  await page.waitForTimeout(900)
  const treq = await page.evaluate(() => window.__reqs[0])
  check('粘贴文字走同一个识别链路', !!treq && /马克思主义基本原理/.test(String(treq.body.messages[1].content)))
  check('粘贴文字结果同样进预览', (await page.locator('.ai-row').count()) === 1)
  await page.locator('.lib-card .btn', { hasText: '追加到现有' }).click()
  await page.waitForTimeout(400)
  const finalText = await page.textContent('.page, body')
  check('追加导入后原有课程仍在', /高等数学A/.test(finalText) && /马克思主义基本原理/.test(finalText))

  check('全程无脚本错误', errors.length === 0, errors.slice(0, 2).join(' | '))
} finally {
  if (ctx) await ctx.close()
  await browser.close()
  srv.close()
}

console.log('')
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项')
if (fail) {
  console.log('失败项：')
  failures.forEach((f) => console.log(' - ' + f))
  process.exitCode = 1
}
