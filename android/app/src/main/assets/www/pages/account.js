import { S } from '../lib/core.js'
import { h, toast, confirmAsync, openForm, fmtAgo } from '../lib/ui.js'
import {
  isPlatformLogin, setPtToken, accountStatus, emailSend, emailVerify, githubStart, githubPoll,
  redeem, devApply, devApplyStatus, listDevices, revokeDevice,
} from '../lib/platform.js'

export const meta = { title: '账号与邀请码', route: 'account' }

let rootEl = null
let ACCT = null
let devices = []
let gh = null
let ghTimer = null

const DEV_STATUS = { none: '未申请', pending: '审核中', approved: '已通过', rejected: '已驳回' }

export function mount(root) {
  rootEl = root
  render()
  if (isPlatformLogin()) loadStatus()
  return () => stopGh()
}

function stopGh() {
  if (ghTimer) clearInterval(ghTimer)
  ghTimer = null
}

async function loadStatus() {
  try {
    ACCT = await accountStatus()
  } catch (e) {
    if (e.status === 401) {
      await setPtToken('')
      ACCT = null
    } else {
      ACCT = { _err: e.message }
    }
  }
  render()
}

async function refreshDevices() {
  try {
    const r = await listDevices()
    devices = r.devices || []
  } catch (e) {
    toast('拉取设备失败：' + (e.message || e))
  }
  render()
}

function render() {
  if (!rootEl) return
  rootEl.innerHTML = ''
  const scroll = h('div', { class: 'scroll' })
  rootEl.appendChild(scroll)

  if (isPlatformLogin()) {
    scroll.appendChild(profileCard())
    scroll.appendChild(redeemCard())
    scroll.appendChild(devCard())
    scroll.appendChild(devicesCard())
    scroll.appendChild(logoutCard())
  } else {
    scroll.appendChild(loginCard())
  }
  scroll.appendChild(h('div', { class: 'list-pad' }))
}

// ---------------------------------------------------------------- 登录

function loginCard() {
  const card = h('div', { class: 'card' }, [h('h2', { text: '登录 x-hub 账号' })])
  card.appendChild(h('p', { class: 'muted', text: '登录后可兑换邀请码、领取平台免费 AI 额度、申请开发者。账号是云端服务，与局域网同步无关。' }))
  card.appendChild(emailLogin())
  card.appendChild(h('div', { class: 'divider', text: '或' }))
  card.appendChild(githubLogin())
  return card
}

function emailLogin() {
  const wrap = h('div', { class: 'login-box' })
  let step = 'email' // email -> code
  let email = ''
  const emailInput = h('input', { class: 'input', type: 'email', inputmode: 'email', placeholder: '你的邮箱' })
  const codeInput = h('input', { class: 'input', type: 'text', inputmode: 'numeric', maxlength: 6, placeholder: '6 位验证码' })
  const err = h('p', { class: 'err', hidden: true })
  const btn = h('button', { class: 'btn primary block', type: 'button', text: '发送验证码' })

  codeInput.style.display = 'none'

  function showErr(t) {
    err.textContent = t
    err.hidden = false
  }
  function clearErr() {
    err.hidden = true
  }

  btn.onclick = async () => {
    clearErr()
    if (step === 'email') {
      email = String(emailInput.value || '').trim()
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return showErr('请填写正确的邮箱')
      btn.disabled = true
      btn.textContent = '发送中…'
      try {
        await emailSend(email)
        step = 'code'
        emailInput.style.display = 'none'
        codeInput.style.display = ''
        btn.textContent = '登录'
        toast('验证码已发送')
      } catch (e) {
        showErr(emailErrorText(e))
      } finally {
        btn.disabled = false
      }
    } else {
      const code = String(codeInput.value || '').replace(/\D/g, '')
      if (code.length !== 6) return showErr('验证码是 6 位数字')
      btn.disabled = true
      btn.textContent = '登录中…'
      try {
        const r = await emailVerify(email, code)
        await setPtToken(r.token || '')
        ACCT = null
        await loadStatus()
      } catch (e) {
        showErr(authErrorText(e))
        btn.disabled = false
        btn.textContent = '登录'
      }
    }
  }

  wrap.appendChild(h('div', { class: 'login-title', text: '邮箱验证码登录' }))
  wrap.appendChild(emailInput)
  wrap.appendChild(codeInput)
  wrap.appendChild(btn)
  wrap.appendChild(err)
  return wrap
}

