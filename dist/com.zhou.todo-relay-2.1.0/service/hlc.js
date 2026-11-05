'use strict'
/**
 * 混合逻辑时钟（HLC）。
 * 排序键形如 `0000018f2e5c3a10-0003-7f3a`：物理毫秒(16) - 计数(4) - 节点短码(4)，定宽。
 * 定宽是为了让字符串比较等价于数值比较——LWW 只需要一个全序，不需要解析。
 */

const MAX_C = 0xffff

function shortCode(nodeId) {
  // FNV-1a 32 位，取低 16 位当节点短码：同一次运行内稳定即可
  let h = 0x811c9dc5
  for (let i = 0; i < nodeId.length; i++) {
    h ^= nodeId.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return (h & 0xffff).toString(16).padStart(4, '0')
}

function fmt(t, c, node) {
  return t.toString(16).padStart(16, '0') + '-' + c.toString(16).padStart(4, '0') + '-' + node
}

function parse(hlc) {
  if (typeof hlc !== 'string' || hlc.length !== 26) return null
  const t = parseInt(hlc.slice(0, 16), 16)
  const c = parseInt(hlc.slice(17, 21), 16)
  if (!Number.isFinite(t) || !Number.isFinite(c)) return null
  return { t, c, node: hlc.slice(22) }
}

function compare(a, b) {
  if (a === b) return 0
  if (!a) return -1
  if (!b) return 1
  return a < b ? -1 : 1
}

class Clock {
  constructor(nodeId) {
    this.node = shortCode(nodeId)
    this.t = 0
    this.c = 0
  }

  /** 本地事件：产生一个新时间戳 */
  next(nowMs) {
    const now = typeof nowMs === 'number' ? nowMs : Date.now()
    if (now > this.t) {
      this.t = now
      this.c = 0
    } else {
      this.c += 1
      if (this.c > MAX_C) {
        this.t += 1
        this.c = 0
      }
    }
    return fmt(this.t, this.c, this.node)
  }

  /** 收到远端事件：把本地时钟推到不小于远端，保证因果单调 */
  observe(hlc, nowMs) {
    const p = parse(hlc)
    if (!p) return
    const now = typeof nowMs === 'number' ? nowMs : Date.now()
    const t = Math.max(now, this.t, p.t)
    let c
    if (t === this.t && t === p.t) c = Math.max(this.c, p.c) + 1
    else if (t === this.t) c = this.c + 1
    else if (t === p.t) c = p.c + 1
    else c = 0
    if (c > MAX_C) {
      this.t = t + 1
      this.c = 0
    } else {
      this.t = t
      this.c = c
    }
  }

  /** 物理毫秒部分（用于与宿主 updated_at 这类「只有时间」的信号比较） */
  physical(hlc) {
    const p = parse(hlc)
    return p ? p.t : 0
  }
}

module.exports = { Clock, compare, parse, fmt, shortCode }
