'use strict'
/**
 * 混合逻辑时钟（HLC）。
 * 排序键形如 `0000018f2e5c3a10-0003-7f3a`：物理毫秒(16) - 计数(4) - 节点短码(4)，定宽。
 * 定宽是为了让字符串比较等价于数值比较——LWW 只需要一个全序，不需要解析。
 *
 * 两条硬约束（安全审计 P0-5）：
 * 1. 本地时钟必须单调——系统时间被回拨时，产生的键不能比上一个更小，否则本机的新改动
 *    会被自己更早的键压住。
 * 2. 远端时钟不能无限信任——一台把时间调到 2099 年的设备会把 hub 的 t 推到极远未来，
 *    此后本机所有新事件都小于它，全部被判 STALE。所以对超前量设上限，超了就拒收。
 */

const MAX_C = 0xffff

/** 允许远端时钟最多比本机快 5 分钟（NTP 抖动 + 跨时区误配都在此范围内） */
const MAX_DRIFT_MS = 5 * 60 * 1000
/** 允许远端时钟最多比本机慢 1 年（更旧的一律视为损坏数据） */
const MAX_AGE_MS = 365 * 24 * 3600 * 1000

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
    this.lastPhysical = 0
  }

  /** 本地事件：产生一个新时间戳 */
  next(nowMs) {
    const raw = typeof nowMs === 'number' ? nowMs : Date.now()
    // 单调保护：系统时间回拨时不让键倒退，最多按最后一个物理毫秒继续用计数位排队
    const now = Math.max(raw, this.lastPhysical)
    this.lastPhysical = now
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

  /**
   * 收到远端事件：把本地时钟推到不小于远端，保证因果单调。
   * 返回 { rejected, reason, drift } —— 调用方必须处理 rejected，
   * 不能静默丢弃（否则问题从「时钟被推偏」变成「改动凭空消失」）。
   */
  observe(hlc, nowMs) {
    const p = parse(hlc)
    if (!p) return { rejected: true, reason: 'BAD_FORMAT' }
    const now = typeof nowMs === 'number' ? nowMs : Date.now()

    if (p.t > now + MAX_DRIFT_MS) {
      return { rejected: true, reason: 'FUTURE_DRIFT', drift: p.t - now, remoteT: p.t }
    }
    if (p.t < now - MAX_AGE_MS) {
      return { rejected: true, reason: 'ANCIENT', drift: p.t - now, remoteT: p.t }
    }

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
    return { rejected: false }
  }

  /** 物理毫秒部分（用于与宿主 updated_at 这类「只有时间」的信号比较） */
  physical(hlc) {
    const p = parse(hlc)
    return p ? p.t : 0
  }
}

module.exports = { Clock, compare, parse, fmt, shortCode, MAX_DRIFT_MS, MAX_AGE_MS }
