/**
 * 倒数日纯函数回归：日期解析、天数计算、标签、规整。
 *
 * 运行：
 *   node --experimental-default-type=module --test android/tests/countdown.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { parseDate, daysUntil, normalizeCountdown, normalizeCountdowns, countdownLabel, dayAbs, toYmd } from '../app/src/main/assets/www/lib/countdown.js'

const NOW = new Date(2026, 10, 8).getTime() // 2026-11-08

test('parseDate：YYYY-MM-DD 与非法输入', () => {
  assert.equal(parseDate('2026-11-08'), new Date(2026, 10, 8).getTime())
  assert.equal(parseDate('bad'), null)
  assert.equal(parseDate(null), null)
})

test('daysUntil：未来正数、过去负数、今天为 0', () => {
  assert.equal(daysUntil('2026-11-10', NOW), 2)
  assert.equal(daysUntil('2026-11-06', NOW), -2)
  assert.equal(daysUntil('2026-11-08', NOW), 0)
})

test('countdownLabel：还有/已过/就是今天', () => {
  assert.equal(countdownLabel({ date: '2026-11-10' }, NOW), '还有 2 天')
  assert.equal(countdownLabel({ date: '2026-11-06' }, NOW), '已过 2 天')
  assert.equal(countdownLabel({ date: '2026-11-08' }, NOW), '就是今天')
})

test('dayAbs：取绝对值', () => {
  assert.equal(dayAbs({ date: '2026-11-10' }, NOW), 2)
  assert.equal(dayAbs({ date: '2026-11-06' }, NOW), 2)
})

test('normalizeCountdown：规整标题与日期，非法返回 null', () => {
  const c = normalizeCountdown({ title: '  期末考试  ', date: '2026-12-01' })
  assert.equal(c.title, '期末考试')
  assert.equal(c.date, '2026-12-01')
  assert.equal(normalizeCountdown({ title: '', date: '2026-12-01' }), null)
  assert.equal(normalizeCountdown({ title: 'x', date: 'bad' }), null)
})

test('normalizeCountdowns：去重、过滤坏数据、按日期升序', () => {
  const list = normalizeCountdowns([
    { id: 'a', title: '远期', date: '2027-01-01' },
    { id: 'b', title: '近期', date: '2026-11-20' },
    { id: 'a', title: '重复', date: '2026-12-01' },
    { title: '', date: '2026-12-01' },
  ])
  assert.equal(list.length, 2)
  assert.deepEqual(list.map((c) => c.title), ['近期', '远期'])
})

test('toYmd：毫秒转 YYYY-MM-DD', () => {
  assert.equal(toYmd(new Date(2026, 0, 5).getTime()), '2026-01-05')
})
