import { boot, S, onChange } from './lib/core.js'
import { initAlerts } from './lib/alerts.js'
import { closeSheet, toast } from './lib/ui.js'
import { runQuickAdd, resetQuickAdd } from './lib/quickadd.js'
import * as home from './pages/home.js'
import * as todos from './pages/todos.js'
import * as notes from './pages/notes.js'
import * as ai from './pages/ai.js'
import * as more from './pages/more.js'
import * as calendar from './pages/calendar.js'
import * as account from './pages/account.js'
import * as pomodoro from './pages/pomodoro.js'
import * as stickies from './pages/stickies.js'
import * as resources from './pages/resources.js'
import * as snippets from './pages/snippets.js'
import * as ext from './pages/ext.js'
import * as settings from './pages/settings.js'

const PAGES = { home, todos, notes, ai, more, calendar, account, pomodoro, stickies, resources, snippets, ext, settings }
const TAB_OF = { home: 'home', todos: 'todos', notes: 'notes', ai: 'ai', more: 'more' }
// 二级页 → 返回目标：日历从首页进，其余从「更多」进
// 二级页 → 固定返回目标；没写的（如笔记，可能从首页也可能从「我的」进）按来源回退
const BACK_TO = { calendar: 'home', account: 'more', pomodoro: 'ext', stickies: 'more', resources: 'more', snippets: 'more', ext: 'more', settings: 'more' }
const SUB_PAGES = { calendar: 1, account: 1, pomodoro: 1, stickies: 1, resources: 1, snippets: 1, ext: 1, settings: 1 }

const pageEl = document.getElementById('page')
const titleEl = document.getElementById('page-title')
const backEl = document.getElementById('btn-back')
const tabbarEl = document.getElementById('tabbar')
// 底栏 6 个格子：首页 / 待办 / 笔记 / ＋ / AI / 我的，第 4 格是动作不参与切页
const SLOT_ROUTE = ['home', 'todos', 'notes', null, 'ai', 'more']
const TAB_SLOTS = { home: 0, todos: 1, notes: 2, ai: 4, more: 5 }
const VALID_SLOTS = [0, 1, 2, 4, 5]
const chipEl = document.getElementById('status-chip')
const textEl = document.getElementById('status-text')

let current = null
let cleanup = null
let prevRoute = 'home'
let suppressTabClick = false

function routeName() {
  const name = (location.hash || '').replace(/^#\/?/, '')
  return PAGES[name] ? name : 'home'
}

function go(name) {
  if (location.hash === '#/' + name) render(true)
  else location.hash = '#/' + name
}

function render(force) {
  const name = routeName()
  if (!force && current === name) return
  if (current && current !== name) prevRoute = current
  if (cleanup) {
    try {
      cleanup()
    } catch (e) {
      console.error(e)
    }
    cleanup = null
  }
  current = name
  const page = PAGES[name]
  titleEl.textContent = page.meta.title
  backEl.hidden = !SUB_PAGES[name]

  const activeTab = TAB_OF[name] || BACK_TO[name] || 'home'
  document.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('on', t.getAttribute('data-route') === activeTab)
  })
  if (tabbarEl) {
    const slot = TAB_SLOTS[activeTab]
    tabbarEl.style.setProperty('--tab-i', String(slot == null ? 0 : slot))
  }

  pageEl.innerHTML = ''
  // 先清掉上一页注册的「+」动作，再由新页面自己注册
  resetQuickAdd()
  cleanup = page.mount(pageEl) || null
}

function syncChip() {
  const st = S.status
  const state = st === 'conflict' ? 'conflict' : st === 'syncing' ? 'syncing' : st === 'online' ? 'online' : st === 'error' ? 'error' : 'offline'
  chipEl.setAttribute('data-state', state)
  textEl.textContent = S.statusText
}

function start() {
  document.querySelectorAll('.tab').forEach((t) => {
    t.addEventListener('click', () => go(t.getAttribute('data-route')))
  })
  backEl.addEventListener('click', () => go(BACK_TO[current] || prevRoute || 'more'))
  const addBtn = document.getElementById('btn-quick-add')
  if (addBtn) addBtn.addEventListener('click', () => runQuickAdd())
  chipEl.addEventListener('click', () => go('settings'))
  window.addEventListener('hashchange', () => render())
  initTabGesture()
  onChange(syncChip)

  boot()
    .then(() => {
      // 端口变了 = 换了一个空存储分区，明确告诉用户，而不是让它静默「丢数据」
      if (window.Android && typeof window.Android.originChanged === 'function') {
        try {
          S.originSwitched = !!window.Android.originChanged()
          S.originPort = window.Android.originPort ? window.Android.originPort() : 0
        } catch (e) {
          /* 老桥没有这两个方法，忽略 */
        }
      }
      settings.applyTheme(S.meta.themeMode, S.meta.accentColor)
      initAlerts()
      render(true)
      syncChip()
    })
    .catch((e) => {
      pageEl.innerHTML = '<div class="card"><p class="muted">启动失败：' + e + '</p></div>'
    })
}

