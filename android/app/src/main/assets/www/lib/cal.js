/* 日历数据层：日期键、按月排布、按天聚合。首页卡片与日历页共用同一份实现。 */

import { h, startOfDay } from './ui.js'

/** 本地日期键 'y-m-d'：不能用 toISOString，那是 UTC，晚上 8 点后会差一天 */
export function dayKey(ms) {
  const d = new Date(ms)
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate()
}

/** 按天聚合待办：总条数 / 未完成 / 已完成 / 逾期（逾期按自然日判，与待办分组口径一致） */
export function aggregate(todos) {
  const map = new Map()
  const todayStart = startOfDay(Date.now())
  for (const t of todos) {
    if (!t.dueAt) continue
    const k = dayKey(t.dueAt)
    let a = map.get(k)
    if (!a) {
      a = { total: 0, open: 0, done: 0, overdue: 0 }
      map.set(k, a)
    }
    a.total++
    if (t.done) a.done++
    else {
      a.open++
      if (startOfDay(t.dueAt) < todayStart) a.overdue++
    }
  }
  return map
}

/**
 * 一个月的格子（含前后补白），周一为一周起始。
 * @returns {Array<{ms:number, day:number, key:string, inMonth:boolean}>}
 */
export function monthMatrix(y, m) {
  const first = new Date(y, m, 1)
  const lead = (first.getDay() + 6) % 7
  const days = new Date(y, m + 1, 0).getDate()
  const total = Math.ceil((lead + days) / 7) * 7
  const out = []
  for (let i = 0; i < total; i++) {
    const d = new Date(y, m, 1 - lead + i)
    out.push({
      ms: d.getTime(),
      day: d.getDate(),
      key: dayKey(d.getTime()),
      inMonth: d.getMonth() === m && d.getFullYear() === y,
    })
  }
  return out
}

export const WEEK_HEAD = ['一', '二', '三', '四', '五', '六', '日']

/** 最多三个圆点：有逾期先红，全部完成转灰，其余为主题色 */
function dots(a) {
  const box = h('span', { class: 'd' })
  if (!a || !a.total) return box
  const n = Math.min(3, a.total)
  const allDone = a.open === 0
  for (let i = 0; i < n; i++) {
    let cls = ''
    if (allDone) cls = 'dn'
    else if (i === 0 && a.overdue > 0) cls = 'od'
    box.appendChild(h('i', { class: cls }))
  }
  return box
}

/**
 * 一个日期格。首页卡片与日历页共用，只在尺寸上由外层容器区分。
 * @param {{ms:number,day:number,key:string,inMonth:boolean}} c
 * @param {Map} agg aggregate() 的结果
 * @param {{todayMs?:number, selMs?:number, onclick?:Function}} opt
 */
export function cellNode(c, agg, opt) {
  const o = opt || {}
  const cls = ['dcell']
  if (!c.inMonth) cls.push('out')
  if (o.todayMs && c.ms === o.todayMs) cls.push('today')
  if (o.selMs && c.ms === o.selMs) cls.push('sel')
  return h(
    'button',
    {
      class: cls.join(' '),
      type: 'button',
      'data-ms': String(c.ms),
      // 卡片里的格子只是视觉，整张卡是入口：不给它单独占一个 Tab 位
      tabindex: o.onclick ? '0' : '-1',
      onclick: o.onclick,
    },
    [h('span', { class: 'dn', text: String(c.day) }), dots(agg.get(c.key))]
  )
}
