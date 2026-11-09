import { S, saveMeta, applyMeta } from '../lib/core.js'
import { h, closeSheet, toast, confirmAsync } from '../lib/ui.js'
import { PRESET_FALLBACK, isPlatformLogin } from '../lib/platform.js'
import { requestText, openExternal } from '../lib/native.js'
import { openModelPicker } from '../lib/modelpicker.js'
import {
  KIND_CUSTOM,
  addCustomModel,
  availability,
  currentModel,
  loadProfiles,
  modelBase,
  modelKey,
  modelSubtitle,
  recoverModel,
  removeModel,
  selectModel,
  syncPlatformModels,
  updateCustomModel,
} from '../lib/aimodels.js'
import { runAgent, buildSystemPrompt } from '../lib/agent.js'
import {
  MAX_SESSIONS,
  IDX_KEY,
  ACTIVE_KEY,
  chatKey,
  newSessionId,
  clampMessages,
  makeSession,
  refreshSession,
  upsertSession,
  removeSessions,
  sessionMessages,
  initStore,
  groupSessions,
  fmtTime,
} from '../lib/chatStore.js'

export const meta = { title: 'AI 助手', route: 'ai' }

/** 外链图标（lucide ExternalLink，与原 x-hub「获取 Key」链接同形） */
const EXT_ICON =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/></svg>'

let rootEl = null
let messages = []
let sessions = []
/** '' = 尚未发出第一条消息的新对话草稿；有值 = 正在查看 / 继续某个历史会话 */
let activeId = ''
let sending = false
let abortCtl = null
let lastUsage = null
let lastElapsed = 0
/** 回退提示每次进入页面只说一遍，避免每次重绘都弹 */
let fallbackNoted = ''
/** 历史面板：批量选择模式与勾选集合 */
let histPanel = null
let selecting = false
let selected = new Set()

export function mount(root) {
  rootEl = root
  const init = initStore(S.meta)
  sessions = init.sessions
  activeId = init.activeId
  lastUsage = null
  lastElapsed = 0
  // 旧版 aiMessages 的迁移：applyMeta 会**同步**把 writes 写进 S.meta（落盘在后台），
  // 必须先执行再读消息，否则升级后首次进 AI 页会看到一条空会话。
  if (init.writes.length) applyMeta(init.writes)
  messages = activeId ? sessionMessages(S.meta, activeId) : []
  render()
  return () => {
    if (abortCtl) abortCtl.abort()
    closeHistory()
  }
}

function currentTitle() {
  const s = sessions.filter((x) => x.id === activeId)[0]
  return s ? s.title : '新对话'
}

/** 一次事务落盘：消息体 + 索引 + 当前指针，三者要么一起成功要么一起不动 */
async function persist() {
  if (!activeId) return
  const msgs = clampMessages(messages)
  messages = msgs
  const now = Date.now()
  const cur = sessions.filter((s) => s.id === activeId)[0] || makeSession(activeId, msgs, now)
  sessions = upsertSession(sessions, refreshSession(cur, msgs, now))
  await applyMeta([[chatKey(activeId), msgs], [IDX_KEY, sessions], [ACTIVE_KEY, activeId]])
}

/** 把一个模型条目展开成请求参数；profile 为空表示当前没有可用模型 */
function cfgFor(profile, extra) {
  const p = profile || null
  return Object.assign(
    {
      profile: p,
      platform: !!p && p.kind === 'platform',
      baseURL: p ? modelBase(p) : '',
      apiKey: p ? modelKey(p) : '',
      model: p ? p.model : '',
      system: S.meta.aiSystem || '',
      temperature: S.meta.aiTemp == null ? 0.7 : Number(S.meta.aiTemp),
      blocked: '',
      fallbackText: '',
    },
    extra || {}
  )
}

function cfg() {
  const r = currentModel()
  return cfgFor(r.profile, {
    blocked: r.profile ? '' : r.text,
    fallbackText: r.fallbackFrom ? r.text : '',
    selected: r.selected,
  })
}

function configured() {
  return !!cfg().profile
}

function endpoint(base) {
  return String(base || '').replace(/\/+$/, '') + '/chat/completions'
}

/** 顶部/空态共用：打开模型选择器，选完就地重绘 */
function pickModel() {
  openModelPicker({
    title: '选择模型',
    hint: '确认后立即生效：AI 助手与课表 AI 识别共用这个模型，并记住到下次切换。',
    onPick: () => render(),
    onManage: () => openConfig(),
  })
}

