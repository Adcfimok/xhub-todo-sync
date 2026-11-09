/* 模型目录：把「x-hub 平台内置模型」与「自备 OpenAI 兼容接口」统一成一份可选清单。

   3.7.0 之前只有一组标量 meta（aiPlatform / aiBase / aiKey / aiModel），
   换模型等于重填整套配置，也无法同时保留多个自备接口。现在改为：

     meta.aiModels   = JSON 字符串，[{id, kind, model, label, base?, key?, addedAt}]
     meta.aiSelected = 当前选择的 id（例如 pl:deepseek-chat / cu:xxx）
     meta.aiPlatformModels = 上次成功拉到的平台模型名（离线兜底）

   旧键继续双写：回滚到旧版 APK 仍能对话；新版首次启动会自动把旧配置迁成一条模型。
   meta 不同步到电脑（见 core.js），所以 API Key 与本次选择都只留在这台手机上。

   本文件上半部分是纯函数（显式传入 profiles / selectedId / opts），
   方便 node --test 直接跑；下半部分才碰 S.meta 与 IndexedDB。 */

import { S, applyMeta, saveMeta } from './core.js'
import { PLATFORM_URL, ptToken, platformModels } from './platform.js'

export const MODELS_KEY = 'aiModels'
export const SELECTED_KEY = 'aiSelected'
export const PLATFORM_CACHE_KEY = 'aiPlatformModels'
export const PLATFORM_SYNC_KEY = 'aiPlatformSyncAt'
/** 清单上限：再多也没人翻，反而把选择器撑爆 */
export const MAX_MODELS = 60
/** 平台清单的静默刷新间隔（服务端后台加减模型后本地快照不会自己变） */
export const PLATFORM_SYNC_TTL = 6 * 3600 * 1000

export const KIND_PLATFORM = 'platform'
export const KIND_CUSTOM = 'custom'

// ---------------------------------------------------------------- 纯函数

/**
 * 清洗任意来源的模型数组：丢掉缺 kind/model 的脏数据、按 id 去重、补齐 label。
 * 读盘 / 迁移 / 合并三处共用，保证内存里的形状永远一致。
 */
export function sanitizeProfiles(list) {
  const out = []
  const seen = new Set()
  ;(Array.isArray(list) ? list : []).forEach((raw) => {
    if (!raw || typeof raw !== 'object') return
    const kind = raw.kind === KIND_PLATFORM ? KIND_PLATFORM : raw.kind === KIND_CUSTOM ? KIND_CUSTOM : ''
    const model = String(raw.model || '').trim()
    if (!kind || !model) return
    const base = kind === KIND_CUSTOM ? String(raw.base || '').trim().replace(/\/+$/, '') : ''
    let id = String(raw.id || '').trim()
    if (!id) id = kind === KIND_PLATFORM ? 'pl:' + model : 'cu:' + model + '@' + base
    if (!id || seen.has(id)) return
    seen.add(id)
    const p = {
      id,
      kind,
      model,
      label: String(raw.label || '').trim() || model,
      addedAt: Number(raw.addedAt) || 0,
    }
    if (kind === KIND_CUSTOM) {
      p.base = base
      p.key = String(raw.key || '')
    }
    out.push(p)
  })
  return out.slice(0, MAX_MODELS)
}

/** 平台模型条目：id 用 pl: 前缀，服务端改名即视为另一条 */
export function platformProfile(name, now) {
  const model = String(name || '').trim()
  if (!model) return null
  return { id: 'pl:' + model, kind: KIND_PLATFORM, model, label: model, addedAt: Number(now) || Date.now() }
}