function githubLogin() {
  const wrap = h('div', { class: 'login-box' })
  const btn = h('button', { class: 'btn block', type: 'button', text: '用 GitHub 登录' })
  const area = h('div', { class: 'gh-area' })

  btn.onclick = async () => {
    btn.disabled = true
    btn.textContent = '发起中…'
    try {
      gh = await githubStart()
      renderGh(area)
      startPolling(area)
    } catch (e) {
      area.innerHTML = ''
      area.appendChild(h('p', { class: 'err', text: authErrorText(e) }))
      btn.disabled = false
      btn.textContent = '用 GitHub 登录'
    }
  }

  function renderGh(area) {
    area.innerHTML = ''
    const code = h('div', { class: 'gh-code', text: gh.user_code || '' })
    const link = h('a', {
      class: 'gh-link',
      href: gh.verification_uri || '',
      target: '_blank',
      text: gh.verification_uri || '',
    })
    area.appendChild(h('p', { class: 'muted', text: '在浏览器打开下面的地址，输入这段代码完成授权：' }))
    area.appendChild(code)
    area.appendChild(link)
    area.appendChild(h('p', { class: 'hint-line', id: 'gh-status', text: '等待授权…' }))
  }

  function startPolling(area) {
    stopGh()
    ghTimer = setInterval(async () => {
      try {
        const r = await githubPoll(gh.poll_id)
        if (r.status === 'ok') {
          stopGh()
          await setPtToken(r.token || '')
          ACCT = null
          await loadStatus()
          return
        }
        if (r.status === 'error') {
          stopGh()
          const st = area.querySelector('#gh-status')
          if (st) st.textContent = '授权失败：' + (r.message || '已取消或超时')
          btn.disabled = false
          btn.textContent = '用 GitHub 登录'
        }
      } catch (e) {
        stopGh()
        const st = area.querySelector('#gh-status')
        if (st) st.textContent = '轮询出错：' + (e.message || e)
        btn.disabled = false
        btn.textContent = '用 GitHub 登录'
      }
    }, Math.max(3, gh.interval || 5) * 1000)
  }

  wrap.appendChild(h('div', { class: 'login-title', text: 'GitHub 登录' }))
  wrap.appendChild(btn)
  wrap.appendChild(area)
  return wrap
}

// ---------------------------------------------------------------- 已登录

function profileCard() {
  const a = ACCT
  if (a && a._err) {
    return h('div', { class: 'card' }, [
      h('h2', { text: '账号' }),
      h('p', { class: 'muted', text: '已登录，但拉取信息失败：' + a._err }),
      h('button', { class: 'btn block', type: 'button', text: '重试', onclick: loadStatus }),
    ])
  }
  if (!a) {
    return h('div', { class: 'card' }, [
      h('h2', { text: '账号' }),
      h('p', { class: 'muted', text: '正在加载…' }),
    ])
  }

  const quota = a.quota || {}
  const credits = a.credits || {}
  const role = a.role === 'developer' ? '开发者' : a.role === 'admin' ? '管理员' : '普通用户'

  return h('div', { class: 'card' }, [
    h('div', { class: 'status-head' }, [
      h('span', { class: 'big-dot', 'data-state': 'online' }),
      h('div', { class: 'status-meta' }, [
        h('div', { class: 'status-title', text: a.username || '（未命名）' }),
        h('div', { class: 'status-sub', text: role + ' · ' + (a.invite_redeemed ? '已兑换邀请码' : '未兑换邀请码') }),
      ]),
    ]),
    h('div', { class: 'kv' }, [
      h('div', null, [h('span', { text: '额度' }), h('b', { text: (quota.remaining || 0) + ' / ' + (quota.total || 0) })]),
      h('div', null, [h('span', { text: '积分' }), h('b', { text: (credits.remaining || 0) + ' / ' + (credits.total || 0) })]),
      h('div', null, [h('span', { text: '开发者' }), h('b', { text: DEV_STATUS[a.developer_status] || a.developer_status || '—' })]),
    ]),
  ])
}

function redeemCard() {
  const input = h('input', { class: 'input', type: 'text', placeholder: '输入邀请码' })
  const err = h('p', { class: 'err', hidden: true })
  const btn = h('button', { class: 'btn primary block', type: 'button', text: '兑换' })

  btn.onclick = async () => {
    const code = String(input.value || '').trim()
    if (!code) {
      err.textContent = '请输入邀请码'
      err.hidden = false
      return
    }
    err.hidden = true
    btn.disabled = true
    btn.textContent = '兑换中…'
    try {
      await redeem(code)
      toast('兑换成功')
      await loadStatus()
    } catch (e) {
      err.textContent = redeemErrorText(e)
      err.hidden = false
    } finally {
      btn.disabled = false
      btn.textContent = '兑换'
    }
  }

  return h('div', { class: 'card' }, [
    h('h2', { text: '兑换邀请码' }),
    h('p', { class: 'muted', text: '账号与权益分离：兑换后才发放额度、才可申请开发者。' }),
    input,
    btn,
    err,
  ])
}

