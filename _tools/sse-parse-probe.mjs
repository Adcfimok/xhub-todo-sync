#!/usr/bin/env node
/**
 * AI 助手「不会建待办」的根因存档。
 *
 * 背景：手机端 AI 走 lib/agent.js 的 streamOnce() 自己解析 SSE，
 * 而桌面端走 Rust 侧实现，所以同一个模型在 PC 上能建待办、手机上不行。
 *
 * ⚠️ agent.js 已于 2.9.2 修复（抽出 parseSseBlock / createSseParser）。
 * 本脚本的 legacy 分支复刻的是**修复前**逻辑，用途是证明当时为什么建不了待办，
 * 不参与当前代码路径。当前实现的回归在 android/tests/ai-parse.test.mjs。
 *
 * 用法：
 *   node _tools/sse-parse-probe.mjs          # 对比表
 *   node _tools/sse-parse-probe.mjs --json   # 机器可读
 *
 * 退出码：0 = legacy 有失败用例（缺陷可复现）；1 = legacy 全部通过（说明前提变了，需重新排查）
 */

const ev = (o) => 'data: ' + JSON.stringify(o)
const toolEv = (name, args) =>
  ev({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name, arguments: args } }] } }] })
const doneEv = 'data: [DONE]'

// ---------------------------------------------------------------- legacy：与 agent.js 现状逐行一致

function parseLegacy(chunks) {
  let buf = ''
  let content = ''
  const calls = []
  let usage = null

  for (const chunk of chunks) {
    buf += chunk
    const parts = buf.split('\n\n') // ← 缺陷 1：只认 \n\n
    buf = parts.pop()
    for (const part of parts) {
      const line = part.split('\n').find((l) => l.startsWith('data:')) // ← 缺陷 2：只取首行 data
      if (!line) continue
      const data = line.slice(5).trim()
      if (!data || data === '[DONE]') continue
      let obj
      try {
        obj = JSON.parse(data)
      } catch (e) {
        continue
      }
      if (obj.usage) usage = obj.usage
      const delta = obj.choices && obj.choices[0] && obj.choices[0].delta
      if (!delta) continue
      if (delta.content) content += delta.content
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const i = typeof tc.index === 'number' ? tc.index : 0
          if (!calls[i]) calls[i] = { name: '', args: '' }
          if (tc.function) {
            if (tc.function.name) calls[i].name += tc.function.name
            if (tc.function.arguments) calls[i].args += tc.function.arguments
          }
        }
      }
    }
  }
  // ← 缺陷 3：结束时没有 flush 残留 buf
  return { content, calls: calls.filter(Boolean), usage, leftover: buf.length }
}

// ---------------------------------------------------------------- fixed：方案里的替换实现

function parseFixed(chunks) {
  let buf = ''
  let content = ''
  const calls = []
  let usage = null
  let rawBytes = 0
  let sawAnyEvent = false

  const handleEvent = (block) => {
    // 一个事件块内可能有多行 data:（SSE 规范允许，按 \n 拼接）
    const dataLines = []
    for (const rawLine of block.split('\n')) {
      const line = rawLine.replace(/\r$/, '')
      if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
    }
    if (!dataLines.length) return
    const data = dataLines.join('\n').trim()
    if (!data || data === '[DONE]') return
    let obj
    try {
      obj = JSON.parse(data)
    } catch (e) {
      return
    }
    sawAnyEvent = true
    if (obj.usage) usage = obj.usage
    const delta = obj.choices && obj.choices[0] && obj.choices[0].delta
    const message = obj.choices && obj.choices[0] && obj.choices[0].message // 非流式兜底
    const src = delta || message
    if (!src) return
    if (src.content) content += src.content
    if (Array.isArray(src.tool_calls)) {
      for (const tc of src.tool_calls) {
        const i = typeof tc.index === 'number' ? tc.index : 0
        if (!calls[i]) calls[i] = { name: '', args: '' }
        if (tc.function) {
          if (tc.function.name) calls[i].name += tc.function.name
          if (tc.function.arguments) calls[i].args += tc.function.arguments
        }
      }
    }
  }

  for (const chunk of chunks) {
    rawBytes += chunk.length
    buf += chunk
    // 缺陷 1 的修法：\r\n\r\n 与 \n\n 都算分隔；先归一化再切
    buf = buf.replace(/\r\n/g, '\n')
    const parts = buf.split('\n\n')
    buf = parts.pop()
    parts.forEach(handleEvent)
  }
  // 缺陷 3 的修法：末尾残留当成一个事件处理（很多中转最后一条不带空行）
  if (buf.trim()) handleEvent(buf)

  // 缺陷 4：整块是单个 JSON（中转忽略 stream 参数时就是这种）
  if (!sawAnyEvent && rawBytes) {
    try {
      const j = JSON.parse(chunks.join('').replace(/^data:\s*/, '').trim())
      const choice = j.choices && j.choices[0]
      if (choice && choice.message) {
        if (choice.message.content) content += choice.message.content
        if (Array.isArray(choice.message.tool_calls)) {
          choice.message.tool_calls.forEach((tc, i) => {
            calls[i] = { name: (tc.function && tc.function.name) || '', args: (tc.function && tc.function.arguments) || '' }
          })
        }
        if (j.usage) usage = j.usage
        sawAnyEvent = true
      }
    } catch (e) {
      /* 确实是坏响应，交给上层报错 */
    }
  }

  return { content, calls: calls.filter(Boolean), usage, leftover: buf.length, parsed: sawAnyEvent }
}

