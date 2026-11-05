/* x-hub 平台（云端账号 / 邀请码 / 开发者 / 平台 AI 额度）客户端。

   服务端 https://x-hub.xfactor.top 已放开 CORS（access-control-allow-origin: *，预检也通过），
   WebView 里可以直接 fetch，无需原生桥。

   ⚠️ 与局域网同步无关：账号 token 存 meta.ptToken，别和电脑配对 token（meta.token）混淆。 */

import { S, saveMeta } from './core.js'

export const PLATFORM_URL = 'https://x-hub.xfactor.top'

/** 内置供应商预设（离线兜底；登录后可用平台可配清单覆盖）—— 与 x-hub 桌面端 PRESET_FALLBACK 逐项对齐 */
export const PRESET_FALLBACK = [
  { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', keyGuideUrl: 'https://platform.deepseek.com/api_keys', note: '深度求索官方 API，性价比高' },
  { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', keyGuideUrl: 'https://platform.openai.com/api-keys', note: '' },
  { name: 'Moonshot 月之暗面', baseUrl: 'https://api.moonshot.cn/v1', keyGuideUrl: 'https://platform.moonshot.cn/console/api-keys', note: '' },
  { name: '阿里云百炼', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', keyGuideUrl: 'https://bailian.console.aliyun.com/?apiKey=1', note: '通义千问系列，国内直连' },
  // localhost 指「跑 Ollama 的那台机器」：自备 Key 模式请求经电脑中转，所以这里就是电脑本机
  { name: 'Ollama（本机）', baseUrl: 'http://localhost:11434/v1', keyGuideUrl: '', note: '本机模型，无需 API Key' },
]

export function ptToken() {
  return S.meta.ptToken || ''
}

export function isPlatformLogin() {
  return !!S.meta.ptToken
}

export async function setPtToken(t) {
  await saveMeta('ptToken', t || '')
}

/** 统一请求。服务端错误体形如 {error, message}；非 2xx 抛带 code 的 Error。 */
export async function platformFetch(path, opts = {}) {
  const headers = {}
  if (opts.body) headers['Content-Type'] = 'application/json'
  if (opts.token) headers['Authorization'] = 'Bearer ' + opts.token

  let resp
  try {
    resp = await fetch(PLATFORM_URL + path, {
      method: opts.method || 'GET',
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    })
  } catch (e) {
    const err = new Error('连不上 x-hub 平台服务器')
    err.code = 'NETWORK_ERROR'
    throw err
  }

  let data = null
  try {
    data = await resp.json()
  } catch (e) {
    data = null
  }
  if (!resp.ok) {
    const err = new Error((data && (data.message || data.error)) || 'HTTP ' + resp.status)
    err.code = data && (data.error || data.code)
    err.status = resp.status
    throw err
  }
  return data
}

// ---------------- 账号 ----------------

/** 登录态 + 额度：GET /me（注意：账号状态在 /me，不在 /api/v1/me） */
export function accountStatus() {
  return platformFetch('/me', { token: ptToken() })
}

export function emailSend(email) {
  return platformFetch('/api/v1/auth/email/send', { method: 'POST', body: { email } })
}

export function emailVerify(email, code) {
  return platformFetch('/api/v1/auth/email/verify', { method: 'POST', body: { email, code } })
}

export function githubStart() {
  return platformFetch('/api/v1/auth/github/device/start', { method: 'POST', body: {} })
}

export function githubPoll(pollId) {
  return platformFetch('/api/v1/auth/github/device/poll', { method: 'POST', body: { poll_id: pollId } })
}

/** 兑换邀请码（兑换后才发额度、才可申请开发者） */
export function redeem(code) {
  return platformFetch('/api/v1/me/redeem', { method: 'POST', token: ptToken(), body: { code } })
}

export function devApply(reason) {
  return platformFetch('/api/v1/dev/apply', { method: 'POST', token: ptToken(), body: { reason } })
}

export function devApplyStatus() {
  return platformFetch('/api/v1/dev/apply', { token: ptToken() })
}

export function listDevices() {
  return platformFetch('/api/v1/me/device-tokens', { token: ptToken() })
}

export function revokeDevice(id) {
  return platformFetch('/api/v1/me/device-tokens/' + id + '/revoke', { method: 'POST', token: ptToken(), body: {} })
}

// ---------------- 平台 AI ----------------

/** 平台可用模型名清单 */
export function platformModels() {
  return platformFetch('/api/v1/ai/models', { token: ptToken() })
}

/** 平台可配的供应商预设（登录后）；失败时调用方回落 PRESET_FALLBACK */
export function providerPresets() {
  return platformFetch('/api/v1/ai/provider-presets', { token: ptToken() })
}

// 外链走系统浏览器：实现收敛在 native.js，这里转出以保持既有引用
export { openExternal } from './native.js'
