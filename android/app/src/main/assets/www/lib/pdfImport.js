/* 课表 PDF 的 AI 识别层：提示词、请求体、模型输出的抽取与归一化。
 *
 * 这一层不碰 DOM、不发请求，全部是纯函数，好处是能在 Node 里直接单测：
 *   - 模型把 JSON 包在 ```json 里、前后写解释、字段名大小写不一、星期写成「周一」、
 *     节次写成「第 3-4 节」、周次写成「1-16周(单)」……这些都得在这里吃掉。
 *   - 识别不出来时不能猜造课程：要么留空并挂一条待确认，要么整条丢弃。
 *
 * 课程最终仍走 lib/timetable.js 的 normalizeCourse，这里只产出「草稿」：
 * 多带 issues（待确认字段）与 srcWeeks（AI 看到的周次原文），供预览页校正。
 */

import { dayFromValue, parseWeeks, sectionsFromValue } from './edu.js'
import { MAX_SLOTS } from './timetable.js'

/** 一次最多接受多少条，超出说明模型在胡编（正常课表不会超过这个数） */
export const MAX_AI_COURSES = 200
/** 图片模式下最多带几页，和原生 PdfIngest.MAX_PAGES 对齐 */
export const MAX_AI_PAGES = 4

/** 模型输出必须是这个形状；字段说明写清楚，减少「自由发挥」 */
export const AI_SCHEMA_HINT = `{
  "termStart": "开学第一周周一的日期，形如 2026-09-01；看不出来就留空字符串",
  "courses": [
    {
      "name": "课程名称（必填，原样抄，不要翻译、不要补全）",
      "teacher": "任课教师，没有就留空字符串",
      "location": "上课地点/教室，没有就留空字符串",
      "day": 1,
      "start": 1,
      "end": 2,
      "weeks": "周次原文，如 1-16 / 2-3,8-17 / 1-16周(单)",
      "weekType": "all | odd | even，看不出就是 all",
      "confidence": "high | low",
      "uncertain": ["识别不准的字段名，如 location"]
    }
  ]
}`

/**
 * 系统提示。要点：
 *   1. 只输出 JSON，不要解释，避免解析器要处理大段散文；
 *   2. day 用 1-7 数字，start/end 用节次序号，别输出「周一」「第1-2节」；
 *   3. 同一门课不同周次/不同天要拆成多条，和本 App 的课程模型对齐；
 *   4. 看不清就留空 + confidence=low，禁止编造。
 */
export function aiSystemPrompt() {
  return [
    '你是课表识别助手。用户会给你一份课表（可能是文本，也可能是页面图片），',
    '请把其中的课程逐条抽成 JSON。',
    '',
    '严格遵守：',
    '1. 只输出一个 JSON 对象，不要 Markdown 代码块、不要任何解释文字。',
    '2. 字段形状如下：',
    AI_SCHEMA_HINT,
    '3. day 用数字 1-7 表示周一到周日；start/end 是节次序号（第 1 节 = 1），',
    '   如果课表写的是具体时间（如 08:00-09:40），按课表里的节次表换算成节次；',
    '   完全看不出节次就填 1 和 2，并把 "start"/"end" 放进 uncertain。',
    '4. 一门课在多个星期、多个时间段、多个周次段上课时，拆成多条记录。',
    '5. 周次优先填 weeks 原文（保留「单周」「双周」「1-16」这类写法）。',
    '6. 宁缺毋滥：看不清的字段留空字符串，并把字段名放进 uncertain；',
    '   完全无法确认是不是课程的（表头、页码、教室列表、备注）不要输出。',
    '7. 不要合并同名但时间不同的课，也不要给课程改名或翻译。',
  ].join('\n')
}

/** 文本模式的 user 消息：把抽取到的文本原样给它，保留换行（表格靠换行还原） */
export function buildTextUserMessage(text, meta) {
  const t = String(text || '').replace(/\r/g, '').trim()
  const head = []
  if (meta && meta.fileName) head.push('文件名：' + meta.fileName)
  if (meta && meta.pages) head.push('PDF 页数：' + meta.pages)
  head.push('说明：下面是 PDF 的文本层内容，按页面顺序排列，换行代表原来的行。')
  return head.join('\n') + '\n\n【课表文本开始】\n' + t + '\n【课表文本结束】'
}

