/**
 * AI 课表识别的纯函数单测：模型输出抽取、字段归一化、待确认项与去重。
 *
 * 这一层是「AI 会胡说」与「课表必须干净」之间的闸门：
 * 它既不联网也不碰 DOM，所以可以在这里把各种脏输出按最坏情况喂一遍。
 *
 * 运行：node --experimental-default-type=module --test android/tests/pdf-import.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MAX_AI_COURSES,
  buildRequestBody,
  buildTextUserMessage,
  dedupeDrafts,
  extractContent,
  extractJson,
  mapAiCourse,
  mapAiResult,
  pickCourseArray,
  revalidate,
  summarize,
  toCourse,
} from '../app/src/main/assets/www/lib/pdfImport.js'

// ---------------------------------------------------------------- 模型输出抽取

test('extractJson：纯 JSON / 代码围栏 / 前后有解释文字都能取出对象', () => {
  assert.deepEqual(extractJson('{"courses":[]}'), { courses: [] })
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 })
  assert.deepEqual(extractJson('好的，识别结果如下：\n{"courses":[{"name":"高数"}]}\n希望对你有帮助'), {
    courses: [{ name: '高数' }],
  })
})

test('extractJson：顶层数组也支持', () => {
  const arr = extractJson('[{"name":"体育","day":3,"start":5,"end":6}]')
  assert.ok(Array.isArray(arr))
  assert.equal(arr[0].name, '体育')
})

test('extractJson：字符串里出现花括号不会被当成结案符', () => {
  const obj = extractJson('前言 {"courses":[{"name":"算法{设计}","day":1}]} 后记')
  assert.equal(obj.courses[0].name, '算法{设计}')
})

test('extractJson：被截断的输出补括号后仍尽量解析，且不抛错', () => {
  const obj = extractJson('{"courses":[{"name":"大学英语","day":2,"start":3,"end":4}')
  assert.ok(obj && Array.isArray(obj.courses))
  assert.equal(obj.courses[0].name, '大学英语')
})

test('extractJson：完全不是 JSON 时返回 null，不猜造', () => {
  assert.equal(extractJson('抱歉，我无法识别这份课表。'), null)
  assert.equal(extractJson(''), null)
  assert.equal(extractJson(null), null)
})

test('pickCourseArray：courses/data/result/list 嵌套与裸数组都能取', () => {
  assert.equal(pickCourseArray({ courses: [1] }).length, 1)
  assert.equal(pickCourseArray({ data: { courses: [1, 2] } }).length, 2)
  assert.equal(pickCourseArray({ result: [1] }).length, 1)
  assert.equal(pickCourseArray([1, 2, 3]).length, 3)
  assert.equal(pickCourseArray({ nothing: 1 }).length, 0)
})

// ---------------------------------------------------------------- 字段归一化

test('mapAiCourse：中文星期、中文节次、中文周次都能落到模型字段', () => {
  const r = mapAiCourse({ name: '高等数学', day: '星期三', start: '第 3-4 节', weeks: '1-16周', location: '教3-201', teacher: '张老师' }, 0)
  assert.ok(!r.drop)
  const c = r.drafts[0]
  assert.equal(c.day, 3)
  assert.equal(c.start, 3)
  assert.equal(c.end, 4)
  assert.equal(c.weekStart, 1)
  assert.equal(c.weekEnd, 16)
  assert.equal(c.location, '教3-201')
})

test('mapAiCourse：多段周次拆成多条，各自只带自己的周次', () => {
  const r = mapAiCourse({ name: '程序设计', day: 2, start: 1, end: 2, weeks: '2-3,8-17' }, 3)
  assert.equal(r.drafts.length, 2)
  assert.deepEqual(
    r.drafts.map((d) => [d.weekStart, d.weekEnd]),
    [
      [2, 3],
      [8, 17],
    ]
  )
})

test('mapAiCourse：单双周识别成 weekType，原文留在 srcWeeks 供核对', () => {
  const odd = mapAiCourse({ name: '体育', day: 4, start: 5, end: 6, weeks: '1-16周(单)' }, 0).drafts[0]
  assert.equal(odd.weekType, 1)
  const even = mapAiCourse({ name: '体育', day: 4, start: 5, end: 6, weeks: '2-16 双周' }, 0).drafts[0]
  assert.equal(even.weekType, 2)
  assert.match(odd.srcWeeks, /1-16/)
})

test('mapAiCourse：缺课程名 / 明显是表头 → 丢弃，不凭空造课', () => {
  assert.ok(mapAiCourse({ day: 1, start: 1 }, 0).drop)
  assert.ok(mapAiCourse({ name: '   ' }, 0).drop)
  assert.ok(mapAiCourse({ name: '星期' }, 0).drop)
  assert.ok(mapAiCourse({ name: '节次' }, 0).drop)
})

test('mapAiCourse：缺星期/节次/周次会给出 warn，并填可用的默认值', () => {
  const c = mapAiCourse({ name: '形势与政策' }, 0).drafts[0]
  assert.equal(c.day, 1)
  assert.ok(c.start >= 1 && c.end >= c.start)
  const fields = c.issues.filter((x) => x.level === 'warn').map((x) => x.field)
  assert.ok(fields.includes('day'))
  assert.ok(fields.includes('start'))
  assert.ok(fields.includes('weekStart'))
})

test('mapAiCourse：缺地点/教师只是 info，不算待确认', () => {
  const c = mapAiCourse({ name: '导论', day: 1, start: 1, end: 2, weeks: '1-8' }, 0).drafts[0]
  assert.ok(c.issues.every((x) => x.level !== 'warn'))
  assert.ok(c.issues.some((x) => x.field === 'location' && x.level === 'info'))
  assert.ok(c.issues.some((x) => x.field === 'teacher' && x.level === 'info'))
})

test('mapAiCourse：模型自报 confidence=low 或 uncertain 时升级为待确认', () => {
  const low = mapAiCourse({ name: '物理', day: 2, start: 3, end: 4, weeks: '1-16', confidence: 'low' }, 0).drafts[0]
  assert.ok(low.issues.some((x) => x.level === 'warn'))
  const marked = mapAiCourse(
    { name: '化学', day: 2, start: 3, end: 4, weeks: '1-16', location: 'B101', uncertain: ['location'] },
    0
  ).drafts[0]
  assert.ok(marked.issues.some((x) => x.field === 'location' && x.level === 'warn'))
})

test('mapAiCourse：字段别名（大写下划线 / 英文 / 中文）都能读', () => {
  const c = mapAiCourse(
    { Course_Name: '数据库', Day_Of_Week: 5, periodStart: 7, periodEnd: 8, weekList: '1-12', 教师: '李老师', 地点: 'B204' },
    0
  ).drafts[0]
  assert.equal(c.name, '数据库')
  assert.equal(c.day, 5)
  assert.equal(c.start, 7)
  assert.equal(c.end, 8)
  assert.equal(c.teacher, '李老师')
  assert.equal(c.location, 'B204')
})

// ---------------------------------------------------------------- 整份结果

test('mapAiResult：统计跳过项、校验 termStart、带出 warnings', () => {
  const r = mapAiResult({
    termStart: '2026-09-01',
    courses: [
      { name: '高数', day: 1, start: 1, end: 2, weeks: '1-16' },
      { name: '星  期' },
      { day: 3, start: 1 },
    ],
  })
  assert.equal(r.courses.length, 1)
  assert.equal(r.termStart, '2026-09-01')
  assert.equal(r.dropped, 2) // 表头「星 期」+ 缺名字的那条
  assert.ok(r.warnings.length >= 1)
})

test('mapAiResult：不合法的 termStart 直接置空，不写入脏日期', () => {
  const r = mapAiResult({ termStart: '九月一号', courses: [{ name: '数学', day: 1, start: 1, end: 2, weeks: '1-16' }] })
  assert.equal(r.termStart, '')
})

test('mapAiResult：完全相同的课程去重，同课不同周次保留', () => {
  const r = mapAiResult({
    courses: [
      { name: '高数', day: 1, start: 1, end: 2, weeks: '1-16' },
      { name: '高数', day: 1, start: 1, end: 2, weeks: '1-16' },
      { name: '高数', day: 1, start: 1, end: 2, weeks: '1-8' },
    ],
  })
  assert.equal(r.courses.length, 2)
})

test('mapAiResult：超过上限截断并提示，不无限制塞进课表', () => {
  const many = []
  for (let i = 0; i < MAX_AI_COURSES + 30; i++) {
    many.push({ name: '课' + i, day: (i % 7) + 1, start: (i % 12) + 1, end: (i % 12) + 1, weeks: '1-16' })
  }
  const r = mapAiResult({ courses: many })
  assert.equal(r.courses.length, MAX_AI_COURSES)
  assert.ok(r.warnings.some((w) => /超过上限/.test(w)))
})

test('mapAiResult：空结果返回 0 条，供页面提示「没识别到」', () => {
  const r = mapAiResult({ courses: [] })
  assert.equal(r.courses.length, 0)
  assert.equal(r.termStart, '')
})

// ---------------------------------------------------------------- 校正与导入

test('revalidate：改名后可通过，越界字段给出 warn', () => {
  assert.ok(revalidate({ name: '' }).drop)
  const bad = revalidate({ name: 'x', day: 9, start: 3, end: 1, weekStart: 10, weekEnd: 2, location: 'A', teacher: 'B' })
  const fields = bad.issues.map((x) => x.field)
  assert.ok(fields.includes('day'))
  assert.ok(fields.includes('end'))
  assert.ok(fields.includes('weekEnd'))
})

test('dedupeDrafts：同天同节同周只留一条', () => {
  const a = { name: 'A', day: 1, start: 1, end: 2, weekStart: 1, weekEnd: 16, weekType: 0 }
  assert.equal(dedupeDrafts([a, Object.assign({}, a), Object.assign({}, a, { weekType: 1 })]).length, 2)
})

test('toCourse：生成唯一 id，并把字段裁成课表模型认识的形状', () => {
  const d = { name: '高数', teacher: '张', location: 'A101', day: 1, start: 1, end: 2, weekStart: 1, weekEnd: 16, weekType: 0 }
  const a = toCourse(d, 1)
  const b = toCourse(d, 2)
  assert.ok(a.id && b.id && a.id !== b.id)
  assert.deepEqual(Object.keys(a).sort(), ['color', 'day', 'end', 'id', 'location', 'name', 'start', 'teacher', 'weekEnd', 'weekStart', 'weekType'])
})

test('summarize：只统计未删除的，warn 与 info 分开计数', () => {
  const s = summarize([
    { name: 'A', issues: [] },
    { name: 'B', issues: [{ level: 'warn' }] },
    { name: 'C', issues: [{ level: 'info' }] },
    { name: 'D', deleted: true, issues: [{ level: 'warn' }] },
  ])
  assert.deepEqual(s, { total: 3, warn: 1, info: 1, ok: 2 })
})

// ---------------------------------------------------------------- 响应解包

test('extractContent：完整 chat/completions 里取出 message.content', () => {
  const raw = JSON.stringify({
    choices: [{ message: { role: 'assistant', content: '{"courses":[{"name":"高数"}]}' } }],
  })
  assert.equal(extractContent(raw), '{"courses":[{"name":"高数"}]}')
})

test('extractContent：SSE 多行 data 拼接成完整正文，[DONE] 忽略', () => {
  const raw = ['data: {"choices":[{"delta":{"content":"{\\"courses\\":"}}]}', 'data: {"choices":[{"delta":{"content":"[]}"}}]}', 'data: [DONE]', ''].join('\n')
  assert.equal(extractContent(raw), '{"courses":[]}')
})

test('extractContent：纯文本原样返回，不硬套 JSON', () => {
  assert.equal(extractContent('抱歉，看不清这份课表'), '抱歉，看不清这份课表')
  assert.equal(extractContent(''), '')
})

test('extractContent + extractJson：真实链路能从接口响应一路拿到课程', () => {
  const raw = JSON.stringify({ choices: [{ message: { content: '```json\n{"courses":[{"name":"线性代数","day":2,"start":3,"end":4,"weeks":"1-16"}]}\n```' } }] })
  const r = mapAiResult(extractJson(extractContent(raw)))
  assert.equal(r.courses.length, 1)
  assert.equal(r.courses[0].name, '线性代数')
})

// ---------------------------------------------------------------- 请求体

test('buildRequestBody：文本模式用字符串 content，带 system 与低温度', () => {
  const body = JSON.parse(buildRequestBody({ mode: 'text', model: 'gpt-4o-mini', text: '周一 1-2 高数' }))
  assert.equal(body.model, 'gpt-4o-mini')
  assert.equal(body.temperature, 0.1)
  assert.equal(body.stream, false)
  assert.equal(body.messages.length, 2)
  assert.equal(body.messages[1].content.includes('周一 1-2 高数'), true)
})

test('buildRequestBody：图片模式带 text + image_url，且不把 data URL 落成字符串数组', () => {
  const body = JSON.parse(
    buildRequestBody({ mode: 'vision', model: 'qwen-vl-max', images: ['data:image/jpeg;base64,AAA', 'data:image/jpeg;base64,BBB'] })
  )
  const c = body.messages[1].content
  assert.ok(Array.isArray(c))
  assert.equal(c[0].type, 'text')
  assert.equal(c.filter((x) => x.type === 'image_url').length, 2)
  assert.equal(c[1].image_url.url, 'data:image/jpeg;base64,AAA')
})

test('buildTextUserMessage：保留换行（表格靠换行还原行结构）', () => {
  const s = buildTextUserMessage('周一 1-2 高数\n周二 3-4 英语', { fileName: '课表.pdf', pages: 1 })
  assert.match(s, /课表\.pdf/)
  assert.match(s, /周一 1-2 高数\n周二 3-4 英语/)
})
