/* 教务系统课表导入：解析层（纯函数，不碰 DOM，可在 Node 里单测）。
 *
 * 流程对齐 WakeUp课程表 6.5.2 的「教务一键导入」（见其 assets/empty.html 的提示文案）：
 *   选/填教务网址 → App 内置浏览器打开 → 用户自己在教务页登录 → 点到课表界面
 *   → 点「导入当前页」→ 抓当前页 HTML → 本机解析成课程 → 预览确认后写入课表。
 * 账号密码始终留在教务系统自己的页面里，本 App 不读取、不保存、不上传。
 *
 * 覆盖三类来源：
 *   1. 教务导出的 JSON（含桌面「教学安排表.json」这类 course_name/weekday/periods/weeks 字段）
 *   2. 教务接口返回的 JSON（kbList / data / rows / timetable 等任意层级的课程数组）
 *   3. 课表页 HTML 表格（正方 / URP / 强智等，含同域 iframe 里的表格）
 * 解析不出来时由 UI 引导「粘贴源码」或「手动录入」，绝不猜造课程。
 */

import { normalizeCourse } from './timetable.js'

/** 常见教务系统：只作为「解析提示」，网址必须由用户填自己学校的（不内置/不编造校方地址） */
export const EDU_PRESETS = [
  { id: 'zf', name: '正方教务', hint: '课表通常是 #Table1 / #kbtable 的 7 列网格，进「信息查询 → 学生课表」后导入' },
  { id: 'urp', name: 'URP 综合教务', hint: '进「综合查询 → 本学期课表」，表格按节次分行' },
  { id: 'qz', name: '强智 / 新教务', hint: '多为 JSON 接口渲染的课表，等课程名都显示出来再导入' },
  { id: 'qg', name: '青果 / 树维', hint: '课表常在 iframe 里，登录后在课表页直接导入即可' },
  { id: 'other', name: '其它 / 自定义网址', hint: '填学校教务系统的首页地址，进来后自己点到课表页' },
]

const NAME_KEYS = ['name', 'coursename', 'course_name', 'kcmc', 'kcm', 'course', 'title', '课程名', '课程名称', '课名']
const DAY_KEYS = ['dayofweek', 'day_of_week', 'weekday', 'day', 'xq', 'xqj', 'xingqi', 'week', '星期', '周几', '星期几']
const START_KEYS = ['periodstart', 'period_start', 'startsection', 'start_section', 'startperiod', 'startperiod', 'start', 'ksjc', 'qssj', 'startnode', 'begin', '起始节', '开始节次']
const END_KEYS = ['periodend', 'period_end', 'endsection', 'end_section', 'endperiod', 'end', 'jsjc', 'jssj', 'endnode', '结束节', '结束节次']
const PERIOD_KEYS = ['periods', 'period', 'section', 'sections', 'jc', 'jie', 'skjc', '节次', '上课节次']
const WEEKS_KEYS = ['weeks', 'weeklist', 'week', 'zc', 'qszc', 'weekrange', 'weekrange', '周次', '上课周次', '周数']
const WS_KEYS = ['weekstart', 'week_start', 'startweek', 'qszc', '起始周']
const WE_KEYS = ['weekend', 'week_end', 'endweek', 'zzzc', '结束周']
const WT_KEYS = ['weektype', 'week_type', 'dsz', '单双周', '周类型']
const TEACHER_KEYS = ['teacher', 'teachername', 'teacher_name', 'jsxm', 'js', '教师', '任课教师', '老师']
const LOCATION_KEYS = ['location', 'room', 'classroom', 'place', 'address', 'dd', 'skdd', 'jsmc', '教室', '地点', '上课地点']

function keyOf(k) {
  return String(k).toLowerCase().replace(/[\s_\-]/g, '')
}

/** 从一条记录里按候选字段名取值（忽略大小写 / 下划线 / 连字符） */
function pick(obj, keys) {
  if (!obj || typeof obj !== 'object') return undefined
  const bag = {}
  Object.keys(obj).forEach((k) => {
    const v = obj[k]
    if (v != null && v !== '') bag[keyOf(k)] = v
  })
  for (const k of keys) {
    const v = bag[keyOf(k)]
    if (v != null && v !== '') return v
  }
  return undefined
}

function clampInt(n, lo, hi) {
  const x = Math.round(Number(n))
  return isFinite(x) ? Math.max(lo, Math.min(hi, x)) : lo
}

