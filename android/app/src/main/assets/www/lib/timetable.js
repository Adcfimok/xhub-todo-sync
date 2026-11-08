/* 课表数据模型与纯函数（可测试）。
 *
 * 课程模型（存在 S.meta.timetable.courses 里）：
 *   { id, name, teacher, location, day(1-7 周一=1), start, end, weekStart, weekEnd, weekType, color }
 *   - start/end：节次（1..MAX_SLOTS）
 *   - weekType：0=每周 1=单周 2=双周
 *   - color：配色索引 0..COLORS.length-1
 *
 * termStart：开学那周的周一（YYYY-MM-DD），用于算「第几周」。
 * 没有设置开学日期时，用「本学期从当前周开始」兜底。
 */

export const MAX_SLOTS = 12

/** 节次时间表：上午 4 节 + 下午 4 节 + 晚上 4 节 */
export const SLOT_TIMES = [
  '08:00', '08:55', '10:00', '10:55', '14:00', '14:55', '16:00', '16:55', '19:00', '19:55', '20:50', '21:40',
]

export const WEEK_NAMES = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日']

/** 课程配色（按索引取色） */
export const COURSE_COLORS = ['#5b8cff', '#7c5cff', '#34b57d', '#f5a623', '#e05c7b', '#2bb8c9']

export const WEEK_TYPE_LABEL = ['每周', '单周', '双周']

/** 当天零点（本地时区） */
function dayStart(ms) {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** 本周周一零点 */
export function weekStart(ms) {
  const d = new Date(ms)
  const wd = d.getDay() || 7 // 周日=7
  return dayStart(ms) - (wd - 1) * 86400000
}

/** 解析 YYYY-MM-DD / 毫秒 / Date 为当天零点毫秒 */
export function parseTermStart(v) {
  if (v == null || v === '') return null
  if (typeof v === 'number') return dayStart(v)
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(v).trim())
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]).getTime()
  const t = new Date(v).getTime()
  return Number.isFinite(t) ? dayStart(t) : null
}

/** 当前是第几周（开学那周 = 第 1 周）；没有开学日期时按「本周是第 1 周」兜底 */
export function weekOfTerm(termStart, now) {
  const s = parseTermStart(termStart)
  const t = now == null ? Date.now() : now
  if (!s) return 1
  const diff = Math.round((weekStart(t) - weekStart(s)) / 86400000 / 7)
  return Math.max(1, diff + 1)
}

/** 课程在指定周是否上课 */
export function courseInWeek(c, weekNum) {
  const ws = Number(c.weekStart) || 1
  const we = Number(c.weekEnd) || 1
  if (weekNum < ws || weekNum > we) return false
  const wt = Number(c.weekType) || 0
  if (wt === 1) return weekNum % 2 === 1
  if (wt === 2) return weekNum % 2 === 0
  return true
}

/** 某天（1-7）某周的全部课程，按起始节次排序 */
export function coursesOnDay(courses, day, weekNum) {
  return (courses || [])
    .filter((c) => c && Number(c.day) === day && courseInWeek(c, weekNum))
    .slice()
    .sort((a, b) => (Number(a.start) || 0) - (Number(b.start) || 0))
}

/** 规整课程，丢掉非法字段，返回 null 表示不可用 */
export function normalizeCourse(raw) {
  if (!raw || !String(raw.name || '').trim()) return null
  const day = Math.max(1, Math.min(7, Math.round(Number(raw.day) || 1)))
  let start = Math.max(1, Math.min(MAX_SLOTS, Math.round(Number(raw.start) || 1)))
  let end = Math.max(start, Math.min(MAX_SLOTS, Math.round(Number(raw.end) || start)))
  let ws = Math.max(1, Math.round(Number(raw.weekStart) || 1))
  let we = Math.max(ws, Math.round(Number(raw.weekEnd) || ws))
  const wt = Number(raw.weekType) === 1 ? 1 : Number(raw.weekType) === 2 ? 2 : 0
  const color = Math.max(0, Math.min(COURSE_COLORS.length - 1, Math.round(Number(raw.color) || 0)))
  return {
    id: String(raw.id || 'c' + Math.random().toString(16).slice(2, 10)),
    name: String(raw.name).trim().slice(0, 40),
    teacher: String(raw.teacher || '').trim().slice(0, 30),
    location: String(raw.location || '').trim().slice(0, 40),
    day, start, end, weekStart: ws, weekEnd: we, weekType: wt, color,
  }
}

/** 节次显示：第 1-2 节 / 第 3 节 */
export function slotLabel(c) {
  const s = Number(c.start) || 1
  const e = Number(c.end) || s
  return e === s ? '第 ' + s + ' 节' : '第 ' + s + '-' + e + ' 节'
}

/** 课表整体规整：过滤坏数据、去重 */
export function normalizeTimetable(raw) {
  const src = raw && Array.isArray(raw.courses) ? raw.courses : []
  const seen = {}
  const courses = []
  src.forEach((c) => {
    const n = normalizeCourse(c)
    if (!n || seen[n.id]) return
    seen[n.id] = 1
    courses.push(n)
  })
  return { termStart: raw && raw.termStart ? raw.termStart : '', courses }
}
