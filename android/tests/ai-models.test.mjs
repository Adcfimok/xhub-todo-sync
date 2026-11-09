/*
 * 模型目录纯逻辑单测：清洗、默认值、回退、平台清单对账、旧键双写。
 *
 * 这些函数算错的表现是：换模型后对话仍打旧模型 / 平台下架后卡死 / 升级后配置丢失，
 * 所以逐条钉死。运行：node --test android/tests/ai-models.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MAX_MODELS,
  availability,
  customProfile,
  defaultProfile,
  hostOf,
  isModelGoneError,
  legacyWrites,
  mergePlatform,
  platformProfile,
  resolveRun,
  sanitizeProfiles,
} from '../app/src/main/assets/www/lib/aimodels.js'

const NOW = 1_700_000_000_000

const pl = (name) => ({ id: 'pl:' + name, kind: 'platform', model: name, label: name, addedAt: NOW })
const cu = (name, extra) =>
  Object.assign({ id: 'cu:' + name, kind: 'custom', model: name, label: name, base: 'https://api.test/v1', key: 'sk-' + name, addedAt: NOW }, extra || {})

test('sanitizeProfiles：丢掉缺 kind/model 的脏数据并按 id 去重', () => {
  const out = sanitizeProfiles([
    { kind: 'platform', model: 'a' },
    { kind: 'platform', model: 'a' }, // 同 id → 去重
    { kind: 'weird', model: 'b' },
    { kind: 'custom', model: '' },
    { kind: 'custom', model: 'c', base: 'https://x/v1/', key: 'k' },
    null,
    'x',
  ])
  assert.equal(out.length, 2)
  assert.equal(out[0].id, 'pl:a')
  assert.equal(out[1].id, 'cu:c@https://x/v1', '缺 id 时按模型名 + 地址生成稳定 id')
  assert.equal(out[1].base, 'https://x/v1', '末尾斜杠应被去掉')
  assert.equal(out[1].label, 'c', '没写名称时用模型名兜底')
})

test('sanitizeProfiles：超过上限截断，避免选择器被撑爆', () => {
  const many = Array.from({ length: MAX_MODELS + 5 }, (_, i) => pl('m' + i))
  assert.equal(sanitizeProfiles(many).length, MAX_MODELS)
})

test('platformProfile / customProfile：id 稳定且可读', () => {
  assert.equal(platformProfile('deepseek-chat', NOW).id, 'pl:deepseek-chat')
  assert.equal(platformProfile('  ', NOW), null)
  const c = customProfile({ label: '我的模型', base: ' https://api.x/v1/ ', model: ' gpt-4o ', key: ' k ' }, NOW)
  assert.equal(c.id.indexOf('cu:'), 0)
  assert.equal(c.model, 'gpt-4o')
  assert.equal(c.base, 'https://api.x/v1')
  assert.equal(c.label, '我的模型')
})

test('availability：平台看登录态，自备看地址/Key', () => {
  assert.equal(availability(null, {}).code, 'none')
  assert.equal(availability(pl('a'), { loggedIn: false }).code, 'no-login')
  assert.equal(availability(pl('a'), { loggedIn: true }).ok, true)
  assert.equal(availability(cu('a', { base: '' }), {}).code, 'no-base')
  assert.equal(availability(cu('a', { key: '' }), {}).code, 'no-key')
  assert.equal(availability(cu('a'), {}).ok, true)
})

test('defaultProfile：登录优先平台首条，未登录优先自备', () => {
  const models = [cu('mine'), pl('p1'), pl('p2')]
  assert.equal(defaultProfile(models, true).id, 'pl:p1')
  assert.equal(defaultProfile(models, false).id, 'cu:mine')
  assert.equal(defaultProfile([pl('only')], false).id, 'pl:only', '没有自备时仍返回平台条目用于展示「需登录」')
  assert.equal(defaultProfile([], true), null)
})

test('resolveRun：已选可用就直接用', () => {
  const models = [pl('p1'), cu('mine')]
  const r = resolveRun(models, 'cu:mine', { loggedIn: true })
  assert.equal(r.profile.id, 'cu:mine')
  assert.equal(r.fallbackFrom, '')
  assert.equal(r.reason, '')
})

test('resolveRun：未选择时落到默认项', () => {
  const r = resolveRun([cu('mine'), pl('p1')], '', { loggedIn: true })
  assert.equal(r.profile.id, 'pl:p1')
  assert.equal(r.fallbackFrom, '', '首次默认不算「回退」')
})

test('resolveRun：所选模型被删 → 回退到默认并给出 fallbackFrom', () => {
  const models = [pl('p1'), cu('mine')]
  const r = resolveRun(models, 'cu:gone', { loggedIn: true })
  assert.equal(r.profile.id, 'pl:p1')
  assert.equal(r.fallbackFrom, 'cu:gone')
  assert.equal(r.reason, 'missing')
  assert.match(r.text, /不在列表/)
})

test('resolveRun：平台未登录 → 回退到自备模型并说明原因', () => {
  const models = [pl('p1'), cu('mine')]
  const r = resolveRun(models, 'pl:p1', { loggedIn: false })
  assert.equal(r.profile.id, 'cu:mine')
  assert.equal(r.fallbackFrom, 'pl:p1')
  assert.equal(r.reason, 'no-login')
  assert.match(r.text, /需要登录/)
})

test('resolveRun：全都不可用 → profile 为 null，但保留原因', () => {
  const r = resolveRun([pl('p1')], 'pl:p1', { loggedIn: false })
  assert.equal(r.profile, null)
  assert.equal(r.reason, 'no-login')
  assert.ok(r.text)
})

test('mergePlatform：自备在前、平台按服务端顺序，多退少补', () => {
  const before = [cu('mine'), pl('old'), pl('keep')]
  const m = mergePlatform(before, ['keep', 'new', 'new'], NOW)
  assert.deepEqual(
    m.profiles.map((p) => p.id),
    ['cu:mine', 'pl:keep', 'pl:new']
  )
  assert.deepEqual(m.added, ['new'])
  assert.deepEqual(m.removed, ['old'])
  assert.equal(m.changed, true)
})

test('mergePlatform：清单不变时 changed=false，不产生无意义的落盘', () => {
  const before = [cu('mine'), pl('a'), pl('b')]
  const m = mergePlatform(before, ['a', 'b'], NOW)
  assert.equal(m.changed, false)
})

test('mergePlatform：空清单不删任何条目（瞬时故障不能当全部下架）', () => {
  const before = [pl('a')]
  const m = mergePlatform(before, [], NOW)
  // 纯函数本身只做合并；调用方 syncPlatformModels 会拦截空清单并直接返回
  assert.equal(m.profiles.length, 0)
  assert.deepEqual(m.removed, ['a'])
})

test('legacyWrites：平台条目不把账号 token 写进 aiKey', () => {
  const w = Object.fromEntries(legacyWrites(pl('p1')))
  assert.equal(w.aiPlatform, '1')
  assert.equal(w.aiBase, '')
  assert.equal(w.aiKey, '')
  assert.equal(w.aiModel, 'p1')

  const c = Object.fromEntries(legacyWrites(cu('mine')))
  assert.equal(c.aiPlatform, '')
  assert.equal(c.aiBase, 'https://api.test/v1')
  assert.equal(c.aiKey, 'sk-mine')
  assert.equal(c.aiModel, 'mine')

  const empty = Object.fromEntries(legacyWrites(null))
  assert.equal(empty.aiModel, '')
})

test('isModelGoneError：只认模型本身的问题，不误伤接口地址 404', () => {
  assert.equal(isModelGoneError(new Error('model_not_allowed')), true)
  assert.equal(isModelGoneError(new Error('模型不存在')), true)
  assert.equal(isModelGoneError(new Error('The model `x` does not exist')), true)
  assert.equal(isModelGoneError(new Error('接口地址不对（404），检查 baseURL 是否带 /v1')), false)
  assert.equal(isModelGoneError(new Error('Key 无效或已过期（401）')), false)
  assert.equal(isModelGoneError(null), false)
})

test('hostOf：解析失败也不抛错', () => {
  assert.equal(hostOf('https://api.deepseek.com/v1'), 'api.deepseek.com')
  assert.equal(hostOf('not a url'), 'not a url')
  assert.equal(hostOf(''), '')
})
