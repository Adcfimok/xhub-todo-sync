/* 倒数日：记录重要日子，算「还有多少天 / 已过多少天」，首页卡片可左右滑动切换。
 *
 * 条目模型（存在 S.meta.countdowns 里）：
 *   { id, title, date('YYYY-MM-DD') }
 * 天数正数 = 还没到（还有 X 天），负数 = 已过去（已过 X 天），0 = 就是今天。
 */

/** 解析 YYYY-MM-DD 为当天零点毫秒；无效返回 null */
export function parseDate(v) {
  if (v == null) return null
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(v).trim())
  if (m) {
    const t = new Date(+m[1], +m[2] - 1, +m[3]).getTime()
    return Number.isFinite(t) ? t : null
  }
  const t = new Date(v).getTime()
  return Number.isFinite(t) ? t : null
}

function dayStart(ms) {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** 距离目标日期的整天数：正=未来，负=过去，0=今天 */
export function daysUntil(date, now) {
  const d = parseDate(date)
  if (!d) return null
  const t = now == null ? Date.now() : now
  return Math.round((dayStart(d) - dayStart(t)) / 86400000)
}

/** 规整条目；非法返回 null */
export function normalizeCountdown(raw) {
  if (!raw || !String(raw.title || '').trim()) return null
  const d = parseDate(raw.date)
  if (!d) return null
  return {
    id: String(raw.id || 'd' + Math.random().toString(16).slice(2, 10)),
    title: String(raw.title).trim().slice(0, 30),
    date: toYmd(d),
  }
}

export function toYmd(ms) {
  const d = new Date(ms)
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}

/** 大字天数（不带正负号，用于大卡片） */
export function dayAbs(c, now) {
  const n = daysUntil(c.date, now)
  return n == null ? 0 : Math.abs(n)
}

/** 一行描述：还有 X 天 / 已过 X 天 / 就是今天 */
export function countdownLabel(c, now) {
  const n = daysUntil(c.date, now)
  if (n == null) return ''
  if (n === 0) return '就是今天'
  if (n > 0) return '还有 ' + n + ' 天'
  return '已过 ' + -n + ' 天'
}

/** 规整整个列表：过滤坏数据、去重、按日期升序（最近的在前面） */
export function normalizeCountdowns(raw) {
  const src = raw && Array.isArray(raw) ? raw : []
  const seen = {}
  const list = []
  src.forEach((c) => {
    const n = normalizeCountdown(c)
    if (!n || seen[n.id]) return
    seen[n.id] = 1
    list.push(n)
  })
  list.sort((a, b) => parseDate(a.date) - parseDate(b.date))
  return list
}
