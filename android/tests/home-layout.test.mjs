/**
 * 首页卡片布局回归：统计拆成四张 4×1 卡片后的几何与老数据迁移。
 *
 * 运行：
 *   node --experimental-default-type=module --test android/tests/home-layout.test.mjs
 *
 * 重点盯两件事：
 * 1) 四张统计卡与「每日一句」在网格里占的格数完全一致（4 列 × 1 行）
 * 2) 老版本存的单张「统计」卡（4×2）升级后自动拆成四张，日历等卡片被顺延而不是丢失
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

const STAT_IDS = ['stat:todos', 'stat:notes', 'stat:resources', 'stat:snippets']

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

test('统计四卡与每日一句同为 4×1', () => {
  const quote = cardDef('quote')
  assert.equal(quote.defW, 4)
  assert.equal(quote.defH, 1)
  STAT_IDS.forEach((id) => {
    const def = cardDef(id)
    assert.ok(def, `${id} 应该在卡片目录里`)
    assert.equal(def.defW, 4, `${id} 默认宽度应为整行`)
    assert.equal(def.defH, 1, `${id} 默认高度应与每日一句一致`)
    assert.equal(def.minH, 1)
    assert.ok(def.route, `${id} 需要可跳转路由`)
    assert.equal(def.tap, true, `${id} 需要整卡可点`)
  })
})

test('默认布局：统计四卡紧跟每日一句且互不重叠', () => {
  const layout = defaultLayout()
  const quote = layout.items.find((i) => i.id === 'quote')
  assert.deepEqual({ x: quote.x, y: quote.y, w: quote.w, h: quote.h }, { x: 0, y: 0, w: 4, h: 1 })

  STAT_IDS.forEach((id, i) => {
    const it = layout.items.find((x) => x.id === id)
    assert.ok(it, `${id} 在默认布局里`)
    assert.equal(it.x, 0)
    assert.equal(it.y, 1 + i)
    assert.equal(it.w, 4)
    assert.equal(it.h, 1)
  })

  noOverlap(layout.items)
  inGrid(layout.items)
})

test('卡片目录里不再有合并的「统计」卡，卡片库总数为 13', () => {
  assert.equal(CARD_DEFS.some((d) => d.id === 'stats'), false)
  assert.equal(CARD_DEFS.length, 13)
})

test('老布局的 4×2 统计卡会拆成四张并把后面的卡片顺延', () => {
  const legacy = {
    v: 1,
    items: [
      { id: 'quote', x: 0, y: 0, w: 4, h: 1 },
      { id: 'stats', x: 0, y: 1, w: 4, h: 2 },
      { id: 'calendar', x: 0, y: 3, w: 4, h: 3 },
      { id: 'today', x: 0, y: 6, w: 2, h: 2 },
      { id: 'holidays', x: 2, y: 6, w: 2, h: 2 },
    ],
  }
  const out = normalizeLayout(legacy)
  assert.equal(out.items.some((i) => i.id === 'stats'), false, '老 id 不应残留')
  STAT_IDS.forEach((id, i) => {
    const it = out.items.find((x) => x.id === id)
    assert.ok(it, `${id} 迁移后应存在`)
    assert.deepEqual({ x: it.x, y: it.y, w: it.w, h: it.h }, { x: 0, y: 1 + i, w: 4, h: 1 })
  })
  const cal = out.items.find((i) => i.id === 'calendar')
  assert.ok(cal && cal.y >= 5, '日历应被顺延到统计四卡之后')
  assert.equal(out.items.length, 8)
  noOverlap(out.items)
  inGrid(out.items)
})

test('迁移是幂等的：再存再读不会多出卡片', () => {
  const once = normalizeLayout({ items: [{ id: 'stats', x: 0, y: 1, w: 4, h: 2 }] })
  const twice = normalizeLayout(once)
  assert.deepEqual(
    twice.items.map((i) => i.id).sort(),
    once.items.map((i) => i.id).sort()
  )
  assert.equal(twice.items.length, 4)
  noOverlap(twice.items)
})

test('统计卡缩放受 minW 约束，拖完仍然合法', () => {
  const layout = defaultLayout()
  const moved = placeCard(layout, 'stat:todos', { x: 0, y: 9, w: 1, h: 1 })
  const it = moved.items.find((i) => i.id === 'stat:todos')
  assert.ok(it.w >= 3, '统计卡不能窄于 3 列')
  noOverlap(moved.items)
  inGrid(moved.items)
})

test('移除再添加统计卡能回到网格里', () => {
  const layout = defaultLayout()
  const removed = removeCard(layout, 'stat:snippets')
  assert.equal(removed.items.some((i) => i.id === 'stat:snippets'), false)
  const added = addCard(removed, 'stat:snippets')
  const it = added.items.find((i) => i.id === 'stat:snippets')
  assert.ok(it, '应能加回来')
  assert.equal(it.w, 4)
  assert.equal(it.h, 1)
  noOverlap(added.items)
  inGrid(added.items)
})