/** 自备模型条目；base 末尾的斜杠统一去掉，避免拼出 //chat/completions */
export function customProfile(input, now) {
  const model = String((input && input.model) || '').trim()
  if (!model) return null
  const stamp = Number(now) || Date.now()
  return {
    id: 'cu:' + stamp.toString(36) + Math.random().toString(36).slice(2, 6),
    kind: KIND_CUSTOM,
    model,
    label: String((input && input.label) || '').trim() || model,
    base: String((input && input.base) || '').trim().replace(/\/+$/, ''),
    key: String((input && input.key) || ''),
    addedAt: stamp,
  }
}

/**
 * 某个模型此刻能不能用。平台条目看登录态（Key 是账号 token，不落库），
 * 自备条目看地址 / 模型名 / Key 是否齐。
 */
export function availability(profile, opts) {
  const loggedIn = !!(opts && opts.loggedIn)
  if (!profile) return { ok: false, code: 'none', text: '还没有可用模型' }
  if (!profile.model) return { ok: false, code: 'no-model', text: '模型名为空' }
  if (profile.kind === KIND_PLATFORM) {
    if (!loggedIn) return { ok: false, code: 'no-login', text: '需要登录 x-hub 账号' }
    return { ok: true, code: 'ok', text: 'x-hub 平台额度' }
  }
  if (!profile.base) return { ok: false, code: 'no-base', text: '缺少接口地址' }
  if (!profile.key) return { ok: false, code: 'no-key', text: '缺少 API Key' }
  return { ok: true, code: 'ok', text: '自备接口' }
}

/**
 * 默认模型：登录了就先给 x-hub 内置清单第一条（这也是首次安装的默认值），
 * 否则给第一个自备模型；都没有时退回第一条平台条目（用于展示「需登录」而不是空白）。
 */
export function defaultProfile(profiles, loggedIn) {
  const list = Array.isArray(profiles) ? profiles : []
  const pl = list.filter((p) => p.kind === KIND_PLATFORM)
  const cu = list.filter((p) => p.kind === KIND_CUSTOM)
  if (loggedIn && pl.length) return pl[0]
  if (cu.length) return cu[0]
  return pl[0] || cu[0] || null
}

/**
 * 解析「这次该用哪个模型」。
 *
 * 优先级：已选且可用 → 默认项 → 列表里第一个可用项。
 * 返回 fallbackFrom 时不改存储，由调用方提示用户「原模型不可用，已临时改用」；
 * 只有用户主动选择（selectModel）或同步确认模型下架时才写盘。
 */
export function resolveRun(profiles, selectedId, opts) {
  const list = Array.isArray(profiles) ? profiles : []
  const loggedIn = !!(opts && opts.loggedIn)
  const id = String(selectedId || '')
  const selected = list.filter((p) => p.id === id)[0] || null

  if (selected) {
    const a = availability(selected, { loggedIn })
    if (a.ok) return { profile: selected, selected, fallbackFrom: '', reason: '', text: a.text }
  }

  const order = []
  const def = defaultProfile(list, loggedIn)
  if (def) order.push(def)
  list.forEach((p) => {
    if (order.indexOf(p) < 0) order.push(p)
  })
  const alt = order.filter((p) => availability(p, { loggedIn }).ok)[0] || null

  const selText = selected
    ? availability(selected, { loggedIn }).text
    : id
    ? '所选模型已不在列表中'
    : '还没有选择模型'
  const reason = selected ? availability(selected, { loggedIn }).code : id ? 'missing' : 'none'
  // 选中的 id 已被删 / 下架（selected 为空）也要算回退，否则界面会把替代模型当成用户的选择
  const switched = !!(alt && id && alt.id !== id)
  return {
    profile: alt,
    selected,
    fallbackFrom: switched ? id : '',
    reason,
    text: switched ? selText + '，已临时改用「' + alt.label + '」' : selText,
  }
}

/**
 * 平台清单对账：自备条目原样保留在前，平台条目按服务端顺序重排。
 * 空清单由调用方拦截（瞬时故障不能当成「全部下架」）。
 */