/** 星期：1=周一 … 7=周日；支持「星期三」「周三」「3」「Wednesday」「Wed」「0=周日」 */
export function dayFromValue(v) {
  if (v == null || v === '') return 0
  if (typeof v === 'number') {
    // 越界的数字是脏数据，不能 clamp 成周日，否则会凭空造出一门课
    if (v === 0) return 7
    const n = Math.round(v)
    return n >= 1 && n <= 7 ? n : 0
  }
  const s = String(v).trim()
  const cn = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7, 末: 7 }
  const m = /星期\s*([一二三四五六日天])|周\s*([一二三四五六日天])|([一二三四五六日天])\s*\(?周?\)?/.exec(s)
  if (m) {
    const ch = m[1] || m[2] || m[3]
    if (cn[ch]) return cn[ch]
  }
  const en = { mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6, sun: 7, sunday: 7 }
  const e = /[a-z]+/i.exec(s)
  if (e && en[e[0].toLowerCase()]) return en[e[0].toLowerCase()]
  const num = Number(s.replace(/[^\d]/g, ''))
  if (isFinite(num) && num >= 0 && num <= 7) return num === 0 ? 7 : num
  return 0
}

/** 节次：{start,end}，支持 "1-3" / "第 1~3 节" / "1,2,3" / [1,3] / 数字 */
export function sectionsFromValue(v, fallbackStart) {
  const base = clampInt(fallbackStart || 1, 1, 12)
  if (v == null || v === '') return { start: base, end: base }
  if (Array.isArray(v)) {
    if (!v.length) return { start: base, end: base }
    const nums = v.map((x) => clampInt(x, 1, 12))
    return { start: Math.min.apply(null, nums), end: Math.max.apply(null, nums) }
  }
  if (typeof v === 'number') return { start: clampInt(v, 1, 12), end: clampInt(v, 1, 12) }
  const s = String(v)
  const pair = /(\d{1,2})\s*[-~—－至到,、]\s*(\d{1,2})/.exec(s)
  if (pair) {
    const a = clampInt(pair[1], 1, 12)
    const b = clampInt(pair[2], 1, 12)
    return { start: Math.min(a, b), end: Math.max(a, b) }
  }
  const nums = (s.match(/\d{1,2}/g) || []).map((x) => clampInt(x, 1, 12))
  if (nums.length) return { start: Math.min.apply(null, nums), end: Math.max.apply(null, nums) }
  return { start: base, end: base }
}

/**
 * 周次字符串 → 若干连续段。我们的课程模型一段只能存 [weekStart, weekEnd]，
 * 所以 "2-3,8-17" 会拆成两条课程记录，而不是丢掉后半段。
 * 支持："1-16" / "2-3,8-17" / "1,3,5-8" / "第 1-16 周" / "1-16单" / "单周 1-16" / [1,2,3]
 */
export function parseWeeks(v, wtHint) {
  let wt = 0
  if (typeof wtHint === 'number') wt = wtHint === 1 ? 1 : wtHint === 2 ? 2 : 0
  else if (wtHint != null) {
    const w = String(wtHint)
    if (/双/.test(w)) wt = 2
    else if (/单|奇/.test(w)) wt = 1
    else if (/^\d$/.test(w.trim())) wt = clampInt(w, 0, 2)
  }
  const detect = (s) => {
    if (/双周|双数周/.test(s)) return 2
    if (/单周|单数周|奇[数周]/.test(s)) return 1
    return 0
  }
  if (v == null || v === '') return [{ weekStart: 1, weekEnd: 16, weekType: wt }]
  let text = ''
  let nums = []
  if (Array.isArray(v)) nums = v.map((x) => clampInt(x, 1, 30)).filter((x) => x >= 1)
  else if (typeof v === 'object') {
    const ws = pick(v, WS_KEYS)
    const we = pick(v, WE_KEYS)
    const a = clampInt(ws || 1, 1, 30)
    const b = clampInt(we || a, a, 30)
    wt = wt || detect(JSON.stringify(v)) || 0
    return [{ weekStart: a, weekEnd: b, weekType: wt }]
  } else {
    text = String(v)
    wt = wt || detect(text)
    // 先抽所有 "a-b" 区间，再把剩下的散点数字合并进来
    text = text.replace(/第/g, '').replace(/周(次|数)?/g, '')
    const parts = text.split(/[,，;；、\/\s]+/).filter(Boolean)
    parts.forEach((p) => {
      const m = /(\d{1,2})\s*[-~—－至到]\s*(\d{1,2})/.exec(p)
      if (m) {
        const a = clampInt(m[1], 1, 30)
        const b = clampInt(m[2], 1, 30)
        for (let i = Math.min(a, b); i <= Math.max(a, b); i++) nums.push(i)
      } else if (/^\d{1,2}$/.test(p)) nums.push(clampInt(p, 1, 30))
    })
  }
  if (!nums.length) return [{ weekStart: 1, weekEnd: 16, weekType: wt }]
  nums = Array.from(new Set(nums)).sort((a, b) => a - b)
  const segs = []
  let a = nums[0]
  let prev = nums[0]
  for (let i = 1; i < nums.length; i++) {
    if (nums[i] === prev + 1) {
      prev = nums[i]
    } else {
      segs.push({ weekStart: a, weekEnd: prev, weekType: wt })
      a = prev = nums[i]
    }
  }
  segs.push({ weekStart: a, weekEnd: prev, weekType: wt })
  return segs
}

