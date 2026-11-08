/**
 * 速达「手机应用」独立数据模型回归。
 *
 * 运行：node --experimental-default-type=module --test android/tests/app-shortcuts.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PHONE_APPS_KEY,
  MAX_PHONE_APPS,
  normalizeApps,
  hasApp,
  addApp,
  removeApp,
  pcOnlyRecords,
} from '../app/src/main/assets/www/lib/appShortcuts.js'
import { COLS } from '../app/src/main/assets/www/lib/core.js'

test('手机应用存的是 meta key，绝不与任何同步集合同名', () => {
  assert.equal(PHONE_APPS_KEY, 'phoneApps')
  assert.ok(!COLS.includes(PHONE_APPS_KEY))
  assert.ok(COLS.includes('resources')) // PC 端仍用 resources 集合同步
  assert.equal(MAX_PHONE_APPS, 200)
})

test('normalizeApps：丢坏数据、按包名去重、封顶', () => {
  const raw = [
    { pkg: 'com.a', label: '应用A', icon: '/__appicon/a.png', addedAt: 1 },
    { pkg: 'com.a', label: '重复', icon: '/x.png' },
    null,
    { pkg: '', label: '没包名' },
    { pkg: 'com.b', label: '应用B' },
  ]
  const out = normalizeApps(raw)
  assert.equal(out.length, 2)
  assert.equal(out[0].label, '应用A')
  assert.equal(out[1].pkg, 'com.b')
  assert.equal(out[1].icon, '')
  assert.deepEqual(normalizeApps(null), [])
  const many = Array.from({ length: 230 }, (_, i) => ({ pkg: 'p' + i, label: 'A' + i }))
  assert.equal(normalizeApps(many).length, MAX_PHONE_APPS)
})

test('addApp / hasApp / removeApp：只动手机应用，不返回原数组引用', () => {
  let list = []
  const t = 1700000000000
  assert.equal(hasApp(list, 'com.a'), false)
  list = addApp(list, { pkg: 'com.a', label: '微信', icon: '/__appicon/wx.png' }, t)
  assert.equal(list.length, 1)
  assert.deepEqual(list[0], { pkg: 'com.a', label: '微信', icon: '/__appicon/wx.png', addedAt: t })
  assert.equal(hasApp(list, 'com.a'), true)
  const again = addApp(list, { pkg: 'com.a', label: '微信' }, t + 1)
  assert.equal(again, list, '重复添加应原样返回，不产生第二条')
  list = addApp(list, { pkg: 'com.b', label: '支付宝' }, t + 2)
  assert.equal(list.length, 2)
  const removed = removeApp(list, 'com.a')
  assert.equal(removed.length, 1)
  assert.equal(removed[0].pkg, 'com.b')
  assert.equal(list.length, 2, 'removeApp 不改原数组')
})

test('pcOnlyRecords：电脑程序只读来自 resources，与手机应用字段不混', () => {
  const records = [
    { id: 'resources:h3', col: 'resources', kind: 'app', name: 'VS Code', target: 'code.exe', deleted: false },
    { id: 'resources:h1', col: 'resources', kind: 'web', name: 'GitHub', target: 'https://github.com', deleted: false },
    { id: 'resources:h4', col: 'resources', kind: 'file', name: '报告.pdf', deleted: false },
    { id: 'resources:h9', col: 'resources', kind: 'app', name: '已删', deleted: true },
  ]
  const pc = pcOnlyRecords(records)
  assert.deepEqual(pc.map((r) => r.name), ['VS Code', '报告.pdf'])
  pc.forEach((r) => {
    assert.equal(r.col, 'resources')
    assert.ok(!('pkg' in r), 'PC 记录不该带手机应用的 pkg 字段')
  })
})

test('两个个体的数据形状互不兼容，不会被当成同一条记录', () => {
  const phone = [{ pkg: 'com.a', label: '应用A', icon: '/__appicon/a.png' }]
  assert.equal(pcOnlyRecords(phone).length, 0)
  assert.equal(normalizeApps([{ col: 'resources', kind: 'app', name: 'VS Code' }]).length, 0)
})
