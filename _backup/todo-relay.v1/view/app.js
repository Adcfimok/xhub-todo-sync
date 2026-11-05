/* 待办同步 · 整页前端
 * 职责：① 把宿主待办搬进中枢（ingest）② 把远端改动写回宿主（outbound）
 *       ③ 展示配对/设备/冲突。真正的同步判定全在 service 后端，这里不做合并。 */
(function () {
  'use strict'

  var api = window.xhub || null
  var $ = function (id) { return document.getElementById(id) }

  var S = {
    admin: null,
    online: false,
    lastSyncAt: 0,
    lastError: '',
    busy: false,
    conflictCount: 0,
    qrFor: '',
    unauthorized: false,
  }

  var POLL_MS = 4000
  var CFG = { syncIntervalMs: 15000, notifyOnConflict: true }

  // ---------- 基础 ----------

  function svc(path, opts) {
    opts = opts || {}
    var init = { method: opts.method || 'GET' }
    if (opts.body) {
      init.headers = { 'Content-Type': 'application/json' }
      init.body = opts.body
    }
    return api.service.request(path, init).then(function (r) {
      return r.json().then(function (d) {
        if (r.status >= 400) {
          var err = new Error((d && (d.message || d.code)) || ('HTTP ' + r.status))
          err.code = d && d.code
          err.status = r.status
          throw err
        }
        return d
      })
    })
  }

  function fmtTime(ms) {
    if (!ms) return '—'
    var d = new Date(ms)
    var p = function (n) { return String(n).padStart(2, '0') }
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
  }

  function fmtDue(ms) {
    if (!ms) return '未排期'
    var d = new Date(ms), n = new Date()
    var diff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) -
      new Date(n.getFullYear(), n.getMonth(), n.getDate())) / 86400000)
    if (diff < 0) return '逾期 ' + (-diff) + ' 天'
    if (diff === 0) return '今天 ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
    if (diff === 1) return '明天'
    if (diff < 7) return diff + ' 天后'
    return (d.getMonth() + 1) + '月' + d.getDate() + '日'
  }

  function setStatus(state, text) {
    $('status-chip').setAttribute('data-state', state)
    $('status-text').textContent = text
  }

  // ---------- 渲染 ----------

  function render() {
    var a = S.admin
    var st = a && a.stats

    if (S.unauthorized) {
      setStatus('error', '后端未授权')
    } else if (!a) {
      setStatus('error', '后端未响应')
    } else if (st && st.conflicts > 0) {
      setStatus('conflict', st.conflicts + ' 条冲突待确认')
    } else if (st && st.pendingHost > 0) {
      setStatus('syncing', '待回写 ' + st.pendingHost + ' 条')
    } else if ((a.devices || []).some(function (d) { return d.online })) {
      setStatus('online', '已连接 ' + (a.devices || []).filter(function (d) { return d.online }).length + ' 台')
    } else {
      setStatus('online', '服务就绪 · 等待设备')
    }

    renderPair(a)
    renderDevices(a ? a.devices : [])
    renderTodos(a ? a.records : [])
    renderConflicts(a ? a.conflicts : [])

    $('bar-left').textContent = S.lastError
      ? '上次错误：' + S.lastError
      : (S.lastSyncAt ? '上次同步 ' + fmtTime(S.lastSyncAt) : '尚未同步')
    $('bar-right').textContent = a
      ? '端口 ' + a.port + ' · 记录 ' + st.total + ' · 变更序号 ' + st.seq
      : ''

    if (a && st) {
      if (CFG.notifyOnConflict && st.conflicts > S.conflictCount && api && api.ui && st.conflicts > 0) {
        api.ui.notify('待办同步：出现冲突', st.conflicts + ' 条记录两端口同时修改，已按最近修改合并').catch(function () {})
      }
      S.conflictCount = st.conflicts
    }
  }

  function renderPair(a) {
    if (!a) {
      $('pair-code').textContent = '······'
      $('pair-hint').textContent = '后端未启动'
      $('pair-note').textContent = '扩展的后端进程没有就绪。若刚安装，请稍等几秒；仍不行请到扩展设置里确认「运行本地后端」已授权。'
      $('qr').innerHTML = '<div class="ph">后端未就绪</div>'
      return
    }
    $('pair-code').textContent = String(a.pairCode || '').replace(/(\d{3})(\d{3})/, '$1 $2')
    var left = Math.max(0, Math.round((a.pairExpiresAt - Date.now()) / 1000))
    $('pair-hint').textContent = left > 0 ? '剩余 ' + Math.floor(left / 60) + ' 分 ' + (left % 60) + ' 秒' : '已过期，点「换配对码」'

    var addrs = (a.addresses || [])
    var primary = (addrs.filter(function (x) { return x.preferred })[0] || addrs[0] || {}).address
    var primaryText = primary ? primary + ':' + a.port : '没有检测到局域网地址'
    $('primary-addr').textContent = primaryText
    $('btn-copy-addr').onclick = function () {
      copyText(primaryText)
      var b = $('btn-copy-addr')
      b.textContent = '已复制'
      setTimeout(function () { b.textContent = '复制' }, 1000)
    }

    var ul = $('addrs')
    ul.innerHTML = ''
    var others = addrs.filter(function (x) { return x.address !== primary })
    others.forEach(function (it) {
      var li = document.createElement('li')
      var sp = document.createElement('span')
      sp.className = 'iface'
      sp.textContent = it.iface
      var code = document.createElement('code')
      code.textContent = it.address + ':' + a.port
      code.title = '点击复制'
      code.addEventListener('click', function () {
        copyText(it.address + ':' + a.port)
        code.textContent = '已复制 ✓'
        setTimeout(function () { code.textContent = it.address + ':' + a.port }, 900)
      })
      li.appendChild(sp)
      li.appendChild(code)
      ul.appendChild(li)
    })
    if (!addrs.length) {
      var li2 = document.createElement('li')
      li2.textContent = '请确认已连上 Wi-Fi 或网线'
      ul.appendChild(li2)
    }

    $('pair-note').textContent = (a.devices || []).length
      ? '手机端已配对 ' + a.devices.length + ' 台。新增设备需要在手机上输入上面的配对码。'
      : '在手机 App 里扫描二维码即可完成配对，无需手动输入地址。'

    var primary = (addrs.filter(function (x) { return x.preferred })[0] || addrs[0] || {}).address
    if (primary) {
      var payload = 'xhub://1/' + primary + ':' + a.port + '/' + a.pairCode
      if (payload !== S.qrFor) {
        S.qrFor = payload
        drawQR(payload)
      }
    }
  }

  function drawQR(text) {
    var box = $('qr')
    try {
      if (typeof window.qrcode !== 'function') throw new Error('no lib')
      var qr = window.qrcode(0, 'M')
      qr.addData(text)
      qr.make()
      box.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true })
    } catch (e) {
      box.innerHTML = '<div class="ph">无法生成二维码</div>'
    }
  }

  function renderDevices(list) {
    var ul = $('devices')
    $('dev-count').textContent = String(list.length)
    ul.innerHTML = ''
    if (!list.length) {
      var li = document.createElement('li')
      li.className = 'empty'
      li.textContent = '还没有设备配对'
      ul.appendChild(li)
      return
    }
    list.forEach(function (d) {
      var row = document.createElement('li')
      row.className = 'device'
      row.setAttribute('data-online', d.online ? '1' : '0')

      var meta = document.createElement('div')
      meta.className = 'meta'
      var name = document.createElement('div')
      name.className = 'name'
      name.textContent = d.name || d.id
      var sub = document.createElement('div')
      sub.className = 'sub'
      sub.textContent = (d.platform || '') + (d.appVersion ? ' · v' + d.appVersion : '') +
        ' · 最后在线 ' + (d.lastSeen ? fmtTime(d.lastSeen) : '—')
      meta.appendChild(name)
      meta.appendChild(sub)

      var st = document.createElement('span')
      st.className = 'state'
      st.textContent = d.revoked ? '已移除' : d.online ? '在线' : '离线'

      row.appendChild(meta)
      row.appendChild(st)
      if (!d.revoked) {
        var btn = document.createElement('button')
        btn.className = 'revoke'
        btn.type = 'button'
        btn.textContent = '移除'
        btn.addEventListener('click', function () { revoke(d) })
        row.appendChild(btn)
      }
      ul.appendChild(row)
    })
  }

  function renderTodos(list) {
    var ul = $('todos')
    var live = (list || []).filter(function (r) { return !r.deleted })
    $('todo-count').textContent = String(live.length)
    $('todo-hint').textContent = '来自工作台'
    ul.innerHTML = ''
    $('todos-empty').hidden = live.length > 0
    if (!live.length) return

    live.sort(function (a, b) {
      if (a.done !== b.done) return a.done ? 1 : -1
      return (a.dueAt || Infinity) - (b.dueAt || Infinity)
    })
    live.slice(0, 80).forEach(function (r) {
      var li = document.createElement('li')
      li.className = 'todo'
      li.setAttribute('data-done', r.done ? '1' : '0')

      var box = document.createElement('span')
      box.className = 'box'
      var title = document.createElement('span')
      title.className = 'title'
      title.textContent = r.title || '（未命名）'
      var due = document.createElement('span')
      due.className = 'due'
      due.textContent = fmtDue(r.dueAt)
      if (r.dueAt && r.dueAt < Date.now() && !r.done) due.setAttribute('data-late', '1')

      li.appendChild(box)
      li.appendChild(title)
      li.appendChild(due)
      if (r.by && r.by !== 'pc-host') {
        var src = document.createElement('span')
        src.className = 'src'
        src.textContent = '手机'
        li.appendChild(src)
      }
      ul.appendChild(li)
    })
  }

  function renderConflicts(list) {
    var ul = $('conflicts')
    $('conflict-count').textContent = String(list.length)
    ul.innerHTML = ''
    $('conflicts-empty').hidden = list.length > 0
    list.forEach(function (c, i) {
      var li = document.createElement('li')
      li.className = 'conflict'

      var r1 = document.createElement('div')
      r1.className = 'row1'
      var t = document.createElement('span')
      t.className = 't'
      t.textContent = c.title || c.id
      var when = document.createElement('span')
      when.className = 'when'
      when.textContent = fmtTime(c.at)
      r1.appendChild(t)
      r1.appendChild(when)

      var r2 = document.createElement('div')
      r2.className = 'row2'
      r2.textContent = '字段 ' + (c.fields || []).join('/') + ' · 采纳 ' +
        (c.winner === 'pc-host' ? '本机' : '手机') + '，覆盖 ' + (c.loser === 'pc-host' ? '本机' : '手机')

      var btn = document.createElement('button')
      btn.className = 'restore'
      btn.type = 'button'
      btn.textContent = '恢复被覆盖的版本'
      btn.addEventListener('click', function () { restore(i) })

      li.appendChild(r1)
      li.appendChild(r2)
      li.appendChild(btn)
      ul.appendChild(li)
    })
  }

  // ---------- 宿主桥接 ----------

  function hostList() {
    return api.data.todos.list().then(function (res) {
      return Array.isArray(res) ? res : (res && (res.data || res.items || res.rows)) || []
    })
  }

  function ingest() {
    if (!api || !api.data || !api.data.todos) return Promise.resolve()
    return hostList().then(function (rows) {
      return svc('/api/local/ingest', {
        method: 'POST',
        body: JSON.stringify({ records: rows, full: true }),
      })
    })
  }

  function fieldGap(rec, host) {
    var out = []
    if ((rec.title || '') !== (host.title || '')) out.push('title')
    if (!!rec.done !== !!host.done) out.push('done')
    if (Number(rec.priority || 0) !== Number(host.priority || 0)) out.push('priority')
    if ((rec.dueAt || null) !== (host.due_at || null)) out.push('dueAt')
    if ((rec.description || '') !== (host.description || '')) out.push('description')
    if (!!rec.pinned !== !!host.pinned) out.push('pinned')
    return out
  }

  async function applyToHost(rec, ctx) {
    var todos = api.data.todos
    var hostId = rec.hostId

    if (rec.deleted) {
      if (hostId) {
        try { await todos.delete({ id: hostId }) } catch (e) {
          if (!/NOT_FOUND/.test(String(e && e.message))) throw e
        }
      }
      return null
    }

    if (!hostId) {
      var parentHostId = null
      if (rec.parentId && ctx.byRecord[rec.parentId]) parentHostId = ctx.byRecord[rec.parentId].hostId
      var created = await todos.create({ title: rec.title || '未命名待办', parentId: parentHostId || undefined })
      hostId = created && (created.id || (created.todo && created.todo.id))
      if (!hostId) throw new Error('创建待办后没有拿到 id')
      ctx.byRecord[rec.id] = { id: rec.id, hostId: hostId, version: (created && created.version) || 0 }
      var fresh = await todos.get(hostId)
      await applyFields(rec, fresh || created, hostId)
      return await todos.get(hostId)
    }

    var cur = await todos.get(hostId)
    if (!cur) throw new Error('宿主待办已不存在')
    await applyFields(rec, cur, hostId)
    return await todos.get(hostId)
  }

  async function applyFields(rec, host, hostId) {
    var todos = api.data.todos
    var gap = fieldGap(rec, host)
    if (!gap.length) return

    if (gap.indexOf('title') >= 0 || gap.indexOf('priority') >= 0) {
      await todos.update({ id: hostId, title: rec.title || host.title, priority: Number(rec.priority || 0) })
    }
    if (gap.indexOf('dueAt') >= 0) {
      await todos.schedule({ id: hostId, dueAt: rec.dueAt || null, remindAt: rec.remindAt || null })
    }
    if (gap.indexOf('description') >= 0) {
      try { await todos.setDescription({ id: hostId, description: rec.description || '' }) } catch (e) {
        if (!/INVALID_ARGUMENT/.test(String(e && e.message))) throw e
      }
    }
    if (gap.indexOf('pinned') >= 0) {
      await todos.setPinned({ id: hostId, pinned: !!rec.pinned })
    }
    if (gap.indexOf('done') >= 0) {
      await todos.toggle({ id: hostId })
    }
  }

  async function drainOutbound() {
    if (S.busy || !api || !api.data || !api.data.todos) return
    S.busy = true
    try {
      var ctx = { byRecord: {} }
      ;((S.admin && S.admin.records) || []).forEach(function (r) { ctx.byRecord[r.id] = r })

      for (var round = 0; round < 6; round++) {
        var out = await svc('/api/local/outbound?limit=50')
        var items = out.items || []
        if (!items.length) break

        var applied = []
        for (var i = 0; i < items.length; i++) {
          var rec = items[i]
          try {
            var fresh = await applyToHost(rec, ctx)
            applied.push({
              id: rec.id,
              hostId: fresh ? fresh.id : rec.hostId || null,
              hostVersion: fresh ? fresh.version : null,
            })
          } catch (e) {
            console.warn('[todo-relay] 回写失败', rec.id, e)
            S.lastError = '回写失败：' + (e && e.message ? e.message : e)
          }
        }
        await svc('/api/local/ack', {
          method: 'POST',
          body: JSON.stringify({ cursor: out.cursor, applied: applied }),
        })
        if (items.length < 50) break
      }
      S.lastSyncAt = Date.now()
    } catch (e) {
      handleErr(e)
    } finally {
      S.busy = false
    }
  }

  function handleErr(e) {
    var msg = String((e && e.message) || e)
    S.lastError = msg
    if (/PERMISSION_DENIED|未获信任|未授权/.test(msg)) {
      S.unauthorized = true
      ensureAuthBtn()
    }
    render()
  }

  function syncOnce() {
    return ingest()
      .then(function () { return drainOutbound() })
      .then(function () {
        S.lastError = ''
        return poll()
      })
      .catch(handleErr)
  }

  // ---------- 动作 ----------

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(function () { legacyCopy(text) })
      return
    }
    legacyCopy(text)
  }

  function legacyCopy(text) {
    try {
      var ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    } catch (e) {
      /* 复制失败不影响主流程，用户还能手输 */
    }
  }

  function ensureAuthBtn() {
    if (document.getElementById('btn-auth')) return
    var actions = document.querySelector('.top-actions')
    var b = document.createElement('button')
    b.id = 'btn-auth'
    b.className = 'btn'
    b.type = 'button'
    b.textContent = '去授权'
    b.addEventListener('click', function () {
      if (api && typeof api.openPermissions === 'function') api.openPermissions()
    })
    actions.insertBefore(b, actions.firstChild)
  }

  function revoke(d) {
    if (!window.confirm('移除设备「' + (d.name || d.id) + '」后，该手机需要重新配对才能同步。继续？')) return
    svc('/api/admin/revoke', { method: 'POST', body: JSON.stringify({ deviceId: d.id }) })
      .then(poll)
      .catch(handleErr)
  }

  function restore(index) {
    svc('/api/admin/restore', { method: 'POST', body: JSON.stringify({ index: index }) })
      .then(function () { return syncOnce() })
      .then(poll)
      .catch(handleErr)
  }

  // ---------- 轮询 ----------

  function poll() {
    if (!api || !api.service) {
      setStatus('error', '不在 x-hub 内运行')
      return Promise.resolve()
    }
    return svc('/api/admin/state')
      .then(function (d) {
        S.admin = d
        S.unauthorized = false
        S.online = true
        if (!S.lastSyncAt) S.lastSyncAt = d.serverTime
        render()
      })
      .catch(function (e) {
        S.admin = null
        handleErr(e)
      })
  }

  // ---------- 启动 ----------

  function bind() {
    $('btn-sync').addEventListener('click', function () {
      var b = $('btn-sync')
      b.disabled = true
      b.textContent = '同步中…'
      syncOnce()
        .then(poll)
        .then(function () { b.textContent = '立即同步' })
        .catch(function () { b.textContent = '立即同步' })
        .finally(function () { b.disabled = false })
    })

    $('btn-rotate').addEventListener('click', function () {
      svc('/api/admin/rotate-code', { method: 'POST', body: '{}' })
        .then(function () { S.qrFor = ''; return poll() })
        .catch(handleErr)
    })

    $('btn-clear-conflicts').addEventListener('click', function () {
      svc('/api/admin/clear-conflicts', { method: 'POST', body: '{}' })
        .then(poll)
        .catch(handleErr)
    })

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) return
      poll()
      syncOnce()
    })

    if (api && api.events && api.events.on) {
      api.events.on('theme-changed', function () { render() })
    }
  }

  function loadConfig() {
    if (!api || !api.config) return Promise.resolve()
    return api.config
      .all()
      .then(function (c) {
        if (!c) return
        if (Number(c.syncIntervalMs) >= 5000) CFG.syncIntervalMs = Number(c.syncIntervalMs)
        CFG.notifyOnConflict = c.notifyOnConflict !== false
      })
      .catch(function () {})
  }

  loadConfig().then(function () {
    setInterval(function () { syncOnce() }, CFG.syncIntervalMs)
  })

  bind()
  poll()
  syncOnce()
  setInterval(poll, POLL_MS)
  setInterval(drainOutbound, 5000)
})()
