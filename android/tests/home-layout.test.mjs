/**
 * 首页卡片布局回归：统计卡「拆四张 → 回退单张」后的几何与数据迁移。
 *
 * 运行：
 *   node --experimental-default-type=module --test android/tests/home-layout.test.mjs
 *
 * 重点盯两件事：
 * 1) 统计仍是一张 4×2 卡片，四个数字在卡片内部，不再有 stat:* 独立卡
 * 2) 装过 2.12.0 的布局（四张 4×1 统计卡）读出来会合并回一张，日历等卡片顺延而不是丢掉
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  GRID_COLS,
  CARD_DEFS,
  cardDef,
  defaultLayout,
  normalizeLayout,
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

test('统计卡是单张 4×2，卡片目录里没有拆开的 stat:*', () => {
  const def = cardDef('stats')
  assert.ok(def, 'stats 应该在卡片目录里')
  assert.equal(def.defW, 4)
  assert.equal(def.defH, 2)
  assert.equal(def.minH, 2)
  assert.equal(def.route, undefined, '统计卡自己不跳转，靠四宫格里的按钮')
  SPLIT_IDS.forEach((id) => assert.equal(cardDef(id), null, `${id} 不应再出现在目录里`))
})

test('默认布局：名言之后就是统计卡，日历接在下面', () => {
  const layout = defaultLayout()
  const stats = layout.items.find((i) => i.id === 'stats')
  assert.deepEqual({ x: stats.x, y: stats.y, w: stats.w, h: stats.h }, { x: 0, y: 1, w: 4, h: 2 })
  const cal = layout.items.find((i) => i.id === 'calendar')
  assert.equal(cal.y, 3)
  assert.equal(layout.items.some((i) => SPLIT_IDS.includes(i.id)), false)
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

test('2.12.0 的四张统计卡会合并回一张，后面的卡片顺延', () => {
  const split = {
    v: 1,
    items: [
      { id: 'quote', x: 0, y: 0, w: 4, h: 1 },
      { id: 'stat:todos', x: 0, y: 1, w: 4, h: 1 },
      { id: 'stat:notes', x: 0, y: 2, w: 4, h: 1 },
      { id: 'stat:resources', x: 0, y: 3, w: 4, h: 1 },
      { id: 'stat:snippets', x: 0, y: 4, w: 4, h: 1 },
      { id: 'calendar', x: 0, y: 5, w: 4, h: 3 },
      { id: 'today', x: 0, y: 8, w: 2, h: 2 },
      { id: 'holidays', x: 2, y: 8, w: 2, h: 2 },
    ],
  }
  const out = normalizeLayout(split)
  assert.equal(out.items.some((i) => SPLIT_IDS.includes(i.id)), false, '拆分卡不应残留')
  const stats = out.items.find((i) => i.id === 'stats')
  assert.ok(stats, '应合并出一张统计卡')
  assert.deepEqual({ x: stats.x, y: stats.y, w: stats.w, h: stats.h }, { x: 0, y: 1, w: 4, h: 2 })
  const cal = out.items.find((i) => i.id === 'calendar')
  assert.ok(cal && cal.y >= 3, '日历应被顺延到统计卡之后')
  assert.equal(out.items.length, 5)
  noOverlap(out.items)
  inGrid(out.items)
})

test('合并是幂等的：再存再读不会多卡', () => {
  const once = normalizeLayout({ items: SPLIT_IDS.map((id, i) => ({ id, x: 0, y: 1 + i, w: 4, h: 1 })) })
  const twice = normalizeLayout(once)
  assert.equal(once.items.length, 1)
  assert.deepEqual(
    twice.items.map((i) => i.id),
    once.items.map((i) => i.id)
  )
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
  assert.deepEqual({ y: stats.y, w: stats.w, h: stats.h }, { y: 2, w: 4, h: 2 })
  noOverlap(out.items)
})

test('统计卡缩放受 minH 约束，拖完仍然合法', () => {
  const layout = defaultLayout()
  const moved = placeCard(layout, 'stats', { x: 0, y: 9, w: 4, h: 1 })
  const it = moved.items.find((i) => i.id === 'stats')
  assert.equal(it.h, 2, '统计卡不能压到 1 行')
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
  assert.equal(it.w, 4)
  assert.equal(it.h, 2)
  noOverlap(added.items)
  inGrid(added.items)
})
