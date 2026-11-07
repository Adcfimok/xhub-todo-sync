/* 农历换算 + 二十四节气：节日模块的基础数据层。
 *
 * 农历表与换算算法移植自 x-hub 桌面端的 src/utils/lunar.ts（1900–2100 位编码表），
 * 只是去掉了 TypeScript 类型标注；节气用通行的「世纪常数」公式。
 * 全部本地计算：不联网、不依赖任何服务，离线也能看节日。
 */

const LUNAR_INFO = [
  0x04bd8, 0x04ae0, 0x0a570, 0x054d5, 0x0d260, 0x0d950, 0x16554, 0x056a0, 0x09ad0, 0x055d2,
  0x04ae0, 0x0a5b6, 0x0a4d0, 0x0d250, 0x1d255, 0x0b540, 0x0d6a0, 0x0ada2, 0x095b0, 0x14977,
  0x04970, 0x0a4b0, 0x0b4b5, 0x06a50, 0x06d40, 0x1ab54, 0x02b60, 0x09570, 0x052f2, 0x04970,
  0x06566, 0x0d4a0, 0x0ea50, 0x06e95, 0x05ad0, 0x02b60, 0x186e3, 0x092e0, 0x1c8d7, 0x0c950,
  0x0d4a0, 0x1d8a6, 0x0b550, 0x056a0, 0x1a5b4, 0x025d0, 0x092d0, 0x0d2b2, 0x0a950, 0x0b557,
  0x06ca0, 0x0b550, 0x15355, 0x04da0, 0x0a5d0, 0x14573, 0x052d0, 0x0a9a8, 0x0e950, 0x06aa0,
  0x0aea6, 0x0ab50, 0x04b60, 0x0aae4, 0x0a570, 0x05260, 0x0f263, 0x0d950, 0x05b57, 0x056a0,
  0x096d0, 0x04dd5, 0x04ad0, 0x0a4d0, 0x0d4d4, 0x0d250, 0x0d558, 0x0b540, 0x0b5a0, 0x195a6,
  0x095b0, 0x049b0, 0x0a974, 0x0a4b0, 0x0b27a, 0x06a50, 0x06d40, 0x0af46, 0x0ab60, 0x09570,
  0x04af5, 0x04970, 0x064b0, 0x074a3, 0x0ea50, 0x06b58, 0x055c0, 0x0ab60, 0x096d5, 0x092e0,
  0x0c960, 0x0d954, 0x0d4a0, 0x0da50, 0x07552, 0x056a0, 0x0abb7, 0x025d0, 0x092d0, 0x0cab5,
  0x0a950, 0x0b4a0, 0x0baa4, 0x0ad50, 0x055d9, 0x04ba0, 0x0a5b0, 0x15176, 0x052b0, 0x0a930,
  0x07954, 0x06aa0, 0x0ad50, 0x05b52, 0x04b60, 0x0a6e6, 0x0a4e0, 0x0d260, 0x0ea65, 0x0d530,
  0x05aa0, 0x076a3, 0x096d0, 0x04afb, 0x04ad0, 0x0a4d0, 0x1d0b6, 0x0d250, 0x0d520, 0x0dd45,
  0x0b5a0, 0x056d0, 0x055b2, 0x049b0, 0x0a577, 0x0a4b0, 0x0aa50, 0x1b255, 0x06d20, 0x0ada0,
  0x14b63, 0x09370, 0x049f8, 0x04970, 0x064b0, 0x168a6, 0x0ea50, 0x06b20, 0x1a6c4, 0x0aae0,
  0x092e0, 0x0d2e3, 0x0c960, 0x0d557, 0x0d4a0, 0x0da50, 0x05d55, 0x056a0, 0x0a6d0, 0x055d4,
  0x052d0, 0x0a9b8, 0x0a950, 0x0b4a0, 0x0b6a6, 0x0ad50, 0x055a0, 0x0aba4, 0x0a5b0, 0x052b0,
  0x0b273, 0x06930, 0x07337, 0x06aa0, 0x0ad50, 0x14b55, 0x04b60, 0x0a570, 0x054e4, 0x0d160,
  0x0e968, 0x0d520, 0x0daa0, 0x16aa6, 0x056d0, 0x04ae0, 0x0a9d4, 0x0a2d0, 0x0d150, 0x0f252,
  0x0d520,
]

const HEAVENLY_STEMS = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸']
const EARTHLY_BRANCHES = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥']
const ZODIAC = ['鼠', '牛', '虎', '兔', '龙', '蛇', '马', '羊', '猴', '鸡', '狗', '猪']
const MONTH_NAMES = ['正', '二', '三', '四', '五', '六', '七', '八', '九', '十', '冬', '腊']
const DAY_NAMES = [
  '初一', '初二', '初三', '初四', '初五', '初六', '初七', '初八', '初九', '初十',
  '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十',
  '廿一', '廿二', '廿三', '廿四', '廿五', '廿六', '廿七', '廿八', '廿九', '三十',
]