export function mergePlatform(profiles, names, now) {
  const list = Array.isArray(profiles) ? profiles : []
  const stamp = Number(now) || Date.now()
  const custom = list.filter((p) => p.kind === KIND_CUSTOM)
  const oldPl = list.filter((p) => p.kind === KIND_PLATFORM)
  const oldMap = new Map(oldPl.map((p) => [p.model, p]))
  const seen = new Set()
  const nextPl = []
  ;(Array.isArray(names) ? names : []).forEach((raw) => {
    const name = String(raw || '').trim()
    if (!name || seen.has(name)) return
    seen.add(name)
    nextPl.push(oldMap.get(name) || platformProfile(name, stamp))
  })
  const removed = oldPl.filter((p) => !seen.has(p.model)).map((p) => p.model)
  const added = nextPl.filter((p) => !oldMap.has(p.model)).map((p) => p.model)
  const merged = custom.concat(nextPl)
  const before = list.map((p) => p.id).join('|')
  const after = merged.map((p) => p.id).join('|')
  return { profiles: merged, added, removed, changed: before !== after }
}

/** 选中某个模型时同步写回旧键，保证降级 / 旧页面仍能读到同一套配置 */
export function legacyWrites(profile) {
  if (!profile) {
    return [
      ['aiPlatform', ''],
      ['aiBase', ''],
      ['aiKey', ''],
      ['aiModel', ''],
    ]
  }
  const platform = profile.kind === KIND_PLATFORM
  return [
    ['aiPlatform', platform ? '1' : ''],
    ['aiBase', platform ? '' : profile.base || ''],
    ['aiKey', platform ? '' : profile.key || ''],
    ['aiModel', profile.model || ''],
  ]
}

/**
 * 平台侧「模型没了」的错误特征：只有点到模型本身才重试，
 * 不能把「接口地址错 404」也当成模型下架（那会连累自备接口）。
 */
export function isModelGoneError(err) {
  const text = String((err && (err.message || err)) || '')
  if (!text) return false
  return /model_not_allowed|model_not_found|unknown model|invalid model|does not exist.*model|model.*does not exist|模型不(存在|可用)|无效的?模型|找不到模型/i.test(
    text
  )
}

/** 列表副标题用的主机名：base 解析失败时原样返回，绝不抛错 */
export function hostOf(base) {
  const s = String(base || '')
  try {
    return new URL(s).host || s
  } catch (e) {
    return s.replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  }
}

// ---------------------------------------------------------------- 存储 / 同步

function readJson(value, fallback) {
  if (Array.isArray(value)) return value
  if (typeof value === 'string' && value) {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed : fallback
    } catch (e) {
      return fallback
    }
  }
  return fallback
}

export function loadProfiles(meta) {
  const m = meta || S.meta
  return sanitizeProfiles(readJson(m[MODELS_KEY], []))
}

export function selectedIdOf(meta) {
  const m = meta || S.meta
  return String(m[SELECTED_KEY] || '')
}

export function cachedPlatformNames(meta) {
  const m = meta || S.meta
  return readJson(m[PLATFORM_CACHE_KEY], []).map((x) => String(x || '').trim()).filter(Boolean)
}

function saveProfiles(profiles) {
  return saveMeta(MODELS_KEY, JSON.stringify(sanitizeProfiles(profiles)))
}

/** 当前该用的模型 + 回退说明，页面直接消费 */
export function currentModel(meta) {
  const m = meta || S.meta
  return resolveRun(loadProfiles(m), selectedIdOf(m), { loggedIn: !!ptToken() })
}

export function modelBase(profile) {
  if (!profile) return ''
  return profile.kind === KIND_PLATFORM ? PLATFORM_URL + '/v1' : profile.base || ''
}

export function modelKey(profile) {
  if (!profile) return ''
  return profile.kind === KIND_PLATFORM ? ptToken() : profile.key || ''
}

export function modelEndpoint(profile) {
  return String(modelBase(profile) || '').replace(/\/+$/, '') + '/chat/completions'
}

