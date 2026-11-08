/**
 * 称呼（nickname）回归：纯函数的占位替换、问候拼接、长度钳制。
 *
 * 运行：
 *   node --experimental-default-type=module --test android/tests/nickname.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeNickname, applyNickname, greetWithNickname } from '../app/src/main/assets/www/lib/nickname.js'

test('normalizeNickname：去掉首尾空白、合并中间空格、限长 16', () => {
  assert.equal(normalizeNickname('  小明  '), '小明')
  assert.equal(normalizeNickname('小   明'), '小 明')
  assert.equal(normalizeNickname('x'.repeat(30)).length, 16)
  assert.equal(normalizeNickname(''), '')
  assert.equal(normalizeNickname(null), '')
})

test('applyNickname：把 {name} 占位替换成称呼', () => {
  assert.equal(applyNickname('{name}，今天也要元气满满。', '小明'), '小明，今天也要元气满满。')
  assert.equal(applyNickname('日拱一卒，功不唐捐。', '小明'), '日拱一卒，功不唐捐。')
  // 多个占位都替换
  assert.equal(applyNickname('{name}好，{name}。', '阿七'), '阿七好，阿七。')
})

test('applyNickname：没设置称呼时回退成「朋友」，不裸着显示占位', () => {
  assert.equal(applyNickname('{name}，加油。', ''), '朋友，加油。')
  assert.equal(applyNickname('{name}，加油。', '  '), '朋友，加油。')
})

test('greetWithNickname：有称呼才拼接「，称呼」，无称呼保持原样', () => {
  assert.equal(greetWithNickname('早上好', '小明'), '早上好，小明')
  assert.equal(greetWithNickname('早上好', ''), '早上好')
  assert.equal(greetWithNickname('晚上好', '  阿七 '), '晚上好，阿七')
})
