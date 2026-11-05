/**
 * 配对二维码 / 手输地址的解析。
 *
 * 支持三种载荷：
 *   v3  xhub://3/<6位码>/<host:port,host:port,...>   多候选地址（新版推荐）
 *   v2  xhub://2/<host:port>/<6位码>
 *   v1  xhub://1/<host:port>/<6位码>
 *
 * 为什么要有 v3：一台电脑往往有好几张网卡（VPN、VMware、Hyper-V、WSL），
 * 扫码时不一定知道哪张手机能连上。把候选地址一起写进二维码，手机按顺序探测，
 * 第一个通的就用——比让用户自己猜地址可靠得多。
 */

const V3 = /^xhub:\/\/3\/(\d{6})\/(.+)$/
const V2 = /^xhub:\/\/[12]\/([^/]+)\/(\d{6})$/

/** 与 core.js::normalizeHost 保持一致的轻量版（本模块不依赖 DOM / IndexedDB） */
export function normalizeHostStr(v, defaultPort = 47821) {
  let s = String(v || '').trim()
  s = s.replace(/^https?:\/\//i, '').replace(/\/+$/, '')
  if (!s) return ''
  if (!/:\d+$/.test(s)) s += ':' + defaultPort
  return s
}

/**
 * @param {string} raw 二维码文本
 * @returns {{code:string, hosts:string[], version:number}|null}
 */
export function parsePairPayload(raw) {
  const text = String(raw || '').trim()
  if (!text) return null

  const m3 = V3.exec(text)
  if (m3) {
    const hosts = m3[2]
      .split(',')
      .map((x) => normalizeHostStr(x))
      .filter(Boolean)
    if (!hosts.length) return null
    return { code: m3[1], hosts: hosts.slice(0, 6), version: 3 }
  }

  const m2 = V2.exec(text)
  if (m2) {
    const host = normalizeHostStr(m2[1])
    if (!host) return null
    return { code: m2[2], hosts: [host], version: 2 }
  }

  return null
}