function devCard() {
  const card = h('div', { class: 'card' }, [h('h2', { text: '开发者申请' })])

  if (ACCT && ACCT._err) return card

  const status = ACCT ? ACCT.developer_status : 'none'
  if (status === 'approved') {
    card.appendChild(h('p', { class: 'muted', text: '你已是开发者，可以在电脑端发布扩展。' }))
    return card
  }

  const applyBtn = h('button', {
    class: 'btn primary block',
    type: 'button',
    text: status === 'pending' ? '重新提交申请' : '申请成为开发者',
    onclick: () => openApply(),
  })
  card.appendChild(
    h('p', { class: 'muted', text: status === 'pending' ? '你的申请正在审核中，可重新提交。' : '开发者可在 x-hub 扩展市场发布扩展。' })
  )
  card.appendChild(applyBtn)

  function openApply() {
    openForm({
      title: '开发者申请',
      fields: [{ key: 'reason', label: '申请理由', type: 'textarea', rows: 4, maxlength: 500, placeholder: '简单说明你想发布什么扩展' }],
      values: { reason: '' },
      async onSave(v) {
        const reason = String(v.reason || '').trim()
        if (!reason) return toast('请填写申请理由')
        try {
          await devApply(reason)
          toast('已提交')
          await loadStatus()
        } catch (e) {
          toast('提交失败：' + (e.message || e))
        }
      },
    })
  }

  return card
}

function devicesCard() {
  const card = h('div', { class: 'card' }, [h('h2', { text: '我的设备' })])
  card.appendChild(h('p', { class: 'muted', text: '同一账号多台设备同时在线；设备丢失时可单独撤销。' }))
  const load = h('button', { class: 'btn block', type: 'button', text: '加载设备', onclick: refreshDevices })
  card.appendChild(load)

  if (devices.length) {
    const list = h('div', { class: 'device-list' })
    devices.forEach((d) => {
      const item = h('div', { class: 'device-item' }, [
        h('span', { class: 'device-name' }, [
          h('span', { text: d.label || '未命名设备' }),
          d.current ? h('b', { class: 'self', text: '本机' }) : null,
        ]),
        h('span', { class: 'device-meta', text: d.last_seen_at ? '最近使用 ' + fmtAgo(d.last_seen_at) : '' }),
        d.current
          ? h('span', { class: 'device-meta', text: '下线请用「退出登录」' })
          : h('button', {
              class: 'mini',
              type: 'button',
              text: '撤销',
              onclick: async () => {
                if (!(await confirmAsync('撤销这台设备后，它需要重新登录才能使用。确定？'))) return
                try {
                  await revokeDevice(d.id)
                  toast('已撤销')
                  await refreshDevices()
                } catch (e) {
                  toast('撤销失败：' + (e.message || e))
                }
              },
            }),
      ])
      list.appendChild(item)
    })
    card.appendChild(list)
  }
  return card
}

function logoutCard() {
  return h('div', { class: 'card' }, [
    h('h2', { text: '退出登录' }),
    h('p', { class: 'muted', text: '清除本机账号凭据；已兑换的额度与权益保留在账号里。' }),
    h('button', {
      class: 'btn danger block',
      type: 'button',
      text: '退出登录',
      onclick: async () => {
        if (!(await confirmAsync('退出后 AI 平台额度将不可用，需要重新登录。确定？'))) return
        await setPtToken('')
        ACCT = null
        devices = []
        render()
      },
    }),
  ])
}

// ---------------------------------------------------------------- 错误文案

function authErrorText(e) {
  const c = e.code
  if (c === 'NETWORK_ERROR') return '连不上 x-hub 平台服务器，请检查网络'
  if (c === 'UNAUTHORIZED') return '登录已失效，请重新登录'
  if (c === 'GITHUB_UNAVAILABLE') return '登录服务暂时连不上 GitHub，请稍后再试'
  return e.message || '操作失败'
}

function emailErrorText(e) {
  const c = e.code
  if (c === 'RATE_LIMITED') return '这个邮箱一小时内发得太多了（上限 5 封），请稍后再试'
  if (c === 'EMAIL_SEND_FAILED') return '邮件发送失败，请稍后再试'
  if (c === 'EMAIL_NOT_CONFIGURED') return '服务器尚未配置发信，暂时无法用邮箱登录'
  return authErrorText(e)
}

function redeemErrorText(e) {
  const c = e.code
  if (c === 'INVALID_CODE' || c === 'invalid') return '邀请码无效或已被使用'
  if (c === 'ALREADY_REDEEMED') return '这个账号已经兑换过邀请码'
  return authErrorText(e)
}