function cleanText(s) {
  return String(s == null ? '' : s)
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>/gi, '|')
    .replace(/<[^>]*>/g, '')
    .replace(/[\t\r\n]+/g, ' ')
    .replace(/\s*\|\s*/g, '|')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/** 一条 JSON 课程记录 → 若干条（周次多段会拆开），字段已按本 App 模型命名 */
export function normalizeEduRecord(raw) {
  if (!raw || typeof raw !== 'object') return []
  const name = cleanText(pick(raw, NAME_KEYS))
  if (!name || name.length < 2) return []
  const day = dayFromValue(pick(raw, DAY_KEYS))
  if (!day) return []
  const periods = pick(raw, PERIOD_KEYS)
  const st = pick(raw, START_KEYS)
  const en = pick(raw, END_KEYS)
  let sec
  if (periods != null && periods !== '') sec = sectionsFromValue(periods, st || 1)
  else if (st != null || en != null) {
    const a = clampInt(st || en || 1, 1, 12)
    const b = clampInt(en || st || a, 1, 12)
    sec = { start: Math.min(a, b), end: Math.max(a, b) }
  } else sec = { start: 1, end: 1 }
  const teacher = cleanText(pick(raw, TEACHER_KEYS))
  const location = cleanText(pick(raw, LOCATION_KEYS))
  const weeksRaw = pick(raw, WEEKS_KEYS)
  const ws = pick(raw, WS_KEYS)
  const we = pick(raw, WE_KEYS)
  const wtHint = pick(raw, WT_KEYS)
  let segs
  if (weeksRaw != null && weeksRaw !== '') segs = parseWeeks(weeksRaw, wtHint)
  else if (ws != null || we != null) {
    const a = clampInt(ws || 1, 1, 30)
    const b = clampInt(we || a, a, 30)
    const wt = /双/.test(String(wtHint)) ? 2 : /单|奇/.test(String(wtHint)) ? 1 : 0
    segs = [{ weekStart: a, weekEnd: b, weekType: wt }]
  } else segs = parseWeeks(null, wtHint)

  return segs.map((sg) => ({
    name,
    teacher,
    location,
    day,
    start: sec.start,
    end: sec.end,
    weekStart: sg.weekStart,
    weekEnd: sg.weekEnd,
    weekType: sg.weekType,
    color: (day - 1) % 6,
  }))
}

/** 在任意层级的 JSON 里找出「最像课程列表」的数组 */
function findCourseArray(root, depth) {
  if (depth == null) depth = 0
  if (depth > 4 || root == null) return []
  if (Array.isArray(root)) {
    const score = root.filter((x) => x && typeof x === 'object' && (pick(x, NAME_KEYS) || pick(x, DAY_KEYS))).length
    return score > 0 ? root : []
  }
  if (typeof root !== 'object') return []
  let best = []
  const prefer = /course|kb|timetable|schedule|list|rows|data|result|课表|课程/i
  const keys = Object.keys(root).sort((a, b) => (prefer.test(b) ? 1 : 0) - (prefer.test(a) ? 1 : 0))
  for (const k of keys) {
    const v = root[k]
    if (!v || typeof v !== 'object') continue
    if (Array.isArray(v)) {
      const score = v.filter((x) => x && typeof x === 'object' && pick(x, NAME_KEYS)).length
      if (score > best.filter((x) => x && typeof x === 'object' && pick(x, NAME_KEYS)).length) best = v
    } else {
      const nested = findCourseArray(v, depth + 1)
      if (nested.length > best.length) best = nested
    }
  }
  return best
}

