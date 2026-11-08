/**
 * 教务系统一键导入：解析层回归。
 *
 * 运行：
 *   node --experimental-default-type=module --test android/tests/edu-import.test.mjs
 *
 * 说明：JSON 用例的字段结构与用户桌面「教学安排表.json」完全一致
 * （course_name / weekday / period_start / period_end / weeks / location / teacher），
 * 值已脱敏；真实样本另在发布前单独跑过一次，33 条课程全部识别。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  dayFromValue,
  sectionsFromValue,
  parseWeeks,
  parseEduText,
  parseHtmlTable,
  parseJsonCourses,
  normalizeEduRecord,
  mergeTimetable,
  EDU_PRESETS,
} from '../app/src/main/assets/www/lib/edu.js'

// ---------------------------------------------------------------- 字段归一

test('dayFromValue：中文 / 数字 / 英文星期都归一到 1..7', () => {
  assert.equal(dayFromValue('星期一'), 1)
  assert.equal(dayFromValue('周三'), 3)
  assert.equal(dayFromValue('星期日'), 7)
  assert.equal(dayFromValue('星期天'), 7)
  assert.equal(dayFromValue(5), 5)
  assert.equal(dayFromValue(0), 7) // 有些教务系统用 0 表示周日
  assert.equal(dayFromValue('Friday'), 5)
  assert.equal(dayFromValue('3'), 3)
  assert.equal(dayFromValue(''), 0)
})

test('sectionsFromValue：区间 / 数组 / 单节 / 中文节次', () => {
  assert.deepEqual(sectionsFromValue('1-3', 1), { start: 1, end: 3 })
  assert.deepEqual(sectionsFromValue('第 1~3 节', 1), { start: 1, end: 3 })
  assert.deepEqual(sectionsFromValue([3, 1], 1), { start: 1, end: 3 })
  assert.deepEqual(sectionsFromValue(4, 1), { start: 4, end: 4 })
  assert.deepEqual(sectionsFromValue('', 2), { start: 2, end: 2 })
})

test('parseWeeks：多段周次拆开、单双周、连续数字合并', () => {
  assert.deepEqual(parseWeeks('2-3,8-17'), [
    { weekStart: 2, weekEnd: 3, weekType: 0 },
    { weekStart: 8, weekEnd: 17, weekType: 0 },
  ])
  assert.deepEqual(parseWeeks('第 1-16 周 单周'), [{ weekStart: 1, weekEnd: 16, weekType: 1 }])
  assert.deepEqual(parseWeeks('1-8双周'), [{ weekStart: 1, weekEnd: 8, weekType: 2 }])
  assert.deepEqual(parseWeeks([1, 2, 3, 7]), [
    { weekStart: 1, weekEnd: 3, weekType: 0 },
    { weekStart: 7, weekEnd: 7, weekType: 0 },
  ])
  assert.deepEqual(parseWeeks(null), [{ weekStart: 1, weekEnd: 16, weekType: 0 }])
})

// ---------------------------------------------------------------- JSON 来源

const SAMPLE_JSON = {
  meta: { student_id: '2026000001', student_name: '同学', academic_year: '2026', source_file: '教学安排表.xls' },
  courses: [
    {
      id: 1, course_name: '思想道德与法治', teacher: '陈老师', day_of_week: '星期一', weekday: 1,
      period_start: 1, period_end: 3, periods: '1-3', weeks: '2-3,8-17', week_type: null, location: '8502-8504',
    },
    {
      id: 2, course_name: '大学英语1', teacher: '李老师', day_of_week: '星期二', weekday: 2,
      period_start: 5, period_end: 6, periods: '5-6', weeks: '1-16 单周', location: '外语楼302',
    },
    {
      id: 3, course_name: '经济数学', teacher: '王老师', day_of_week: '星期四', weekday: 4,
      period_start: 3, period_end: 4, periods: '3-4', weeks: '1-12', location: '教3-201',
    },
  ],
}

test('parseEduText：教学安排表 JSON 的字段、节次、教师、地点全部识别', () => {
  const r = parseEduText(JSON.stringify(SAMPLE_JSON))
  assert.equal(r.source, 'json')
  assert.equal(r.warnings.length, 0)
  // 第一门课周次是两段，应拆成两条；合计 4 条
  assert.equal(r.courses.length, 4)
  const first = r.courses.filter((c) => c.name === '思想道德与法治')
  assert.equal(first.length, 2)
  assert.deepEqual(first.map((c) => [c.weekStart, c.weekEnd]).sort(), [[2, 3], [8, 17]])
  assert.deepEqual([first[0].day, first[0].start, first[0].end], [1, 1, 3])
  assert.equal(first[0].teacher, '陈老师')
  assert.equal(first[0].location, '8502-8504')
  const eng = r.courses.filter((c) => c.name === '大学英语1')[0]
  assert.equal(eng.weekType, 1)
  assert.equal(eng.day, 2)
  assert.equal(eng.start, 5)
  assert.equal(eng.location, '外语楼302')
})

test('parseEduText：嵌套在 data / kbList 里的接口 JSON 也能找到课程数组', () => {
  const api = {
    code: 200,
    data: {
      kbList: [
        { kcmc: '高等数学', xqj: '3', ksjc: 1, jsjc: 2, zc: '1-16', jsxm: '张老师', skdd: '教3-201' },
        { kcmc: '线性代数', xqj: '5', ksjc: 7, jsjc: 8, zc: '2-16双周', skdd: '教4-102' },
      ],
    },
  }
  const r = parseEduText(JSON.stringify(api), 'https://jw.example.edu.cn/api/kb')
  assert.equal(r.source, 'json')
  assert.equal(r.courses.length, 2)
  assert.equal(r.courses[0].name, '高等数学')
  assert.equal(r.courses[0].day, 3)
  assert.equal(r.courses[1].weekType, 2)
  assert.equal(r.url, 'https://jw.example.edu.cn/api/kb')
})

test('normalizeEduRecord：缺课程名 / 缺星期直接丢弃，不猜造课程', () => {
  assert.deepEqual(normalizeEduRecord({ course_name: '', weekday: 1 }), [])
  assert.deepEqual(normalizeEduRecord({ course_name: '体育' }), [])
  assert.deepEqual(normalizeEduRecord({ course_name: '体育', weekday: 9 }), []) // 越界星期不算
  assert.equal(parseJsonCourses(SAMPLE_JSON).length, 4)
})

// ---------------------------------------------------------------- HTML 来源

const ZF_HTML = `<html><body>
<table id="kbtable">
  <tr><th>节次</th><th>星期一</th><th>星期二</th><th>星期三</th><th>星期四</th><th>星期五</th><th>星期六</th><th>星期日</th></tr>
  <tr><td>1-2</td><td>高等数学<br>1-16周<br>张老师<br>教3-201</td><td></td><td></td><td></td><td></td><td></td><td></td></tr>
  <tr><td>3-4</td><td></td><td>大学英语<br>1-16周 单周<br>李老师<br>外语楼302</td><td></td><td></td><td></td><td></td><td></td><td></td></tr>
</table>
<table><tr><td>无关表格</td></tr></table>
</body></html>`

test('parseEduText：正方风格课表表格，节次 / 星期 / 地点 / 单双周', () => {
  const r = parseEduText(ZF_HTML, 'https://jw.example.edu.cn/kb')
  assert.equal(r.source, 'html-table')
  assert.equal(r.courses.length, 2)
  const math = r.courses.filter((c) => c.name === '高等数学')[0]
  assert.deepEqual([math.day, math.start, math.end], [1, 1, 2])
  assert.equal(math.location, '教3-201')
  assert.equal(math.teacher, '张老师')
  assert.deepEqual([math.weekStart, math.weekEnd, math.weekType], [1, 16, 0])
  const eng = r.courses.filter((c) => c.name === '大学英语')[0]
  assert.deepEqual([eng.day, eng.start, eng.end], [2, 3, 4])
  assert.equal(eng.weekType, 1)
  assert.equal(eng.location, '外语楼302')
})

test('parseHtmlTable：iframe 里的课表与外层无关表格共存时取课程最多的一张', () => {
  const html = ZF_HTML + '<!--FRAME-->' + `<table><tr><th>星期一</th></tr><tr><td>体育<br>1-16周<br>教1-101</td></tr></table>`
  assert.equal(parseHtmlTable(html).length, 2)
})

test('parseEduText：登录页 / 空内容不会硬造课程，给出可读提示', () => {
  const empty = parseEduText('')
  assert.equal(empty.courses.length, 0)
  assert.ok(empty.warnings.length)
  const login = parseEduText('<html><body><input type="password"><button>登录</button></body></html>')
  assert.equal(login.courses.length, 0)
  assert.ok(login.warnings.join('').includes('识别') || login.warnings.join('').includes('课表'))
})

// ---------------------------------------------------------------- 合并

test('mergeTimetable：覆盖 / 追加 / 保留开学日期', () => {
  const existing = { termStart: '2026-09-07', courses: [{ id: 'old', name: '旧课' }] }
  const parsed = parseEduText(JSON.stringify(SAMPLE_JSON))
  const replaced = mergeTimetable(existing, parsed, 'replace', '')
  assert.equal(replaced.courses.length, parsed.courses.length)
  assert.equal(replaced.termStart, '2026-09-07')
  assert.equal(replaced.courses.some((c) => c.id === 'old'), false)
  const appended = mergeTimetable(existing, parsed, 'append', '2026-09-14')
  assert.equal(appended.courses.length, 1 + parsed.courses.length)
  assert.equal(appended.termStart, '2026-09-14')
  assert.equal(appended.courses[0].id, 'old')
})

test('EDU_PRESETS：内置教务类型齐全且每个都有操作提示', () => {
  assert.ok(EDU_PRESETS.length >= 5)
  EDU_PRESETS.forEach((p) => {
    assert.ok(p.id && p.name && p.hint)
  })
})
