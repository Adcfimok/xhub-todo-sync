import { boot, S, onChange, saveMeta } from './lib/core.js'
import { initAlerts } from './lib/alerts.js'
import { closeSheet, toast, h } from './lib/ui.js'
import { normalizeNickname } from './lib/nickname.js'
import { weekOfTerm, coursesOnDay } from './lib/timetable.js'
import { runQuickAdd, resetQuickAdd, setQuickAddFallback } from './lib/quickadd.js'
import { openTodoForm } from './lib/todoform.js'
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
import * as holidays from './pages/holidays.js'
import * as ext from './pages/ext.js'
import * as settings from './pages/settings.js'
import * as transfer from './pages/transfer.js'
import * as timetable from './pages/timetable.js'
import * as countdown from './pages/countdown.js'

const PAGES = { home, todos, notes, ai, more, calendar, account, pomodoro, stickies, resources, snippets, holidays, ext, settings, transfer, timetable, countdown }
const TAB_OF = { home: 'home', todos: 'todos', ai: 'ai', more: 'more' }
// 二级页 → 固定返回目标；没写的（如笔记，可能从首页也可能从「我的」进）按来源回退
const BACK_TO = { calendar: 'home', account: 'more', pomodoro: 'ext', stickies: 'more', resources: 'more', snippets: 'more', holidays: 'more', ext: 'more', settings: 'more', transfer: 'more', timetable: 'more', countdown: 'more' }
// 笔记不再是底栏页，但它有固定入口（我的 / 首页两处），所以要按二级页处理：
// 只有进了 SUB_PAGES，返回键才会退回来源页，而不是一律回首页。
const SUB_PAGES = { calendar: 1, account: 1, pomodoro: 1, stickies: 1, resources: 1, snippets: 1, holidays: 1, ext: 1, settings: 1, notes: 1, transfer: 1, timetable: 1, countdown: 1 }

const pageEl = document.getElementById('page')
const titleEl = document.getElementById('page-title')
const backEl = document.getElementById('btn-back')
const tabbarEl = document.getElementById('tabbar')
// 底栏 5 个格子：首页 / 待办 / ＋ / AI / 我的，第 3 格是动作不参与切页
const SLOT_ROUTE = ['home', 'todos', null, 'ai', 'more']
const TAB_SLOTS = { home: 0, todos: 1, ai: 3, more: 4 }
const VALID_SLOTS = [0, 1, 3, 4]
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
  // 供样式按页面微调（如 AI 页底部输入胶囊上方的提示条位置）
  document.body.dataset.route = name
  const page = PAGES[name]
  titleEl.textContent = page.meta.title
  // 笔记已移出底栏；它和其它二级页一样按来源定高亮（从首页进就亮首页，从「我的」进就亮「我的」）
  const activeTab = TAB_OF[name] || BACK_TO[name] || (SUB_PAGES[name] ? TAB_OF[prevRoute] || 'more' : 'home')
  backEl.hidden = !SUB_PAGES[name]

  document.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('on', t.getAttribute('data-route') === activeTab)
  })
  if (tabbarEl) {
    const slot = TAB_SLOTS[activeTab]
    tabbarEl.style.setProperty('--tab-i', String(slot == null ? 0 : slot))
    // 切页脉冲：高亮块从一个格子「跳」到另一个格子时，放大 + 炫彩一次
    tabbarEl.classList.remove('switching')
    void tabbarEl.offsetWidth
    tabbarEl.classList.add('switching')
    clearTimeout(render._pulse)
    render._pulse = setTimeout(() => tabbarEl.classList.remove('switching'), 440)
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

// ---------------------------------------------------------------- 新建类型选择

const addMask = document.getElementById('add-mask')
const addPicker = document.getElementById('add-picker')

export function closeAddPicker() {
  if (addMask) addMask.hidden = true
  if (addPicker) addPicker.hidden = true
}

/**
 * 底栏「＋」的默认动作：先选类型，再进对应表单。
 * 待办 / 笔记 / 提示词是三个最常新建的集合，其余（速达、便签）偏配置，不放进这里。
 */
export function openAddPicker() {
  if (!addPicker) return
  addMask.hidden = false
  addPicker.hidden = false
}

function bindAddPicker() {
  if (!addPicker) return
  addMask.addEventListener('click', closeAddPicker)
  addPicker.addEventListener('click', (e) => {
    const btn = e.target.closest ? e.target.closest('.add-item') : null
    if (!btn) return
    const type = btn.getAttribute('data-type')
    closeAddPicker()
    // 等面板收起再开表单，避免两层遮罩叠在一起、返回键一次只关一层
    setTimeout(() => {
      if (type === 'todos') openTodoForm(null)
      else if (type === 'notes') notes.openEditor(null)
      else if (type === 'snippets') snippets.openEditor(null)
    }, 140)
  })
}

function start() {
  document.querySelectorAll('.tab').forEach((t) => {
    t.addEventListener('click', () => {
      // 酷安式图标弹跳：点击时图标做一次「放大 → 回弹 → 落定」的果冻动画
      const svg = t.querySelector('svg')
      if (svg) {
        t.classList.remove('bounce')
        void svg.getBoundingClientRect()
        t.classList.add('bounce')
        setTimeout(() => t.classList.remove('bounce'), 420)
      }
      go(t.getAttribute('data-route'))
    })
  })
  backEl.addEventListener('click', () => go(BACK_TO[current] || prevRoute || 'more'))
  const addBtn = document.getElementById('btn-quick-add')
  if (addBtn) addBtn.addEventListener('click', () => runQuickAdd())
  setQuickAddFallback(openAddPicker)
  bindAddPicker()
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
      restoreKeepAlive()
      syncWidgetData()
      onChange(syncWidgetData)
      render(true)
      syncChip()
      // 首次启动：没设置过称呼就强制弹窗，填完才放行
      showNicknameGate()
    })
    .catch((e) => {
      pageEl.innerHTML = '<div class="card"><p class="muted">启动失败：' + e + '</p></div>'
    })
}

