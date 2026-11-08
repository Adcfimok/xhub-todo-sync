/* 用户称呼：首次启动强制设置一次，之后可在「我的 → 称呼」里改。
 *
 * 称呼会应用到三处：
 * - 首页问候：「早上好」→「早上好，<称呼>」
 * - AI 对话：system prompt 里告知助手怎么称呼用户
 * - 每日一句：语料里的 {name} 占位替换成称呼
 *
 * 这里只放纯函数，方便单元测试；存储统一走 S.meta.nickname。
 */

/** 规整称呼：去掉首尾空白，限制长度，避免脏数据 */
export function normalizeNickname(v) {
  const s = String(v == null ? '' : v).trim().replace(/\s+/g, ' ')
  return s.slice(0, 16)
}

/**
 * 把内容里的名字占位 {name} 替换成称呼。
 * 没设称呼时回退成「朋友」，保证语料里的占位不会裸着显示。
 */
export function applyNickname(content, nick) {
  const n = normalizeNickname(nick)
  const who = n || '朋友'
  return String(content == null ? '' : content).replace(/\{name\}/g, who)
}

/** 带称呼的问候：原问候语 + 「，称呼」；没称呼就不加 */
export function greetWithNickname(greet, nick) {
  const n = normalizeNickname(nick)
  return n ? greet + '，' + n : greet
}
