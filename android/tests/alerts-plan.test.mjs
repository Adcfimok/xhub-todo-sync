/*
 * 提醒调度纯逻辑单测：哪条该响 / 下次几点响 / 原生日志怎么对账。
 * 这三件事算错的表现就是「提醒晚到」或「完全不响」，所以值得逐条钉死。
 *
 * 运行：node --test android/tests/alerts-plan.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  planItems,
  dueNow,
  nextDueAt,
  readAlarmEvents,
  trimFired,
  MAX_PLAN,
  PLAN_AHEAD,
  OVERDUE_GRACE,
  LATE_WINDOW,
} from '../app/src/main/assets/www/lib/plan.js'

const MIN = 60 * 1000
const NOW = 1_700_000_000_000 // 固定基准时刻，避免测试与真实时间耦合

/** 造一条待办：默认提醒时刻 = now + 1 分钟 */
function todo(id, remindAt, extra) {
  return Object.assign(
    { id, col: 'todos', title: '待办 ' + id, done: false, deleted: false, remindAt },
    extra || {}
  )
}

test('planItems：只收未来的开启中的待办', () => {
  const items = planItems(
    [
      todo('a', NOW - 1), // 已过期 → 不进计划（由 sweep 负责）
      todo('b', NOW + 5 * MIN),
      todo('c', NOW + 6 * MIN, { deleted: true }),
      todo('d', NOW + 7 * MIN, { done: true }),
      { id: 'e', col: 'notes', remindAt: NOW + 8 * MIN },
    ],
    {},
    NOW
  )
  assert.deepEqual(
    items.map((i) => i.id),
    ['b']
  )
})

test('planItems：按时间升序', () => {
  const items = planItems([todo('a', NOW + 30 * MIN), todo('b', NOW + 1 * MIN), todo('c', NOW + 10 * MIN)], {}, NOW)
  assert.deepEqual(
    items.map((i) => i.at),
    [NOW + 1 * MIN, NOW + 10 * MIN, NOW + 30 * MIN]
  )
})

test('planItems：tag 是原生侧的去重键', () => {
  const [it] = planItems([todo('x1', NOW + MIN)], {}, NOW)
  assert.equal(it.tag, 'todo-x1')
  assert.equal(it.kind, 'todo')
})

test('planItems：超过 180 天的不下发', () => {
  const items = planItems([todo('far', NOW + PLAN_AHEAD + MIN), todo('near', NOW + MIN)], {}, NOW)
  assert.deepEqual(
    items.map((i) => i.id),
    ['near']
  )
})

test('planItems：番茄钟计时中也进计划', () => {
  const meta = { pomState: { running: true, endAt: NOW + 20 * MIN, mode: 'focus' } }
  const items = planItems([], meta, NOW)
  assert.equal(items.length, 1)
  assert.equal(items[0].tag, 'pomo')
  assert.equal(items[0].at, NOW + 20 * MIN)
})

test('planItems：番茄钟没在跑就不进计划', () => {
  assert.equal(planItems([], { pomState: { running: false, endAt: NOW + MIN } }, NOW).length, 0)
})

test('planItems：上限 MAX_PLAN，防止把上千条塞给系统', () => {
  const many = []
  for (let i = 0; i < MAX_PLAN + 20; i++) many.push(todo('t' + i, NOW + (i + 1) * MIN))
  const items = planItems(many, {}, NOW)
  assert.equal(items.length, MAX_PLAN)
  assert.equal(items[0].id, 't0') // 保留最近的
})

test('planItems：remindLead=-1 表示明确关闭，不进计划', () => {
  const items = planItems([todo('off', NOW + MIN, { remindLead: -1 })], {}, NOW)
  assert.equal(items.length, 0)
})

test('dueNow：刚过点 1 分钟内要响，且不标补发', () => {
  const at = NOW - 30 * 1000
  const due = dueNow([todo('a', at)], NOW, {})
  assert.equal(due.length, 1)
  assert.equal(due[0].key, 'a@' + at)
  assert.equal(due[0].late, false)
})

test('dueNow：逾期超过 15 分钟不再补响（避免开 App 时炸出一堆旧提醒）', () => {
  const due = dueNow([todo('a', NOW - OVERDUE_GRACE - MIN)], NOW, {})
  assert.equal(due.length, 0)
})