function render() {
  if (!rootEl) return
  rootEl.innerHTML = ''
  const c = cfg()

  if (!configured()) {
    rootEl.appendChild(
      h('div', { class: 'scroll' }, [
        h('div', { class: 'card' }, [
          h('h2', { text: '先选择模型' }),
          h('p', {
            class: 'muted',
            text: '可以用 x-hub 内置模型（登录账号后走平台额度），也可以接入任意 OpenAI 兼容接口。请求由手机直接发出，不经过电脑；密钥只存在这台手机上。',
          }),
          c.blocked ? h('p', { class: 'muted mdl-warn-text', text: '当前模型不可用：' + c.blocked }) : null,
          h('button', { class: 'btn primary block', type: 'button', text: '选择模型', onclick: pickModel }),
          h('button', { class: 'btn block', type: 'button', text: '管理 / 添加自备模型', onclick: openConfig }),
          // 即使换了模型 / 清了 Key，历史对话也必须还能翻出来看
          h('button', { class: 'btn block hist-open', type: 'button', text: '查看历史对话（' + sessions.length + '）', onclick: openHistory }),
        ]),
        h('div', { class: 'card' }, [
          h('h2', { text: '能做什么' }),
          h('p', { class: 'muted', text: '配好之后可以直接说「明天下午三点提醒我交房租」「把要交房租那条标成紧急」，助手会真的把待办建好 / 改好。' }),
        ]),
      ])
    )
    return
  }

  if (c.fallbackText && fallbackNoted !== c.fallbackText) {
    fallbackNoted = c.fallbackText
    setTimeout(() => toast(c.fallbackText), 60)
  }

  rootEl.appendChild(
    h('div', { class: 'chat-tools' }, [
      h(
        'button',
        {
          class: 'chat-model cm-btn',
          type: 'button',
          id: 'btn-chat-model',
          title: c.fallbackText || '切换模型',
          onclick: pickModel,
        },
        [
          h('i', { class: 'cm-dot', 'data-kind': c.platform ? 'platform' : 'custom' }),
          h('span', { class: 'cm-name', text: c.profile.label }),
          h('i', { class: 'cm-tag', text: c.platform ? '平台' : '自备' }),
        ]
      ),
      h('button', { class: 'mini', type: 'button', id: 'btn-chat-history', text: '历史 ' + sessions.length, 'aria-label': '历史对话', onclick: openHistory }),
      h('button', { class: 'mini', type: 'button', text: '⚙', 'aria-label': '设置', onclick: openConfig }),
      h('button', { class: 'mini', type: 'button', id: 'btn-new-chat', text: '+ 新对话', onclick: newChat }),
    ])
  )
  rootEl.appendChild(sessionBar())

  const scroll = h('div', { class: 'chat-scroll', id: 'chat-scroll' })
  if (!messages.length) {
    scroll.appendChild(
      h('div', { class: 'chat-empty' }, [
        h('p', { class: 'empty-t', text: activeId ? '继续这段对话' : '问点什么' }),
        h('p', { class: 'empty-s', text: '试试：帮我建一条明天下午三点的待办，标题是交房租' }),
        activeId ? null : h('p', { class: 'empty-s', text: '这是新对话，发出第一条消息后自动保存；点顶部「历史」能回到此前的对话。' }),
        h(
          'div',
          { class: 'quick' },
          ['我有什么待办', '把今天到期的都标成紧急', '新建：周五 10 点和设计对齐'].map((t) =>
            h('button', { class: 'chip', type: 'button', text: t, onclick: () => send(t) })
          )
        ),
      ])
    )
  }
  messages.forEach((m, i) => scroll.appendChild(bubble(m, i === messages.length - 1)))
  rootEl.appendChild(scroll)

  // 输入区：磨砂胶囊，token 统计在框内顶部
  const stats = h('div', { class: 'composer-stats', id: 'composer-stats', text: statsText() })
  const input = h('textarea', { class: 'chat-input', id: 'chat-input', rows: 1, placeholder: '输入消息，或直接让我建待办…' })
  input.addEventListener('input', () => {
    input.style.height = 'auto'
    input.style.height = Math.min(96, input.scrollHeight) + 'px'
  })
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      submit()
    }
  })

  rootEl.appendChild(
    h('div', { class: 'composer' }, [
      stats,
      h('div', { class: 'composer-row' }, [
        input,
        h('button', {
          class: 'send-btn',
          type: 'button',
          id: 'btn-send',
          text: sending ? '■' : '↑',
          onclick: () => (sending ? stop() : submit()),
        }),
      ]),
    ])
  )

  function submit() {
    const t = input.value.trim()
    if (!t || sending) return
    input.value = ''
    input.style.height = 'auto'
    send(t)
  }

  setTimeout(() => {
    scroll.scrollTop = scroll.scrollHeight
  }, 30)
}

function bubble(m, isLast) {
  // 只要还没出正文就一直转，工具徽章在下面独立显示
  const waiting = m.role === 'assistant' && !m.content && sending && isLast
  const b = h('div', { class: 'bubble' })
  if (waiting) {
    b.appendChild(h('span', { class: 'typing' }, [h('i'), h('i'), h('i')]))
  } else {
    b.textContent = m.content || (m.role === 'assistant' ? '…' : '')
  }

  const wrap = h('div', { class: 'msg ' + (m.role === 'user' ? 'me' : 'ai') }, [b])
  if (m.tools && m.tools.length) {
    const bar = h('div', { class: 'tool-chips' })
    m.tools.forEach((t) => {
      bar.appendChild(h('span', { class: 'tool-chip' + (t.ok ? '' : ' bad'), text: (t.ok ? '✓ ' : '✕ ') + t.summary }))
    })
    wrap.appendChild(bar)
  }
  return wrap
}