/** 图片模式的 user 消息：图片走 image_url，文字部分只说明页序 */
export function buildVisionUserMessage(count, meta) {
  const lines = []
  if (meta && meta.fileName) lines.push('文件名：' + meta.fileName)
  lines.push('说明：下面是课表 PDF 渲染出来的 ' + count + ' 页图片，按页码顺序排列。')
  lines.push('请把每一页里的课程都抽出来；跨页重复的同一门课只保留一条。')
  return lines.join('\n')
}

/**
 * 组装 OpenAI 兼容的 chat/completions 请求体。
 * 文本模式用字符串 content（兼容性最好）；图片模式用 content 数组，
 * 每张图是 data URL —— 本地 /__pdfpage/ 图片模型访问不到，必须内联。
 */
export function buildRequestBody(opt) {
  const mode = opt && opt.mode === 'vision' ? 'vision' : 'text'
  const model = String((opt && opt.model) || '')
  const userText = mode === 'vision' ? buildVisionUserMessage((opt.images || []).length, opt.meta) : buildTextUserMessage(opt.text, opt.meta)
  const content =
    mode === 'vision'
      ? [{ type: 'text', text: userText }].concat(
          (opt.images || []).map((url) => ({ type: 'image_url', image_url: { url } }))
        )
      : userText
  const body = {
    model,
    temperature: 0.1,
    stream: false,
    messages: [
      { role: 'system', content: aiSystemPrompt() },
      { role: 'user', content },
    ],
  }
  if (mode === 'text') body.max_tokens = 4000
  return JSON.stringify(body)
}

/**
 * 从模型输出里挖出 JSON。要处理的真实情况：
 *   - ```json ... ``` 围栏
 *   - 「好的，这是识别结果：{...}」这类前后说明
 *   - 直接是数组
 *   - 末尾被 max_tokens 截断（括号不闭合）→ 尽量配平后解析
 */
export function extractJson(raw) {
  let s = String(raw == null ? '' : raw).trim()
  if (!s) return null
  // 去掉围栏标记，保留内容
  s = s.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim()

  const direct = tryParse(s)
  if (direct) return direct

  // 扫描：从第一个 { 或 [ 开始按「括号栈」配平（跳过字符串内的括号）。
  // 只数一种括号会在 {"courses":[{...}]} 里提前收尾，把内层对象当成整份结果。
  const start = firstIndex(s, ['{', '['])
  if (start < 0) return null
  const stack = []
  let inStr = false
  let esc = false
  for (let i = start; i < s.length; i++) {
    const ch = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') {
      inStr = true
      continue
    }
    if (ch === '{') stack.push('}')
    else if (ch === '[') stack.push(']')
    else if (ch === '}' || ch === ']') {
      if (stack.length && stack[stack.length - 1] === ch) stack.pop()
      if (stack.length === 0) {
        const piece = s.slice(start, i + 1)
        const parsed = tryParse(piece)
        if (parsed) return parsed
        // 多余逗号之类的常见小毛病，去掉再试一次
        const fixed = tryParse(piece.replace(/,\s*([}\]])/g, '$1'))
        if (fixed) return fixed
        break
      }
    }
  }

  // 截断的 JSON：把未闭合的括号按栈补齐（宁可少几条，也不要把整份丢掉）
  if (stack.length) {
    let piece = s.slice(start).replace(/,\s*$/, '')
    for (let k = stack.length - 1; k >= 0; k--) piece += stack[k]
    return tryParse(piece.replace(/,\s*([}\]])/g, '$1'))
  }
  return null
}

function tryParse(s) {
  try {
    const v = JSON.parse(s)
    return v && typeof v === 'object' ? v : null
  } catch (e) {
    return null
  }
}

function firstIndex(s, chars) {
  let best = -1
  chars.forEach((c) => {
    const i = s.indexOf(c)
    if (i >= 0 && (best < 0 || i < best)) best = i
  })
  return best
}

