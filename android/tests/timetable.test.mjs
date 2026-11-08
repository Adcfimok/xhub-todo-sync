/**
 * 课表纯函数回归：周次计算、单双周、按天筛选、规整。
 *
 * 运行：
 *   node --experimental-default-type=module --test android/tests/timetable.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  weekOfTerm,
  courseInWeek,
  coursesOnDay,
  normalizeCourse,
  normalizeTimetable,
  slotLabel,
  parseTermStart,
} from '../app/src/main/assets/www/lib/timetable.js'

// 2026-09-07 是周一（开学第 1 周）
const TERM = '2026-09-07'

test('weekOfTerm：开学那周是第 1 周', () => {
  const monday = new Date(2026, 8, 7).getTime()
  assert.equal(weekOfTerm(TERM, monday), 1)
  const nextMonday = new Date(2026, 8, 14).getTime()
  assert.equal(weekOfTerm(TERM, nextMonday), 2)
  const thirdMonday = new Date(2026, 8, 21).getTime()
  assert.equal(weekOfTerm(TERM, thirdMonday), 3)
})

test('weekOfTerm：没有开学日期时按本周是第 1 周兜底', () => {
  assert.equal(weekOfTerm('', Date.now()), 1)
  assert.equal(weekOfTerm(null, Date.now()), 1)
})

test('courseInWeek：单双周与周次范围', () => {
  const every = { weekStart: 1, weekEnd: 16, weekType: 0 }
  const odd = { weekStart: 1, weekEnd: 16, weekType: 1 }
  const even = { weekStart: 1, weekEnd: 16, weekType: 2 }
  assert.equal(courseInWeek(every, 5), true)
  assert.equal(courseInWeek(odd, 5), true)
  assert.equal(courseInWeek(odd, 6), false)
  assert.equal(courseInWeek(even, 6), true)
  assert.equal(courseInWeek(even, 5), false)
  // 超出周次范围
  assert.equal(courseInWeek({ weekStart: 1, weekEnd: 8, weekType: 0 }, 9), false)
})

test('coursesOnDay：按天 + 周筛选并排序', () => {
  const courses = [
    { id: 'a', name: '数学', day: 1, start: 3, end: 4, weekStart: 1, weekEnd: 16, weekType: 0 },
    { id: 'b', name: '英语', day: 1, start: 1, end: 2, weekStart: 1, weekEnd: 16, weekType: 0 },
    { id: 'c', name: '体育', day: 2, start: 5, end: 6, weekStart: 1, weekEnd: 16, weekType: 0 },
    { id: 'd', name: '单周课', day: 1, start: 7, end: 8, weekStart: 1, weekEnd: 16, weekType: 1 },
  ]
  const monday = coursesOnDay(courses, 1, 3) // 第 3 周（单周）
  assert.deepEqual(monday.map((c) => c.id), ['b', 'a', 'd'])
  const evenMonday = coursesOnDay(courses, 1, 4) // 第 4 周（双周）
  assert.deepEqual(evenMonday.map((c) => c.id), ['b', 'a'])
})

test('normalizeCourse：钳制非法字段并保留合法值', () => {
  const c = normalizeCourse({ name: '  高数  ', day: 9, start: 0, end: 99, weekType: 2, color: 99 })
  assert.equal(c.name, '高数')
  assert.equal(c.day, 7)
  assert.equal(c.start, 1)
  assert.equal(c.end, 12)
  assert.equal(c.weekType, 2)
  assert.ok(c.color >= 0 && c.color <= 5)
  assert.equal(normalizeCourse({ name: '' }), null)
})

test('normalizeTimetable：过滤坏数据、按 id 去重', () => {
  const raw = {
    termStart: '2026-09-07',
    courses: [
      { id: 'x', name: 'A', day: 1, start: 1, end: 2 },
      { id: 'x', name: 'A 重复', day: 2, start: 3, end: 4 },
      { name: '' },
      { name: 'B', day: 3, start: 5, end: 6 },
    ],
  }
  const t = normalizeTimetable(raw)
  assert.equal(t.termStart, '2026-09-07')
  assert.equal(t.courses.length, 2)
  assert.deepEqual(t.courses.map((c) => c.name), ['A', 'B'])
})

test('slotLabel：单节与区间', () => {
  assert.equal(slotLabel({ start: 3, end: 3 }), '第 3 节')
  assert.equal(slotLabel({ start: 1, end: 2 }), '第 1-2 节')
})

test('parseTermStart：多种输入统一成当天零点', () => {
  assert.equal(parseTermStart('2026-09-07'), new Date(2026, 8, 7).getTime())
  assert.equal(parseTermStart(null), null)
})