// 安卓返回键：先关面板 / 子页，返回 false 时交给系统
window.__handleBack = function () {
  const sheet = document.getElementById('sheet')
  if (sheet && !sheet.hidden) {
    closeSheet()
    return true
  }
  const ov = document.getElementById('ext-overlay')
  if (ov) {
    ov.remove()
    return true
  }
  const scan = document.getElementById('scan')
  if (scan && !scan.hidden) {
    document.getElementById('btn-scan-close').click()
    return true
  }
  // 二级页：固定目标优先，否则回来源（笔记可从首页或「我的」进）
  if (SUB_PAGES[current]) {
    go(BACK_TO[current] || prevRoute || 'home')
    return true
  }
  if (current !== 'home') {
    go('home')
    return true
  }
  return false
}

window.__go = go
window.__toast = toast

start()

// ---------------------------------------------------------------- 底栏跟手滑动

/**
 * 在底栏上左右拖动时，高亮块实时跟手（拖拽期间关掉缓动，逐帧跟随），
 * 松手按位移吸附到最近的**有效**格子 —— 中央「+」不是页面，滑过它时不会停。
 */
function initTabGesture() {
  if (!tabbarEl) return
  const N = SLOT_ROUTE.length
  let startX = 0
  let startY = 0
  let baseI = 0
  let unit = 1
  let dragging = false
  let pid = null

  const indexNow = () => {
    const v = Number(tabbarEl.style.getPropertyValue('--tab-i'))
    return isFinite(v) ? Math.max(0, Math.min(N - 1, v)) : 0
  }

  // 离目标最近的合法格子（0/1/2/4/5）。
  // 从笔记(2) 往右拖一格，目标是 3（中央 +）——2 和 4 距离相同，
  // 此时必须按拖动方向倒向 4，否则「拖了一格却弹回原位」。
  const nearestSlot = (want, dir) => {
    let best = VALID_SLOTS[0]
    let bestDist = Math.abs(best - want)
    for (const cur of VALID_SLOTS) {
      const dist = Math.abs(cur - want)
      if (dist < bestDist || (dist === bestDist && (dir > 0 ? cur > best : cur < best))) {
        best = cur
        bestDist = dist
      }
    }
    return best
  }

  tabbarEl.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    // 点在中央 + 上不进入拖拽，避免把「新建」吃掉
    if (e.target.closest && e.target.closest('.tab-add')) return
    startX = e.clientX
    startY = e.clientY
    baseI = indexNow()
    unit = Math.max(1, (tabbarEl.clientWidth - 12) / N)
    dragging = false
    pid = e.pointerId
  })

  tabbarEl.addEventListener(
    'pointermove',
    (e) => {
      if (pid == null || e.pointerId !== pid) return
      const dx = e.clientX - startX
      const dy = e.clientY - startY
      if (!dragging) {
        // 先判方向：竖向滑动不该抢走点击
        if (Math.abs(dx) < 6) return
        if (Math.abs(dx) < Math.abs(dy) * 1.2) return
        dragging = true
        tabbarEl.classList.add('dragging')
        try {
          tabbarEl.setPointerCapture(pid)
        } catch (err) {
          /* 老 WebView 没有指针捕获，不影响主流程 */
        }
      }
      // 两端加阻尼，拖不出去
      const min = -baseI * unit
      const max = (N - 1 - baseI) * unit
      let d = dx
      if (d < min) d = min + (d - min) * 0.32
      if (d > max) d = max + (d - max) * 0.32
      tabbarEl.style.setProperty('--drag', d.toFixed(1) + 'px')
      if (e.cancelable) e.preventDefault()
    },
    { passive: false }
  )

  function finish(e) {
    if (pid == null || (e && e.pointerId !== pid)) return
    const wasDragging = dragging
    const d = parseFloat(tabbarEl.style.getPropertyValue('--drag')) || 0
    dragging = false
    pid = null
    tabbarEl.classList.remove('dragging')
    tabbarEl.style.setProperty('--drag', '0px')
    if (!wasDragging) return

    // 拖完的那次 click 不该再触发 tab 切换
    suppressTabClick = true
    setTimeout(() => (suppressTabClick = false), 60)

    const steps = Math.round(d / unit)
    const target = nearestSlot(baseI + steps, d)
    if (target !== baseI) go(SLOT_ROUTE[target])
  }

  tabbarEl.addEventListener('pointerup', finish)
  tabbarEl.addEventListener('pointercancel', finish)

  tabbarEl.addEventListener(
    'click',
    (e) => {
      if (!suppressTabClick) return
      e.stopPropagation()
      e.preventDefault()
    },
    true
  )
}