/**
 * 从接口响应里取出「模型说的话」。
 * requestText 拿到的是原始响应体：可能是完整的 chat/completions JSON，
 * 也可能是 SSE 的 data: 行（有的服务忽略 stream:false）。两种都要能取，
 * 否则下一步 extractJson 会把 {"choices":...} 当成课表 JSON 去解析。
 */
export function extractContent(raw) {
  const s = String(raw == null ? '' : raw).trim()
  if (!s) return ''
  if (/^data:/m.test(s)) {
    let out = ''
    s.split(/\r?\n/).forEach((line) => {
      const m = /^data:\s*(.*)$/.exec(line.trim())
      if (!m || m[1] === '[DONE]') return
      try {
        const j = JSON.parse(m[1])
        const c = j && j.choices && j.choices[0]
        const d = c && (c.delta || c.message)
        if (d && typeof d.content === 'string') out += d.content
      } catch (e) {
        /* 单行坏掉不影响其它行 */
      }
    })
    if (out) return out
  }
  try {
    const j = JSON.parse(s)
    const c = j && j.choices && j.choices[0]
    if (c) {
      const msg = c.message || c.delta || {}
      if (typeof msg.content === 'string') return msg.content
      if (Array.isArray(msg.content)) return msg.content.map((x) => (x && typeof x.text === 'string' ? x.text : '')).join('')
      if (typeof c.text === 'string') return c.text
    }
    if (typeof j.content === 'string') return j.content
    if (typeof j.output_text === 'string') return j.output_text
  } catch (e) {
    /* 不是整体 JSON，按纯文本处理 */
  }
  return s
}

/** 模型可能把 courses 放在 data/result/list 里，也可能直接给数组 */
export function pickCourseArray(obj) {
  if (!obj) return []
  if (Array.isArray(obj)) return obj
  const keys = ['courses', 'course', 'data', 'result', 'list', 'timetable', 'items', 'rows']
  for (const k of keys) {
    const v = obj[k]
    if (Array.isArray(v)) return v
    if (v && typeof v === 'object' && Array.isArray(v.courses)) return v.courses
  }
  return []
}

const NAME_ALIAS = ['name', 'courseName', 'course_name', 'kcmc', 'title', '课程', '课程名称', '课名']
const TEACHER_ALIAS = ['teacher', 'teacherName', 'teacher_name', 'jsxm', '教师', '老师']
const LOC_ALIAS = ['location', 'room', 'classroom', 'place', '教室', '地点', '上课地点']
const DAY_ALIAS = ['day', 'weekday', 'dayOfWeek', '星期', '周几']
const START_ALIAS = ['start', 'startSection', 'periodStart', 'start_period', '起始节', '开始节次']
const END_ALIAS = ['end', 'endSection', 'periodEnd', 'end_period', '结束节', '结束节次']
const WEEKS_ALIAS = ['weeks', 'week', 'weekList', '周次', '上课周次']
const WT_ALIAS = ['weekType', 'week_type', '单双周', '周类型']
const CONF_ALIAS = ['confidence', 'confidenceLevel', '置信度']
const UNCERTAIN_ALIAS = ['uncertain', 'uncertainFields', '不确定', '待确认']

function val(obj, aliases) {
  if (!obj || typeof obj !== 'object') return undefined
  for (const a of aliases) {
    if (obj[a] != null && obj[a] !== '') return obj[a]
  }
  // 忽略大小写与下划线再找一遍
  const bag = {}
  Object.keys(obj).forEach((k) => {
    bag[String(k).toLowerCase().replace(/[\s_-]/g, '')] = obj[k]
  })
  for (const a of aliases) {
    const k = String(a).toLowerCase().replace(/[\s_-]/g, '')
    const v = bag[k]
    if (v != null && v !== '') return v
  }
  return undefined
}

function str(v, max) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max)
}

function intOf(v) {
  if (v == null || v === '') return 0
  const n = Math.round(Number(String(v).replace(/[^\d.-]/g, '')))
  return isFinite(n) ? n : 0
}

/**
 * 把一条模型输出变成草稿课程。
 * 返回 { draft } 或 { drop: '原因' }：课程名都没有的宁可丢，也不凭空造。
 */