export function modelSubtitle(profile) {
  if (!profile) return ''
  if (profile.kind === KIND_PLATFORM) return 'x-hub 内置 · 平台额度'
  return profile.model + (profile.base ? ' · ' + hostOf(profile.base) : '')
}

/**
 * 启动时的一次性迁移 + 默认选择落盘。
 * 只在真正需要写的时候写，避免每次启动都产生一次 meta 事务。
 */
export function ensureAiStore(meta) {
  const m = meta || S.meta
  const writes = []
  let profiles = loadProfiles(m)

  if (m[MODELS_KEY] == null) {
    const legacyModel = String(m.aiModel || '').trim()
    if (legacyModel) {
      const p =
        m.aiPlatform === '1'
          ? platformProfile(legacyModel)
          : customProfile({
              // 旧配置没有「名称」，用主机名做列表标题，比一串模型名好认
              label: hostOf(m.aiBase) || legacyModel,
              base: m.aiBase,
              key: m.aiKey,
              model: legacyModel,
            })
      if (p) {
        profiles = [p]
        writes.push([MODELS_KEY, JSON.stringify(profiles)])
      }
    } else if (ptToken()) {
      // 没有旧配置但已登录：用上次缓存的平台清单先把列表铺出来，联网后再对账
      const names = cachedPlatformNames(m)
      if (names.length) {
        profiles = mergePlatform([], names).profiles
        writes.push([MODELS_KEY, JSON.stringify(profiles)])
      }
    }
  }

  if (profiles.length && !m[SELECTED_KEY]) {
    const def = defaultProfile(profiles, !!ptToken())
    if (def) {
      writes.push([SELECTED_KEY, def.id])
      legacyWrites(def).forEach((pair) => writes.push(pair))
    }
  }

  if (writes.length) return applyMeta(writes)
  return Promise.resolve()
}

/** 选择即生效：一次事务写 aiSelected + 旧键，AI 助手与课表识别共用 */
export function selectModel(id, meta) {
  const m = meta || S.meta
  const profiles = loadProfiles(m)
  const p = profiles.filter((x) => x.id === id)[0]
  if (!p) return Promise.reject(new Error('模型不存在'))
  return applyMeta([[SELECTED_KEY, p.id]].concat(legacyWrites(p)))
}

function writeProfilesAndSelect(profiles, id) {
  const clean = sanitizeProfiles(profiles)
  const p = clean.filter((x) => x.id === id)[0]
  const writes = [[MODELS_KEY, JSON.stringify(clean)]]
  if (p) writes.push([SELECTED_KEY, p.id])
  legacyWrites(p || null).forEach((pair) => writes.push(pair))
  return applyMeta(writes)
}

/**
 * 新增自备模型。同 base + model 视为同一条，只更新 Key / 名称，避免列表里堆重复项。
 * 返回 { profile, existing }，调用方据此提示「已存在，已更新」。
 */
export async function addCustomModel(input) {
  const draft = customProfile(input)
  if (!draft) throw new Error('先填模型名')
  if (!draft.base) throw new Error('先填接口地址')
  const profiles = loadProfiles()
  const dup = profiles.filter((p) => p.kind === KIND_CUSTOM && p.base === draft.base && p.model === draft.model)[0]
  if (dup) {
    dup.key = draft.key
    dup.label = draft.label
    await writeProfilesAndSelect(profiles, dup.id)
    return { profile: dup, existing: true }
  }
  profiles.push(draft)
  await writeProfilesAndSelect(profiles, draft.id)
  return { profile: draft, existing: false }
}

export async function updateCustomModel(id, patch) {
  const profiles = loadProfiles()
  const p = profiles.filter((x) => x.id === id)[0]
  if (!p) throw new Error('模型不存在')
  if (patch.label != null) p.label = String(patch.label).trim() || p.model
  if (patch.base != null) p.base = String(patch.base).trim().replace(/\/+$/, '')
  if (patch.model != null) {
    p.model = String(patch.model).trim()
    if (!p.model) throw new Error('模型名不能为空')
  }
  if (patch.key != null) p.key = String(patch.key)
  await writeProfilesAndSelect(profiles, id)
  return p
}