function stop() {
  if (abortCtl) abortCtl.abort()
  abortCtl = null
  sending = false
  render()
}

/** 新建对话：只把指针拨回草稿态，已有的历史会话一条都不动，也不需要二次确认 */
function newChat() {
  if (sending) return toast('正在回复，先停止或等回复结束')
  closeHistory()
  activeId = ''
  messages = []
  lastUsage = null
  lastElapsed = 0
  applyMeta([[ACTIVE_KEY, '']])
  render()
  toast('已开始新对话，历史记录都还在')
}

async function send(text) {
  if (sending) return
  let c = cfg()
  if (!c.profile) {
    toast(c.blocked || '还没有可用模型，先选一个')
    openConfig()
    return
  }

  // 懒创建：新对话只有在真的发出第一条消息时才落成一条历史记录，
  // 否则反复点「+ 新对话」会在列表里堆出一串空会话。
  if (!activeId) {
    if (sessions.length >= MAX_SESSIONS) {
      toast('历史对话已达 ' + MAX_SESSIONS + ' 条，请先删除一些再新建')
      return
    }
    activeId = newSessionId()
  }

  const history = messages
    .filter((m) => m.content && (m.role === 'user' || m.role === 'assistant'))
    .map((m) => ({ role: m.role, content: m.content }))

  messages.push({ role: 'user', content: text })
  const ai = { role: 'assistant', content: '', tools: [] }
  messages.push(ai)
  sending = true
  lastUsage = null
  // 先把「提问 + 占位回复」落盘：万一中途被系统杀掉或断网，用户问过什么不会丢
  await persist()
  render()
  const scroll = document.getElementById('chat-scroll')
  if (scroll) scroll.scrollTop = scroll.scrollHeight

  const apiMessages = [{ role: 'system', content: buildSystemPrompt() + (c.system ? '\n\n补充设定：' + c.system : '') }]
    .concat(history)
    .concat([{ role: 'user', content: text }])

  abortCtl = new AbortController()
  const t0 = Date.now()

  const runOpts = (cc) => ({
    url: endpoint(cc.baseURL),
    apiKey: cc.apiKey,
    model: cc.model,
    temperature: cc.temperature,
    messages: apiMessages,
    signal: abortCtl.signal,
    onDelta: (piece) => {
      ai.content += piece
      paintText()
    },
    onTool: (name, summary, ok) => {
      ai.tools.push({ name, summary, ok })
      paintTools()
    },
    onUsage: (u) => {
      lastUsage = u
      lastElapsed = Date.now() - t0
      paintStats()
    },
    confirmDelete: (t) => confirmAsync('AI 要删除待办「' + t.title + '」，删除后不可恢复。', '删除'),
  })

  try {
    try {
      await runAgent(runOpts(c))
    } catch (e) {
      // 平台后台下架模型时是 400 model_not_allowed：对账后换当前模型重试一次。
      // 已经有正文就不重试（流到一半重来会重复输出），如实报错。
      const next = ai.content || ai.tools.length ? null : await recoverModel(c.profile, e)
      if (!next) throw e
      toast('原模型「' + c.profile.label + '」不可用，已改用「' + next.label + '」重试')
      c = cfgFor(next)
      await runAgent(runOpts(c))
    }
    if (!ai.content && !ai.tools.length) ai.content = '（没有返回内容）'
  } catch (e) {
    if (e.name === 'AbortError') {
      if (!ai.content) ai.content = '（已停止）'
    } else {
      let msg = e.message || String(e)
      if (e.status === 401 && c.platform) msg = '平台登录已失效，请重新登录账号'
      ai.content = ai.content ? ai.content + '\n\n[中断] ' + msg : '请求失败：' + msg
    }
  } finally {
    abortCtl = null
    sending = false
    lastElapsed = Date.now() - t0
    // 成功 / 出错 / 主动停止都走这里，完整回复与会话元数据一次落盘
    await persist()
    render()
  }
}

// ---------------------------------------------------------------- 局部刷新（避免整页重绘导致输入框失焦）

function paintText() {
  const bubbleEls = document.querySelectorAll('.msg.ai .bubble')
  const last = bubbleEls[bubbleEls.length - 1]
  const ai = messages[messages.length - 1]
  if (last) last.textContent = ai.content
  const scroll = document.getElementById('chat-scroll')
  if (scroll) scroll.scrollTop = scroll.scrollHeight
}

function paintTools() {
  const ai = messages[messages.length - 1]
  const wraps = document.querySelectorAll('.msg.ai')
  const last = wraps[wraps.length - 1]
  if (!last) return
  let bar = last.querySelector('.tool-chips')
  if (!bar) {
    bar = h('div', { class: 'tool-chips' })
    last.appendChild(bar)
  }
  bar.innerHTML = ''
  ai.tools.forEach((t) => {
    bar.appendChild(h('span', { class: 'tool-chip' + (t.ok ? '' : ' bad'), text: (t.ok ? '✓ ' : '✕ ') + t.summary }))
  })
  const scroll = document.getElementById('chat-scroll')
  if (scroll) scroll.scrollTop = scroll.scrollHeight
}