export function mapAiCourse(raw, index) {
  const name = str(val(raw, NAME_ALIAS), 40)
  if (!name) return { drop: '缺少课程名称' }
  // 明显不是课程的行内标题（先去空白，「星 期」这种也要认出来）
  const compact = name.replace(/\s+/g, '')
  if (/^(星期|周次|节次|时间|课程表|课表|备注|上午|下午|晚上)/.test(compact) && compact.length <= 6) {
    return { drop: '表头而非课程：' + name }
  }

  const issues = []
  const uncertain = val(raw, UNCERTAIN_ALIAS)
  const lowConf = /^(low|低|0|false)$/i.test(String(val(raw, CONF_ALIAS) || ''))
  const marked = (field) =>
    (Array.isArray(uncertain) && uncertain.some((x) => String(x).toLowerCase().indexOf(field) >= 0)) || lowConf

  // 星期
  const dayRaw = val(raw, DAY_ALIAS)
  let day = dayFromValue(dayRaw)
  if (!day) {
    day = 1
    issues.push({ field: 'day', level: 'warn', text: '星期没认出来，暂按周一，请确认' })
  }

  // 节次：模型给的可能是「第1-2节」「1-2」或数字
  const startRaw = val(raw, START_ALIAS)
  const endRaw = val(raw, END_ALIAS)
  let start = 0
  let end = 0
  if (startRaw != null || endRaw != null) {
    const sec = sectionsFromValue(startRaw == null ? endRaw : startRaw)
    start = sec.start
    end = sectionsFromValue(endRaw == null ? startRaw : endRaw).end
  }
  if (!start || !end) {
    const sec = sectionsFromValue(startRaw != null ? startRaw : endRaw, 1)
    start = start || sec.start
    end = end || sec.end
    issues.push({ field: 'start', level: 'warn', text: '节次缺失，暂按第 ' + start + '-' + end + ' 节，请确认' })
  }
  if (start > MAX_SLOTS) start = MAX_SLOTS
  if (end > MAX_SLOTS) end = MAX_SLOTS
  if (end < start) end = start

  // 周次：原文优先；空的话给 1-16 并提示
  const weeksRaw = val(raw, WEEKS_ALIAS)
  const wtRaw = val(raw, WT_ALIAS)
  const hasWeeks = weeksRaw != null && String(weeksRaw).trim() !== ''
  // 「1-16周(单)」这种写法 parseWeeks 认不出来，先在这里归一成 hint
  let wtHint = wtRaw
  if (wtHint == null && hasWeeks) {
    const w = String(weeksRaw)
    if (/单|奇/.test(w)) wtHint = 1
    else if (/双/.test(w)) wtHint = 2
  }
  const segs = parseWeeks(hasWeeks ? weeksRaw : '', wtHint)
  if (!hasWeeks) issues.push({ field: 'weekStart', level: 'warn', text: '周次没写，暂按 1-16 周，请确认' })

  const teacher = str(val(raw, TEACHER_ALIAS), 30)
  const location = str(val(raw, LOC_ALIAS), 40)
  if (!location) issues.push({ field: 'location', level: 'info', text: '没识别到上课地点' })
  if (!teacher) issues.push({ field: 'teacher', level: 'info', text: '没识别到教师' })
  if (marked('location') && location) issues.push({ field: 'location', level: 'warn', text: '地点识别不确定，请核对' })
  if (marked('teacher') && teacher) issues.push({ field: 'teacher', level: 'warn', text: '教师识别不确定，请核对' })
  if (marked('day')) issues.push({ field: 'day', level: 'warn', text: '星期识别不确定，请核对' })

  const drafts = segs.map((seg, k) => ({
    key: 'ai' + index + '_' + k,
    name,
    teacher,
    location,
    day,
    start,
    end,
    weekStart: seg.weekStart,
    weekEnd: seg.weekEnd,
    weekType: seg.weekType,
    srcWeeks: hasWeeks ? String(weeksRaw) : '',
    issues: k === 0 ? issues.slice() : issues.filter((x) => x.field !== 'weekStart'),
    deleted: false,
  }))
  return { drafts }
}

