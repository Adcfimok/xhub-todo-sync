/**
 * 首页卡片布局回归：统计卡与「每日一句」同为 4×1 的几何、以及老布局升级。
 *
 * 运行：
 *   node --experimental-default-type=module --test android/tests/home-layout.test.mjs
 *
 * 重点盯三件事：
 * 1) 统计卡是一张 4×1 卡片，和「每日一句」占同样的格数
 * 2) 装过 2.11.x/2.12.x 的 2 行统计卡，载入时会收成 1 行（用户自己拉到 3 行以上的不动）
 * 3) 装过 2.12.0 的四张统计卡，载入时会合并回一张，日历等卡片顺延而不是丢掉
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  GRID_COLS,
  CARD_DEFS,
  cardDef,
  defaultLayout,
  normalizeLayout,
  loadLayout,
  needsUpgrade,
  addCard,
  removeCard,
  placeCard,
  overlaps,
} from '../app/src/main/assets/www/lib/homeLayout.js'

const SPLIT_IDS = ['stat:todos', 'stat:notes', 'stat:resources', 'stat:snippets']

function noOverlap(items) {
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      assert.equal(overlaps(items[i], items[j]), false, `${items[i].id} 与 ${items[j].id} 重叠`)
    }
  }
}

function inGrid(items) {
  items.forEach((i) => {
    assert.ok(i.x >= 0 && i.x + i.w <= GRID_COLS, `${i.id} 横向越界`)
    assert.ok(i.y >= 0, `${i.id} 纵向越界`)
  })
}

test('统计卡与每日一句同为 4×1', () => {
  const quote = cardDef('quote')
  const stats = cardDef('stats')
  assert.ok(stats, 'stats 应该在卡片目录里')
  assert.deepEqual({ w: stats.defW, h: stats.defH }, { w: quote.defW, h: quote.defH })
  assert.equal(stats.minH, 1, '统计卡最小高度也是 1 行，和名言一致')
  assert.equal(stats.route, undefined, '统计卡自己不跳转，靠四宫格里的按钮')
  SPLIT_IDS.forEach((id) => assert.equal(cardDef(id), null, `${id} 不应再出现在目录里`))
})

test('默认布局：统计紧跟名言、同为 1 行，日历接在下面', () => {
  const layout = defaultLayout()
  const quote = layout.items.find((i) => i.id === 'quote')
  const stats = layout.items.find((i) => i.id === 'stats')
  assert.deepEqual({ x: stats.x, y: stats.y, w: stats.w, h: stats.h }, { x: 0, y: 1, w: 4, h: 1 })
  assert.equal(quote.y + quote.h, stats.y, '统计紧贴名言下一行')
  const cal = layout.items.find((i) => i.id === 'calendar')
  assert.equal(cal.y, 2)
  assert.equal(layout.v, 3)
  noOverlap(layout.items)
  inGrid(layout.items)
})

test('卡片目录共 10 项，卡片库与 2.11.1 一致', () => {
  assert.equal(CARD_DEFS.length, 10)
  assert.deepEqual(
    CARD_DEFS.map((d) => d.id),
    ['quote', 'stats', 'calendar', 'today', 'todos', 'notes', 'stickies', 'resources', 'snippets', 'holidays']
  )
})

test('v1 布局里 2 行的统计卡，载入后收成 1 行并标记为 v3', () => {
  const v1 = {
    v: 1,
    items: [
      { id: 'quote', x: 0, y: 0, w: 4, h: 1 },
      { id: 'stats', x: 0, y: 1, w: 4, h: 2 },
      { id: 'calendar', x: 0, y: 3, w: 4, h: 3 },
      { id: 'today', x: 0, y: 6, w: 2, h: 2 },
      { id: 'holidays', x: 2, y: 6, w: 2, h: 2 },
    ],
  }
  assert.equal(needsUpgrade(v1), true)
  const out = loadLayout(v1)
  const stats = out.items.find((i) => i.id === 'stats')
  assert.deepEqual({ y: stats.y, h: stats.h }, { y: 1, h: 1 })
  const cal = out.items.find((i) => i.id === 'calendar')
  assert.ok(cal.y >= 2 && cal.y <= 3, '日历上移或保持原位，不与其他卡重叠')
  assert.equal(out.v, 3)
  assert.equal(needsUpgrade(out), false, '回写后不应再升级')
  noOverlap(out.items)
  inGrid(out.items)
})

test('v2 布局里收高留下的空行会被压实（用户截图里的那道缝）', () => {
  // 2.12.2 收高后写回的存档：统计 1 行在 y1，日历还停在 y3，中间空一行
  const v2 = {
    v: 2,
    items: [
      { id: 'quote', x: 0, y: 0, w: 4, h: 1 },
      { id: 'stats', x: 0, y: 1, w: 4, h: 1 },
      { id: 'calendar', x: 0, y: 3, w: 4, h: 3 },
      { id: 'today', x: 0, y: 6, w: 2, h: 2 },
      { id: 'holidays', x: 2, y: 6, w: 2, h: 2 },
    ],
  }
  assert.equal(needsUpgrade(v2), true)
  const out = loadLayout(v2)
  const at = (id) => out.items.find((i) => i.id === id)
  assert.equal(at('stats').y, 1)
  assert.equal(at('calendar').y, 2, '日历应紧贴统计卡，不留空行')
  assert.equal(at('today').y, 5)
  assert.equal(at('holidays').y, 5)
  assert.equal(out.v, 3)
  noOverlap(out.items)
  inGrid(out.items)
})

test('压实时只往上挪，不会改变卡片之间的上下顺序', () => {
  const out = loadLayout({
    v: 2,
    items: [
      { id: 'quote', x: 0, y: 0, w: 4, h: 1 },
      { id: 'stats', x: 0, y: 1, w: 4, h: 1 },
      { id: 'calendar', x: 0, y: 4, w: 4, h: 3 },
      { id: 'today', x: 0, y: 9, w: 2, h: 2 },
    ],
  })
  assert.deepEqual(
    out.items.slice().sort((a, b) => a.y - b.y).map((i) => i.id),
    ['quote', 'stats', 'calendar', 'today']
  )
  assert.equal(out.items.find((i) => i.id === 'calendar').y, 2)
  assert.equal(out.items.find((i) => i.id === 'today').y, 5)
})

test('用户自己拉到 3 行以上的统计卡不被强行改回 1 行', () => {
  const v1 = { v: 1, items: [{ id: 'stats', x: 0, y: 1, w: 4, h: 4 }] }
  const out = loadLayout(v1)
  assert.equal(out.items.find((i) => i.id === 'stats').h, 4)
})

test('2.12.0 的四张统计卡会合并回一张 4×1，后面的卡片顺延', () => {
  const split = {
    v: 1,
    items: [
      { id: 'quote', x: 0, y: 0, w: 4, h: 1 },
      { id: 'stat:todos', x: 0, y: 1, w: 4, h: 1 },
      { id: 'stat:notes', x: 0, y: 2, w: 4, h: 1 },
      { id: 'stat:resources', x: 0, y: 3, w: 4, h: 1 },
      { id: 'stat:snippets', x: 0, y: 4, w: 4, h: 1 },
      { id: 'calendar', x: 0, y: 5, w: 4, h: 3 },
    ],
  }
  const out = loadLayout(split)
  assert.equal(out.items.some((i) => SPLIT_IDS.includes(i.id)), false, '拆分卡不应残留')
  const stats = out.items.find((i) => i.id === 'stats')
  assert.ok(stats, '应合并出一张统计卡')
  assert.deepEqual({ x: stats.x, y: stats.y, w: stats.w, h: stats.h }, { x: 0, y: 1, w: 4, h: 1 })
  const cal = out.items.find((i) => i.id === 'calendar')
  assert.ok(cal && cal.y >= 2, '日历应被顺延到统计卡之后')
  noOverlap(out.items)
  inGrid(out.items)
})

test('合并与升级都是幂等的：再存再读不会多卡、不会反复缩高', () => {
  const once = loadLayout({ v: 1, items: SPLIT_IDS.map((id, i) => ({ id, x: 0, y: 1 + i, w: 4, h: 1 })) })
  const twice = loadLayout(once)
  assert.equal(once.items.length, 1)
  assert.equal(twice.items.length, 1)
  assert.equal(twice.items[0].h, 1)
  noOverlap(twice.items)
})

test('只装了一部分统计卡也能合并（用户删过其中几张）', () => {
  const out = normalizeLayout({
    items: [
      { id: 'quote', x: 0, y: 0, w: 4, h: 1 },
      { id: 'stat:notes', x: 0, y: 2, w: 4, h: 1 },
    ],
  })
  assert.equal(out.items.length, 2)
  const stats = out.items.find((i) => i.id === 'stats')
  assert.deepEqual({ y: stats.y, w: stats.w, h: stats.h }, { y: 2, w: 4, h: 1 })
  noOverlap(out.items)
})

test('统计卡高度下限是 1 行，拖到 0 也不行', () => {
  const layout = defaultLayout()
  const moved = placeCard(layout, 'stats', { x: 0, y: 6, w: 4, h: 0 })
  const it = moved.items.find((i) => i.id === 'stats')
  assert.equal(it.h, 1)
  noOverlap(moved.items)
  inGrid(moved.items)
})

test('移除再添加统计卡能回到网格里', () => {
  const layout = defaultLayout()
  const removed = removeCard(layout, 'stats')
  assert.equal(removed.items.some((i) => i.id === 'stats'), false)
  const added = addCard(removed, 'stats')
  const it = added.items.find((i) => i.id === 'stats')
  assert.ok(it, '应能加回来')
  assert.deepEqual({ w: it.w, h: it.h }, { w: 4, h: 1 })
  noOverlap(added.items)
  inGrid(added.items)
})
