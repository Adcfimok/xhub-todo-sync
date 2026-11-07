/* 原生能力封装：出站 HTTP（绕 CORS）、系统通知、剪贴板、打开外部浏览器。
   浏览器预览时逐项降级，保证同一份代码能跑。 */

export function hasBridge() {
  return !!(window.Android && typeof window.Android === 'object')
}

function bridgeFn(name) {
  if (!hasBridge()) return null
  const f = window.Android[name]
  return typeof f === 'function' ? f.bind(window.Android) : null
}

// ---------------------------------------------------------------- 出站 HTTP

const PENDING = new Map()
let seq = 0

function abortError() {
  const e = new Error('已停止')
  e.name = 'AbortError'
  return e
}

/** 把上游错误的三种形状都压成一句话：{error:{message}} / {error:"..."} / {message:"..."} */
function toHttpError(code, body) {
  let msg = String(body || '').slice(0, 300) || 'HTTP ' + code
  try {
    const j = JSON.parse(body)
    const m = j.message || (j.error && (j.error.message || j.error)) || j.code
    if (typeof m === 'string' && m) msg = m
    else if (m) msg = JSON.stringify(m)
  } catch (e) {
    /* 非 JSON 就原样 */
  }
  if (code === 401) msg = 'Key 无效或已过期（401）'
  if (code === 404) msg = '接口地址不对（404），检查 baseURL 是否带 /v1'
  const err = new Error(msg)
  err.status = code
  return err
}

function installHooks() {
  if (window.__httpHooked) return
  window.__httpHooked = true
  window.__httpChunk = function (id, text) {
    const e = PENDING.get(id)
    if (!e || !e.onChunk) return
    try {
      e.onChunk(text)
    } catch (err) {
      /* 渲染出错不该中断取流 */
    }
  }
  window.__httpDone = function (id) {
    const e = PENDING.get(id)
    if (!e) return
    PENDING.delete(id)
    e.resolve()
  }
  window.__httpError = function (id, code, body) {
    const e = PENDING.get(id)
    if (!e) return
    PENDING.delete(id)
    e.reject(toHttpError(code, body))
  }

  /**
   * 原生回调的统一入口：Java 侧只传「事件名 + 一个 JSON 字符串」，
   * 由这里解析后再分发。多参数直接拼进 JS 源码容易构造出越界语法，
   * 收敛成单入口后，注入面只剩「一个引号包裹的字符串」。
   */
  window.__nativeEmit = function (fn, json) {
    let p = {}
    try {
      p = JSON.parse(json || '{}')
    } catch (err) {
      return
    }
    if (fn === 'chunk') window.__httpChunk(p.id, p.text)
    else if (fn === 'done') window.__httpDone(p.id)
    else if (fn === 'error') window.__httpError(p.id, p.code || 0, p.body || '')
  }
}

/**
 * 流式 HTTP 请求。
 * 有原生桥走原生（不受 CORS 限制，AI 才能脱离电脑）；
 * 浏览器预览退化为 fetch + ReadableStream。
 *
 * @param {{method?:string, url:string, headers?:object, body?:string, onChunk?:(t:string)=>void, signal?:AbortSignal}} opt
 */
export function streamHttp(opt) {
  const method = opt.method || 'POST'
  const headers = opt.headers || {}
  const body = opt.body || ''
  installHooks()

  if (!bridgeFn('httpStream')) return fetchStream(opt)

  return new Promise((resolve, reject) => {
    const id = 'r' + ++seq + Math.random().toString(36).slice(2, 6)
    PENDING.set(id, { onChunk: opt.onChunk, resolve, reject })

    if (opt.signal) {
      if (opt.signal.aborted) {
        PENDING.delete(id)
        reject(abortError())
        return
      }
      opt.signal.addEventListener('abort', () => {
        if (!PENDING.has(id)) return
        PENDING.delete(id)
        const abort = bridgeFn('httpAbort')
        if (abort) {
          try {
            abort(id)
          } catch (e) {
            /* 连接可能已结束 */
          }
        }
        reject(abortError())
      })
    }

    try {
      window.Android.httpStream(id, method, opt.url, JSON.stringify(headers), body)
    } catch (e) {
      PENDING.delete(id)
      reject(e)
    }
  })
}

/** 一次性取回完整响应体（测试连通、获取模型这类非流式请求用） */
export function requestText(opt) {
  let acc = ''
  const merged = Object.assign({}, opt, {
    onChunk: (t) => {
      acc += t
      if (opt.onChunk) opt.onChunk(t)
    },
  })
  return streamHttp(merged).then(() => acc)
}

function fetchStream(opt) {
  const ctrl = new AbortController()
  if (opt.signal) opt.signal.addEventListener('abort', () => ctrl.abort())
  const headers = Object.assign({}, opt.headers || {})
  if (opt.body) headers['Content-Type'] = headers['Content-Type'] || 'application/json'

  return fetch(opt.url, {
    method: opt.method || 'POST',
    headers,
    body: opt.body || undefined,
    signal: ctrl.signal,
  }).then((res) => {
    if (!res.ok) {
      return res.text().then((t) => {
        throw toHttpError(res.status, t)
      })
    }
    if (!res.body || !res.body.getReader) {
      return res.text().then((t) => {
        if (opt.onChunk && t) opt.onChunk(t)
      })
    }
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    const pump = () =>
      reader.read().then(({ done, value }) => {
        if (done) return
        const text = dec.decode(value, { stream: true })
        if (opt.onChunk) opt.onChunk(text)
        return pump()
      })
    return pump()
  })
}

// ---------------------------------------------------------------- 通知

/** 系统通知；浏览器预览退化为 Web Notification */
export function notify(title, body) {
  const fn = bridgeFn('notify')
  if (fn) {
    try {
      fn(title, body)
      return true
    } catch (e) {
      return false
    }
  }
  if (window.Notification) {
    if (Notification.permission === 'granted') {
      new Notification(title, { body })
      return true
    }
    if (Notification.permission !== 'denied') {
      Notification.requestPermission().then((p) => {
        if (p === 'granted') new Notification(title, { body })
      })
    }
  }
  return false
}

export function vibrate(ms) {
  const fn = bridgeFn('vibrate')
  if (fn) {
    try {
      fn(ms || 40)
      return
    } catch (e) {
      /* 无振动器 */
    }
  }
  if (navigator.vibrate) navigator.vibrate(ms || 40)
}

// ---------------------------------------------------------------- 剪贴板

export function readClipboard() {
  const fn = bridgeFn('readClipboard')
  if (fn) {
    try {
      return String(fn() || '')
    } catch (e) {
      return ''
    }
  }
  return ''
}

export function writeClipboard(text) {
  const s = String(text == null ? '' : text)
  const fn = bridgeFn('writeClipboard')
  if (fn) {
    try {
      fn(s)
      return Promise.resolve()
    } catch (e) {
      /* 落到 navigator */
    }
  }
  if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(s)
  return Promise.reject(new Error('这台设备不支持写剪贴板'))
}

// ---------------------------------------------------------------- 外部浏览器

export function openExternal(url) {
  if (!url) return Promise.reject(new Error('EMPTY_URL'))
  const fn = bridgeFn('openUrl')
  if (fn) {
    try {
      fn(url)
      return Promise.resolve()
    } catch (e) {
      return Promise.reject(e)
    }
  }
  const w = window.open(url, '_blank', 'noopener')
  return w ? Promise.resolve() : Promise.reject(new Error('BLOCKED'))
}
