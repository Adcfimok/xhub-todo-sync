/* 首页卡片布局模型：4 列网格，每个卡片记 x/y/w/h（单位 = 格）。
 *
 * 设计取舍：
 * - 只存「卡片 id + 位置 + 尺寸」，卡片内容由 pages/home.js 渲染，模型与视图解耦
 * - 位置用整数格而不是像素：换屏幕尺寸不会错位，也不用在缩放时重算
 * - 目标位置被占时向下找最近空位（不弹回），避免拖完「什么都没发生」
 * - 扩展同步的五个集合（待办/笔记/便签/速达/提示词）都注册成可选卡片
 */

export const GRID_COLS = 4
export const ROW_H = 78

/** 卡片目录：minW/minH 是内容能完整显示的下限 */
export const CARD_DEFS = [
  { id: 'quote', title: '每日一句', desc: '本地名言，点一下换一条', minW: 2, minH: 1, defW: 4, defH: 1 },
  // 四个统计各占一张 4×1 卡片：与「每日一句」同宽同高，不再挤在一个卡片的四宫格里
  { id: 'stat:todos', title: '待办', desc: '未完成数量 · 点卡片直达待办', minW: 3, minH: 1, defW: 4, defH: 1, route: 'todos', tap: true },
  { id: 'stat:notes', title: '笔记', desc: '笔记条数 · 点卡片直达笔记', minW: 3, minH: 1, defW: 4, defH: 1, route: 'notes', tap: true },
  { id: 'stat:resources', title: '速达', desc: '速达入口数量 · 点卡片直达', minW: 3, minH: 1, defW: 4, defH: 1, route: 'resources', tap: true },
  { id: 'stat:snippets', title: '提示词', desc: '提示词条数 · 点卡片直达', minW: 3, minH: 1, defW: 4, defH: 1, route: 'snippets', tap: true },
  { id: 'calendar', title: '日历', desc: '本月月历与当日安排', minW: 3, minH: 3, defW: 4, defH: 3 },
  { id: 'today', title: '今天的待办', desc: '到期与最近几条', minW: 2, minH: 2, defW: 4, defH: 2, route: 'todos' },
  { id: 'todos', title: '待办清单', desc: '来自扩展的 todos 集合', minW: 2, minH: 2, defW: 4, defH: 2, route: 'todos' },
  { id: 'notes', title: '最近笔记', desc: '来自扩展的 notes 集合', minW: 2, minH: 2, defW: 2, defH: 2, route: 'notes' },
  { id: 'stickies', title: '便签', desc: '来自扩展的 stickies 集合', minW: 2, minH: 1, defW: 2, defH: 2, route: 'stickies' },
  { id: 'resources', title: '速达', desc: '来自扩展的 resources 集合', minW: 2, minH: 1, defW: 2, defH: 2, route: 'resources' },
  { id: 'snippets', title: '提示词', desc: '来自扩展的 snippets 集合', minW: 2, minH: 1, defW: 2, defH: 2, route: 'snippets' },
  { id: 'holidays', title: '近期节日', desc: '节日与节气，一键加待办', minW: 2, minH: 2, defW: 2, defH: 2, route: 'holidays' },
]

const BY_ID = {}
CARD_DEFS.forEach((d) => (BY_ID[d.id] = d))

export function cardDef(id) {
  return BY_ID[id] || null
}

/** 扩展里同步的五个集合，用来在「卡片库」里标注来源 */
export const EXT_COLLECTIONS = ['todos', 'notes', 'stickies', 'resources', 'snippets']

/** 默认布局：按阅读顺序自上而下排，首次打开就有完整首页 */
export function defaultLayout() {
  const items = []
  const place = (id, x, row, w, h) => items.push({ id, x, y: row, w, h })
  place('quote', 0, 0, 4, 1)
  // 四张统计卡各自独占一行，尺寸与「每日一句」完全一致
  place('stat:todos', 0, 1, 4, 1)
  place('stat:notes', 0, 2, 4, 1)
  place('stat:resources', 0, 3, 4, 1)
  place('stat:snippets', 0, 4, 4, 1)
  place('calendar', 0, 5, 4, 3)
  place('today', 0, 8, 2, 2)
  place('holidays', 2, 8, 2, 2)
  place('notes', 0, 10, 2, 2)
  place('resources', 2, 10, 2, 2)
  return { v: 1, items, rows: 12 }
}

/** 2.11.1 及更早版本用一张 4×2 的「统计」卡装四个数字 */
const LEGACY_STATS = ['stat:todos', 'stat:notes', 'stat:resources', 'stat:snippets']

/**
 * 老布局里的「统计」卡拆成四张统计卡，避免升级后统计直接消失。
 * 保留原来的 y 起点往下依次排开，后面的卡片交给 normalize 顺延。
 */
function expandLegacy(items) {
  const out = []
  items.forEach((it) => {
    if (it && it.id === 'stats') {
      const y0 = Number.isFinite(Number(it.y)) ? Math.max(0, Math.round(Number(it.y))) : 0
      LEGACY_STATS.forEach((id, i) => out.push({ id, x: 0, y: y0 + i, w: GRID_COLS, h: 1 }))
      return
    }
    out.push(it)
  })
  return out
}

function clampInt(v, lo, hi, fb) {
  const n = Number(v)
  if (!Number.isFinite(n)) return fb
  return Math.max(lo, Math.min(hi, Math.round(n)))
}

