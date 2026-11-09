/* 模型选择器：AI 助手顶部与课表 AI 识别共用的一个弹层。

   只做「选哪个」：列表分组（x-hub 内置 / 自备）、可用性标注、确认后写盘。
   不在弹层里编辑模型配置 —— 那属于 AI 助手的设置面板，避免两处表单各写一套。
   选择是全局的：确认后立即生效并持久化，AI 助手与课表识别下一次请求就用它。 */

import { h, toast } from './ui.js'
import { isPlatformLogin } from './platform.js'
import {
  availability,
  currentModel,
  loadProfiles,
  modelSubtitle,
  maybeSyncPlatformModels,
  selectModel,
  syncPlatformModels,
} from './aimodels.js'

/**
 * @param {object} opt
 * @param {string} [opt.title]      标题
 * @param {string} [opt.hint]       说明文案
 * @param {Function} [opt.onPick]   确认后回调（profile）
 * @param {Function} [opt.onCancel] 取消 / 关闭 / 去登录 / 去管理时回调
 * @param {Function} [opt.onManage] 「管理模型」入口；不传则跳到 AI 助手页
 */
export function openModelPicker(opt) {
  const o = opt || {}
  const mask = h('div', { class: 'lib-mask' })
  const card = h('div', { class: 'lib-card mdl-card' })
  mask.appendChild(card)
  document.body.appendChild(mask)

  let pendingId = ''
  let busy = false
  let settled = false
  let refreshMsg = ''

  function close(cancelled) {
    if (settled) return
    settled = true
    mask.remove()
    if (cancelled && o.onCancel) o.onCancel()
  }

  mask.addEventListener('click', (e) => {
    if (e.target === mask) close(true)
  })

  function goManage() {
    close(true)
    if (o.onManage) o.onManage()
    else location.hash = '#/ai'
  }

  function goLogin() {
    close(true)
    location.hash = '#/account'
  }

  function row(p, loggedIn) {
    const a = availability(p, { loggedIn })
    const on = p.id === pendingId
    return h(
      'button',
      {
        class: 'mdl-row' + (on ? ' on' : '') + (a.ok ? '' : ' off'),
        type: 'button',
        'data-id': p.id,
        'aria-pressed': on ? 'true' : 'false',
        onclick: () => {
          pendingId = p.id
          draw()
        },
      },
      [
        h('span', { class: 'mdl-dot' }),
        h('span', { class: 'mdl-main' }, [
          h('span', { class: 'mdl-t' }, [
            h('b', { text: p.label }),
            on ? h('i', { class: 'mdl-badge', text: '已选' }) : null,
            a.ok ? null : h('i', { class: 'mdl-bad', text: a.text }),
          ]),
          h('span', { class: 'mdl-s', text: modelSubtitle(p) }),
        ]),
      ]
    )
  }

  function section(title, action) {
    return h('div', { class: 'mdl-sect' }, [h('b', { text: title }), action || null])
  }

  function draw() {
    const profiles = loadProfiles()
    const cur = currentModel()
    const loggedIn = isPlatformLogin()
    if (!pendingId || !profiles.some((p) => p.id === pendingId)) {
      pendingId = (cur.profile && cur.profile.id) || (profiles[0] && profiles[0].id) || ''
    }
    const pending = profiles.filter((p) => p.id === pendingId)[0] || null
    const pa = availability(pending, { loggedIn })

    card.innerHTML = ''
    card.appendChild(
      h('div', { class: 'lib-head' }, [
        h('b', { text: o.title || '选择模型' }),
        h('button', { class: 'mini', type: 'button', text: '取消', onclick: () => close(true) }),
      ])
    )
    card.appendChild(
      h('p', {
        class: 'lib-hint',
        text: o.hint || '确认后立即生效：AI 助手与课表 AI 识别都用这个模型，并记住到下次切换。',
      })
    )

    if (cur.fallbackFrom) {
      card.appendChild(h('p', { class: 'mdl-banner', text: '原模型已不可用：' + cur.text }))
    } else if (!profiles.length) {
      card.appendChild(h('p', { class: 'mdl-banner', text: '还没有可用模型。先添加一个自备模型，或登录 x-hub 账号使用内置模型。' }))
    }

    // ---------- x-hub 内置 ----------
    const pl = profiles.filter((p) => p.kind === 'platform')
    card.appendChild(
      section(
        'x-hub 内置模型',
        loggedIn
          ? h('button', {
              class: 'mini',
              type: 'button',
              text: busy ? '刷新中…' : '刷新',
              disabled: busy,
              onclick: () => refresh(false),
            })
          : null
      )
    )

    if (!loggedIn) {
      card.appendChild(
        h('div', { class: 'mdl-lock' }, [
          h('div', { class: 'mdl-main' }, [
            h('span', { class: 'mdl-t' }, [h('b', { text: 'x-hub 内置模型' })]),
            h('span', { class: 'mdl-s', text: '登录账号后自动获取，走平台额度，无需填 Key' }),
          ]),
          h('button', { class: 'btn', type: 'button', text: '去登录', onclick: goLogin }),
        ])
      )
    } else if (!pl.length) {
      card.appendChild(
        h('p', { class: 'mdl-empty', text: busy ? '正在获取平台模型…' : refreshMsg || '还没有获取到平台模型' })
      )
    } else {
      const list = h('div', { class: 'mdl-list' })
      pl.forEach((p) => list.appendChild(row(p, loggedIn)))
      card.appendChild(list)
    }

    // ---------- 自备 ----------
    const cu = profiles.filter((p) => p.kind === 'custom')
    card.appendChild(
      section(
        '自备模型',
        h('button', { class: 'mini', type: 'button', text: '管理', onclick: goManage })
      )
    )
    if (!cu.length) {
      card.appendChild(h('p', { class: 'mdl-empty', text: '还没有自备模型。可以接入 DeepSeek、OpenAI、百炼等任意 OpenAI 兼容接口。' }))
    } else {
      const list = h('div', { class: 'mdl-list' })
      cu.forEach((p) => list.appendChild(row(p, loggedIn)))
      card.appendChild(list)
    }

    // ---------- 确认 ----------
    card.appendChild(
      h('p', {
        class: 'mdl-tip' + (pa.ok ? '' : ' bad'),
        text: pa.ok
          ? '当前选择：' + (pending ? pending.label : '') + '（' + pa.text + '）'
          : '这个模型暂时不可用：' + pa.text,
      })
    )
    card.appendChild(
      h('div', { class: 'mdl-actions' }, [
        h('button', { class: 'btn', type: 'button', text: '取消', onclick: () => close(true) }),
        h('button', {
          class: 'btn primary',
          type: 'button',
          id: 'mdl-ok',
          text: busy ? '处理中…' : '使用这个模型',
          disabled: busy || !pa.ok,
          onclick: confirm,
        }),
      ])
    )
  }

  async function confirm() {
    if (busy) return
    const profiles = loadProfiles()
    const p = profiles.filter((x) => x.id === pendingId)[0]
    if (!p) return
    if (!availability(p, { loggedIn: isPlatformLogin() }).ok) return
    busy = true
    draw()
    try {
      await selectModel(p.id)
      settled = true
      mask.remove()
      toast('已切换到「' + p.label + '」')
      if (o.onPick) o.onPick(p)
    } catch (e) {
      busy = false
      draw()
      toast('切换失败：' + ((e && e.message) || e))
    }
  }

  async function refresh(soft) {
    if (busy) return
    busy = true
    refreshMsg = ''
    draw()
    const r = soft ? await maybeSyncPlatformModels(false) : await syncPlatformModels()
    busy = false
    if (!r.ok && !r.skipped) {
      refreshMsg =
        r.code === 'no-login'
          ? '需要先登录账号'
          : r.code === 'empty'
          ? '平台暂未返回模型，稍后再试'
          : '获取失败，检查网络后重试'
    }
    draw()
  }

  draw()
  // 登录状态下静默对账一次（6 小时内同步过会直接跳过），
  // 服务端下架的模型在这里就会消失，不用等用户选中后撞 400。
  if (isPlatformLogin()) refresh(true)
}
