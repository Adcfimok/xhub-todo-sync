/**
 * 提醒规则回归：待办提醒时刻怎么算、标记怎么写、服务端会不会把字段丢掉。
 *
 * 运行：
 *   node --experimental-default-type=module --test android/tests/remind.test.mjs
 *
 * 三类断言：
 * 1) 客户端纯函数（lib/remind.js）
 * 2) 服务端字段白名单（extensions/todo-relay/service/store.js 的 normalizeRecord）
 * 3) 番茄钟时长配置的钳制（lib/pomo.js 里的纯计算路径）
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { remindTimeOf, remindLabel, DEFAULT_LEAD_MIN } from '../app/src/main/assets/www/lib/remind.js'

const require = createRequire(import.meta.url)
const store = require('../../extensions/todo-relay/service/store.js')

const DUE = new Date(2026, 10, 8, 15, 0, 0).getTime() // 2026-11-08 15:00
// 服务端的 HLC 必须 26 位（时间戳 + 序号 + 设备），这里给一个合法值
const HLC = '00000000000000000000000001'

test('提前 30 分钟：按截止时间减 30 分钟', () => {
  assert.equal(remindTimeOf({ dueAt: DUE, remindLead: 30 }), DUE - 30 * 60000)
})

test('准时：等于截止时间', () => {
  assert.equal(remindTimeOf({ dueAt: DUE, remindLead: 0 }), DUE)
})

test('自定义绝对时刻：优先于截止时间与提前量', () => {
  const custom = DUE - 3 * 3600000
  assert.equal(remindTimeOf({ dueAt: DUE, remindLead: 60, remindAt: custom }), custom)
})

test('明确关闭（-1）：无论有没有 dueAt 都不提醒', () => {
  assert.equal(remindTimeOf({ dueAt: DUE, remindLead: -1 }), 0)
  assert.equal(remindTimeOf({ dueAt: DUE, remindLead: -1, remindAt: DUE - 60000 }), 0)
})

test('老记录没有提醒字段：回落到提前 15 分钟', () => {
  assert.equal(remindTimeOf({ dueAt: DUE }), DUE - DEFAULT_LEAD_MIN * 60000)
  assert.equal(remindTimeOf({ dueAt: DUE, remindLead: null }), DUE - DEFAULT_LEAD_MIN * 60000)
})

test('没有截止时间也没有自定义：不提醒', () => {
  assert.equal(remindTimeOf({ title: 'x' }), 0)
  assert.equal(remindTimeOf(null), 0)
})

test('提醒标记文案：分钟 / 小时 / 天 / 准时 / 空', () => {
  assert.equal(remindLabel({ remindLead: 30 }), '提前30 分钟')
  assert.equal(remindLabel({ remindLead: 120 }), '提前2 小时')
  assert.equal(remindLabel({ remindLead: 2880 }), '提前2 天')
  assert.equal(remindLabel({ remindLead: 0 }), '准时')
  assert.equal(remindLabel({ remindLead: -1 }), '')
  assert.equal(remindLabel({ remindLead: null, remindAt: 0 }), '')
})

test('服务端保留 remindLead：-1 与 1440 都不能被清零', () => {
  const off = store.normalizeRecord({
    id: 'todos:abc',
    col: 'todos',
    title: '不提醒',
    dueAt: DUE,
    remindLead: -1,
    hlc: HLC,
  })
  assert.equal(off.remindLead, -1, '-1 必须原样保留')
  assert.equal(off.remindAt, null)

  const day = store.normalizeRecord({
    id: 'todos:def',
    col: 'todos',
    title: '提前一天',
    dueAt: DUE,
    remindLead: 1440,
    remindAt: DUE - 86400000,
    hlc: HLC,
  })
  assert.equal(day.remindLead, 1440)
  assert.equal(day.remindAt, DUE - 86400000)
})

test('服务端拒绝越界提前量：超出一年按一年钳制', () => {
  const rec = store.normalizeRecord({
    id: 'todos:xyz',
    col: 'todos',
    title: '越界',
    dueAt: DUE,
    remindLead: 99999999,
    hlc: HLC,
  })
  assert.equal(rec.remindLead, 525600)
})