// ---------------------------------------------------------------- 用例

const splitToolArgs = () =>
  [toolEv('create_todo', '{"title":"交房租",'), toolEv('', '"due_at":"2026-11-08 15:00"}')]
    .map((x) => x + '\n\n')
    .join('') + doneEv + '\n\n'

const CASES = [
  {
    id: 'official-lf',
    name: '官方 \\n\\n，tool 参数分两片',
    chunks: [splitToolArgs()],
    expect: 'pass',
  },
  {
    id: 'crlf',
    name: '中转 \\r\\n\\r\\n（Cloudflare / 部分网关）',
    chunks: [[toolEv('create_todo', '{"title":"交房租"}'), doneEv].map((x) => x + '\r\n\r\n').join('')],
    expect: 'fail-legacy',
  },
  {
    id: 'no-trailing-blank',
    name: '唯一一条事件，结尾没有空行',
    chunks: [toolEv('create_todo', '{"title":"交房租"}') + '\n'],
    expect: 'fail-legacy',
  },
  {
    id: 'non-stream-json',
    name: '中转忽略 stream，直接回完整 JSON',
    chunks: [
      [
        JSON.stringify({
          choices: [{ message: { tool_calls: [{ function: { name: 'create_todo', arguments: '{"title":"交房租"}' } }] } }],
        }),
      ],
    ],
    expect: 'fail-legacy',
  },
  {
    id: 'last-event-no-blank',
    name: 'tool 事件有空行，[DONE] 没有',
    chunks: [toolEv('create_todo', '{"title":"交房租"}') + '\n\n' + doneEv],
    expect: 'pass',
  },
  {
    id: 'split-tcp',
    name: '事件被 TCP 切成两半',
    chunks: [splitToolArgs().slice(0, 40), splitToolArgs().slice(40)],
    expect: 'pass',
  },
  {
    id: 'multiline-data',
    name: '同一事件内多行 data:',
    chunks: [
      [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,',
        'data: "function":{"name":"create_todo","arguments":"{\\"title\\":\\"交房租\\"}"}}]}}]}\n\n',
        doneEv + '\n\n',
      ].join('\n'),
    ],
    expect: 'fail-legacy',
  },
]

const json = process.argv.includes('--json')
const rows = []

for (const c of CASES) {
  const legacy = parseLegacy(c.chunks)
  const fixed = parseFixed(c.chunks)
  rows.push({
    id: c.id,
    name: c.name,
    legacy: { calls: legacy.calls.length, leftover: legacy.leftover, ok: legacy.calls.length > 0 },
    fixed: { calls: fixed.calls.length, parsed: !!fixed.parsed, ok: fixed.calls.length > 0 },
    expect: c.expect,
  })
}

if (json) {
  console.log(JSON.stringify({ rows }, null, 2))
} else {
  const pad = (s, n) => s + ' '.repeat(Math.max(0, n - [...s].reduce((w, ch) => w + (ch.charCodeAt(0) > 255 ? 2 : 1), 0)))
  console.log('')
  console.log(pad('用例', 40) + pad('现状 agent.js', 16) + pad('方案实现', 12) + '判定')
  console.log('-'.repeat(78))
  for (const r of rows) {
    const legacyText = r.legacy.ok ? '解析出 ' + r.legacy.calls + ' 个' : '解析 0（残留 ' + r.legacy.leftover + 'B）'
    const fixedText = r.fixed.ok ? '解析出 ' + r.fixed.calls + ' 个' : '解析 0'
    const verdict = r.legacy.ok === r.fixed.ok && r.fixed.ok ? '一致' : r.legacy.ok ? '一致' : r.fixed.ok ? '现状失败 → 方案通过' : '两者都失败'
    console.log(pad(r.name, 40) + pad(legacyText, 16) + pad(fixedText, 12) + verdict)
  }
  console.log('')
  const legacyFail = rows.filter((r) => !r.legacy.ok).length
  const fixedFail = rows.filter((r) => !r.fixed.ok).length
  console.log('现状实现失败 ' + legacyFail + '/' + rows.length + ' 例；方案实现失败 ' + fixedFail + '/' + rows.length + ' 例。')
  console.log('')
  console.log('结论：只要上游不是「标准 \\n\\n + 完整分帧」，手机端就一个事件都解析不出来，')
  console.log('      tool_calls 恒为空 → runAgent 直接返回 → 表现为「AI 只聊天、不建待办」。')
  console.log('      桌面端走 Rust 侧实现，不经过这段解析，所以同场景正常。')
}

process.exit(rows.some((r) => !r.legacy.ok) ? 0 : 1)