function paintStats() {
  const el = document.getElementById('composer-stats')
  if (el) el.textContent = statsText()
}

function fmtTok(n) {
  const v = Number(n) || 0
  return v >= 1000 ? (v / 1000).toFixed(1) + 'k' : String(v)
}

function statsText() {
  if (!lastUsage) return sending ? '正在思考…' : ''
  const u = lastUsage
  const parts = ['↑ ' + fmtTok(u.input), '↓ ' + fmtTok(u.output)]
  if (u.cached) {
    const rate = Math.round((u.cached / Math.max(1, u.input)) * 100)
    parts.push('缓存 ' + fmtTok(u.cached) + '（' + rate + '%）')
  }
  if (lastElapsed > 800 && u.output > 0) {
    parts.push(((u.output / lastElapsed) * 1000).toFixed(0) + ' tok/s')
  }
  return parts.join(' · ')
}

// ---------------------------------------------------------------- 历史对话

/** 当前会话状态条：把「新对话」与「历史对话」在界面上明确分开 */
function sessionBar() {
  const isNew = !activeId
  return h('div', { class: 'chat-session' + (isNew ? ' is-new' : '') }, [
    h('span', { class: 'chat-session-tag', text: isNew ? '✦ 新对话' : '↺ 历史对话' }),
    h('span', { class: 'chat-session-name', text: isNew ? '发第一条消息后自动保存' : currentTitle() }),
    h('span', { class: 'chat-session-meta', text: isNew ? '' : messages.length + ' 条' }),
  ])
}

function openHistory() {
  if (sending) return toast('正在回复，先停止或等回复结束')
  if (histPanel) return
  selecting = false
  selected = new Set()
  const mask = h('div', { class: 'hist-mask' })
  const panel = h('div', { class: 'hist-panel' })
  mask.appendChild(panel)
  document.body.appendChild(mask)
  mask.addEventListener('click', (e) => {
    if (e.target === mask) closeHistory()
  })
  histPanel = { mask, panel }
  paintHistory()
}

function closeHistory() {
  if (!histPanel) return
  histPanel.mask.remove()
  histPanel = null
  selecting = false
  selected = new Set()
}

function paintHistory() {
  if (!histPanel) return
  const panel = histPanel.panel
  panel.innerHTML = ''
  panel.appendChild(
    h('div', { class: 'hist-head' }, [
      h('b', { text: '历史对话 · ' + sessions.length + ' 条' }),
      h('button', { class: 'mini', type: 'button', text: '关闭', onclick: closeHistory }),
    ])
  )
  panel.appendChild(
    h('div', { class: 'hist-tools' }, [
      h('button', {
        class: 'mini',
        type: 'button',
        text: selecting ? '取消选择' : '批量选择',
        onclick: () => {
          selecting = !selecting
          selected = new Set()
          paintHistory()
        },
      }),
      selecting
        ? h('button', {
            class: 'mini',
            type: 'button',
            text: '全选',
            onclick: () => {
              selected = new Set(sessions.map((s) => s.id))
              paintHistory()
            },
          })
        : null,
      selecting
        ? h('button', {
            class: 'mini danger' + (selected.size ? '' : ' disabled'),
            type: 'button',
            text: '删除选中（' + selected.size + '）',
            onclick: () => deleteSessions(Array.from(selected)),
          })
        : null,
    ])
  )
  panel.appendChild(h('p', { class: 'hist-hint', text: '点一条对话即可查看并继续提问；删除前会再确认一次。' }))

  const list = h('div', { class: 'hist-list' })
  if (!sessions.length) {
    list.appendChild(
      h('div', { class: 'empty' }, [
        h('p', { class: 'empty-t', text: '还没有历史对话' }),
        h('p', { class: 'empty-s', text: '发出第一条消息后，这段对话会自动保存在这里。' }),
      ])
    )
  }
  groupSessions(sessions, Date.now()).forEach((g) => {
    list.appendChild(h('div', { class: 'hist-group', text: g.label }))
    g.items.forEach((s) => {
      const row = h('div', { class: 'hist-row' + (s.id === activeId ? ' on' : '') })
      if (selecting) {
        const cb = h('input', { type: 'checkbox', class: 'hist-check' })
        cb.checked = selected.has(s.id)
        cb.addEventListener('change', () => {
          if (cb.checked) selected.add(s.id)
          else selected.delete(s.id)
          paintHistory()
        })
        row.appendChild(cb)
      }
      row.appendChild(
        h('button', { class: 'hist-main', type: 'button', onclick: () => switchSession(s.id) }, [
          h('div', { class: 'hist-title' }, [
            h('b', { text: s.title }),
            s.id === activeId ? h('span', { class: 'hist-cur', text: '当前' }) : null,
          ]),
          h('span', { class: 'hist-preview', text: s.preview }),
          h('span', { class: 'hist-meta', text: fmtTime(s.updatedAt, Date.now()) + ' · ' + s.count + ' 条消息' }),
        ])
      )
      if (!selecting) {
        row.appendChild(h('button', { class: 'mini danger', type: 'button', text: '删除', onclick: () => deleteSessions([s.id]) }))
      }
      list.appendChild(row)
    })
  })
  panel.appendChild(list)
}

