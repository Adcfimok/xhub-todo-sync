import { S, syncNow, pair, saveMeta, normalizeHost, COLS, COL_NAME, APP_VER, emit, onChange } from '../lib/core.js'
import { h, toast, confirmAsync, openForm, fmtAgo, fmtDue, emptyBlock } from '../lib/ui.js'
import { alarmState, testAlarm, openExactAlarmSettings, openNotificationSettings, requestNotifyPermission, hasAlarms } from '../lib/native.js'
import { scheduleAlarms } from '../lib/alerts.js'

export const meta = { title: '同步与设置', route: 'settings' }

let rootEl = null
// 扫码得到的候选地址（v3 二维码会带多个），配对时按顺序试
let pendingHosts = []
let off = null
let scan = { stream: null, raf: 0 }

export function mount(root) {
  rootEl = root
  render()
  off = onChange(render)
  return () => {
    off && off()
    closeScan()
  }
}

function render() {
  if (!rootEl) return
  rootEl.innerHTML = ''
  const scroll = h('div', { class: 'scroll' })
  rootEl.appendChild(scroll)

  const paired = !!S.meta.token
  const stats = countStats()

  scroll.appendChild(statusCard(paired, stats))
  if (!paired) scroll.appendChild(pairCard())
  if (S.conflicts.length) scroll.appendChild(conflictCard())
  scroll.appendChild(displayCard())
  scroll.appendChild(notifyCard())
  scroll.appendChild(keepAliveCard())
  scroll.appendChild(aboutCard())
  if (paired) scroll.appendChild(unpairCard())
  scroll.appendChild(h('div', { class: 'list-pad' }))
}

function countStats() {
  const out = {}
  COLS.forEach((c) => (out[c] = 0))
  S.records.forEach((r) => {
    if (!r.deleted && out[r.col] != null) out[r.col]++
  })
  return out
}

function statusCard(paired, stats) {
  const dirty = S.records.filter((r) => r.dirty).length
  const online = S.status === 'online' || S.status === 'syncing' || S.status === 'conflict'
  const dotState = S.status === 'conflict' ? 'conflict' : online ? 'online' : S.status === 'error' ? 'error' : 'offline'

  return h('div', { class: 'card' }, [
    h('div', { class: 'status-head' }, [
      h('span', { class: 'big-dot', 'data-state': dotState }),
      h('div', { class: 'status-meta' }, [
        h('div', { class: 'status-title', text: paired ? statusTitle() : '未连接电脑' }),
        h('div', { class: 'status-sub', text: S.lastErr || (paired ? (online ? '两端数据已对齐' : '离线中，改动会先存在手机里') : '填入电脑地址与配对码即可同步') }),
      ]),
    ]),
    h('div', { class: 'kv' }, [
      h('div', null, [h('span', { text: '电脑地址' }), h('b', { text: S.meta.host || '—' })]),
      h('div', null, [h('span', { text: '设备名' }), h('b', { text: S.meta.deviceName || '—' })]),
      h('div', null, [h('span', { text: '上次同步' }), h('b', { text: S.syncAt ? fmtAgo(S.syncAt) : '—' })]),
      h('div', null, [h('span', { text: '待上传' }), h('b', { text: String(dirty) })]),
    ]),
    h('div', { class: 'stat-row' }, COLS.map((c) => h('span', { class: 'stat-pill', text: COL_NAME[c] + ' ' + stats[c] }))),
    h('div', { class: 'row-btns' }, [
      h('button', { class: 'btn primary', type: 'button', text: paired ? '立即同步' : '先配对', onclick: () => (paired ? doSync() : scrollToPair()) }),
      h('button', { class: 'btn', type: 'button', text: '强制全量', onclick: () => resync() }),
    ]),
  ])
}

function statusTitle() {
  if (S.status === 'syncing') return '同步中…'
  if (S.status === 'conflict') return '已连接 · 有冲突'
  if (S.status === 'online') return '已连接电脑'
  if (S.status === 'error') return '连接异常'
  return '离线'
}

