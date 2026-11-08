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
/** 布局结构版本：v2 起统计卡与「每日一句」同为 4×1；v3 起升级时向上压实，补齐收高留下的空行 */
export const LAYOUT_V = 3

/** 卡片目录：minW/minH 是内容能完整显示的下限 */
export const CARD_DEFS = [
  { id: 'quote', title: '每日一句', desc: '本地名言，点一下换一条', minW: 2, minH: 1, defW: 4, defH: 1 },
  { id: 'stats', title: '统计', desc: '待办/笔记/速达/提示词计数', minW: 3, minH: 1, defW: 4, defH: 1 },
  { id: 'calendar', title: '日历', desc: '本月月历与当日安排', minW: 3, minH: 3, defW: 4, defH: 3 },
  { id: 'today', title: '今天的待办', desc: '到期与最近几条', minW: 2, minH: 2, defW: 4, defH: 2, route: 'todos' },
  { id: 'todos', title: '待办清单', desc: '来自扩展的 todos 集合', minW: 2, minH: 2, defW: 4, defH: 2, route: 'todos' },
  { id: 'notes', title: '最近笔记', desc: '来自扩展的 notes 集合', minW: 2, minH: 2, defW: 2, defH: 2, route: 'notes' },
  { id: 'stickies', title: '便签', desc: '来自扩展的 stickies 集合', minW: 2, minH: 1, defW: 2, defH: 2, route: 'stickies' },
  { id: 'resources', title: '速达', desc: '来自扩展的 resources 集合', minW: 2, minH: 1, defW: 2, defH: 2, route: 'resources' },
  { id: 'snippets', title: '提示词', desc: '来自扩展的 snippets 集合', minW: 2, minH: 1, defW: 2, defH: 2, route: 'snippets' },
  { id: 'holidays', title: '近期节日', desc: '节日与节气，一键加待办', minW: 2, minH: 2, defW: 2, defH: 2, route: 'holidays' },
  { id: 'timetable', title: '今日课表', desc: '今天的课程安排', minW: 2, minH: 2, defW: 4, defH: 2, route: 'timetable' },
  { id: 'countdown', title: '倒数日', desc: '重要日子倒计时 · 左右滑动切换', minW: 2, minH: 2, defW: 4, defH: 2, route: 'countdown' },
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
  // 统计紧跟名言，同为 4×1：两张卡在首页上沿对齐、宽高一致
  place('stats', 0, 1, 4, 1)
  place('timetable', 0, 2, 4, 2)
  place('countdown', 0, 4, 4, 2)
  place('calendar', 0, 6, 4, 3)
  place('today', 0, 9, 2, 2)
  place('holidays', 2, 9, 2, 2)
  place('notes', 0, 11, 2, 2)
  place('resources', 2, 11, 2, 2)
  return { v: LAYOUT_V, items, rows: 13 }
}

/** 2.12.0 短暂把统计拆成四张 4×1 卡片，2.12.1 起回退成一张「统计」卡 */
const SPLIT_STATS = ['stat:todos', 'stat:notes', 'stat:resources', 'stat:snippets']

/**
 * 回退迁移：装过 2.12.0 的布局里是四张统计卡，这里合并回一张「统计」卡，
 * 放在第一张统计卡原来的位置，其余卡片交给 normalize 解冲突，避免回退后统计凭空消失。
 */
function collapseStats(items) {
  let at = -1
  let y = 0
  let x = 0
  const rest = []
  items.forEach((it) => {
    if (!it) return
    if (SPLIT_STATS.indexOf(it.id) >= 0) {
      if (at < 0) {
        at = rest.length
        y = Number.isFinite(Number(it.y)) ? Math.max(0, Math.round(Number(it.y))) : 0
        x = Number.isFinite(Number(it.x)) ? Math.max(0, Math.round(Number(it.x))) : 0
      }
      return
    }
    rest.push(it)
  })
  if (at < 0) return items
  rest.splice(at, 0, { id: 'stats', x: Math.min(x, GRID_COLS - 4), y, w: 4, h: 1 })
  return rest
}

/**
 * 向上压实（升级用）：卡片只会往上挪进空位，不会横向移动或下移。
 * 统计卡从 2 行收成 1 行后，下面各卡的 y 还是老的，中间会空出一整行 —— 就是用户截图里那道缝。
 */
function pullUp(items) {
  const ordered = items
    .filter(Boolean)
    .map((it) => ({
      id: it.id,
      x: Math.max(0, Math.min(GRID_COLS - 1, Math.round(Number(it.x) || 0))),
      y: Math.max(0, Math.round(Number(it.y) || 0)),
      w: Math.max(1, Math.min(GRID_COLS, Math.round(Number(it.w) || 1))),
      h: Math.max(1, Math.round(Number(it.h) || 1)),
    }))
    .sort((a, b) => a.y - b.y || a.x - b.x)

  const placed = []
  ordered.forEach((it) => {
    const cand = (y) => ({ id: it.id, x: it.x, y, w: it.w, h: it.h })
    let y = it.y
    while (y > 0 && isFree(placed, cand(y - 1), it.id)) y--
    placed.push(cand(y))
  })
  return placed
}

/**
 * 老布局升级：
 * - v1 → v2：2.11.x/2.12.x 的统计卡默认 2 行，收成 1 行与名言对齐（用户拉到 3 行以上的不动）
 * - v2 → v3：收高后会空出一行，整体向上压实，把首页中间那道缝补齐
 */
function upgradeLayout(raw) {
  if (!raw || !Array.isArray(raw.items)) return raw
  const v = Number(raw.v) || 0
  if (v >= LAYOUT_V) return raw
  let items = raw.items.filter(Boolean)
  if (v < 2) {
    items = items.map((it) =>
      it.id === 'stats' && Number(it.h) === 2 ? Object.assign({}, it, { h: 1 }) : it
    )
  }
  return { v: LAYOUT_V, items: pullUp(items) }
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
  const src = raw && Array.isArray(raw.items) ? collapseStats(raw.items) : []
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
  return { v: LAYOUT_V, items, rows }
}

/** 载入：没有存过就用默认布局；老版本布局先升级到当前结构再规整 */
export function loadLayout(raw) {
  if (!raw || !Array.isArray(raw.items)) return defaultLayout()
  return normalizeLayout(upgradeLayout(raw))
}

/** 这份存档是不是还没升级到当前结构（用于载入后顺手回写） */
export function needsUpgrade(raw) {
  return !raw || !Array.isArray(raw.items) || Number(raw.v) < LAYOUT_V
}

/**
 * 向上压实：把每张卡尽量往上推，推不动为止。
 * 手机屏窄，删掉一张卡后留一整块空白会让首页看起来「坏了」，
 * 所以在「增删卡」时压实；手动拖动时不动，尊重用户摆的位置。
 */
export function compact(layout) {
  return normalizeLayout({ items: pullUp(layout.items) })
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
