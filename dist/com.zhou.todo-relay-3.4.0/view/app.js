/* 待办同步 · 整页前端（多集合）
 * 职责：① 把宿主五类数据搬进中枢 ② 把远端改动写回宿主
 *       ③ 展示配对/设备/冲突 ④ 代手机端执行扩展的 data.* 调用
 * 真正的同步判定全在 service 后端，这里不做合并。 */
(function () {
  'use strict'

  var api = window.xhub || null
  var $ = function (id) { return document.getElementById(id) }

  var COLS = ['todos', 'notes', 'stickies', 'resources', 'snippets']
  var COL_NAME = { todos: '待办', notes: '笔记', stickies: '便签', resources: '速达', snippets: '提示词' }

  var S = {
    admin: null,
    lastSyncAt: 0,
    lastError: '',
    busy: false,
    conflictCount: 0,
    qrFor: '',
    unauthorized: false,
    col: 'todos',
    polling: null,
    lastPollAt: 0,
    streamOk: false,
  }

  var POLL_MS = 4000
  var CFG = { syncIntervalMs: 15000, notifyOnConflict: true, autoIngest: true }

  // 安卓端下载入口：发新版时改这里（与 _tools/release-upload/versions.json 的
  // android-apk 条目保持一致）。宿主 iframe 没有 allow-popups，target="_blank"
  // 与 window.open() 都会被静默拦截，所以跳转一律走 api.openExternal。
  var ANDROID_DL = {
    version: '3.4.0',
    size: 368759,
    apk: 'https://github.com/Adcfimok/xhub-todo-sync/releases/download/android-v3.4.0/todo-link-3.4.0.apk',
    notes: 'https://github.com/Adcfimok/xhub-todo-sync/releases/tag/android-v3.4.0',
  }

  // ---------------------------------------------------------------- 基础

  var SVC_TIMEOUT = 8000

  function svc(path, opts) {
    opts = opts || {}
    // 本机接口要求带自定义头：跨站请求发不出自定义头（会先触发预检并被拒），
    // 这是拦 CSRF 的第三道，前两道是 Origin 白名单与 isLocal。
    var init = { method: opts.method || 'GET', headers: { 'X-Hub-Local': '1' } }
    if (opts.body) {
      init.headers['Content-Type'] = 'application/json'
      init.body = opts.body
    }
    // 服务端卡住时不能让按钮永远转圈，超时后按失败处理，下次轮询再试
    var timeout = new Promise(function (_, reject) {
      setTimeout(function () {
        var err = new Error('请求超时')
        err.code = 'TIMEOUT'
        err.timeout = true
        reject(err)
      }, opts.timeout || SVC_TIMEOUT)
    })
    var call = api.service.request(path, init).then(function (r) {
      return r.json().then(function (d) {
        if (r.status >= 400) {
          var err = new Error((d && (d.message || d.code)) || 'HTTP ' + r.status)
          err.code = d && d.code
          err.status = r.status
          throw err
        }
        return d
      })
    })
    return Promise.race([call, timeout])
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

  // ---------------------------------------------------------------- 宿主适配器

  var todos = api && api.data && api.data.todos

  var ADAPTERS = {
    todos: {
      list: function () { return todos.list() },
      create: function (rec) {
        return todos.create({ title: rec.title || '未命名待办', parentId: hostIdOf(rec.parentId) })
      },
      fields: function (rec, host) {
        var out = []
        if ((rec.title || '') !== (host.title || '')) out.push('title')
        if (!!rec.done !== !!host.done) out.push('done')
        if (Number(rec.priority || 0) !== Number(host.priority || 0)) out.push('priority')
        if ((rec.dueAt || null) !== (host.due_at || null)) out.push('dueAt')
        if ((rec.description || '') !== (host.description || '')) out.push('description')
        if (!!rec.pinned !== !!host.pinned) out.push('pinned')
        return out
      },
      update: async function (id, rec, host) {
        var gap = this.fields(rec, host)
        if (!gap.length) return
        if (gap.indexOf('title') >= 0 || gap.indexOf('priority') >= 0) {
          await todos.update({ id: id, title: rec.title || host.title, priority: Number(rec.priority || 0) })
        }
        if (gap.indexOf('dueAt') >= 0) {
          await todos.schedule({ id: id, dueAt: rec.dueAt || null, remindAt: rec.remindAt || null })
        }
        if (gap.indexOf('description') >= 0) {
          try { await todos.setDescription({ id: id, description: rec.description || '' }) } catch (e) {
            if (!/INVALID_ARGUMENT/.test(String(e && e.message))) throw e
          }
        }
        if (gap.indexOf('pinned') >= 0) await todos.setPinned({ id: id, pinned: !!rec.pinned })
        if (gap.indexOf('done') >= 0) await todos.toggle({ id: id })
      },
      remove: function (id) { return todos.delete({ id: id }) },
    },

    notes: {
      list: function () { return api.data.notes.list() },
      create: function (rec) { return api.data.notes.create({ title: rec.title || '无标题笔记' }) },
      fields: function (rec, host) {
        var out = []
        if ((rec.title || '') !== (host.title || '')) out.push('title')
        if ((rec.content || '') !== (host.content || '')) out.push('content')
        return out
      },
      update: function (id, rec) {
        return api.data.notes.update({ id: id, title: rec.title || '', content: rec.content || '' })
      },
      remove: function (id) { return api.data.notes.delete({ id: id }) },
    },

    resources: {
      list: function () { return api.data.resources.list() },
      create: function (rec) {
        return api.data.resources.create({
          kind: rec.kind || 'web',
          name: rec.name || '未命名',
          target: rec.target || '',
          category: rec.category || undefined,
          icon: rec.icon || undefined,
          args: rec.args || undefined,
        })
      },
      fields: function (rec, host) {
        var out = []
        if ((rec.name || '') !== (host.name || '')) out.push('name')
        if ((rec.target || '') !== (host.target || '')) out.push('target')
        if ((rec.kind || '') !== (host.kind || '')) out.push('kind')
        return out
      },
      update: function (id, rec, host) {
        return api.data.resources.update({
          id: id,
          kind: rec.kind || host.kind,
          name: rec.name || host.name,
          target: rec.target || host.target,
          category: rec.category || undefined,
          icon: rec.icon || undefined,
          args: rec.args || undefined,
        })
      },
      remove: function (id) { return api.data.resources.delete({ id: id }) },
    },

    snippets: {
      list: function () { return api.data.snippets.list() },
      create: function (rec) { return api.data.snippets.create({ title: rec.title || '未命名', content: rec.content || '' }) },
      fields: function (rec, host) {
        var out = []
        if ((rec.title || '') !== (host.title || '')) out.push('title')
        if ((rec.content || '') !== (host.content || '')) out.push('content')
        if (!!rec.pinned !== !!host.is_pinned) out.push('pinned')
        return out
      },
      update: async function (id, rec, host) {
        var gap = this.fields(rec, host)
        if (gap.indexOf('title') >= 0 || gap.indexOf('content') >= 0) {
          await api.data.snippets.update({ id: id, title: rec.title || host.title, content: rec.content || '' })
        }
        if (gap.indexOf('pinned') >= 0) await api.data.snippets.togglePin({ id: id })
      },
      remove: function (id) { return api.data.snippets.delete({ id: id }) },
    },

    stickies: {
      list: function () { return api.data.stickies.list() },
      create: function () { return Promise.resolve(null) },
      fields: function (rec, host) {
        return (rec.content || '') !== (host.content || '') ? ['content'] : []
      },
      update: function (id, rec) {
        return api.data.stickies.save({ slot: Number(id), content: rec.content || '' })
      },
      remove: function (id) {
        return api.data.stickies.save({ slot: Number(id), content: '' })
      },
    },
  }

  var recordMap = {}
  function hostIdOf(recId) {
    if (!recId) return undefined
    var r = recordMap[recId]
    return r && r.hostId != null ? r.hostId : undefined
  }

  // ---------------------------------------------------------------- 同步

  function hostList(col) {
    return ADAPTERS[col].list().then(function (res) {
      return Array.isArray(res) ? res : (res && (res.data || res.items || res.rows)) || []
    })
  }

  function ingestAll() {
    if (!api || !api.data) return Promise.resolve()
    var chain = Promise.resolve()
    COLS.forEach(function (col) {
      chain = chain.then(function () {
        // 单类失败不影响其它类：宿主版本可能没有某一类能力
        return hostList(col)
          .then(function (rows) {
            // 该类读成功 → 从「缺权限」名单里划掉；名单空了才恢复提示
            if (S.deniedCols && S.deniedCols[col]) {
              delete S.deniedCols[col]
              if (!Object.keys(S.deniedCols).length) {
                S.permDenied = false
                var sc = $('scope-line')
                if (sc) {
                  sc.className = 'scope'
                  sc.textContent = '读取：待办 / 笔记 / 便签 / 速达 / 提示词（只读字段）。写回：仅待办（标题、完成、优先级、截止、备注）与便签内容。'
                }
                var pb = $('btn-perm')
                if (pb) pb.hidden = true
              }
            }
            // 空列表要连读两次才当「真的删光了」：单次空数组更可能是宿主还没加载完
            var allowEmpty = S.emptySeen && S.emptySeen[col] === true
            S.emptySeen = S.emptySeen || {}
            S.emptySeen[col] = rows.length === 0
            return svc('/api/local/ingest', {
              method: 'POST',
              body: JSON.stringify({ col: col, records: rows, full: true, allowEmpty: allowEmpty }),
            })
          })
          .catch(function (e) {
            if (/Cannot read|is not a function|undefined/.test(String(e && e.message))) return
            var msg = String((e && e.message) || e)
            S.lastError = COL_NAME[col] + ' 读取失败：' + msg
            // 权限类失败要给出可操作入口，而不是只留一行红字
            if (/PERMISSION_DENIED|未授权|权限/.test(msg)) {
              S.permDenied = true
              S.deniedCols = S.deniedCols || {}
              S.deniedCols[col] = true
              var btn = $('btn-perm')
              if (btn) btn.hidden = false
              var sc = $('scope-line')
              if (sc) {
                var bad = Object.keys(S.deniedCols).map(function (c) { return COL_NAME[c] }).join(' / ')
                sc.className = 'scope bad'
                sc.textContent = '缺少读取权限：扩展的 data:read 被关闭了，' + bad + ' 读不到。点「打开扩展权限设置」开启后重试。'
              }
            }
          })
      })
    })
    return chain
  }

  async function applyRecord(rec, ctx) {
    var ad = ADAPTERS[rec.col]
    if (!ad || !api.data[rec.col]) return null
    if (rec.deleted) {
      if (rec.hostId != null) {
        try { await ad.remove(rec.hostId) } catch (e) {
          if (!/NOT_FOUND/.test(String(e && e.message))) throw e
        }
      }
      return null
    }
    if (rec.hostId == null) {
      var created = await ad.create(rec)
      if (!created) return null
      var newId = created.id != null ? created.id : created.slot
      if (newId == null) return null
      ctx.byRecord[rec.id] = { id: rec.id, hostId: newId, version: created.version || 0 }
      var fresh = ad.list ? await ad.update(newId, rec, created) : null
      // update 返回 undefined；重新读一次拿新版本
      var now = await readHost(rec.col, newId)
      return now || created
    }
    var host = await readHost(rec.col, rec.hostId)
    if (!host) throw new Error('宿主记录已不存在')
    await ad.update(rec.hostId, rec, host)
    return await readHost(rec.col, rec.hostId)
  }

  function readHost(col, hostId) {
    if (col === 'stickies') {
      return hostList('stickies').then(function (rows) {
        return rows.filter(function (r) { return Number(r.slot) === Number(hostId) })[0] || null
      })
    }
    var api2 = api.data[col]
    if (!api2 || !api2.get) return Promise.resolve(null)
    return api2.get(hostId).catch(function () { return null })
  }

  async function drainOutbound() {
    if (S.busy || !api || !api.data) return
    S.busy = true
    try {
      var ctx = { byRecord: {} }
      ;((S.admin && S.admin.records) || []).forEach(function (r) { ctx.byRecord[r.id] = r })

      for (var round = 0; round < 8; round++) {
        var out = await svc('/api/local/outbound?limit=50')
        var items = out.items || []
        if (!items.length) break

        var applied = []
        for (var i = 0; i < items.length; i++) {
          var rec = items[i]
          try {
            var fresh = await applyRecord(rec, ctx)
            applied.push({
              id: rec.id,
              hostId: fresh ? (fresh.id != null ? fresh.id : fresh.slot) : rec.hostId,
              hostVersion: fresh ? fresh.version : null,
            })
          } catch (e) {
            S.lastError = '回写失败（' + COL_NAME[rec.col] + '）：' + (e && e.message ? e.message : e)
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
    return ingestAll()
      .then(function () { return drainOutbound() })
      .then(function () {
        S.lastError = ''
        return poll()
      })
      .catch(handleErr)
  }

  // ---------------------------------------------------------------- 扩展桥接

  var bridgeBusy = false
  function bridgeLoop() {
    if (bridgeBusy || !api || !api.service) return
    bridgeBusy = true
    svc('/api/local/bridge/pending')
      .then(function (res) {
        var items = (res && res.items) || []
        return items.reduce(function (chain, it) {
          return chain.then(function () { return runBridge(it) })
        }, Promise.resolve())
      })
      .catch(function () { /* 主页面未开时静默 */ })
      .then(function () { bridgeBusy = false })
  }

  function runBridge(it) {
    var path = String(it.method || '').split('.')
    var target = api
    for (var i = 0; i < path.length; i++) {
      if (!target) break
      target = target[path[i]]
    }
    var p
    if (typeof target === 'function') {
      p = Promise.resolve().then(function () { return target.call(api, it.args || {}) })
    } else {
      p = Promise.reject(new Error('不支持的方法 ' + it.method))
    }
    return p.then(
      function (result) {
        return svc('/api/local/bridge/result', { method: 'POST', body: JSON.stringify({ id: it.id, result: result }) })
      },
      function (err) {
        return svc('/api/local/bridge/result', {
          method: 'POST',
          body: JSON.stringify({ id: it.id, error: String((err && err.message) || err) }),
        })
      }
    )
  }

  // ---------------------------------------------------------------- 渲染

  /**
   * 可靠性告警：库损坏/只读要显眼（红），写盘失败退避重试中次之（橙）。
   * 这些状态以前只打在服务端控制台，用户看不到，等于没有。
   */
  function renderFatal(a) {
    var el = $('fatal-bar')
    if (!el) return
    var msg = ''
    var level = 'error'
    if (a && a.fatal && a.fatal.message) {
      msg = a.fatal.code === 'STATE_CORRUPT'
        ? '本地库损坏：' + a.fatal.message + '。当前为只读模式，改动不会保存。'
        : '扩展配置损坏：' + a.fatal.message + '。'
    } else if (a && a.readOnly) {
      msg = '本地库处于只读模式（未找到可用的状态文件），改动不会保存。'
    } else if (a && a.saveFails > 0) {
      level = 'warn'
      msg = '本地库写入失败 ' + a.saveFails + ' 次，正在自动重试；期间改动可能未落盘。'
    }
    if (!msg) {
      el.hidden = true
      el.textContent = ''
      return
    }
    el.className = 'fatal-bar' + (level === 'warn' ? ' warn' : '')
    el.textContent = msg
    el.hidden = false
  }

  function render() {
    var a = S.admin
    var st = a && a.stats

    if (S.unauthorized) setStatus('error', '后端未授权')
    else if (!a) setStatus('error', '后端未响应')
    else if (st && st.conflicts > 0) setStatus('conflict', st.conflicts + ' 条冲突待确认')
    else if (st && st.pendingHost > 0) setStatus('syncing', '待回写 ' + st.pendingHost + ' 条')
    else if ((a.devices || []).some(function (d) { return d.online })) {
      setStatus('online', '已连接 ' + (a.devices || []).filter(function (d) { return d.online }).length + ' 台')
    } else setStatus('online', '服务就绪 · 等待设备')

    recordMap = {}
    ;((a && a.records) || []).forEach(function (r) { recordMap[r.id] = r })

    renderPair(a)
    renderDevices(a ? a.devices : [])
    renderStats(a)
    renderContent(a)
    renderConflicts(a ? a.conflicts : [])

    renderFatal(a)

    $('bar-left').textContent = S.lastError
      ? '上次错误：' + S.lastError
      : S.lastSyncAt ? '上次同步 ' + fmtTime(S.lastSyncAt) : '尚未同步'
    $('bar-right').textContent = a
      ? '端口 ' + a.port + ' · 记录 ' + st.total + ' · 变更序号 ' + st.seq + (a.pcPageOnline ? '' : ' · 桥接离线')
      : ''

    if (a && st) {
      if (CFG.notifyOnConflict && st.conflicts > S.conflictCount && api && api.ui && st.conflicts > 0) {
        api.ui.notify('数据同步：出现冲突', st.conflicts + ' 条记录两端口同时修改，已按最近修改合并').catch(function () {})
      }
      S.conflictCount = st.conflicts
    }
  }

  // 主地址 / 虚拟网卡 / 权限 的诊断渲染
  function badge(text, cls) {
    var b = document.createElement('span')
    b.className = 'badge' + (cls ? ' ' + cls : '')
    b.textContent = text
    return b
  }

  function setWarn(text, tip) {
    var el = $('net-warn')
    if (!el) return
    if (!text) {
      el.hidden = true
      el.textContent = ''
      return
    }
    el.hidden = false
    el.className = 'net-warn' + (tip ? ' tip' : '')
    el.textContent = text
  }

  function renderPair(a) {
    var perm = $('btn-perm')

    if (!a) {
      $('pair-code').textContent = '——'
      $('pair-hint').textContent = '后端未启动'
      $('primary-addr').textContent = '—'
      $('primary-tag').innerHTML = ''
      $('addrs').innerHTML = ''
      $('qr').innerHTML = '<div class="ph">后端未就绪</div>'
      $('pair-note').textContent = '手机此时无法配对。下面三个原因按概率从高到低：network 权限被关闭、47821 端口被占用、安全软件拦截了 node 进程。'
      setWarn('后端进程没起来：先点下面的按钮确认 network 权限，再重启后端（右键扩展图标 → 重启后端）。', false)
      if (perm) perm.hidden = !(api && api.runtime && api.runtime.openPermissions)
      S.qrFor = ''
      return
    }

    if (perm) perm.hidden = !S.permDenied
    $('pair-code').textContent = String(a.pairCode || '').replace(/(\d{3})(\d{3})/, '$1 $2')
    var left = Math.max(0, Math.round((a.pairExpiresAt - Date.now()) / 1000))
    $('pair-hint').textContent = left > 0 ? '剩余 ' + Math.floor(left / 60) + ' 分 ' + (left % 60) + ' 秒' : '已过期，点「换配对码」'

    var addrs = a.addresses || []
    var primary = a.primary || (addrs.find(function (x) { return x.primary }) || addrs[0] || {}).address || ''
    var rec = addrs.find(function (x) { return x.address === primary }) || null
    var primaryText = primary ? primary + ':' + a.port : '没有检测到局域网地址'
    $('primary-addr').textContent = primaryText
    $('btn-copy-addr').onclick = function () {
      copyText(primaryText)
      var b = $('btn-copy-addr')
      b.textContent = '已复制'
      setTimeout(function () { b.textContent = '复制' }, 1000)
    }

    // 主地址的来历要说清楚：是默认路由探测出来的，还是仅按网段猜的
    var tag = $('primary-tag')
    tag.innerHTML = ''
    if (primary) {
      tag.appendChild(badge(rec && rec.primary ? '默认路由' : '推荐', 'ok'))
      if (rec && rec.iface) tag.appendChild(badge(rec.iface, ''))
      if (rec && rec.virtual) tag.appendChild(badge('虚拟网卡', 'warn'))
    }

    // 结论先于细节：不能连的情况直接给红条
    if (!a.lanEnabled) {
      setWarn('后端只监听 127.0.0.1，手机连不上：请确认扩展的 network 权限已开启，然后重启后端。', false)
    } else if (!primary) {
      setWarn('没有检测到局域网地址：请确认电脑已连上 Wi-Fi 或网线。', false)
    } else if (rec && rec.virtual) {
      setWarn('主地址落在虚拟网卡上，手机多半连不上：请关掉 VPN / 虚拟网卡后点「换配对码」重试，或直接用列表里的物理网卡地址。', true)
    } else {
      setWarn('')
    }

    // 其它地址：物理网卡在前，虚拟网卡标灰并注明
    var ul = $('addrs')
    ul.innerHTML = ''
    addrs.filter(function (x) { return x.address !== primary }).forEach(function (it) {
      var li = document.createElement('li')
      if (it.virtual) li.className = 'virtual'
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
      if (it.virtual) li.appendChild(badge('虚拟', 'virtual'))
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
      : '在手机 App 里扫描二维码即可完成配对；二维码里带上了全部可用地址，手机会逐个试。'

    // 二维码 v3：把候选地址一起带上，手机按顺序探测，第一个通的就用
    var cands = []
    if (primary && !(rec && rec.virtual)) cands.push(primary)
    addrs.forEach(function (x) {
      if (x.virtual) return
      if (cands.indexOf(x.address) >= 0) return
      if (cands.length >= 4) return
      cands.push(x.address)
    })
    if (!cands.length && primary) cands.push(primary)
    if (cands.length) {
      var payload = 'xhub://3/' + a.pairCode + '/' + cands.map(function (ip) { return ip + ':' + a.port }).join(',')
      if (payload !== S.qrFor) {
        S.qrFor = payload
        drawQR(payload)
      }
    }
  }

  function bindPermButton() {
    var btn = $('btn-perm')
    if (!btn) return
    btn.onclick = function () {
      if (api && api.runtime && api.runtime.openPermissions) {
        api.runtime.openPermissions()
      } else {
        alert('当前宿主版本不支持直接打开权限设置，请到 x-hub 扩展中心 → 待办同步 → 权限 里手动开启')
      }
    }
  }

  function drawQR(text) {
    var box = $('qr')
    try {
      if (typeof window.qrcode !== 'function') throw new Error('no lib')
      box.dataset.payload = text
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
        var fbtn = document.createElement('button')
        fbtn.className = 'revoke fileflag' + (d.allowFiles === false ? ' off' : ' on')
        fbtn.type = 'button'
        fbtn.textContent = d.allowFiles === false ? '文件 关' : '文件 开'
        fbtn.title = d.allowFiles === false ? '这台设备不能收发文件，点击开启' : '允许这台设备收发文件，点击关闭'
        fbtn.addEventListener('click', function () { toggleFiles(d) })
        row.appendChild(fbtn)
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

  function toggleFiles(d) {
    svc('/api/local/files/allow', {
      method: 'POST',
      body: JSON.stringify({ deviceId: d.id, allow: d.allowFiles === false }),
    })
      .then(function () { return poll() })
      .then(function () { return refreshFiles() })
      .catch(handleErr)
  }

  function renderStats(a) {
    var box = $('col-stats')
    box.innerHTML = ''
    COLS.forEach(function (col) {
      var b = a && a.stats && a.stats.byCol ? a.stats.byCol[col] : null
      var chip = document.createElement('button')
      chip.type = 'button'
      chip.className = 'col-chip' + (S.col === col ? ' on' : '')
      chip.innerHTML = '<span>' + COL_NAME[col] + '</span><b>' + (b ? b.live : 0) + '</b>'
      chip.addEventListener('click', function () {
        S.col = col
        render()
      })
      box.appendChild(chip)
    })
  }

  function renderContent(a) {
    var ul = $('content')
    ul.innerHTML = ''
    var list = ((a && a.records) || []).filter(function (r) { return r.col === S.col && !r.deleted })
    $('content-hint').textContent = list.length ? '共 ' + list.length + ' 条' : ''
    if (!list.length) {
      var li = document.createElement('li')
      li.className = 'empty'
      li.textContent = '这一类还没有数据'
      ul.appendChild(li)
      return
    }
    list
      .slice()
      .sort(function (x, y) { return (y.updatedAt || 0) - (x.updatedAt || 0) })
      .slice(0, 40)
      .forEach(function (r) {
        var li = document.createElement('li')
        li.className = 'item'
        var t = document.createElement('span')
        t.className = 'it'
        t.textContent = itemTitle(r)
        var m = document.createElement('span')
        m.className = 'im'
        m.textContent = itemMeta(r)
        li.appendChild(t)
        li.appendChild(m)
        ul.appendChild(li)
      })
  }

  function itemTitle(r) {
    if (r.col === 'notes') return r.title || '无标题笔记'
    if (r.col === 'resources') return r.name || r.title || '未命名'
    if (r.col === 'stickies') return '便签 ' + (r.slot || 1)
    return r.title || r.content || '（空）'
  }

  function itemMeta(r) {
    if (r.col === 'todos') return r.done ? '已完成' : fmtDue(r.dueAt)
    if (r.col === 'resources') return r.kind === 'web' ? '网页' : r.kind === 'file' ? '文件' : '程序'
    if (r.col === 'stickies') return String(r.content || '').slice(0, 24)
    if (r.by && r.by !== 'pc-host') return '来自手机'
    return ''
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
      t.textContent = (COL_NAME[c.col] ? '[' + COL_NAME[c.col] + '] ' : '') + (c.title || c.id)
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

  // ---------------------------------------------------------------- 动作

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
    } catch (e) { /* 复制失败不影响主流程 */ }
  }

  // ---------------------------------------------------------------- 安卓端下载

  function fmtKB(bytes) {
    if (!bytes) return ''
    return Math.round(bytes / 1024) + ' KB'
  }

  function openLink(url) {
    if (api && typeof api.openExternal === 'function') {
      api.openExternal(url).catch(function () {
        copyText(url)
        flashCopy('btn-copy-dl', '已复制，请到浏览器打开')
      })
      return
    }
    // 宿主太旧没有 openExternal：退化成复制链接，至少不让点击毫无反应
    copyText(url)
    flashCopy('btn-copy-dl', '已复制，请到浏览器打开')
  }

  function flashCopy(id, text) {
    var b = $(id)
    if (!b) return
    if (!b.dataset.label) b.dataset.label = b.textContent
    b.textContent = text
    setTimeout(function () { b.textContent = b.dataset.label }, 1400)
  }

  function renderDownload() {
    var sub = [fmtKB(ANDROID_DL.size), 'GitHub Releases'].filter(Boolean).join(' · ')
    $('dl-title').textContent = '下载安卓端 v' + ANDROID_DL.version
    $('dl-sub').textContent = sub
  }

  function bindDownload() {
    renderDownload()
    $('btn-download').addEventListener('click', function () {
      openLink(ANDROID_DL.apk)
    })
    $('btn-copy-dl').addEventListener('click', function () {
      copyText(ANDROID_DL.apk)
      flashCopy('btn-copy-dl', '已复制')
    })
    $('btn-dl-notes').addEventListener('click', function () {
      openLink(ANDROID_DL.notes)
    })
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

  // ---------------------------------------------------------------- 轮询

  function poll() {
    if (!api || !api.service) {
      setStatus('error', '不在 x-hub 内运行')
      return Promise.resolve()
    }
    // 单飞：上一次还没回来就不再叠加，避免服务端卡顿时排起一队请求
    if (S.polling) return S.polling
    S.polling = svc('/api/admin/state')
      .then(function (d) {
        S.admin = d
        S.unauthorized = false
        S.lastPollAt = Date.now()
        if (!S.lastSyncAt) S.lastSyncAt = d.serverTime
        render()
      })
      .catch(function (e) {
        S.admin = null
        handleErr(e)
      })
      .finally(function () {
        S.polling = null
      })
    return S.polling
  }

  // ---------------------------------------------------------------- 文件传输

  var FILES = { data: null, sending: [], at: 0, loading: false }
  var MAX_FILE = 512 * 1024 * 1024

  function fmtSize(n) {
    n = Number(n) || 0
    if (n < 1024) return n + ' B'
    if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB'
    if (n < 1024 * 1024 * 1024) return (n / 1048576).toFixed(n < 10 * 1048576 ? 1 : 0) + ' MB'
    return (n / 1073741824).toFixed(2) + ' GB'
  }

  function iconOf(kind) {
    return { image: '▣', video: '▶', audio: '♪', doc: '▤', archive: '▦', code: '⌘' }[kind] || '◇'
  }

  // 扩展页面跑在宿主 iframe 里，直连 127.0.0.1 会被跨源拦掉；
  // 统一走宿主提供的 service.request（它转发到本服务的 /api/local/*）。
  var HOST = api && api.service && typeof api.service.request === 'function' ? api.service : null

  function fileApi(path, opts) {
    opts = opts || {}
    var init = { method: opts.method || 'GET', headers: {} }
    if (opts.body !== undefined) {
      init.headers['Content-Type'] = 'application/json'
      init.body = opts.body
    }
    var call = HOST ? HOST.request(path, init) : fetch(path, init)
    var timeout = new Promise(function (_, reject) {
      setTimeout(function () {
        var e = new Error('请求超时')
        e.status = 0
        reject(e)
      }, opts.timeout || 30000)
    })
    return Promise.race([call, timeout]).then(function (r) {
      if (r.status >= 200 && r.status < 300) return r.json()
      return r
        .json()
        .catch(function () { return {} })
        .then(function (d) {
          var e = new Error((d && (d.message || d.code)) || 'HTTP ' + r.status)
          e.code = d && d.code
          e.status = r.status
          throw e
        })
    })
  }

  function refreshFiles() {
    if (FILES.loading) return Promise.resolve()
    FILES.loading = true
    return fileApi('/api/local/files/state')
      .then(function (d) {
        FILES.data = d
        FILES.at = Date.now()
        renderFiles()
      })
      .catch(function (e) {
        // 服务刚起来时 404 很常见，不做打扰；页面底部仍能看到同步状态
        if (e.status !== 404) S.lastError = e.message
      })
      .finally(function () { FILES.loading = false })
  }

  function renderFiles() {
    var d = FILES.data
    if (!d) return
    var st = d.stats || {}
    $('files-quota').textContent = fmtSize(st.used) + ' / ' + fmtSize(st.quota) + ' · 单文件上限 ' + fmtSize(d.maxFile || MAX_FILE)

    if (d.saveDir) {
      $('savedir-path').textContent = d.saveDir.isDefault ? '默认收件箱' : d.saveDir.path
      $('savedir-path').title = d.saveDir.path || ''
      $('btn-savedir-default').hidden = !!d.saveDir.isDefault
    }

    var out = $('file-out')
    out.innerHTML = ''
    var outs = d.out || []
    $('out-count').textContent = String(outs.filter(function (x) { return x.state === 'pending' }).length)
    $('file-out-empty').hidden = outs.length > 0
    outs.slice(0, 20).forEach(function (it) { out.appendChild(fileRow(it, 'out')) })

    var inbox = $('file-in')
    inbox.innerHTML = ''
    var ins = d.inbox || []
    $('in-count').textContent = String(ins.length)
    $('file-in-empty').hidden = ins.length > 0
    ins.slice(0, 30).forEach(function (it) { inbox.appendChild(fileRow(it, 'in')) })
  }

  function outStateText(it) {
    if (it.state === 'delivered') return '已送达 ' + fmtTime(it.deliveredAt)
    if (it.state === 'declined') return '手机已拒收'
    if (it.state === 'expired' || it.expired) return '已过期（24 小时）'
    if (it.state === 'sending') return '正在读取…'
    return '等待手机接收'
  }

  function fileRow(it, kind) {
    var li = document.createElement('li')
    li.className = 'file'
    var ic = document.createElement('span')
    ic.className = 'fic'
    ic.textContent = iconOf(it.kind)
    var meta = document.createElement('div')
    meta.className = 'fmeta'
    var nm = document.createElement('div')
    nm.className = 'fname'
    nm.textContent = it.name
    nm.title = it.path || it.name
    var sub = document.createElement('div')
    sub.className = 'fsub'
    var bits = [fmtSize(it.size)]
    if (kind === 'in') {
      bits.push('来自 ' + (it.from || '手机'))
      bits.push(fmtTime(it.at))
    } else {
      bits.push(outStateText(it))
    }
    sub.textContent = bits.join(' · ')
    meta.appendChild(nm)
    meta.appendChild(sub)
    li.appendChild(ic)
    li.appendChild(meta)
    if (it.risk === 'high') {
      var risk = document.createElement('span')
      risk.className = 'frisk'
      risk.textContent = '可执行'
      risk.title = '可执行/脚本类文件：确认来源再打开'
      li.appendChild(risk)
    }
    if (kind === 'in') {
      var cp = document.createElement('button')
      cp.className = 'revoke ghost'
      cp.type = 'button'
      cp.textContent = '复制路径'
      cp.addEventListener('click', function () { copyText(it.path || '') })
      li.appendChild(cp)
    }
    var del = document.createElement('button')
    del.className = 'revoke'
    del.type = 'button'
    del.textContent = '删除'
    del.addEventListener('click', function () { removeFile(it.id) })
    li.appendChild(del)
    return li
  }

  function copyText(text) {
    if (!text) return
    var done = function () { flash('已复制：' + text) }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text, done) })
    } else {
      fallbackCopy(text, done)
    }
  }

  function fallbackCopy(text, done) {
    var ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    try { document.execCommand('copy') } catch (e) {}
    document.body.removeChild(ta)
    done()
  }

  function flash(msg) {
    var el = $('bar-left')
    if (!el) return
    var old = el.textContent
    el.textContent = msg
    setTimeout(function () { if (el.textContent === msg) el.textContent = old }, 4000)
  }

  function removeFile(id) {
    fileApi('/api/local/files/remove', { method: 'POST', json: true, body: JSON.stringify({ id: id }) })
      .then(function () { return refreshFiles() })
      .catch(handleErr)
  }

  function clearFiles(scope) {
    fileApi('/api/local/files/clear', { method: 'POST', json: true, body: JSON.stringify({ scope: scope }) })
      .then(function (r) { flash('已清理 ' + r.removed + ' 个文件'); return refreshFiles() })
      .catch(handleErr)
  }

  function renderProgress() {
    var box = $('file-progress')
    box.innerHTML = ''
    FILES.sending.forEach(function (t) {
      var row = document.createElement('div')
      row.className = 'up' + (t.error ? ' bad' : '')
      var head = document.createElement('div')
      head.className = 'up-head'
      var nm = document.createElement('span')
      nm.className = 'up-name'
      nm.textContent = t.name
      var pct = document.createElement('span')
      pct.className = 'up-pct'
      pct.textContent = t.error ? '失败' : Math.round(t.pct * 100) + '%'
      head.appendChild(nm)
      head.appendChild(pct)
      var track = document.createElement('div')
      track.className = 'up-track'
      var bar = document.createElement('i')
      bar.style.width = Math.max(2, Math.round(t.pct * 100)) + '%'
      track.appendChild(bar)
      row.appendChild(head)
      row.appendChild(track)
      if (t.error) {
        var err = document.createElement('div')
        err.className = 'up-err'
        err.textContent = t.error
        row.appendChild(err)
      }
      box.appendChild(row)
    })
  }

  /** 宿主桥只收字符串：把 1MiB 转成 base64（分片拼接，避免 apply 参数上限） */
  function toB64(buf) {
    var bytes = new Uint8Array(buf)
    var s = ''
    var step = 0x8000
    for (var i = 0; i < bytes.length; i += step) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + step))
    }
    return btoa(s)
  }

  var LOCAL_CHUNK = 1024 * 1024

  function postChunk(id, off, buf, attempt) {
    var init = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ off: off, data: toB64(buf) }),
    }
    var url = '/api/local/files/send/chunk?id=' + encodeURIComponent(id)
    return (HOST ? HOST.request(url, init) : fetch(url, init)).then(
      function (r) {
        if (r.ok) return r.json()
        return r
          .json()
          .catch(function () { return {} })
          .then(function (d) {
            var retryable = r.status >= 500 || r.status === 429
            if (retryable && attempt < 3) {
              return new Promise(function (res) { setTimeout(res, 300 * Math.pow(2, attempt)) }).then(function () {
                return postChunk(id, off, buf, attempt + 1)
              })
            }
            var e = new Error((d && (d.message || d.code)) || 'HTTP ' + r.status)
            e.code = d && d.code
            throw e
          })
      },
      function (err) {
        if (attempt < 3) {
          return new Promise(function (res) { setTimeout(res, 300 * Math.pow(2, attempt)) }).then(function () {
            return postChunk(id, off, buf, attempt + 1)
          })
        }
        throw err
      }
    )
  }

  function uploadOne(file, onProgress) {
    if (file.size > MAX_FILE) return Promise.reject(new Error('文件超过 512MB 上限'))
    if (!file.size) return Promise.reject(new Error('空文件不能发送'))
    return fileApi('/api/local/files/send/init', {
      method: 'POST',
      json: true,
      body: JSON.stringify({ name: file.name, size: file.size, mime: file.type || '' }),
    }).then(function (init) {
      var off = 0
      var sentChunks = 0
      var totalChunks = Math.ceil(file.size / LOCAL_CHUNK)
      function next() {
        if (off >= file.size) {
          return fileApi('/api/local/files/send/finish', {
            method: 'POST',
            json: true,
            body: JSON.stringify({ id: init.id }),
          })
        }
        var end = Math.min(off + LOCAL_CHUNK, file.size)
        var at = off
        return file
          .slice(at, end)
          .arrayBuffer()
          .then(function (buf) { return postChunk(init.id, at, buf, 0) })
          .then(function () {
            off = end
            sentChunks++
            onProgress(sentChunks / totalChunks)
            return next()
          })
      }
      return next()
    })
  }

  var sendChain = Promise.resolve()

  function enqueueFiles(list) {
    Array.prototype.slice.call(list || []).forEach(function (f) {
      var t = { name: f.name, size: f.size, pct: 0, error: '' }
      FILES.sending.push(t)
      renderProgress()
      sendChain = sendChain
        .then(function () {
          return uploadOne(f, function (p) {
            t.pct = p
            renderProgress()
          })
        })
        .then(function () {
          t.pct = 1
          renderProgress()
          refreshFiles()
          setTimeout(function () {
            var at = FILES.sending.indexOf(t)
            if (at >= 0) FILES.sending.splice(at, 1)
            renderProgress()
          }, 2600)
        })
        .catch(function (e) {
          t.error = (e && e.message) || '发送失败'
          t.pct = 0
          renderProgress()
        })
    })
  }

  function bindFiles() {
    $('btn-pick-file').addEventListener('click', function () { $('file-input').click() })
    $('file-input').addEventListener('change', function (e) {
      enqueueFiles(e.target.files)
      e.target.value = ''
    })
    var drop = $('file-drop')
    ;['dragenter', 'dragover'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) {
        e.preventDefault()
        drop.classList.add('over')
      })
    })
    ;['dragleave', 'drop'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) {
        e.preventDefault()
        drop.classList.remove('over')
      })
    })
    drop.addEventListener('drop', function (e) {
      if (e.dataTransfer && e.dataTransfer.files) enqueueFiles(e.dataTransfer.files)
    })
    $('btn-files-clear-in').addEventListener('click', function () { clearFiles('in') })
    $('btn-files-clear-out').addEventListener('click', function () { clearFiles('out') })
    $('btn-savedir').addEventListener('click', function () { openSaveDir() })
    $('btn-savedir-default').addEventListener('click', function () { setSaveDir('') })
    refreshFiles()
    setInterval(function () {
      if (Date.now() - FILES.at < 12000) return
      refreshFiles()
    }, 6000)
  }

  /** 保存位置弹窗：输入目录路径，或恢复默认收件箱 */
  function openSaveDir() {
    var cur = FILES.data && FILES.data.saveDir && !FILES.data.saveDir.isDefault ? FILES.data.saveDir.path : ''
    var mask = document.createElement('div')
    mask.className = 'savedir-mask'
    var box = document.createElement('div')
    box.className = 'savedir-card'
    var head = document.createElement('div')
    head.className = 'savedir-head'
    var title = document.createElement('b')
    title.textContent = '文件保存位置'
    var close = document.createElement('button')
    close.className = 'link'
    close.type = 'button'
    close.textContent = '取消'
    close.addEventListener('click', function () { mask.remove() })
    head.appendChild(title)
    head.appendChild(close)
    var hint = document.createElement('p')
    hint.className = 'savedir-hint'
    hint.textContent = '手机发来的文件会保存到这个目录；留空则用默认收件箱。'
    var input = document.createElement('input')
    input.className = 'savedir-input'
    input.value = cur
    input.placeholder = '例如：D:\\Downloads\\手机文件'
    var btn = document.createElement('button')
    btn.className = 'btn primary savedir-save'
    btn.type = 'button'
    btn.textContent = '保存'
    btn.addEventListener('click', function () { setSaveDir(input.value.trim()) })
    box.appendChild(head)
    box.appendChild(hint)
    box.appendChild(input)
    box.appendChild(btn)
    mask.appendChild(box)
    document.body.appendChild(mask)
    mask.addEventListener('click', function (e) { if (e.target === mask) mask.remove() })
    setTimeout(function () { input.focus() }, 60)
  }

  function setSaveDir(path) {
    fileApi('/api/local/files/savedir', { method: 'POST', json: true, body: JSON.stringify({ path: path }) })
      .then(function (r) {
        var box = document.querySelector('.savedir-mask')
        if (box) box.remove()
        flash(path ? '已设置保存位置：' + r.path : '已恢复默认收件箱')
        return refreshFiles()
      })
      .catch(handleErr)
  }

  // ---------------------------------------------------------------- 实时推送

  var stream = null
  var streamFails = 0

  /**
   * 服务端早就实现了 SSE，此前两端都没接，只能靠 4 秒轮询。
   * 接上之后改动基本是即时到达；轮询降级为兜底（断线时仍然可用）。
   */
  function connectStream() {
    if (typeof EventSource === 'undefined') return
    if (stream && stream.readyState !== EventSource.CLOSED) return
    try {
      stream = new EventSource('/api/local/stream')
    } catch (e) {
      return
    }
    stream.addEventListener('hello', function () {
      streamFails = 0
      S.streamOk = true
      poll()
    })
    stream.addEventListener('change', function () {
      // 有变更就拉一次状态；拉取本身很轻，且已做单飞
      poll()
    })
    stream.addEventListener('peer', function () { poll() })
    // 文件事件只刷新文件面板，不触发整页同步
    stream.addEventListener('file', function (e) {
      refreshFiles()
      if (e && e.data) {
        try {
          var p = JSON.parse(e.data)
          if (p.kind === 'received') flash('收到手机文件：' + p.name)
        } catch (err) {}
      }
    })
    stream.onerror = function () {
      streamFails += 1
      S.streamOk = false
      // EventSource 自带重连；连续失败太多就关掉，让轮询接管，避免空转
      if (streamFails > 5 && stream) {
        try { stream.close() } catch (_) {}
        stream = null
      }
    }
  }

  // ---------------------------------------------------------------- 启动

  function bind() {
    $('btn-sync').addEventListener('click', function () {
      var b = $('btn-sync')
      b.disabled = true
      b.textContent = '同步中…'
      syncOnce()
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
  bindFiles()
  bindPermButton()
  bindDownload()
  connectStream()
  poll()
  syncOnce()
  setInterval(function () {
    // SSE 正常时把轮询降为 20 秒兜底；断线则立刻回到 4 秒
    if (S.streamOk && Date.now() - (S.lastPollAt || 0) < 20000) return
    poll()
  }, POLL_MS)
  setInterval(drainOutbound, 5000)
  setInterval(bridgeLoop, 1500)
})()