/** 查看 / 继续：换指针、载入该会话消息、滚到最新一条；之后发消息会继续写进这个会话 */
async function switchSession(id) {
  if (sending) return toast('正在回复，先停止或等回复结束')
  if (id === activeId) {
    closeHistory()
    return
  }
  activeId = id
  messages = sessionMessages(S.meta, id)
  lastUsage = null
  lastElapsed = 0
  await applyMeta([[ACTIVE_KEY, id]])
  closeHistory()
  render()
  toast('已切换到「' + currentTitle() + '」，可以直接继续提问')
}

/** 单条 / 批量删除共用：一律先确认，删的是消息 key 本身而不是留空壳 */
async function deleteSessions(ids) {
  if (!ids || !ids.length) return
  if (sending) return toast('正在回复，先停止或等回复结束')
  const titleOf = (id) => {
    const s = sessions.filter((x) => x.id === id)[0]
    return s ? s.title : '对话'
  }
  const text =
    ids.length === 1
      ? '删除对话「' + titleOf(ids[0]) + '」？删除后不可恢复。'
      : '删除选中的 ' + ids.length + ' 条对话？删除后不可恢复。'
  if (!(await confirmAsync(text, '删除'))) return

  const wasActive = ids.indexOf(activeId) >= 0
  const remaining = removeSessions(sessions, ids)
  const deletes = ids.map((id) => chatKey(id))
  sessions = remaining
  if (wasActive) {
    activeId = ''
    messages = []
    lastUsage = null
    lastElapsed = 0
  }
  selecting = false
  selected = new Set()
  await applyMeta([[IDX_KEY, sessions], [ACTIVE_KEY, activeId]], deletes)
  closeHistory()
  render()
  toast('已删除 ' + ids.length + ' 条对话')
}

// ---------------------------------------------------------------- 配置面板

/**
 * 模型设置：列表本身就是选择器。
 * - 点一行即切换（写 aiSelected + 旧键），不需要再点保存；
 * - 自备模型可增删改，平台模型由服务端清单决定（只读，可刷新）；
 * - 底部「保存并关闭」只负责系统提示词，避免「换了模型却忘了保存」。
 */