test('dueNow：原生标记「关机期间错过」的允许在 12 小时内补发，并标 late', () => {
  const at = NOW - 2 * 3600 * 1000 // 2 小时前
  const key = 'a@' + at
  const due = dueNow([todo('a', at)], NOW, { missed: new Set([key]) })
  assert.equal(due.length, 1)
  assert.equal(due[0].late, true)
})

test('dueNow：错过超过 12 小时就不补了', () => {
  const at = NOW - LATE_WINDOW - MIN
  const key = 'a@' + at
  const due = dueNow([todo('a', at)], NOW, { missed: new Set([key]) })
  assert.equal(due.length, 0)
})

test('dueNow：已经提醒过的不再响（同一条只响一次）', () => {
  const at = NOW - MIN
  const due = dueNow([todo('a', at)], NOW, { notified: { ['a@' + at]: NOW - 1000 } })
  assert.equal(due.length, 0)
})

test('dueNow：稍后提醒未到期就不响，到期后响', () => {
  const at = NOW - MIN
  const key = 'a@' + at
  assert.equal(dueNow([todo('a', at)], NOW, { snooze: { [key]: NOW + MIN } }).length, 0)
  assert.equal(dueNow([todo('a', at)], NOW, { snooze: { [key]: NOW - MIN } }).length, 1)
})

test('dueNow：改期后旧时刻不会被「已提醒」挡住新时刻', () => {
  const oldAt = NOW - 10 * MIN
  const newAt = NOW - MIN
  const due = dueNow([todo('a', newAt)], NOW, { notified: { ['a@' + oldAt]: NOW - 9 * MIN } })
  assert.equal(due.length, 1)
  assert.equal(due[0].key, 'a@' + newAt)
})

test('dueNow：已删除 / 已完成 / 别的集合都不响', () => {
  const at = NOW - MIN
  assert.equal(dueNow([todo('a', at, { done: true })], NOW, {}).length, 0)
  assert.equal(dueNow([todo('b', at, { deleted: true })], NOW, {}).length, 0)
  assert.equal(dueNow([{ id: 'c', col: 'notes', remindAt: at }], NOW, {}).length, 0)
})

test('nextDueAt：取所有未来提醒里最近的一个', () => {
  const next = nextDueAt([todo('a', NOW + 10 * MIN), todo('b', NOW + MIN)], {}, NOW)
  assert.equal(next, NOW + MIN)
})

test('nextDueAt：已过点的不算「下一条」', () => {
  const next = nextDueAt([todo('a', NOW - MIN)], {}, NOW)
  assert.equal(next, 0)
})

test('nextDueAt：番茄钟与待办一起比，谁近取谁', () => {
  const meta = { pomState: { running: true, endAt: NOW + 3 * MIN } }
  assert.equal(nextDueAt([todo('a', NOW + 10 * MIN)], meta, NOW), NOW + 3 * MIN)
})

test('readAlarmEvents：真的响过的记成 fired', () => {
  const { fired, missed } = readAlarmEvents([{ tag: 'todo-a', at: 100, ts: 120, late: false }])
  assert.deepEqual(fired, [{ key: 'a@100', ts: 120 }])
  assert.equal(missed.length, 0)
})

test('readAlarmEvents：错过的记成 missed，不写 notifiedMap', () => {
  const { fired, missed } = readAlarmEvents([{ tag: 'todo-b', at: 200, ts: 200, late: true }])
  assert.equal(fired.length, 0)
  assert.deepEqual(missed, ['b@200'])
})

test('readAlarmEvents：pomo / selftest / 非法条目一律忽略', () => {
  const { fired, missed } = readAlarmEvents([
    { tag: 'pomo', at: 100 },
    { tag: 'selftest', at: 100 },
    { tag: '', at: 100 },
    { tag: 'todo-c', at: 0 },
    null,
  ])
  assert.equal(fired.length, 0)
  assert.equal(missed.length, 0)
})

test('readAlarmEvents：ts 缺失时用 at 兜底', () => {
  const { fired } = readAlarmEvents([{ tag: 'todo-d', at: 500, late: false }])
  assert.equal(fired[0].ts, 500)
})

test('trimFired：超出上限时丢最旧的', () => {
  const map = {}
  for (let i = 0; i < 10; i++) map['k' + i] = i
  const out = trimFired(map, 5)
  assert.equal(Object.keys(out).length, 5)
  assert.equal(out.k0, undefined)
  assert.equal(out.k9, 9)
})

test('trimFired：没超上限时原样返回', () => {
  const map = { a: 1, b: 2 }
  assert.deepEqual(trimFired(map, 5), map)
})