// ---------------------------------------------------------------- 后台保活 / 桌面小组件

/** 上次开了保活就自动拉起前台服务，避免每次手动开 */
function restoreKeepAlive() {
  if (S.meta.keepAlive !== '1') return
  if (window.Android && typeof window.Android.startKeepAlive === 'function') {
    try {
      window.Android.startKeepAlive()
    } catch (e) {
      /* 老桥没有这个方法，忽略 */
    }
  }
}

/** 把待办摘要与今日课表同步给桌面小组件（onChange 时也会刷新） */
function syncWidgetData() {
  if (!window.Android || typeof window.Android.setWidgetData !== 'function') return
  const todos = S.records.filter((r) => r.col === 'todos' && !r.deleted && !r.done)
  const todo = todos.length ? todos.length + ' 件待办 · ' + (todos[0].title || '') : '待办已清空'
  const tt = S.meta.timetable
  let ttText = '今天没有课'
  if (tt && Array.isArray(tt.courses)) {
    const weekNum = weekOfTerm(tt.termStart)
    const day = new Date().getDay() || 7
    const list = coursesOnDay(tt.courses, day, weekNum)
    if (list.length) ttText = list.slice(0, 3).map((c) => c.name).join(' · ') + (list.length > 3 ? ' 等' : '')
  }
  try {
    window.Android.setWidgetData(todo, ttText)
  } catch (e) {
    /* 老桥没有这个方法，忽略 */
  }
}

// ---------------------------------------------------------------- 首次称呼弹窗

/**
 * 首次启动的强制弹窗：不可关闭（没有取消、点遮罩无效、返回键也拦），
 * 用户输入称呼并提交后才消失。之后可在「我的 → 称呼」里改。
 */
function showNicknameGate() {
  if (S.meta.nickname) return
  const mask = h('div', { class: 'nick-gate' })
  const input = h('input', { class: 'input nick-input', placeholder: '例如：小明', maxlength: '16' })
  const box = h('div', { class: 'nick-card' }, [
    h('div', { class: 'nick-title', text: '希望我怎么称呼你' }),
    h('p', { class: 'nick-sub', text: '会用在首页问候、AI 对话和每日一句里，之后可在「我的 → 称呼」中修改。' }),
    input,
    h('button', { class: 'btn primary block nick-save', type: 'button', text: '就这么叫我', onclick: submit }),
  ])
  mask.appendChild(box)
  document.body.appendChild(mask)

  function submit() {
    const v = normalizeNickname(input.value)
    if (!v) {
      toast('先告诉我怎么称呼你吧')
      input.focus()
      return
    }
    saveMeta('nickname', v).then(() => {
      mask.remove()
      toast('你好，' + v + '！')
      render(true)
    })
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit()
  })
  setTimeout(() => input.focus(), 150)
}

// 安卓返回键：先关面板 / 子页，返回 false 时交给系统
window.__handleBack = function () {
  // 首次称呼弹窗不可关闭：返回键也拦下
  if (document.querySelector('.nick-gate')) return true
  // 类型选择是最上层，先关它
  if (addPicker && !addPicker.hidden) {
    closeAddPicker()
    return true
  }
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
      // 拖动进度 0~1：拖满一格即到顶，高亮块的放大与色散都按这个值走
      const p = Math.min(1, Math.abs(d) / unit)
      tabbarEl.style.setProperty('--drag-p', p.toFixed(3))
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
    tabbarEl.style.setProperty('--drag-p', '0')
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
