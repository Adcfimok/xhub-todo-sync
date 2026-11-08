/* AI 历史对话的存储模型（纯函数，不碰 DOM，可在 Node 里单测）。
 *
 * 存储方案：全部落在 IndexedDB 的 `meta` store，按会话分 key，不新建 object store、
 * 不升 DB_VER（覆盖安装零迁移风险）。
 *   aiSessions       会话索引数组（轻量：id / title / createdAt / updatedAt / count / preview）
 *   aiChat:<id>      该会话的消息数组（最多 MAX_MSGS 条）
 *   aiActiveId       当前打开的会话 id；'' = 尚未开始的新对话草稿态
 *   aiMigrated       旧版 aiMessages 已迁移标记
 *
 * 为什么这样切：
 *   - 追加一条消息只写「这一个会话」的 key + 索引，不用重写全部历史；
 *   - 删除是真正的 key 删除（core.js 的 applyMeta 支持 metaDel），不留空壳；
 *   - meta 不参与 PROTO 2 的同步载荷（syncNow 只推 S.records 的脏记录），
 *     所以对话历史天然只留在这台手机上，不会把大量文本推给电脑；
 *   - 代价是 S.meta 常驻内存，因此设 MAX_SESSIONS 上限并拒绝静默丢弃。
 */

export const MAX_MSGS = 60
export const MAX_SESSIONS = 100
export const IDX_KEY = 'aiSessions'
export const ACTIVE_KEY = 'aiActiveId'
export const MIGRATED_KEY = 'aiMigrated'
export const LEGACY_KEY = 'aiMessages'

export function chatKey(id) {
  return 'aiChat:' + id
}

export function newSessionId() {
  return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

/** 规整消息：只留合法角色，裁剪到上限；返回新数组但**保留消息对象引用**（流式回调还指着它） */
export function clampMessages(raw) {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-MAX_MSGS)
}

export function sessionTitle(msgs, fallback) {
  const first = (msgs || []).filter((m) => m.role === 'user' && String(m.content || '').trim())[0]
  const t = String(first ? first.content : '').replace(/\s+/g, ' ').trim()
  return t ? t.slice(0, 24) : fallback || '新对话'
}

export function previewOf(msgs) {
  const list = (msgs || []).filter((m) => String(m.content || '').trim())
  const last = list[list.length - 1]
  if (!last) return '（还没有消息）'
  const who = last.role === 'user' ? '我：' : '助手：'
  return who + String(last.content).replace(/\s+/g, ' ').trim().slice(0, 40)
}

export function normalizeSessions(raw) {
  if (!Array.isArray(raw)) return []
  const seen = {}
  const out = []
  raw.forEach((s) => {
    if (!s || typeof s !== 'object') return
    const id = String(s.id || '')
    if (!id || seen[id]) return
    seen[id] = 1
    out.push({
      id,
      title: String(s.title || '新对话').slice(0, 40),
      createdAt: Number(s.createdAt) || 0,
      updatedAt: Number(s.updatedAt) || Number(s.createdAt) || 0,
      count: Number(s.count) || 0,
      preview: String(s.preview || '').slice(0, 80),
    })
  })
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

export function makeSession(id, msgs, now) {
  const t = Number(now) || Date.now()
  return {
    id,
    title: sessionTitle(msgs),
    createdAt: t,
    updatedAt: t,
    count: (msgs || []).length,
    preview: previewOf(msgs),
  }
}

/** 标题只生成一次；每次落盘刷新时间 / 条数 / 预览 */
export function refreshSession(s, msgs, now) {
  const t = Number(now) || Date.now()
  const base = s || makeSession(newSessionId(), msgs, t)
  return {
    id: base.id,
    title: base.title && base.title !== '新对话' ? base.title : sessionTitle(msgs, base.title),
    createdAt: base.createdAt || t,
    updatedAt: t,
    count: (msgs || []).length,
    preview: previewOf(msgs),
  }
}

export function upsertSession(list, s) {
  const next = (list || []).filter((x) => x.id !== s.id)
  next.push(s)
  return next.sort((a, b) => b.updatedAt - a.updatedAt)
}

export function removeSessions(list, ids) {
  const kill = {}
  ;(ids || []).forEach((id) => (kill[id] = 1))
  return (list || []).filter((s) => !kill[s.id])
}

/** 读取某个会话的消息；索引存在但消息 key 丢失时返回空数组，不猜造内容 */
export function sessionMessages(meta, id) {
  if (!id) return []
  return clampMessages(meta && meta[chatKey(id)])
}

/**
 * 初始化 / 迁移。
 * 旧版只有一个 aiMessages 数组；首次进入把它转成一条历史会话，
 * 并把 activeId 指过去 —— 用户升级后打开 AI 看到的还是原来那段对话。
 * @returns {{sessions:Array, activeId:string, writes:Array}} writes 是给 applyMeta 的 [key, value] 对
 */
export function initStore(meta, now) {
  const m = meta || {}
  const t = Number(now) || Date.now()
  let sessions = normalizeSessions(m[IDX_KEY])
  const writes = []
  let activeId = String(m[ACTIVE_KEY] || '')

  const legacy = clampMessages(m[LEGACY_KEY])
  if (legacy.length && m[MIGRATED_KEY] !== '1') {
    const id = newSessionId()
    sessions = upsertSession(sessions, makeSession(id, legacy, t))
    writes.push([chatKey(id), legacy])
    writes.push([IDX_KEY, sessions])
    writes.push([MIGRATED_KEY, '1'])
    // 迁移出来的这段就是用户上次正在看的对话，直接续上
    activeId = id
    writes.push([ACTIVE_KEY, id])
  }

  if (activeId && !sessions.some((s) => s.id === activeId)) {
    activeId = ''
    writes.push([ACTIVE_KEY, ''])
  }
  return { sessions, activeId, writes }
}

/** 历史列表按「今天 / 昨天 / 更早」分组，空组不显示 */
export function groupSessions(list, now) {
  const d = new Date(Number(now) || Date.now())
  const today = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const buckets = [[], [], []]
  ;(list || []).forEach((s) => {
    const t = Number(s.updatedAt) || 0
    if (t >= today) buckets[0].push(s)
    else if (t >= today - 86400000) buckets[1].push(s)
    else buckets[2].push(s)
  })
  return [
    { label: '今天', items: buckets[0] },
    { label: '昨天', items: buckets[1] },
    { label: '更早', items: buckets[2] },
  ].filter((g) => g.items.length)
}

export function fmtTime(ts, now) {
  const t = Number(ts) || 0
  const d = new Date(t)
  if (!t || isNaN(d.getTime())) return ''
  const hh = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
  const n = new Date(Number(now) || Date.now())
  const start = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime()
  if (t >= start) return hh
  if (t >= start - 86400000) return '昨天 ' + hh
  return d.getMonth() + 1 + '/' + d.getDate() + ' ' + hh
}