/** 删除模型；删的正好是当前项时，自动落到默认模型，避免界面停在空选择上 */
export async function removeModel(id) {
  const profiles = loadProfiles().filter((p) => p.id !== id)
  const clean = sanitizeProfiles(profiles)
  const writes = [[MODELS_KEY, JSON.stringify(clean)]]
  let next = null
  if (selectedIdOf() === id) {
    next = defaultProfile(clean, !!ptToken())
    writes.push([SELECTED_KEY, next ? next.id : ''])
    legacyWrites(next).forEach((pair) => writes.push(pair))
  }
  await applyMeta(writes)
  return next
}

/**
 * 拉平台清单并对账。
 * - 未登录 / 网络失败 / 空清单都不改本地，避免把用户配好的列表清空；
 * - 当前选中的平台模型被下架时自动落到默认项（返回 switched）。
 */
export async function syncPlatformModels() {
  if (!ptToken()) return { ok: false, code: 'no-login' }
  let resp
  try {
    resp = await platformModels()
  } catch (e) {
    return { ok: false, code: 'network', error: e }
  }
  const names = (Array.isArray(resp && resp.models) ? resp.models : Array.isArray(resp) ? resp : [])
    .map((x) => String(x || '').trim())
    .filter(Boolean)
  if (!names.length) return { ok: false, code: 'empty' }

  await saveMeta(PLATFORM_CACHE_KEY, JSON.stringify(names))
  await saveMeta(PLATFORM_SYNC_KEY, Date.now())

  const merged = mergePlatform(loadProfiles(), names, Date.now())
  const writes = []
  if (merged.changed) writes.push([MODELS_KEY, JSON.stringify(merged.profiles)])
  let switched = null
  const sel = selectedIdOf()
  // 首次拉到清单时还没有选择：把默认项显式落盘，别让「默认」只存在于计算里
  if (!sel && merged.profiles.length) {
    const def = defaultProfile(merged.profiles, true)
    if (def) {
      writes.push([SELECTED_KEY, def.id])
      legacyWrites(def).forEach((pair) => writes.push(pair))
    }
  }
  if (sel.indexOf('pl:') === 0 && !merged.profiles.some((p) => p.id === sel)) {
    switched = defaultProfile(merged.profiles, true)
    if (switched) {
      writes.push([SELECTED_KEY, switched.id])
      legacyWrites(switched).forEach((pair) => writes.push(pair))
    }
  }
  if (writes.length) await applyMeta(writes)
  return { ok: true, added: merged.added, removed: merged.removed, switched, profiles: merged.profiles }
}

/** 页面打开时的静默对账：有平台模型且 6 小时内同步过就跳过，省流量也省等待 */
export async function maybeSyncPlatformModels(force) {
  if (!ptToken()) return { ok: false, code: 'no-login' }
  const at = Number(S.meta[PLATFORM_SYNC_KEY]) || 0
  const hasPl = loadProfiles().some((p) => p.kind === KIND_PLATFORM)
  if (!force && hasPl && Date.now() - at < PLATFORM_SYNC_TTL) return { ok: true, skipped: true }
  return syncPlatformModels()
}

/**
 * 请求撞上「模型不可用」时的自愈：重新对账 → 用新的当前模型重试一次。
 * 只有平台模型会走这条路（自备模型的模型名要用户自己改）。
 */
export async function recoverModel(profile, err) {
  if (!profile || profile.kind !== KIND_PLATFORM) return null
  if (!isModelGoneError(err)) return null
  const r = await syncPlatformModels()
  if (!r.ok) return null
  const cur = currentModel()
  if (cur.profile && cur.profile.id !== profile.id) return cur.profile
  return null
}