export function overlaps(a, b) {
  if (a.id === b.id) return false
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

/** 该矩形放下去会不会压到别的卡片 */
export function isFree(items, rect, ignoreId) {
  return !items.some((it) => {
    if (it.id === (ignoreId || rect.id)) return false
    return overlaps(it, rect)
  })
}

/**
 * 从目标位置开始，向下逐行找最近的可放位置。
 * 先试目标行，再试下面每一行（同一行从左到右），保证「拖到被占位置」也能落下来。
 */
export function nearestFree(items, rect, ignoreId) {
  const w = Math.max(1, Math.min(GRID_COLS, rect.w))
  const maxY = Math.max.apply(null, items.map((i) => i.y + i.h).concat([0])) + rect.h + 2
  for (let y = Math.max(0, rect.y); y <= maxY; y++) {
    for (let x = Math.max(0, Math.min(GRID_COLS - w, rect.x)); x >= 0; x--) {
      const cand = { id: rect.id, x, y, w, h: rect.h }
      if (isFree(items, cand, ignoreId)) return cand
    }
    // 再从右侧试一遍（用户可能想靠右放）
    for (let x = 0; x <= GRID_COLS - w; x++) {
      const cand = { id: rect.id, x, y, w, h: rect.h }
      if (isFree(items, cand, ignoreId)) return cand
    }
  }
  return { id: rect.id, x: 0, y: maxY, w, h: rect.h }
}

/** 规整：丢掉不认识的 id、钳制尺寸、解冲突、重算行数 */
export function normalizeLayout(raw) {
  const src = raw && Array.isArray(raw.items) ? expandLegacy(raw.items) : []
  const seen = {}
  const items = []
  src.forEach((it) => {
    if (!it || !BY_ID[it.id] || seen[it.id]) return
    const def = BY_ID[it.id]
    seen[it.id] = 1
    const w = clampInt(it.w, def.minW, GRID_COLS, def.defW)
    const h = clampInt(it.h, def.minH, 8, def.defH)
    const x = clampInt(it.x, 0, GRID_COLS - w, 0)
    const y = clampInt(it.y, 0, 200, 0)
    const rect = { id: it.id, x, y, w, h }
    // 位置被别人占了就顺延到最近空位，保证加载出来的布局一定可用
    const placed = isFree(items, rect) ? rect : nearestFree(items, rect)
    items.push(placed)
  })
  // 缺的卡片默认不打进布局（等于被用户移除过），但首次使用（无 raw）给默认布局
  const rows = Math.max.apply(null, items.map((i) => i.y + i.h).concat([1]))
  return { v: 1, items, rows }
}

/** 载入：没有存过就用默认布局 */
export function loadLayout(raw) {
  if (!raw || !Array.isArray(raw.items)) return defaultLayout()
  return normalizeLayout(raw)
}

/**
 * 向上压实：把每张卡尽量往上推，推不动为止。
 * 手机屏窄，删掉一张卡后留一整块空白会让首页看起来「坏了」，
 * 所以在「增删卡」时压实；手动拖动时不动，尊重用户摆的位置。
 */
export function compact(layout) {
  const ordered = layout.items.slice().sort((a, b) => a.y - b.y || a.x - b.x)
  const placed = []
  ordered.forEach((it) => {
    let y = it.y
    while (y > 0) {
      const cand = { id: it.id, x: it.x, y: y - 1, w: it.w, h: it.h }
      if (isFree(placed, cand, it.id)) y--
      else break
    }
    placed.push({ id: it.id, x: it.x, y, w: it.w, h: it.h })
  })
  return normalizeLayout({ items: placed })
}

export function removeCard(layout, id) {
  return compact(normalizeLayout({ items: layout.items.filter((i) => i.id !== id) }))
}

/** 加一张卡：放到第一个能放下的位置 */
export function addCard(layout, id) {
  const def = BY_ID[id]
  if (!def || layout.items.some((i) => i.id === id)) return layout
  const rect = { id, x: 0, y: 0, w: def.defW, h: def.defH }
  const spot = nearestFree(layout.items, rect)
  return compact(normalizeLayout({ items: layout.items.concat([spot]) }))
}

/** 移动 / 缩放：先规整再解冲突 */
export function placeCard(layout, id, patch) {
  const cur = layout.items.filter((i) => i.id === id)[0]
  if (!cur) return layout
  const def = BY_ID[id]
  const w = clampInt(patch.w == null ? cur.w : patch.w, def.minW, GRID_COLS, cur.w)
  const h = clampInt(patch.h == null ? cur.h : patch.h, def.minH, 8, cur.h)
  const x = clampInt(patch.x == null ? cur.x : patch.x, 0, GRID_COLS - w, cur.x)
  const y = clampInt(patch.y == null ? cur.y : patch.y, 0, 200, cur.y)
  const target = { id, x, y, w, h }
  const others = layout.items.filter((i) => i.id !== id)
  const placed = isFree(others, target, id) ? target : nearestFree(others, target, id)
  return normalizeLayout({ items: others.concat([placed]) })
}

/** 空位检测：给「未放置的卡片」用 */
export function missingCards(layout) {
  const has = {}
  layout.items.forEach((i) => (has[i.id] = 1))
  return CARD_DEFS.filter((d) => !has[d.id])
}
