/**
 * 浏览器预览用的假桥：让 view / module 页面脱离 x-hub 也能跑起来。
 * 只用于本地调试与截图，不随扩展发布。
 */
(function () {
  'use strict'
  // ?hub=127.0.0.1:47899 可指向另一实例（测试隔离用）
  var HUB = (new URLSearchParams(location.search).get('hub') || '127.0.0.1:47821').replace(/^https?:\/\//, '').replace(/\/$/, '')
  var BASE = 'http://' + HUB
  var seq = 900

  function nowStr(ms) {
    var d = new Date(ms || Date.now())
    var p = function (n) { return String(n).padStart(2, '0') }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
      p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '.000'
  }
  var ts = nowStr()

  var store = {
    todos: [
      { id: 1, title: '写周报', done: 0, priority: 1, due_at: Date.now() + 3600e3, version: 0, description: '把本周进展整理成三条', pinned: 0, repeat_mode: 'once', created_at: ts, updated_at: ts },
      { id: 2, title: '买牛奶', done: 0, priority: 0, due_at: Date.now() + 86400e3, version: 0, description: '', pinned: 0, repeat_mode: 'once', created_at: ts, updated_at: ts },
      { id: 3, title: '交房租', done: 0, priority: 2, due_at: Date.now() - 86400e3, version: 0, description: '', pinned: 0, repeat_mode: 'monthly', created_at: ts, updated_at: ts },
      { id: 4, title: '读完《设计系统》', done: 1, priority: 0, due_at: null, version: 0, description: '', pinned: 0, repeat_mode: 'once', created_at: ts, updated_at: ts },
    ],
    notes: [
      { id: 1, title: '周会纪要', content: '1. 同步方案定稿\n2. 下周开始灰度', created_at: ts, updated_at: ts },
      { id: 2, title: '读书笔记：卡片设计', content: '信息密度不是越多越好，而是每一屏只回答一个问题。', created_at: ts, updated_at: ts },
    ],
    stickies: [
      { id: 1, slot: 1, content: '记得给客户回邮件\n——周三前', version: 1 },
      { id: 2, slot: 2, content: '灵感：把待办按「精力」排序', version: 1 },
    ],
    resources: [
      { id: 1, kind: 'web', name: 'GitHub', target: 'https://github.com', category: 'dev', sort_order: 1, created_at: ts, updated_at: ts },
      { id: 2, kind: 'web', name: '掘金', target: 'https://juejin.cn', category: 'read', sort_order: 2, created_at: ts, updated_at: ts },
      { id: 3, kind: 'app', name: 'VS Code', target: 'code.exe', category: null, sort_order: 3, created_at: ts, updated_at: ts },
    ],
    snippets: [
      { id: 1, title: '周报开头', content: '本周主要完成了以下三件事：', is_pinned: 1, created_at: ts, updated_at: ts },
      { id: 2, title: '礼貌拒绝', content: '感谢邀请，这个时间我已有安排，我们下次再约。', is_pinned: 0, created_at: ts, updated_at: ts },
    ],
  }

  function find(col, id) {
    return store[col].filter(function (x) { return String(x.id) === String(id) })[0]
  }
  function bump(col, id) {
    var t = find(col, id)
    if (t) {
      t.version = (t.version || 0) + 1
      t.updated_at = nowStr()
    }
    return t
  }

  var data = {
    todos: {
      list: async function () {
        // 预览用：?deny=1 模拟宿主把 data:read 关掉，验证权限提示
        if (new URLSearchParams(location.search).get('deny') === '1') {
          throw new Error('PERMISSION_DENIED: 扩展未获得 data:read 权限')
        }
        return store.todos.slice()
      },
      get: async function (id) { return find('todos', id) },
      create: async function (a) {
        var t = { id: ++seq, title: a.title, done: 0, priority: 0, due_at: null, version: 0, description: '', pinned: 0, repeat_mode: 'once', created_at: nowStr(), updated_at: nowStr(), parent_id: a.parentId || null }
        store.todos.push(t)
        return t
      },
      update: async function (a) { var t = bump('todos', a.id); if (t) { t.title = a.title; t.priority = a.priority } return t },
      toggle: async function (a) { var t = bump('todos', a.id); if (t) t.done = t.done ? 0 : 1; return t },
      schedule: async function (a) { var t = bump('todos', a.id); if (t) { t.due_at = a.dueAt; t.remind_at = a.remindAt } return t },
      setDescription: async function (a) { var t = bump('todos', a.id); if (t) t.description = a.description; return t },
      setPinned: async function (a) { var t = bump('todos', a.id); if (t) t.pinned = a.pinned ? 1 : 0; return t },
      delete: async function (a) { store.todos = store.todos.filter(function (t) { return String(t.id) !== String(a.id) }); return { ok: true } },
    },
    notes: {
      list: async function () { return store.notes.slice() },
      get: async function (id) { return find('notes', id) },
      create: async function (a) {
        var n = { id: ++seq, title: a.title || '无标题', content: '', created_at: nowStr(), updated_at: nowStr() }
        store.notes.push(n)
        return n
      },
      update: async function (a) { var n = find('notes', a.id); if (n) { n.title = a.title; n.content = a.content || ''; n.updated_at = nowStr() } return n },
      delete: async function (a) { store.notes = store.notes.filter(function (n) { return String(n.id) !== String(a.id) }); return { ok: true } },
    },
    stickies: {
      list: async function () { return store.stickies.slice() },
      save: async function (a) {
        var s = store.stickies.filter(function (x) { return x.slot === a.slot })[0]
        if (!s) { s = { id: ++seq, slot: a.slot, content: '', version: 0 }; store.stickies.push(s) }
        s.content = a.content || ''
        s.version++
        return s
      },
    },
    resources: {
      list: async function () { return store.resources.slice() },
      get: async function (id) { return find('resources', id) },
      create: async function (a) {
        var r = { id: ++seq, kind: a.kind, name: a.name, target: a.target, category: a.category || null, icon: a.icon || null, args: a.args || null, sort_order: 99, created_at: nowStr(), updated_at: nowStr() }
        store.resources.push(r)
        return r
      },
      update: async function (a) {
        var r = find('resources', a.id)
        if (r) { r.kind = a.kind; r.name = a.name; r.target = a.target; r.category = a.category || null; r.updated_at = nowStr() }
        return r
      },
      delete: async function (a) { store.resources = store.resources.filter(function (r) { return String(r.id) !== String(a.id) }); return { ok: true } },
    },
    snippets: {
      list: async function () { return store.snippets.slice() },
      get: async function (id) { return find('snippets', id) },
      create: async function (a) {
        var s = { id: ++seq, title: a.title || '未命名', content: a.content || '', is_pinned: false, created_at: nowStr(), updated_at: nowStr() }
        store.snippets.push(s)
        return s
      },
      update: async function (a) { var s = find('snippets', a.id); if (s) { s.title = a.title; s.content = a.content || ''; s.updated_at = nowStr() } return s },
      togglePin: async function (a) { var s = find('snippets', a.id); if (s) s.is_pinned = !s.is_pinned; return s },
      delete: async function (a) { store.snippets = store.snippets.filter(function (s) { return String(s.id) !== String(a.id) }); return { ok: true } },
    },
  }

  // ?deny=1 模拟扩展没拿到 data:read（宿主的权限被关掉），仅调试用
  if (new URLSearchParams(location.search).get('deny') === '1') {
    Object.keys(data).forEach(function (col) {
      data[col].list = async function () {
        var e = new Error('PERMISSION_DENIED: 扩展未获得 data:read 授权')
        e.code = 'PERMISSION_DENIED'
        throw e
      }
    })
  }

  window.xhub = {
    runtime: {
      info: async function () { return { id: 'com.zhou.todo-relay', runtime: 'service', serviceReady: true, capabilities: [] } },
      open: function () {},
      callExtension: async function () { return null },
    },
    data: data,
    service: {
      request: async function (path, init) {
        var r = await fetch(BASE + path, init || {})
        var text = await r.text()
        return { status: r.status, headers: {}, text: async function () { return text }, json: async function () { return JSON.parse(text) } }
      },
    },
    config: { get: async function (k, d) { return d === undefined ? null : d }, all: async function () { return {} }, set: async function () {}, remove: async function () {} },
    storage: { get: async function () { return null }, set: async function () {}, remove: async function () {}, clear: async function () {} },
    ui: { notify: async function (a, b) { console.log('[mock notify]', a, b) }, toast: function () {} },
    events: { on: function () { return function () {} }, emit: function () {} },
    theme: { get: async function () { return { mode: 'dark' } } },
    openPermissions: function () {},
    openExternal: function (u) { console.log('[mock] openExternal', u) },
    fs: { saveText: async function () { return {} } },
  }

  // 预览时按 URL 参数切主题，模拟宿主注入
  var q = new URLSearchParams(location.search)
  var theme = q.get('theme') || 'dark'
  document.documentElement.setAttribute('data-xhub-theme', theme)
  document.documentElement.style.setProperty(
    '--xhub-page-bg',
    theme === 'light'
      ? 'radial-gradient(1200px 800px at 12% -8%, rgba(91,91,245,.12), transparent 55%), linear-gradient(150deg,#eef1fa 0%,#f7f3ec 100%)'
      : 'radial-gradient(1200px 800px at 12% -8%, rgba(139,139,255,.16), transparent 55%), linear-gradient(150deg,#14151d 0%,#101018 100%)'
  )
  var v = q.get('xhub-variant')
  if (v) document.documentElement.setAttribute('data-xhub-variant', v)
})()