/** 基准日：农历 1900-01-01 = 公历 1900-01-31 */
const BASE_MS = new Date(1900, 0, 31).getTime()

export function leapMonth(y) {
  return LUNAR_INFO[y - 1900] & 0xf
}

function leapDays(y) {
  return leapMonth(y) ? (LUNAR_INFO[y - 1900] & 0x10000 ? 30 : 29) : 0
}

function monthDays(y, m) {
  return LUNAR_INFO[y - 1900] & (0x10000 >> m) ? 30 : 29
}

function lunarYearDays(y) {
  let sum = 348
  for (let i = 0x8000; i > 0x8; i >>= 1) {
    sum += LUNAR_INFO[y - 1900] & i ? 1 : 0
  }
  return sum + leapDays(y)
}

/** 公历 Date → 农历（本地时区）。超出 1900–2100 返回 null。 */
export function toLunar(date) {
  let offset = Math.floor((date.getTime() - BASE_MS) / 86400000)
  if (offset < 0) return null

  let y = 1900
  let days = 0
  for (; y < 2101 && offset > 0; y++) {
    days = lunarYearDays(y)
    offset -= days
  }
  if (offset > 0) return null
  if (offset < 0) {
    offset += days
    y--
  }
  const year = y

  let isLeap = false
  let i
  let mdays = 0
  for (i = 1; i < 13 && offset > 0; i++) {
    if (leapMonth(year) > 0 && i === leapMonth(year) + 1 && !isLeap) {
      --i
      isLeap = true
      mdays = leapDays(year)
    } else {
      mdays = monthDays(year, i)
    }
    if (isLeap && i === leapMonth(year) + 1) isLeap = false
    offset -= mdays
  }
  if (offset === 0 && leapMonth(year) > 0 && i === leapMonth(year) + 1) {
    if (isLeap) isLeap = false
    else {
      isLeap = true
      --i
    }
  }
  if (offset < 0) {
    offset += mdays
    --i
  }
  const month = i
  const day = offset + 1

  return {
    year,
    month,
    monthName: (isLeap ? '闰' : '') + MONTH_NAMES[month - 1] + '月',
    dayName: DAY_NAMES[day - 1],
    day,
    isLeap,
    ganZhiYear: HEAVENLY_STEMS[(year - 4) % 10] + EARTHLY_BRANCHES[(year - 4) % 12],
    zodiac: ZODIAC[(year - 4) % 12],
    short: MONTH_NAMES[month - 1] + '月' + DAY_NAMES[day - 1].replace(/^初/, ''),
  }
}

/** 农历某年某月某日（可闰月）对应的公历时间；找不到返回 0 */
export function lunarToSolar(lunarYear, month, day, isLeap) {
  // 农历年跨公历年：正月初一最晚在 2 月下旬，腊月最晚在次年 2 月中旬。
  // 所以窗口取「当年 1 月 1 日 → 次年 2 月 20 日」，不能只扫当年。
  const start = new Date(lunarYear, 0, 1).getTime()
  const end = new Date(lunarYear + 1, 1, 20).getTime()
  for (let t = start; t < end; t += 86400000) {
    const l = toLunar(new Date(t))
    if (!l) continue
    if (l.year === lunarYear && l.month === month && l.day === day && !!l.isLeap === !!isLeap) return t
  }
  return 0
}

/** 农历某年腊月最后一天对应的公历时间（除夕） */
export function lunarLastDayOfYear(lunarYear) {
  for (let day = 30; day >= 29; day--) {
    const t = lunarToSolar(lunarYear, 12, day, false)
    if (t) return t
  }
  return 0
}

export const TERM_NAMES = [
  '小寒', '大寒', '立春', '雨水', '惊蛰', '春分',
  '清明', '谷雨', '立夏', '小满', '芒种', '夏至',
  '小暑', '大暑', '立秋', '处暑', '白露', '秋分',
  '寒露', '霜降', '立冬', '小雪', '大雪', '冬至',
]

// 21 世纪的节气分钟偏移（通行算法，误差 ±1 天以内）
const TERM_INFO = [
  0, 21208, 42467, 63836, 85337, 107014, 128867, 150921,
  173149, 195551, 218072, 240693, 263343, 285989, 308563, 331033,
  353350, 375494, 397447, 419210, 440795, 462224, 483532, 504758,
]

/** 第 n 个节气（0=小寒）在当年的公历日；返回 0 表示超出可算范围 */
export function solarTermDay(year, n) {
  if (year < 1900 || year > 2100) return 0
  const base = Date.UTC(1900, 0, 6, 2, 5)
  const ms = 31556925974.7 * (year - 1900) + TERM_INFO[n] * 60000 + base
  return new Date(ms).getUTCDate()
}

/** 公历某天是哪个节气（不是节气日返回空串） */
export function termOfDate(date) {
  const month = date.getMonth() + 1
  const day = date.getDate()
  for (let n = 0; n < 24; n++) {
    if (Math.floor(n / 2) + 1 !== month) continue
    if (solarTermDay(date.getFullYear(), n) === day) return TERM_NAMES[n]
  }
  return ''
}
