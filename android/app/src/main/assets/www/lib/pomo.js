/* 番茄钟时长配置：页面、全局提醒、原生闹钟三处都从这里读，避免各写一份 25/5。
   存在 S.meta.pomoCfg，随本地库落盘，不需要联网。 */

import { S, saveMeta } from './core.js'

export const DEFAULT_CFG = { focusMin: 25, breakMin: 5 }

/** 允许的范围：专注 1–180 分钟、休息 1–60 分钟（与设置页提示保持一致） */
export const LIMITS = { focusMin: [1, 180], breakMin: [1, 60] }

function clampInt(v, lo, hi, fallback) {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.max(lo, Math.min(hi, Math.round(n)))
}

export function pomoCfg() {
  const raw = S.meta && S.meta.pomoCfg ? S.meta.pomoCfg : null
  const src = raw && typeof raw === 'object' ? raw : {}
  return {
    focusMin: clampInt(src.focusMin, LIMITS.focusMin[0], LIMITS.focusMin[1], DEFAULT_CFG.focusMin),
    breakMin: clampInt(src.breakMin, LIMITS.breakMin[0], LIMITS.breakMin[1], DEFAULT_CFG.breakMin),
  }
}

/** 某一模式的时长（秒） */
export function durOf(mode) {
  const cfg = pomoCfg()
  return (mode === 'break' ? cfg.breakMin : cfg.focusMin) * 60
}

export function savePomoCfg(next) {
  const cfg = {
    focusMin: clampInt(next.focusMin, LIMITS.focusMin[0], LIMITS.focusMin[1], DEFAULT_CFG.focusMin),
    breakMin: clampInt(next.breakMin, LIMITS.breakMin[0], LIMITS.breakMin[1], DEFAULT_CFG.breakMin),
  }
  return saveMeta('pomoCfg', cfg).then(() => cfg)
}

export function isCustom() {
  const cfg = pomoCfg()
  return cfg.focusMin !== DEFAULT_CFG.focusMin || cfg.breakMin !== DEFAULT_CFG.breakMin
}

/** 人类可读的时长，用于通知与按钮文案 */
export function fmtMinutes(min) {
  if (min < 60) return min + ' 分钟'
  const hh = Math.floor(min / 60)
  const mm = min % 60
  return mm ? hh + ' 小时 ' + mm + ' 分' : hh + ' 小时'
}