export function openConfig() {
  const sheet = document.getElementById('sheet')
  const mask = document.getElementById('sheet-mask')
  const body = document.getElementById('sheet-body')
  document.getElementById('sheet-title').textContent = '模型设置'
  document.getElementById('btn-delete').hidden = true

  const st = {
    sys: S.meta.aiSystem || '',
    adding: false,
    editingId: '',
    busy: false,
    loadingPlatform: false,
    platformMsg: '',
    form: blankForm(),
    testing: false,
    testMsg: '',
    testOk: null,
  }

  function blankForm() {
    return { label: '', base: '', model: '', key: '', guideUrl: '', note: '', providerName: '' }
  }

  function resetTest() {
    st.testing = false
    st.testMsg = ''
    st.testOk = null
  }

  function setTest(ok, msg) {
    st.testOk = ok
    st.testMsg = msg
    const el = document.getElementById('test-result')
    if (el) {
      el.textContent = msg
      el.className = 'test-result' + (ok == null ? '' : ok ? ' ok' : ' bad')
    }
  }

  function section(title, action) {
    return h('div', { class: 'mdl-sect' }, [h('b', { text: title }), action || null])
  }

  function field(label, type, value, oninput, placeholder) {
    return h('label', { class: 'field' }, [
      h('span', { text: label }),
      h('input', {
        class: 'input',
        type,
        placeholder: placeholder || '',
        value: value || '',
        oninput: (e) => oninput(e.target.value),
      }),
    ])
  }

  function modelRow(p, loggedIn, curId, editable) {
    const a = availability(p, { loggedIn })
    const on = p.id === curId
    const main = h('span', { class: 'mdl-main' }, [
      h('span', { class: 'mdl-t' }, [
        h('b', { text: p.label }),
        on ? h('i', { class: 'mdl-badge', text: '使用中' }) : null,
        a.ok ? null : h('i', { class: 'mdl-bad', text: a.text }),
      ]),
      h('span', { class: 'mdl-s', text: modelSubtitle(p) }),
    ])
    const row = h(
      'div',
      {
        class: 'mdl-row' + (on ? ' on' : '') + (a.ok ? '' : ' off'),
        role: 'button',
        'data-id': p.id,
        onclick: () => useModel(p),
      },
      [h('span', { class: 'mdl-dot' }), main]
    )
    if (!editable) return row
    row.appendChild(
      h('button', {
        class: 'mini',
        type: 'button',
        text: '编辑',
        onclick: (e) => {
          e.stopPropagation()
          startEdit(p)
        },
      })
    )
    row.appendChild(
      h('button', {
        class: 'mini danger',
        type: 'button',
        text: '删除',
        onclick: (e) => {
          e.stopPropagation()
          del(p)
        },
      })
    )
    return row
  }

  function draw() {
    body.innerHTML = ''
    const r = currentModel()
    const profiles = loadProfiles()
    const loggedIn = isPlatformLogin()
    const curId = r.profile ? r.profile.id : ''

    // ---------- 当前 ----------
    body.appendChild(
      h('div', { class: 'mdl-current' }, [
        h('span', { class: 'mdl-main' }, [
          h('span', { class: 'mdl-t' }, [
            h('b', { text: r.profile ? r.profile.label : '未选择模型' }),
            h('i', {
              class: 'mdl-badge',
              text: r.profile ? (r.profile.kind === 'platform' ? '平台' : '自备') : '不可用',
            }),
          ]),
          h('span', { class: 'mdl-s', text: r.profile ? modelSubtitle(r.profile) : r.text }),
        ]),
        h('button', { class: 'mini', type: 'button', text: '选择', onclick: openPickerHere }),
      ])
    )
    if (r.fallbackFrom) body.appendChild(h('p', { class: 'mdl-tip bad', text: r.text }))

    // ---------- x-hub 内置 ----------
    body.appendChild(
      section(
        'x-hub 内置模型',
        loggedIn
          ? h('button', {
              class: 'mini',
              type: 'button',
              text: st.loadingPlatform ? '刷新中…' : '刷新',
              disabled: st.loadingPlatform,
              onclick: refreshPlatform,
            })
          : null
      )
    )
    if (!loggedIn) {
      body.appendChild(h('p', { class: 'field-note', text: '登录 x-hub 账号后自动获取平台模型：走平台额度、公网直连，不需要填 Key。' }))
      body.appendChild(
        h('button', {
          class: 'btn block',
          type: 'button',
          text: '去登录账号',
          onclick: () => {
            closeSheet()
            location.hash = '#/account'
          },
        })
      )
    } else {
      const pl = profiles.filter((p) => p.kind === 'platform')
      if (!pl.length) {
        body.appendChild(
          h('p', {
            class: 'field-note',
            text: st.loadingPlatform ? '正在获取平台模型…' : st.platformMsg || '还没有获取到平台模型，点右上角刷新重试。',
          })
        )
      } else {
        const list = h('div', { class: 'mdl-list' })
        pl.forEach((p) => list.appendChild(modelRow(p, loggedIn, curId, false)))
        body.appendChild(list)
        if (st.platformMsg) body.appendChild(h('p', { class: 'field-note', text: st.platformMsg }))
      }
    }

    // ---------- 自备 ----------
    body.appendChild(
      section(
        '自备模型',
        h('button', {
          class: 'mini',
          type: 'button',
          text: st.adding ? '收起' : '＋ 添加',
          onclick: () => {
            if (st.adding) {
              st.adding = false
              st.editingId = ''
              st.form = blankForm()
              resetTest()
            } else {
              startAdd()
              return
            }
            draw()
          },
        })
      )
    )
    const cu = profiles.filter((p) => p.kind === KIND_CUSTOM)
    if (!cu.length && !st.adding) {
      body.appendChild(h('p', { class: 'field-note', text: '还没有自备模型。支持 DeepSeek、OpenAI、阿里云百炼、Ollama 等任意 OpenAI 兼容接口。' }))
    }
    cu.forEach((p) => body.appendChild(modelRow(p, loggedIn, curId, true)))
    if (st.adding) body.appendChild(customForm())

    // ---------- 系统提示词 ----------
    body.appendChild(
      h('label', { class: 'field' }, [
        h('span', { text: '系统提示词' }),
        h('textarea', {
          rows: 3,
          placeholder: '可选：追加到内置助手设定之后',
          value: st.sys,
          oninput: (e) => (st.sys = e.target.value),
        }),
      ])
    )
    body.appendChild(
      h('p', {
        class: 'field-note',
        text: '模型选择即时保存并全局生效（AI 助手 + 课表 AI 识别），重启后保留；系统提示词点右下角「保存并关闭」生效。',
      })
    )
  }

  function customForm() {
    const f = st.form
    const wrap = h('div', { class: 'mdl-form' })
    const chips = h('div', { class: 'preset-chips' })
    PRESET_FALLBACK.forEach((p) => {
      chips.appendChild(
        h('button', {
          class: 'preset-chip' + (f.base === p.baseUrl ? ' on' : ''),
          type: 'button',
          text: p.name,
          onclick: () => {
            f.base = p.baseUrl
            f.guideUrl = p.keyGuideUrl
            f.note = p.note
            f.providerName = p.name
            resetTest()
            draw()
          },
        })
      )
    })
    wrap.appendChild(h('div', { class: 'field' }, [h('span', { text: '快速填充' }), chips]))
    wrap.appendChild(field('名称（可选）', 'text', f.label, (v) => (f.label = v), '例如 DeepSeek'))
    wrap.appendChild(field('接口地址', 'text', f.base, (v) => (f.base = v.trim()), 'https://api.deepseek.com/v1'))
    wrap.appendChild(field('模型名', 'text', f.model, (v) => (f.model = v.trim()), 'deepseek-chat'))
    wrap.appendChild(field('API Key', 'password', f.key, (v) => (f.key = v.trim()), 'sk-…'))
    if (f.guideUrl) {
      const link = h('a', {
        class: 'field-link',
        href: f.guideUrl,
        onclick: (e) => {
          e.preventDefault()
          openExternal(f.guideUrl).catch(() => toast('无法打开浏览器，请手动复制链接'))
        },
      })
      link.innerHTML = EXT_ICON
      link.appendChild(document.createTextNode('获取 ' + (f.providerName || '该平台') + ' API Key'))
      wrap.appendChild(link)
    }
    if (f.note) wrap.appendChild(h('p', { class: 'field-note', text: f.note }))
    wrap.appendChild(
      h('div', { class: 'row-btns' }, [
        h('button', {
          class: 'btn',
          type: 'button',
          id: 'btn-test',
          text: st.testing ? '测试中…' : '测试连通',
          disabled: st.testing,
          onclick: runTest,
        }),
        h('button', { class: 'btn', type: 'button', id: 'btn-models', text: '获取模型', onclick: runFetchModels }),
      ])
    )
    wrap.appendChild(
      h('p', {
        id: 'test-result',
        class: 'test-result' + (st.testOk == null ? '' : st.testOk ? ' ok' : ' bad'),
        text: st.testMsg,
      })
    )
    wrap.appendChild(
      h('div', { class: 'row-btns' }, [
        h('button', {
          class: 'btn',
          type: 'button',
          text: '取消',
          onclick: () => {
            st.adding = false
            st.editingId = ''
            st.form = blankForm()
            resetTest()
            draw()
          },
        }),
        h('button', {
          class: 'btn primary',
          type: 'button',
          id: 'btn-save-model',
          text: st.busy ? '保存中…' : '保存模型',
          disabled: st.busy,
          onclick: saveCustom,
        }),
      ])
    )
    return wrap
  }

  function openPickerHere() {
    openModelPicker({
      title: '选择模型',
      onPick: () => {
        draw()
        render()
      },
      onManage: () => {
        st.adding = true
        st.editingId = ''
        st.form = blankForm()
        draw()
      },
    })
  }

  async function useModel(p) {
    if (p.id === (currentModel().profile || {}).id) return
    try {
      await selectModel(p.id)
      toast('已切换到「' + p.label + '」')
      draw()
      render()
    } catch (e) {
      toast('切换失败：' + ((e && e.message) || e))
    }
  }

  async function refreshPlatform() {
    if (st.loadingPlatform) return
    st.loadingPlatform = true
    st.platformMsg = ''
    draw()
    const r = await syncPlatformModels()
    st.loadingPlatform = false
    if (!r.ok) {
      st.platformMsg =
        r.code === 'no-login'
          ? '需要先登录账号'
          : r.code === 'empty'
          ? '平台暂未返回模型，稍后再试'
          : '获取失败，检查网络后重试'
    } else if (r.switched) {
      st.platformMsg = '原模型已下架，已切换到「' + r.switched.label + '」'
      toast(st.platformMsg)
    }
    draw()
    render()
  }

  function startAdd() {
    st.adding = true
    st.editingId = ''
    st.form = blankForm()
    resetTest()
    draw()
  }

  function startEdit(p) {
    st.adding = true
    st.editingId = p.id
    const hit = PRESET_FALLBACK.filter((x) => x.baseUrl === p.base)[0]
    st.form = {
      label: p.label,
      base: p.base,
      model: p.model,
      key: p.key,
      guideUrl: hit ? hit.keyGuideUrl : '',
      note: hit ? hit.note : '',
      providerName: hit ? hit.name : '',
    }
    resetTest()
    draw()
  }

  async function del(p) {
    if (!(await confirmAsync('删除模型「' + p.label + '」？', '删除'))) return
    const next = await removeModel(p.id)
    toast(next ? '已删除，当前模型：' + next.label : '已删除')
    draw()
    render()
  }

  async function saveCustom() {
    const f = st.form
    if (!f.base || !f.model) return toast('接口地址和模型名都要填')
    st.busy = true
    draw()
    try {
      if (st.editingId) {
        await updateCustomModel(st.editingId, {
          label: f.label,
          base: f.base,
          model: f.model,
          key: f.key,
        })
        toast('已保存并切换到「' + (f.label || f.model) + '」')
      } else {
        const r = await addCustomModel({ label: f.label, base: f.base, model: f.model, key: f.key })
        toast(r.existing ? '已存在同款模型，已更新 Key 并切换' : '已添加并切换到「' + r.profile.label + '」')
      }
      st.adding = false
      st.editingId = ''
      st.form = blankForm()
      resetTest()
    } catch (e) {
      toast('保存失败：' + ((e && e.message) || e))
    }
    st.busy = false
    draw()
    render()
  }

  async function runTest() {
    const f = st.form
    if (!f.base) return toast('先填接口地址')
    if (!f.key) return toast('先填 API Key')
    if (!f.model) return toast('先填模型名')

    st.testing = true
    const btn = document.getElementById('btn-test')
    if (btn) {
      btn.disabled = true
      btn.textContent = '测试中…'
    }
    setTest(null, '正在连接…')
    const t0 = Date.now()

    try {
      const text = await requestText({
        url: endpoint(f.base),
        headers: { Authorization: 'Bearer ' + f.key },
        body: JSON.stringify({
          model: f.model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: 1,
          stream: false,
        }),
      })
      let ok = true
      let hint = ''
      try {
        const j = JSON.parse(text)
        if (j.error) {
          ok = false
          hint = j.error.message || j.error
        }
      } catch (e) {
        /* 有些服务返回空体，仍算通过 */
      }
      const ms = Date.now() - t0
      setTest(ok, ok ? '连通正常 · ' + f.model + ' · ' + ms + ' ms' : '连通失败：' + hint)
    } catch (e) {
      setTest(false, '连通失败：' + ((e && e.message) || e))
    } finally {
      st.testing = false
      const b2 = document.getElementById('btn-test')
      if (b2) {
        b2.disabled = false
        b2.textContent = '测试连通'
      }
    }
  }

  async function runFetchModels() {
    const f = st.form
    if (!f.base) return toast('先填接口地址')
    if (!f.key) return toast('先填 API Key')

    const btn = document.getElementById('btn-models')
    if (btn) {
      btn.disabled = true
      btn.textContent = '获取中…'
    }
    try {
      const text = await requestText({
        method: 'GET',
        url: String(f.base).replace(/\/+$/, '') + '/models',
        headers: { Authorization: 'Bearer ' + f.key },
      })
      const list = parseModels(text)
      if (!list.length) {
        toast('这个接口没有返回模型列表')
        setTest(false, '获取模型失败：返回里没有 data[].id')
        return
      }
      openPicker('选择模型（' + list.length + '）', list, f.model, (pick) => {
        f.model = pick
        draw()
        setTest(true, '已选模型：' + pick)
      })
    } catch (e) {
      toast('获取模型失败：' + ((e && e.message) || e))
      setTest(false, '获取模型失败：' + ((e && e.message) || e))
    } finally {
      const b2 = document.getElementById('btn-models')
      if (b2) {
        b2.disabled = false
        b2.textContent = '获取模型'
      }
    }
  }

  draw()
  // 登录状态下静默对账：服务端下架的模型在这里就消失，不用等用户选中撞 400
  if (isPlatformLogin()) refreshPlatform()

  document.getElementById('btn-save').textContent = '保存并关闭'
  document.getElementById('btn-save').onclick = async () => {
    await saveMeta('aiSystem', String(st.sys || '').trim())
    closeSheet()
    toast('已保存')
    render()
  }

  document.getElementById('btn-cancel').onclick = closeSheet
  mask.onclick = closeSheet

  // 「清空对话」改成「删除当前对话」：语义与历史列表的单条删除一致，
  // 不再出现「清空了但历史里还留着一条空壳」的两套说法
  if (activeId) {
    const delBtn = document.getElementById('btn-delete')
    delBtn.hidden = false
    delBtn.textContent = '删除当前对话'
    delBtn.onclick = async () => {
      closeSheet()
      await deleteSessions([activeId])
    }
  }

  mask.hidden = false
  sheet.hidden = false
}