/** 同一门课在多个周次段会拆成多条；完全相同的（同天同节同周）只留一条 */
export function dedupeDrafts(list) {
  const seen = {}
  const out = []
  ;(list || []).forEach((c) => {
    if (!c) return
    const k = [c.name, c.day, c.start, c.end, c.weekStart, c.weekEnd, c.weekType].join('|')
    if (seen[k]) return
    seen[k] = 1
    out.push(c)
  })
  return out
}

/**
 * 模型输出 → { courses, termStart, warnings, dropped }。
 * warnings 是整份结果级别的问题（比如一条都没识别出来），
 * 课程级的问题挂在每条的 issues 上，由预览页高亮。
 */
export function mapAiResult(obj, opt) {
  const arr = pickCourseArray(obj)
  const courses = []
  const warnings = []
  let dropped = 0
  arr.slice(0, MAX_AI_COURSES * 2).forEach((raw, i) => {
    const r = mapAiCourse(raw, i)
    if (r.drop) {
      dropped++
      return
    }
    r.drafts.forEach((d) => courses.push(d))
  })
  const uniq = dedupeDrafts(courses)
  if (uniq.length > MAX_AI_COURSES) {
    warnings.push('识别到 ' + uniq.length + ' 条，超过上限，只保留前 ' + MAX_AI_COURSES + ' 条')
    uniq.length = MAX_AI_COURSES
  }
  if (dropped > 0) warnings.push('有 ' + dropped + ' 行不是课程（表头/空行/无法确认），已跳过')
  const termStart = obj && typeof obj === 'object' && !Array.isArray(obj) ? str(obj.termStart || obj.startDate || '', 10) : ''
  return {
    courses: uniq,
    termStart: /^\d{4}-\d{2}-\d{2}$/.test(termStart) ? termStart : '',
    warnings,
    dropped,
    rawCount: arr.length,
  }
}

/** 用户在预览里改完某条后重新校验：返回新的 issues（null 表示这条要丢弃） */
export function revalidate(course) {
  if (!course) return null
  const name = str(course.name, 40)
  if (!name) return { drop: '课程名称不能为空' }
  const issues = []
  const day = Math.round(Number(course.day) || 0)
  if (day < 1 || day > 7) issues.push({ field: 'day', level: 'warn', text: '星期需在周一至周日之间' })
  const start = Math.round(Number(course.start) || 0)
  const end = Math.round(Number(course.end) || 0)
  if (start < 1 || start > MAX_SLOTS) issues.push({ field: 'start', level: 'warn', text: '节次需在 1-' + MAX_SLOTS + ' 之间' })
  if (end < start) issues.push({ field: 'end', level: 'warn', text: '结束节次不能早于开始节次' })
  const ws = Math.round(Number(course.weekStart) || 0)
  const we = Math.round(Number(course.weekEnd) || 0)
  if (ws < 1 || ws > 30) issues.push({ field: 'weekStart', level: 'warn', text: '起始周需在 1-30 之间' })
  if (we < ws) issues.push({ field: 'weekEnd', level: 'warn', text: '结束周不能早于起始周' })
  if (!course.location) issues.push({ field: 'location', level: 'info', text: '没识别到上课地点' })
  if (!course.teacher) issues.push({ field: 'teacher', level: 'info', text: '没识别到教师' })
  return { issues }
}

/** 草稿 → 写入用的课程对象（补齐 id/color，字段裁剪交给 normalizeCourse） */
export function toCourse(draft, seed) {
  return {
    id: draft.id || 'ai' + String(seed || Date.now()).slice(-8) + Math.random().toString(16).slice(2, 6),
    name: draft.name,
    teacher: draft.teacher,
    location: draft.location,
    day: draft.day,
    start: draft.start,
    end: draft.end,
    weekStart: draft.weekStart,
    weekEnd: draft.weekEnd,
    weekType: draft.weekType,
    color: draft.color,
  }
}

/** 预览页顶部的统计：几条待确认 / 几条可导入 */
export function summarize(courses) {
  const list = (courses || []).filter((c) => c && !c.deleted)
  let warn = 0
  let info = 0
  list.forEach((c) => {
    const issues = c.issues || []
    if (issues.some((x) => x.level === 'warn')) warn++
    else if (issues.length) info++
  })
  return { total: list.length, warn, info, ok: list.length - warn }
}