function pairCard() {
  const host = h('input', { class: 'input', type: 'text', inputmode: 'url', placeholder: '192.168.1.10:47821' })
  const code = h('input', { class: 'input', type: 'text', inputmode: 'numeric', maxlength: 6, placeholder: '6 位数字' })
  const err = h('p', { class: 'err', hidden: true })
  const btn = h('button', { class: 'btn primary block', type: 'button', text: '配对并同步' })

  btn.onclick = async () => {
    const typed = normalizeHost(host.value)
    const codeVal = String(code.value || '').replace(/\D/g, '')
    err.hidden = true
    if (!typed) return showErr('请填写电脑地址')
    if (codeVal.length !== 6) return showErr('配对码是 6 位数字')
    // 手输地址优先，其次是二维码带来的候选
    const hosts = [typed].concat(pendingHosts.filter((h) => h && h !== typed))
    btn.disabled = true
    let lastErr = null
    for (let i = 0; i < hosts.length; i++) {
      btn.textContent = hosts.length > 1 ? `连接中… (${i + 1}/${hosts.length})` : '连接中…'
      try {
        await pair(hosts[i], codeVal, S.meta.deviceName)
        pendingHosts = []
        toast('配对成功')
        render()
        return
      } catch (e) {
        lastErr = e
        // 配对码错/次数超限是终态，换地址也没用
        if (e && (e.code === 'INVALID_CODE' || e.code === 'TOO_MANY_ATTEMPTS' || e.code === 'DEVICE_LIMIT')) break
      }
    }
    showErr(pairErrorText(lastErr))
    btn.disabled = false
    btn.textContent = '配对并同步'
  }

  function showErr(t) {
    err.textContent = t
    err.hidden = false
  }

  return h('div', { class: 'card', id: 'pair-card' }, [
    h('h2', { text: '连接电脑' }),
    h('p', { class: 'muted', text: '电脑上打开 x-hub 的「待办同步」扩展，页面上有地址与 6 位配对码。' }),
    h('label', { class: 'field' }, [h('span', { text: '地址' }), host]),
    h('label', { class: 'field' }, [h('span', { text: '配对码' }), code]),
    h('div', { class: 'row-btns' }, [
      btn,
      h('button', { class: 'btn', type: 'button', text: '扫码', onclick: openScan }),
    ]),
    err,
  ])
}

function scrollToPair() {
  const el = document.getElementById('pair-card')
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
}

function pairErrorText(e) {
  const c = e && e.code
  if (c === 'INVALID_CODE') return '配对码不对或已过期，在电脑上点「换配对码」再试'
  if (c === 'TOO_MANY_ATTEMPTS') return '试错次数过多，请等一会儿'
  if (c === 'DEVICE_LIMIT') return '电脑端设备数量已满，先在电脑上移除一台'
  if (e && e.timeout) return '连不上这台电脑：确认手机和电脑在同一个 Wi-Fi；电脑若开着 VPN / 虚拟机网卡，请用页面上标「默认路由」的地址'
  return '配对失败：' + ((e && e.message) || e)
}

function conflictCard() {
  return h('div', { class: 'card' }, [
    h('h2', null, ['冲突记录', h('span', { class: 'count', text: String(S.conflicts.length) })]),
    h('p', { class: 'muted', text: '同一记录两端都改过时按最近修改保留，被覆盖的版本记在这里。' }),
    h(
      'ul',
      { class: 'conflicts' },
      S.conflicts.map((c) =>
        h('li', null, [
          h('div', { class: 'c-t', text: (COL_NAME[c.col] ? '[' + COL_NAME[c.col] + '] ' : '') + c.title }),
          h('div', { class: 'c-s', text: (c.fields && c.fields.length ? '字段 ' + c.fields.join('/') : '整条覆盖') + ' · 保留' + (c.winner === 'pc-host' ? '电脑' : '手机') + '版本' }),
        ])
      )
    ),
    h('button', {
      class: 'btn block',
      type: 'button',
      text: '清除本地记录',
      onclick: () => {
        S.conflicts = []
        render()
      },
    }),
  ])
}

