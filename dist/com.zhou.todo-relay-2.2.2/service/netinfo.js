'use strict'

/**
 * 局域网地址挑选。
 *
 * 这里的核心问题是「哪张网卡才是手机能连上的那张」。
 * 直觉做法是按 IP 段挑（192.168 / 10 / 172.16-31 都像内网），但开发机上往往还有
 * VPN（vgate / TAP）、VMware、VirtualBox、Hyper-V、WSL、Docker 的虚拟网卡，
 * 它们的地址同样落在这些网段里，按 IP 段排出来的第一张多半是虚拟网卡 ——
 * 二维码和「复制地址」给出一个手机根本路由不到的 IP，配对就永远超时。
 *
 * 正确做法是问操作系统「默认路由走哪张网卡」：UDP socket 对公网地址做一次
 * connect（不发包），本地地址就是默认出口地址。再叠加虚拟网卡名降权兜底。
 */

// 常见虚拟 / 隧道网卡的名字特征
const VIRTUAL_IFACE =
  /(vmware|virtualbox|\bvbox\b|hyper-?v|vethernet|\bwsl\b|docker|br-|veth|\btap\b|\btun\b|tailscale|zerotier|wireguard|openvpn|\bvpn\b|npcap|loopback|vgate|clash|surge|\butun\b|hamachi|radmin|mihomo)/i

const LINK_LOCAL = /^169\.254\./

/** 只判断名字：给 UI 标注「虚拟网卡，手机多半连不上」用 */
function isVirtualIface(name) {
  return VIRTUAL_IFACE.test(String(name || ''))
}

/** 公网探测目标：只用于让内核选路，不会真的发 UDP 包 */
const PROBE_TARGETS = ['223.5.5.5', '1.1.1.1', '8.8.8.8']

/**
 * 纯函数：给定网卡列表与默认路由地址，排出「该给手机用」的顺序。
 *
 * @param {Array<{iface:string,address:string}>} list
 * @param {string} primaryIp 默认路由出口地址（探测失败传空串）
 * @returns {Array<{iface:string,address:string,primary:boolean,virtual:boolean,rank:number}>}
 */
function rankAddresses(list, primaryIp) {
  const out = (list || [])
    .filter((it) => it && it.address && !LINK_LOCAL.test(it.address))
    .map((it) => {
      const virtual = isVirtualIface(it.iface)
      const isPrimary = !!primaryIp && it.address === primaryIp
      // 分数只用于兜底排序：默认路由 1000 分，物理网卡 100，虚拟网卡 -100
      let rank = isPrimary ? 1000 : 0
      rank += virtual ? -100 : 100
      if (/^192\.168\./.test(it.address)) rank += 20
      else if (/^10\./.test(it.address)) rank += 15
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(it.address)) rank += 10
      return { iface: String(it.iface || ''), address: it.address, primary: isPrimary, virtual, rank }
    })

  out.sort((a, b) => {
    if (a.primary !== b.primary) return a.primary ? -1 : 1
    if (a.virtual !== b.virtual) return a.virtual ? 1 : -1
    return b.rank - a.rank
  })

  // 一次都没命中默认路由（探测失败 / 单网卡离线）→ 把排在最前的物理网卡当主地址
  if (out.length && !out.some((x) => x.primary)) {
    const firstReal = out.find((x) => !x.virtual)
    if (firstReal) firstReal.primary = true
  }
  return out
}

/** 探测默认路由出口地址；失败返回空串（不抛错，交给兜底排序） */
function probeDefaultRoute() {
  return new Promise((resolve) => {
    let settled = false
    const finish = (v) => {
      if (settled) return
      settled = true
      resolve(v || '')
    }

    const tryOne = (idx) => {
      if (idx >= PROBE_TARGETS.length) return finish('')
      let sock
      try {
        sock = require('dgram').createSocket('udp4')
      } catch (e) {
        return finish('')
      }
      let done = false
      const next = () => {
        if (done) return
        done = true
        try {
          sock.close()
        } catch (e) {
          /* 已关闭 */
        }
        tryOne(idx + 1)
      }
      sock.on('error', next)
      try {
        sock.connect(53, PROBE_TARGETS[idx], () => {
          try {
            const a = sock.address()
            const ip = a && a.address ? a.address : ''
            if (ip) {
              done = true
              try {
                sock.close()
              } catch (e) {
                /* ignore */
              }
              finish(ip)
            } else {
              next()
            }
          } catch (e) {
            next()
          }
        })
      } catch (e) {
        next()
      }
      // 个别系统上 connect 回调不触发，1 秒后换下一个目标
      setTimeout(() => {
        if (!done) next()
      }, 1000)
    }

    tryOne(0)
  })
}

/** 系统网卡 → rankAddresses 的输入 */
function listIPv4(os) {
  const out = []
  const ifaces = os.networkInterfaces()
  for (const [name, arr] of Object.entries(ifaces)) {
    for (const it of arr || []) {
      if (!it || it.family !== 'IPv4' || it.internal) continue
      out.push({ iface: name, address: it.address })
    }
  }
  return out
}

module.exports = { rankAddresses, probeDefaultRoute, listIPv4, isVirtualIface }
