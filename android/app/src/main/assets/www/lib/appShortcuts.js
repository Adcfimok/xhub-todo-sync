/* 速达 · 手机应用的独立数据模型（纯函数，可 Node 单测）。
 *
 * 关键取舍：手机应用**不进 records 集合**，只存 S.meta.phoneApps。
 * core.js 的 PROTO 2 同步只推 S.records 里的脏记录，meta 完全不在同步载荷内，
 * 因此手机应用与 PC 端速达（resources 集合）天然互不读写、互不影响：
 *   - 添加 / 移除手机应用不会 touch 任何 record，不会触发 scheduleSoon()；
 *   - PC 端同步过来的 kind=app / kind=file 记录不会进入手机应用列表；
 *   - 反过来 PC 端也永远看不到这台手机装了什么。
 *
 * 每条：{ pkg, label, icon, addedAt }
 *   icon = `/__appicon/<hash>.png`，由原生 AppCatalog 从系统 Drawable 导出的真实图标。
 */

export const PHONE_APPS_KEY = 'phoneApps'
export const MAX_PHONE_APPS = 200

function clean(v, n) {
  return String(v == null ? '' : v).slice(0, n)
}

/** 规整本地存储：丢掉坏数据、按包名去重、封顶，绝不凭空造应用 */
export function normalizeApps(raw) {
  if (!Array.isArray(raw)) return []
  const seen = {}
  const out = []
  raw.forEach((a) => {
    if (!a || typeof a !== 'object') return
    const pkg = clean(a.pkg, 200).trim()
    if (!pkg || seen[pkg]) return
    seen[pkg] = 1
    out.push({
      pkg,
      label: clean(a.label, 120).trim() || pkg,
      icon: clean(a.icon, 300).trim(),
      addedAt: Number(a.addedAt) || 0,
    })
  })
  return out.slice(0, MAX_PHONE_APPS)
}

export function hasApp(list, pkg) {
  return (list || []).some((a) => a.pkg === pkg)
}

/** 返回新数组；已存在或超上限时原样返回（调用方据此提示，不静默改动） */
export function addApp(list, app, now) {
  const cur = normalizeApps(list)
  // 重复 / 超上限时返回**原数组引用**，调用方据此判断「没加上」并提示，避免误报已添加
  if (!app || !app.pkg || hasApp(cur, app.pkg) || cur.length >= MAX_PHONE_APPS) return list
  return cur.concat([
    {
      pkg: clean(app.pkg, 200).trim(),
      label: clean(app.label, 120).trim() || app.pkg,
      icon: clean(app.icon, 300).trim(),
      addedAt: Number(now) || Date.now(),
    },
  ])
}

export function removeApp(list, pkg) {
  return normalizeApps((list || []).filter((a) => a.pkg !== pkg))
}

/**
 * PC 端程序/文件项：只从 resources 集合里读，供「电脑同步」分区只读展示。
 * 与手机应用列表没有任何共享字段转换，也不会互相写入。
 */
export function pcOnlyRecords(records) {
  return (records || []).filter((r) => r && !r.deleted && (r.kind === 'app' || r.kind === 'file'))
}

/** 手机应用是否可能被同步协议带出去：恒为 false，供回归测试锁住这条边界 */
export function isSyncedToPc(app) {
  return !!(app && app.col && String(app.col).indexOf('resources') === 0)
}