/** 可选主题色：深色/浅色各一套值（浅色下要压暗才够对比度） */
export const ACCENTS = [
  { id: 'violet', name: '靛紫', dark: '#8b8bff', light: '#5b5bf5' },
  { id: 'blue', name: '海蓝', dark: '#5b9dff', light: '#2f6fd0' },
  { id: 'teal', name: '青碧', dark: '#3ddad7', light: '#0e8f8b' },
  { id: 'green', name: '森绿', dark: '#4ade80', light: '#17864b' },
  { id: 'orange', name: '暖橙', dark: '#fb923c', light: '#c2410c' },
  { id: 'pink', name: '樱粉', dark: '#f472b6', light: '#c2185b' },
]

function isLightNow() {
  const attr = document.documentElement.getAttribute('data-theme')
  if (attr === 'light') return true
  if (attr === 'dark') return false
  return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches)
}

export function applyAccent(id) {
  const a = ACCENTS.find((x) => x.id === id) || ACCENTS[0]
  const light = isLightNow()
  const root = document.documentElement
  root.style.setProperty('--accent', light ? a.light : a.dark)
  root.style.setProperty('--on-accent', light ? '#ffffff' : '#14141c')
}

export function applyTheme(mode, accent) {
  const root = document.documentElement
  if (!mode || mode === 'auto') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', mode)
  applyAccent(accent || S.meta.accentColor)
}

// 系统深浅色切换时，跟随模式要重算主题色
if (window.matchMedia) {
  const mq = window.matchMedia('(prefers-color-scheme: dark)')
  const onScheme = () => {
    if (!S.meta.themeMode || S.meta.themeMode === 'auto') applyAccent(S.meta.accentColor)
  }
  if (mq.addEventListener) mq.addEventListener('change', onScheme)
  else if (mq.addListener) mq.addListener(onScheme)
}

function displayCard() {
  const modes = [
    { value: 'light', label: '浅色' },
    { value: 'dark', label: '深色' },
    { value: 'auto', label: '跟随系统' },
  ]
  const cur = S.meta.themeMode || 'auto'
  const accent = S.meta.accentColor || 'violet'

  const dots = h('div', { class: 'accent-row' })
  ACCENTS.forEach((a) => {
    dots.appendChild(
      h('button', {
        class: 'accent-dot' + (accent === a.id ? ' on' : ''),
        type: 'button',
        title: a.name,
        'aria-label': a.name,
        style: '--dot:' + a.dark,
        onclick: async () => {
          await saveMeta('accentColor', a.id)
          applyTheme(S.meta.themeMode, a.id)
          render()
        },
      })
    )
  })

  return h('div', { class: 'card' }, [
    h('h2', { text: '外观' }),
    h(
      'div',
      { class: 'seg' },
      modes.map((m) =>
        h('button', {
          class: cur === m.value ? 'on' : '',
          type: 'button',
          text: m.label,
          onclick: async () => {
            await saveMeta('themeMode', m.value)
            applyTheme(m.value, accent)
            render()
          },
        })
      )
    ),
    h('p', { class: 'hint-line', text: '「跟随系统」会随手机的浅色 / 深色自动切换' }),
    h('div', { class: 'field-label', text: '主题颜色' }),
    dots,
  ])
}

function notifyCard() {
  const on = S.meta.notifyTodo !== '0'
  return h('div', { class: 'card' }, [
    h('h2', { text: '提醒' }),
    h('div', { class: 'switch-row' }, [
      h('div', { class: 'switch-meta' }, [
        h('div', { class: 'switch-title', text: '待办临期提醒' }),
        h('div', { class: 'switch-sub', text: '按每条待办的提醒时间发系统通知 + 震动 + 应用内弹窗；同一条只提醒一次，可稍后 10 分钟' }),
      ]),
      h('label', { class: 'toggle' }, [
        h('input', {
          type: 'checkbox',
          checked: on,
          onchange: async (e) => {
            await saveMeta('notifyTodo', e.target.checked ? '1' : '0')
            // 关掉时必须把已排进系统的闹钟撤掉，否则开关形同虚设
            scheduleAlarms()
            toast(e.target.checked ? '已开启提醒' : '已关闭提醒')
            render()
          },
        }),
        h('span', { class: 'knob' }),
      ]),
    ]),
    selfCheckBlock(),
  ])
}

// ---------------------------------------------------------------- 通知自检

