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
  }

  var POLL_MS = 4000
  var CFG = { syncIntervalMs: 15000, notifyOnConflict: true, autoIngest: true }

  // ---------------------------------------------------------------- 基础

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
          var err = new Error((d && (d.message || d.code)) || 'HTTP ' + r.status)
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
    return svc('/api/admin/state')
      .then(function (d) {
        S.admin = d
        S.unauthorized = false
        if (!S.lastSyncAt) S.lastSyncAt = d.serverTime
        render()
      })
      .catch(function (e) {
        S.admin = null
        handleErr(e)
      })
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
  bindPermButton()
  poll()
  syncOnce()
  setInterval(poll, POLL_MS)
  setInterval(drainOutbound, 5000)
  setInterval(bridgeLoop, 1500)
})()
