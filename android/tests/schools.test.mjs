/**
 * 内置学校列表回归：验证数据完整、字段规范、抽样网址与解密来源一致。
 *
 * 运行：node --experimental-default-type=module --test android/tests/schools.test.mjs
 * 复现解密并与源 APK 逐条核对：node _tools/extract-wakeup-schools.mjs --check
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { SCHOOLS, SCHOOL_SOURCE, SCHOOL_FIELDS } from '../app/src/main/assets/www/lib/schools.js'

test('内置列表条数与来源元信息一致', () => {
  assert.equal(SCHOOL_SOURCE.app, 'WakeUp课程表 6.5.2')
  assert.equal(SCHOOL_SOURCE.file, 'assets/school_info_android_new.txt')
  assert.equal(SCHOOLS.length, SCHOOL_SOURCE.total)
  assert.equal(SCHOOLS.length, 3570)
  const withUrl = SCHOOLS.filter((r) => r[1])
  assert.equal(withUrl.length, SCHOOL_SOURCE.withUrl)
  assert.equal(withUrl.length, 3091)
})

test('每条记录都是 [名称, 网址, 类型, 导入方式, 首字母] 五字段，名称非空', () => {
  assert.deepEqual(SCHOOL_FIELDS, ['name', 'url', 'type', 'importType', 'sortKey'])
  SCHOOLS.forEach((r) => {
    assert.equal(r.length, 5)
    assert.ok(typeof r[0] === 'string' && r[0].length > 0)
    ;['url', 'type', 'importType', 'sortKey'].forEach((_, i) => assert.equal(typeof r[i + 1], 'string'))
  })
})

test('带网址的记录以 http/https 为主；9 条源数据含多个备选网址，UI 会只取第一行', () => {
  // 源数据原样保留：9 所学校把多个备选网址用换行拼接（例如河南工业和信息化职业学院）。
  // 不做清洗，由 timetable.js 选学校时取第一行并 trim —— 这里固定住这个数量，防止静默改动。
  const multi = SCHOOLS.filter((r) => r[1] && /[\r\n]/.test(r[1]))
  assert.equal(multi.length, 9)
  multi.forEach((r) => assert.ok(String(r[1]).split(/[\r\n]+/)[0].trim()))
  const httpish = SCHOOLS.filter((r) => /^https?:\/\//i.test(r[1]))
  assert.ok(httpish.length >= 3000, '绝大多数网址应是 http/https：' + httpish.length)
})

test('抽样学校与解密出的原文一致（含通用导入方式条目）', () => {
  const find = (name) => SCHOOLS.filter((r) => r[0] === name)[0]
  assert.deepEqual(find('安康学院'), [
    '安康学院', 'http://jwxt.aku.edu.cn/jwglxt/xtgl/login_slogin.html', 'zf', 'wakeup', 'A',
  ])
  assert.deepEqual(find('正方教务'), ['正方教务', '', 'zf', 'wakeup', '0'])
  assert.ok(find('安徽中医药大学')[1].includes('eams/login.action'))
  assert.equal(find('超星分享课表导入')[2], 'chaoxing_share')
})

test('教务类型种类与导入方式覆盖符合来源分布', () => {
  const types = new Set(SCHOOLS.map((r) => r[2]))
  const imports = new Set(SCHOOLS.map((r) => r[3]))
  assert.equal(types.size, 130)
  assert.deepEqual([...imports].sort(), ['wakeup', 'ziyan'])
  assert.ok(SCHOOLS.filter((r) => r[2] === 'zf').length > 900)
})

test('versionTimeLine 是来源 JSON 自带的时间戳', () => {
  assert.equal(SCHOOL_SOURCE.versionTimeLine, 1763017986)
})