/** 把毫秒差写成「+0.4 秒 / 提前 2 秒」 */
function fmtDelay(ms) {
  const n = Number(ms) || 0
  const abs = Math.abs(n)
  const text = abs < 1000 ? abs + ' 毫秒' : (abs / 1000).toFixed(1) + ' 秒'
  return n < 0 ? '提前 ' + text : '晚 ' + text
}

/**
 * 通知自检：把「为什么收不到 / 为什么晚」变成看得见的四项状态。
 * 这四项任一为否，都会导致到点不响或晚响——也是最常见的四个坑。
 */
function selfCheckBlock() {
  if (!hasAlarms()) {
    return h('p', { class: 'hint-line', text: '当前环境不支持系统闹钟（浏览器预览），提醒仅在本页可见。' })
  }
  const st = alarmState()
  if (!st) {
    return h('p', { class: 'hint-line', text: '读不到通知状态，请升级到最新版本 App。' })
  }

  const rows = []
  const row = (name, ok, text, action) =>
    h('div', { class: 'check-row' }, [
      h('span', { class: 'check-dot', 'data-ok': ok ? '1' : '0' }),
      h('span', { class: 'check-name', text: name }),
      h('span', { class: 'check-val' + (ok ? '' : ' bad'), text }),
      action || h('span', {}),
    ])

  rows.push(
    row(
      '通知权限',
      st.notify,
      st.notify ? '已开启' : '未开启，收不到任何通知',
      st.notify
        ? null
        : h('button', {
            class: 'mini',
            type: 'button',
            text: '去开启',
            onclick: () => {
              if (!requestNotifyPermission()) openNotificationSettings()
            },
          })
    )
  )
  rows.push(
    row(
      '精确闹钟',
      st.exact,
      st.exact ? '已允许，到点即响' : '未允许，可能晚几分钟到十几分钟',
      st.exact
        ? null
        : h('button', { class: 'mini', type: 'button', text: '去允许', onclick: () => openExactAlarmSettings() })
    )
  )
  rows.push(
    row(
      '提醒渠道',
      st.channel,
      st.channel ? '正常' : '被静音，通知不会弹出',
      st.channel ? null : h('button', { class: 'mini', type: 'button', text: '去设置', onclick: () => openNotificationSettings() })
    )
  )
  rows.push(
    row(
      '已排提醒',
      st.armed > 0,
      st.armed > 0 ? st.armed + ' 条 · 下一条 ' + fmtDue(st.next) : '暂无（没有未来的提醒时间）',
      null
    )
  )
  if (st.lastFire) {
    rows.push(
      row('上次提醒', true, fmtDue(st.lastFire) + ' · 延迟 ' + fmtDelay(st.lastDelay), null)
    )
  }

  return h('div', { class: 'self-check' }, [
    h('div', { class: 'field-label', text: '通知自检' }),
    ...rows,
    h('div', { class: 'check-actions' }, [
      h('button', {
        class: 'btn',
        type: 'button',
        text: '10 秒后测试提醒',
        onclick: () => {
          if (!testAlarm(10)) {
            toast('测试提醒下发失败')
            return
          }
          toast('已排定：10 秒后提醒（可锁屏或退出 App 观察）')
          // 12 秒后回到本页刷新一行「上次提醒 · 延迟」，这就是实测延迟
          setTimeout(() => {
            if (rootEl && rootEl.isConnected) render()
          }, 12000)
        },
      }),
    ]),
    h('p', {
      class: 'hint-line',
      text: '测试走的是和真实提醒完全相同的通路（系统闹钟 → 通知），可锁屏、可退出 App 后观察；回来这一行会显示实测延迟。',
    }),
    h('p', {
      class: 'hint-line',
      text: '国产 ROM（MIUI / HyperOS / EMUI / ColorOS）还需在系统设置里允许「自启动」与「后台运行」，否则锁屏后提醒会被系统拦截。',
    }),
  ])
}

