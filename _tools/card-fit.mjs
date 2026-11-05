import { chromium } from 'playwright'

const WEB = 'http://127.0.0.1:8100/index.html'
const b = await chromium.launch({ channel: 'msedge' })

const LONG_T = '把第三季度的复盘材料按「业务结果 / 关键动作 / 遗留风险」三个维度整理成一份不超过两页的文档，并在周五之前同步给产品和设计'
const LONG_D = '背景：上季度复盘只写了结论，缺少数据支撑。\n要求：每条结论后面补一个数字。\n注意：不要贴原始表格，只给结论和口径说明。\n交付：飞书文档 + 10 分钟口头汇报。'

async function run(width, height, tag) {
  const ctx = await b.newContext({ viewport: { width, height }, deviceScaleFactor: 2, isMobile: width < 600, hasTouch: true })
  const p = await ctx.newPage()
  const errs = []
  p.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message))
  p.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.text())) errs.push('ERR ' + m.text()) })

  await p.goto(WEB, { waitUntil: 'networkidle' })
  await p.waitForTimeout(600)
  await p.evaluate(async ({ LONG_T, LONG_D }) => {
    const m = await import('/lib/core.js')
    // 清掉可能残留的待办
    m.colRecords('todos').forEach((r) => { r.deleted = true })
    const now = Date.now()
    const mk = (title, due, pri, desc) =>
      m.newRecord('todos', { title, dueAt: due, priority: pri, description: desc || '', done: 0 })
    mk('买牛奶', now + 3600e3, 0, '')
    mk(LONG_T, now + 7200e3, 2, LONG_D)
    mk('交房租', now + 86400e3, 1, '记得带身份证')
    mk('回邮件', now + 900e3, 0, '')
    await new Promise((r) => setTimeout(r, 150))
  }, { LONG_T, LONG_D })

  await p.evaluate(() => (location.hash = '#/todos'))
  await p.waitForTimeout(700)

  const info = await p.evaluate(() => {
    const cards = [...document.querySelectorAll('.todo')]
    const cols = (() => {
      const g = document.querySelector('.group')
      if (!g) return 0
      const tpl = getComputedStyle(g).gridTemplateColumns
      return tpl.split(' ').filter(Boolean).length
    })()
    const rows = cards.map((c) => {
      const t = c.querySelector('.t')
      const d = c.querySelector('.desc')
      const cs = getComputedStyle(c)
      return {
        title: (t.textContent || '').slice(0, 12),
        cardH: Math.round(c.getBoundingClientRect().height),
        lines: Math.round(t.getBoundingClientRect().height / parseFloat(getComputedStyle(t).lineHeight)),
        // 内容是否被裁：文字块自身可滚动高度 > 可见高度即为截断
        titleClipped: t.scrollHeight > t.clientHeight + 1,
        descClipped: d ? d.scrollHeight > d.clientHeight + 1 : false,
        descH: d ? Math.round(d.getBoundingClientRect().height) : 0,
        // 卡片是否横向溢出
        overflowX: c.scrollWidth > c.clientWidth + 1,
        pad: cs.padding,
      }
    })
    return {
      cols,
      cards: rows,
      docOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      maxCard: Math.max(...rows.map((r) => r.cardH)),
      minCard: Math.min(...rows.map((r) => r.cardH)),
    }
  })
  console.log(`\n[${tag} ${width}×${height}] 列数=${info.cols} 卡片高度 ${info.minCard}–${info.maxCard}px 横向溢出=${info.docOverflow}`)
  info.cards.forEach((c) => console.log('   ', JSON.stringify(c)))
  console.log('    errs:', errs.join('; ') || 'none')
  await p.screenshot({ path: `fit-${tag}.png`, fullPage: false })
  await ctx.close()
  return info
}

const a = await run(360, 800, 'w360')
const c = await run(390, 844, 'w390')
const d = await run(430, 932, 'w430')
const e = await run(768, 1024, 'w768')
const f = await run(1024, 800, 'w1024')

// 断言
const ok = (name, cond) => console.log((cond ? '✓ ' : '✗ ') + name)
ok('长内容卡片明显高于短内容卡片', a.maxCard - a.minCard > 80)
ok('长标题整段展开（>2 行）', a.cards.some((x) => x.lines >= 3))
ok('无标题截断', [...a.cards, ...c.cards, ...d.cards].every((x) => !x.titleClipped))
ok('无描述截断', [...a.cards, ...d.cards].every((x) => !x.descClipped))
ok('无横向溢出', [a, c, d, e, f].every((x) => !x.docOverflow && x.cards.every((y) => !y.overflowX)))
ok('窄屏单列', a.cols === 1 && c.cols === 1 && d.cols === 1)
ok('平板多列', e.cols >= 2 && f.cols >= 2)
ok('同行卡片不被拉齐（高度各不相同）', new Set(d.cards.map((x) => x.cardH)).size >= 3)

await b.close()
