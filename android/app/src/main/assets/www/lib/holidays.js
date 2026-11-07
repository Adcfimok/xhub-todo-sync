/* 节日数据：中国传统节日、二十四节气、外国传统节日。
 *
 * 全部按年现算，不写死某一年的日期：
 * - 农历节日（春节/端午/中秋…）由 lib/lunar.js 的农历表换算
 * - 节气由世纪常数公式推算（个别年份可能差 1 天，页脚已注明）
 * - 公历节日直接构造；感恩节/母亲节/父亲节按「第几个周几」算；复活节用通行算法
 */

import { lunarToSolar, lunarLastDayOfYear, solarTermDay, TERM_NAMES } from './lunar.js'

export const CATS = [
  { id: 'cn', name: '传统节日', desc: '农历节令与除夕、清明' },
  { id: 'term', name: '二十四节气', desc: '按太阳黄经推算，指导农时与作息' },
  { id: 'intl', name: '外国节日', desc: '公历固定日与按周次计算的节日' },
]

const DAY = 86400000

function at(year, month, day) {
  return new Date(year, month - 1, day, 0, 0, 0, 0).getTime()
}

/** 某年某月的第 n 个星期 w（0=周日） */
function nthWeekday(year, month, weekday, n) {
  const first = new Date(year, month - 1, 1)
  const shift = (weekday - first.getDay() + 7) % 7
  return at(year, month, 1 + shift + (n - 1) * 7)
}

/** 复活节（Anonymous Gregorian 算法） */
function easter(year) {
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  const day = ((h + l - 7 * m + 114) % 31) + 1
  return at(year, month, day)
}

function lunarDate(lunarYear, month, day, isLeap) {
  return lunarToSolar(lunarYear, month, day, isLeap)
}

/**
 * 某一年的全部节日。
 * @param {number} year 公历年
 * @returns {Array<{id:string,name:string,cat:string,date:number,note:string}>}
 */
export function holidaysForYear(year) {
  const out = []
  const push = (cat, name, date, note) => {
    if (!date) return
    out.push({ id: cat + ':' + name + ':' + year, name, cat, date, note: note || '' })
  }

  // ---------------- 中国传统节日 ----------------
  push('cn', '春节', lunarDate(year, 1, 1), '正月初一 · 农历新年')
  push('cn', '元宵节', lunarDate(year, 1, 15), '正月十五 · 赏灯吃元宵')
  push('cn', '龙抬头', lunarDate(year, 2, 2), '二月初二 · 春耕始')
  push('cn', '清明节', at(year, 4, solarTermDay(year, 6) || 5), '节气 · 祭祖踏青')
  push('cn', '端午节', lunarDate(year, 5, 5), '五月初五 · 粽子与龙舟')
  push('cn', '七夕', lunarDate(year, 7, 7), '七月初七 · 乞巧')
  push('cn', '中元节', lunarDate(year, 7, 15), '七月十五 · 祭祖')
  push('cn', '中秋节', lunarDate(year, 8, 15), '八月十五 · 团圆赏月')
  push('cn', '重阳节', lunarDate(year, 9, 9), '九月初九 · 登高敬老')
  push('cn', '腊八节', lunarDate(year, 12, 8), '腊月初八 · 腊八粥')
  push('cn', '小年', lunarDate(year, 12, 23), '腊月廿三 · 祭灶扫尘')
  push('cn', '除夕', lunarLastDayOfYear(year), '农历年最后一天 · 守岁')

  // ---------------- 二十四节气 ----------------
  for (let n = 0; n < 24; n++) {
    const day = solarTermDay(year, n)
    if (!day) continue
    push('term', TERM_NAMES[n], at(year, Math.floor(n / 2) + 1, day), '第 ' + (n + 1) + ' 个节气')
  }

  // ---------------- 外国传统节日 ----------------
  push('intl', '元旦', at(year, 1, 1), 'New Year')
  push('intl', '情人节', at(year, 2, 14), "Valentine's Day")
  push('intl', '愚人节', at(year, 4, 1), "April Fools' Day")
  push('intl', '复活节', easter(year), 'Easter · 春分月圆后首个周日')
  push('intl', '母亲节', nthWeekday(year, 5, 0, 2), "Mother's Day · 5 月第二个周日")
  push('intl', '父亲节', nthWeekday(year, 6, 0, 3), "Father's Day · 6 月第三个周日")
  push('intl', '万圣节', at(year, 10, 31), 'Halloween')
  push('intl', '感恩节', nthWeekday(year, 11, 4, 4), 'Thanksgiving · 11 月第四个周四')
  push('intl', '圣诞节', at(year, 12, 25), 'Christmas')

  return out.sort((a, b) => a.date - b.date)
}

/** 指定年份范围的节日，按日期升序 */
export function holidaysInRange(fromYear, count) {
  const out = []
  for (let i = 0; i < (count || 2); i++) out.push(...holidaysForYear(fromYear + i))
  return out.sort((a, b) => a.date - b.date)
}

/** 距离今天多少天（今天 = 0，明天 = 1，昨天 = -1） */
export function daysFromToday(ms) {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  return Math.round((ms - today) / DAY)
}

export function fmtYmd(ms) {
  const d = new Date(ms)
  return d.getMonth() + 1 + ' 月 ' + d.getDate() + ' 日'
}

export function fmtFull(ms) {
  const d = new Date(ms)
  return d.getFullYear() + ' 年 ' + (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日 · 周' + '日一二三四五六'[d.getDay()]
}