export function parseJsonCourses(root) {
  const arr = findCourseArray(root)
  const out = []
  arr.forEach((r) => out.push.apply(out, normalizeEduRecord(r)))
  return out
}

// ---------------------------------------------------------------- HTML 表格

function parseRows(tableHtml) {
  const rows = []
  const trRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi
  let m
  while ((m = trRe.exec(tableHtml))) {
    const cells = []
    const cellRe = /<(td|th)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi
    let c
    while ((c = cellRe.exec(m[1]))) {
      const text = cleanText(c[3])
      const rs = /rowspan\s*=\s*["']?(\d+)/i.exec(c[2])
      const cs = /colspan\s*=\s*["']?(\d+)/i.exec(c[2])
      cells.push({ text, rowSpan: rs ? clampInt(rs[1], 1, 12) : 1, colSpan: cs ? clampInt(cs[1], 1, 8) : 1 })
    }
    if (cells.length) rows.push(cells)
  }
  return rows
}

const WEEKDAY_HEAD = /星期[一二三四五六日天]|周[一二三四五六日天]|周[1-7]|monday|mon\b|tue|wed|thu|fri|sat|sun/i

function headerMap(row) {
  const map = {}
  let hit = 0
  row.forEach((c, i) => {
    if (WEEKDAY_HEAD.test(c.text)) {
      const d = dayFromValue(c.text)
      if (d) {
        map[i] = d
        hit++
      }
    }
  })
  return hit >= 3 ? map : null
}

function looksLikeCourse(text) {
  if (!text || text.length < 3) return false
  if (/^(星期|周[一二三四五六日天1-7]|第?\s*\d{1,2}\s*节|上午|下午|晚上|时间|节次|周一|周一至周五)$/.test(text)) return false
  if (/^\d{1,2}[:：]\d{2}/.test(text)) return false
  if (!/[\u4e00-\u9fa5A-Za-z]/.test(text)) return false
  return true
}

/** 从课程格文本里拆出：名称 / 周次 / 单双周 / 节次 / 地点 / 教师 */
function courseFromCell(text, day, start, end) {
  const parts = text.split('|').map((x) => x.trim()).filter(Boolean)
  if (!parts.length) return []
  const wt = /双周|双数周/.test(text) ? 2 : /单周|单数周/.test(text) ? 1 : 0
  const secM = /(\d{1,2})\s*[-~—]\s*(\d{1,2})\s*节/.exec(text)
  if (secM) {
    start = clampInt(secM[1], 1, 12)
    end = clampInt(secM[2], 1, 12)
  }
  const weekM = /(\d{1,2})\s*[-~—]\s*(\d{1,2})\s*周/.exec(text) || /(\d{1,2})\s*[-~—]\s*(\d{1,2})(?:\s*$)/.exec(text)
  let segs = [{ weekStart: 1, weekEnd: 16, weekType: wt }]
  if (weekM) {
    const a = clampInt(weekM[1], 1, 30)
    const b = clampInt(weekM[2], 1, 30)
    segs = [{ weekStart: Math.min(a, b), weekEnd: Math.max(a, b), weekType: wt }]
  } else {
    const multi = /(\d{1,2}\s*[-~—]\s*\d{1,2}(?:\s*[,，]\s*\d{1,2}\s*[-~—]\s*\d{1,2})+)/.exec(text)
    if (multi) segs = parseWeeks(multi[1], wt)
  }
  // 课程名：第一段含中文/字母、且不是纯元数据的片段
  let name = ''
  for (const p of parts) {
    const plain = p.replace(/[（(].*?[)）]/g, '').trim()
    if (!looksLikeCourse(plain)) continue
    if (/^\d{1,2}\s*[-~—]\s*\d{1,2}\s*周?$/.test(plain)) continue
    if (/^第?\s*\d{1,2}\s*[-~—]?\s*\d{0,2}\s*节?$/.test(plain)) continue
    name = plain.slice(0, 40)
    break
  }
  if (!name) return []
  // 地点：必须是含地点词的片段，且不能是周次/节次（"1-16周" 曾被误判成教室号）
  let location = ''
  for (const p of parts) {
    if (/周|节|单周|双周/.test(p)) continue
    if (/(教室|[教试]\s?\d|楼|室|校区|实验|机房|操场)/.test(p) && p.length <= 24 && p !== name) {
      location = p.slice(0, 40)
      break
    }
  }
  // 教师：2~4 个汉字且不是课程名/地点/周次的片段
  let teacher = ''
  for (const p of parts) {
    if (/^[\u4e00-\u9fa5]{2,4}$/.test(p) && p !== name && p !== location && !/周|节|单|双/.test(p)) {
      teacher = p
      break
    }
  }
  return segs.map((sg) => ({
    name, teacher, location, day,
    start, end,
    weekStart: sg.weekStart, weekEnd: sg.weekEnd, weekType: sg.weekType,
    color: (day - 1) % 6,
  }))
}

function coursesFromTable(rows) {
  if (rows.length < 2) return []
  let map = headerMap(rows[0])
  let body = rows
  if (map) body = rows.slice(1)
  else {
    // 没表头：按「第 0 列是节次、1..7 列是周一..周日」的常见布局
    map = {}
    for (let i = 1; i <= 7; i++) map[i] = i
  }
  const out = []
  let rowNo = 0
  body.forEach((row) => {
    rowNo++
    // 常见布局第 0 列是「1-2」「3-4」这类大节，用它当这一行的真实节次，
    // 比拿行号当节次准得多；没有节次列时再退回行号。
    let start = rowNo
    let end = rowNo
    const first = row[0] ? row[0].text : ''
    const sec = /(\d{1,2})\s*[-~—]\s*(\d{1,2})/.exec(first)
    if (sec) {
      start = clampInt(sec[1], 1, 12)
      end = clampInt(sec[2], 1, 12)
    }
    row.forEach((cell, ci) => {
      const day = map[ci]
      if (!day || !looksLikeCourse(cell.text)) return
      // 一格默认一门课：按固定块数硬拆会把「课程名/周次/教师/地点」切成多门假课
      const parsed = courseFromCell(cell.text, day, start, Math.max(end, start + cell.rowSpan - 1))
      if (parsed.length) out.push.apply(out, parsed)
    })
  })
  return out
}

export function parseHtmlTable(html) {
  const tables = String(html || '').match(/<table\b[^>]*>[\s\S]*?<\/table>/gi) || []
  let best = []
  for (const t of tables) {
    const courses = coursesFromTable(parseRows(t))
    if (courses.length > best.length) best = courses
  }
  return best
}

/** 统一入口：自动判 JSON / HTML，返回已按本 App 模型规整的课程 */
export function parseEduText(text, url) {
  const raw = String(text == null ? '' : text).trim()
  const warnings = []
  if (!raw) return { courses: [], source: 'empty', warnings: ['没有读到页面内容'] }
  let source = 'html'
  let found = []
  if (/^[\s]*[{[]/.test(raw)) {
    try {
      const obj = JSON.parse(raw)
      found = parseJsonCourses(obj)
      source = 'json'
      if (!found.length) warnings.push('JSON 里没有识别到课程字段，可换用「粘贴 HTML」或手动录入')
    } catch (e) {
      warnings.push('内容像 JSON 但解析失败，按 HTML 表格再试一次')
    }
  }
  if (!found.length) {
    found = parseHtmlTable(raw)
    source = found.length ? 'html-table' : source
  }
  if (!found.length && /\d{1,2}\s*[-~—]\s*\d{1,2}/.test(raw)) {
    warnings.push('页面里有周次/节次数字，但没找到课表表格结构')
  }
  const seen = {}
  const courses = []
  found.forEach((c) => {
    const n = normalizeCourse(c)
    if (!n) return
    const k = [n.name, n.day, n.start, n.end, n.weekStart, n.weekEnd, n.weekType].join('|')
    if (seen[k]) return
    seen[k] = 1
    courses.push(n)
  })
  if (!courses.length && !warnings.length) warnings.push('没能从当前页识别出课程，请确认已经打开「课表」而不是登录页')
  return { courses, source, url: url || '', warnings }
}

/** 合并进现有课表：replace 覆盖，append 追加（同 id 视为同一门课） */
export function mergeTimetable(existing, parsed, mode, termStart) {
  const base = mode === 'append' ? (existing && Array.isArray(existing.courses) ? existing.courses.slice() : []) : []
  const seen = {}
  base.forEach((c) => {
    if (c && c.id) seen[c.id] = 1
  })
  const courses = base.slice()
  ;(parsed && parsed.courses ? parsed.courses : []).forEach((c) => {
    if (!c || seen[c.id]) return
    seen[c.id] = 1
    courses.push(c)
  })
  return { termStart: termStart || (existing && existing.termStart) || '', courses }
}
