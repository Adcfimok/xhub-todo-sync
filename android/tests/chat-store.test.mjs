/**
 * AI 历史会话存储模型回归（纯函数，不需要浏览器）。
 *
 * 运行：node --experimental-default-type=module --test android/tests/chat-store.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_MSGS,
  MAX_SESSIONS,
  IDX_KEY,
  ACTIVE_KEY,
  MIGRATED_KEY,
  LEGACY_KEY,
  chatKey,
  newSessionId,
  clampMessages,
  sessionTitle,
  previewOf,
  normalizeSessions,
  makeSession,
  refreshSession,
  upsertSession,
  removeSessions,
  sessionMessages,
  initStore,
  groupSessions,
  fmtTime,
} from '../app/src/main/assets/www/lib/chatStore.js'

const msg = (role, content) => ({ role, content })

test('clampMessages：过滤非法角色、裁到 60 条，且保留消息对象引用', () => {
  const ai = msg('assistant', '正在写…')
  const raw = [msg('user', '你好'), ai, { role: 'tool', content: 'bad' }, null]
  assert.equal(clampMessages(raw).length, 2)
  assert.equal(clampMessages(raw)[1], ai) // 流式回调还指着这个对象，不能被复制
  const many = Array.from({ length: 80 }, (_, i) => msg('user', '第 ' + i + ' 条'))
  const cut = clampMessages(many)
  assert.equal(cut.length, MAX_MSGS)
  assert.equal(cut[cut.length - 1].content, '第 79 条')
  assert.deepEqual(clampMessages(null), [])
})

test('sessionTitle / previewOf：首条提问做标题，最后一条做预览', () => {
  const msgs = [msg('user', '帮我把\n房租  加进待办'), msg('assistant', '已经加好了')]
  assert.equal(sessionTitle(msgs), '帮我把 房租 加进待办')
  assert.equal(sessionTitle([msg('assistant', '只有回复')]), '新对话')
  assert.equal(previewOf(msgs), '助手：已经加好了')
  assert.equal(previewOf([]), '（还没有消息）')
})

test('normalizeSessions：去重、补字段、按更新时间倒序', () => {
  const list = normalizeSessions([
    { id: 'a', title: '旧', updatedAt: 100 },
    { id: 'b', title: '新', updatedAt: 300, count: 4, preview: '…' },
    { id: 'a', title: '重复', updatedAt: 999 },
    null,
    { id: '', title: '无 id' },
  ])
  assert.equal(list.length, 2)
  assert.equal(list[0].id, 'b')
  assert.equal(list[1].id, 'a')
  assert.equal(list[1].count, 0)
})

test('refreshSession：标题只生成一次，时间与条数每次更新', () => {
  const t = 1700000000000
  const first = [msg('user', '第一句'), msg('assistant', '回复一')]
  const s = makeSession('c1', first, t)
  assert.equal(s.title, '第一句')
  assert.equal(s.count, 2)
  const later = refreshSession(s, first.concat([msg('user', '继续问'), msg('assistant', '回复二')]), t + 1000)
  assert.equal(later.title, '第一句')
  assert.equal(later.updatedAt, t + 1000)
  assert.equal(later.count, 4)
  assert.equal(later.preview, '助手：回复二')
})

test('upsertSession / removeSessions：继续对话会把会话顶到最前，批量删除一次过滤干净', () => {
  let list = []
  list = upsertSession(list, makeSession('a', [msg('user', 'A')], 100))
  list = upsertSession(list, makeSession('b', [msg('user', 'B')], 200))
  assert.deepEqual(list.map((s) => s.id), ['b', 'a'])
  list = upsertSession(list, refreshSession(list[1], [msg('user', 'A2')], 300))
  assert.deepEqual(list.map((s) => s.id), ['a', 'b'])
  assert.equal(removeSessions(list, ['a', 'b', '不存在']).length, 0)
})

test('initStore：旧版 aiMessages 迁移成一条历史会话并自动续上', () => {
  const legacy = [msg('user', '上次没聊完的话题'), msg('assistant', '这是当时的回复')]
  const r = initStore({ [LEGACY_KEY]: legacy }, 1700000000000)
  assert.equal(r.sessions.length, 1)
  assert.equal(r.activeId, r.sessions[0].id)
  assert.equal(r.sessions[0].title, '上次没聊完的话题')
  const w = Object.fromEntries(r.writes)
  assert.deepEqual(w[chatKey(r.activeId)], legacy)
  assert.equal(w[MIGRATED_KEY], '1')
  assert.equal(w[ACTIVE_KEY], r.activeId)
  assert.deepEqual(w[IDX_KEY], r.sessions)
})

test('initStore：迁移标记已存在时不重复建会话', () => {
  const meta = {
    [LEGACY_KEY]: [msg('user', '老对话')],
    [MIGRATED_KEY]: '1',
    [IDX_KEY]: [makeSession('keep', [msg('user', '保留')], 1700000000000)],
  }
  const r = initStore(meta, 1700000001000)
  assert.equal(r.sessions.length, 1)
  assert.equal(r.sessions[0].id, 'keep')
  assert.equal(r.writes.length, 0)
})

test('initStore：activeId 指向已删除会话时回到新对话草稿', () => {
  const r = initStore({ [IDX_KEY]: [], [ACTIVE_KEY]: 'ghost' }, 1700000000000)
  assert.equal(r.activeId, '')
  assert.equal(Object.fromEntries(r.writes)[ACTIVE_KEY], '')
})

test('sessionMessages：读不到消息 key 返回空数组，不猜造内容', () => {
  assert.deepEqual(sessionMessages({}, ''), [])
  assert.deepEqual(sessionMessages({}, 'x'), [])
  assert.equal(sessionMessages({ [chatKey('x')]: [msg('user', '在')] }, 'x').length, 1)
})

test('groupSessions / fmtTime：今天、昨天、更早分组', () => {
  const now = new Date(2026, 10, 8, 15, 30).getTime()
  const today = now - 3600000
  const yesterday = now - 86400000 - 3600000
  const older = now - 5 * 86400000
  const list = normalizeSessions([
    { id: 'a', updatedAt: today },
    { id: 'b', updatedAt: yesterday },
    { id: 'c', updatedAt: older },
  ])
  const g = groupSessions(list, now)
  assert.deepEqual(g.map((x) => x.label), ['今天', '昨天', '更早'])
  assert.equal(fmtTime(today, now), '14:30')
  assert.ok(fmtTime(yesterday, now).startsWith('昨天'))
  assert.ok(fmtTime(older, now).includes('/'))
})

test('完整流程：懒创建 → 继续 → 新建不影响历史 → 单删 → 批删', () => {
  const t = 1700000000000
  const meta = {}
  // 新会话 A：发出第一条消息后落盘
  const a = newSessionId()
  const aMsgs = [msg('user', '帮我建待办'), msg('assistant', '建好了')]
  meta[chatKey(a)] = aMsgs
  meta[IDX_KEY] = [makeSession(a, aMsgs, t)]
  meta[ACTIVE_KEY] = a

  // 继续 A：追加一问一答，索引刷新
  aMsgs.push(msg('user', '再建一条'), msg('assistant', '又建好了'))
  let sessions = upsertSession(meta[IDX_KEY], refreshSession(meta[IDX_KEY][0], aMsgs, t + 1000))
  meta[IDX_KEY] = sessions
  meta[chatKey(a)] = clampMessages(aMsgs)
  assert.equal(sessions[0].count, 4)

  // 新建对话：只把指针拨空，历史不动
  meta[ACTIVE_KEY] = ''
  assert.equal(sessionMessages(meta, a).length, 4)
  assert.equal(meta[IDX_KEY].length, 1)

  // 新会话 B
  const b = newSessionId()
  const bMsgs = [msg('user', '另一个话题'), msg('assistant', '收到')]
  meta[chatKey(b)] = bMsgs
  sessions = upsertSession(sessions, makeSession(b, bMsgs, t + 2000))
  meta[IDX_KEY] = sessions
  meta[ACTIVE_KEY] = b
  assert.equal(sessions.length, 2)
  assert.equal(sessions[0].id, b) // 最近更新的排最前

  // 单删 B（当前会话）→ 回到草稿，A 完好
  sessions = removeSessions(sessions, [b])
  delete meta[chatKey(b)]
  meta[ACTIVE_KEY] = ''
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0].id, a)
  assert.equal(sessionMessages(meta, b).length, 0)

  // 上限常量存在，UI 层据此拒绝静默丢弃
  assert.ok(MAX_SESSIONS > 0 && MAX_MSGS > 0)
})