// ---------------------------------------------------------------- 小工具

/** 兼容 {data:[{id}]} / {models:[...]} / 纯数组三种形状 */
function parseModels(text) {
  let j
  try {
    j = JSON.parse(text)
  } catch (e) {
    return []
  }
  const arr = Array.isArray(j) ? j : j.data || j.models || []
  if (!Array.isArray(arr)) return []
  const out = []
  arr.forEach((x) => {
    const id = typeof x === 'string' ? x : x && (x.id || x.name || x.model)
    if (id && out.indexOf(String(id)) < 0) out.push(String(id))
  })
  return out.sort()
}

function openPicker(title, items, current, onPick) {
  const mask = h('div', { class: 'modal-mask' })
  const box = h('div', { class: 'modal pick-modal' })
  const list = h('div', { class: 'pick-list' })

  const close = () => {
    mask.remove()
    box.remove()
  }

  items.forEach((it) => {
    list.appendChild(
      h('button', {
        class: 'pick-item' + (it === current ? ' on' : ''),
        type: 'button',
        text: it,
        onclick: () => {
          close()
          onPick(it)
        },
      })
    )
  })

  box.appendChild(
    h('div', { class: 'pick-head' }, [h('b', { text: title }), h('button', { class: 'mini', type: 'button', text: '关闭', onclick: close })])
  )
  box.appendChild(list)
  document.body.appendChild(mask)
  document.body.appendChild(box)
  mask.onclick = close
}