function keepAliveCard() {
  const on = S.meta.keepAlive === '1'
  return h('div', { class: 'card' }, [
    h('h2', { text: '后台运行' }),
    h('div', { class: 'switch-row' }, [
      h('div', { class: 'switch-meta' }, [
        h('div', { class: 'switch-title', text: '后台保活' }),
        h('div', { class: 'switch-sub', text: '以低优先级前台服务保持后台运行，及时接收提醒与同步；通知栏会常驻一条提示' }),
      ]),
      h('label', { class: 'toggle' }, [
        h('input', {
          type: 'checkbox',
          checked: on,
          onchange: async (e) => {
            const v = e.target.checked ? '1' : '0'
            await saveMeta('keepAlive', v)
            const A = window.Android
            if (A) {
              try {
                if (e.target.checked) A.startKeepAlive()
                else A.stopKeepAlive()
              } catch (err) {
                /* 老桥没有保活方法，忽略 */
              }
            }
            toast(e.target.checked ? '已开启后台保活' : '已关闭后台保活')
          },
        }),
        h('span', { class: 'knob' }),
      ]),
    ]),
  ])
}

function aboutCard() {
  return h('div', { class: 'card' }, [
    h('h2', { text: '关于' }),
    h('p', { class: 'muted', text: '版本 ' + APP_VER + ' · 数据存在手机本地，断网可用；联网后与电脑双向合并。' }),
    h('p', { class: 'muted', text: '同步只走局域网直连，不经过云端。AI 请求由电脑转发到你配置的模型服务。' }),
  ])
}

function unpairCard() {
  return h('div', { class: 'card' }, [
    h('h2', { text: '解除配对' }),
    h('p', { class: 'muted', text: '清除本机令牌；待办笔记等数据仍保留在手机上。' }),
    h('button', {
      class: 'btn danger block',
      type: 'button',
      text: '解除配对',
      onclick: async () => {
        if (!(await confirmAsync('解除后需要重新输入配对码，确定？'))) return
        await saveMeta('token', '')
        await saveMeta('host', '')
        toast('已解除配对')
        render()
      },
    }),
  ])
}

async function doSync() {
  toast('同步中…')
  await syncNow('manual')
  toast(S.status === 'online' ? '已同步' : '同步未完成：' + S.statusText)
}

async function resync() {
  if (!(await confirmAsync('将从电脑重新拉取全部数据，本地未上传的改动会保留。继续？'))) return
  const { pullSnapshot } = await import('../lib/core.js')
  try {
    await pullSnapshot()
    await syncNow('resync')
    toast('已全量同步')
  } catch (e) {
    toast('失败：' + (e.message || e))
  }
  render()
}

// ---------------------------------------------------------------- 扫码

async function openScan() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast('这台设备不支持扫码，请手动输入地址')
    return
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
    scan.stream = stream
    const v = document.getElementById('scan-video')
    v.srcObject = stream
    await v.play()
    document.getElementById('scan').hidden = false
    document.getElementById('btn-scan-close').onclick = closeScan
    loopScan()
  } catch (e) {
    toast('打不开相机，请手动输入地址')
  }
}

function closeScan() {
  cancelAnimationFrame(scan.raf)
  if (scan.stream) scan.stream.getTracks().forEach((t) => t.stop())
  scan.stream = null
  const el = document.getElementById('scan')
  if (el) el.hidden = true
}

function loopScan() {
  const v = document.getElementById('scan-video')
  if (!scan.stream || !v) return
  if (v.readyState === v.HAVE_ENOUGH_DATA && window.jsQR) {
    const c = document.createElement('canvas')
    c.width = v.videoWidth
    c.height = v.videoHeight
    const ctx = c.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(v, 0, 0, c.width, c.height)
    const img = ctx.getImageData(0, 0, c.width, c.height)
    const found = window.jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' })
    if (found && found.data) {
      const parsed = parsePairPayload(found.data)
      if (parsed) {
        closeScan()
        const hostInput = document.querySelector('#pair-card input[inputmode="url"]')
        const codeInput = document.querySelector('#pair-card input[inputmode="numeric"]')
        pendingHosts = parsed.hosts
        if (hostInput) hostInput.value = pendingHosts[0] || ''
        if (codeInput) codeInput.value = parsed.code
        toast(pendingHosts.length > 1 ? '已识别 ' + pendingHosts.length + ' 个地址，会逐个尝试' : '已识别，点「配对并同步」')
        return
      }
    }
  }
  scan.raf = requestAnimationFrame(loopScan)
}
