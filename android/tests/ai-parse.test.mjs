/**
 * SSE 解析回归：确保「AI 只聊天、不建待办」不再复现。
 *
 * 运行：
 *   node --experimental-default-type=module --test android/tests/ai-parse.test.mjs
 *   （模块本身是浏览器 ESM，没有 package.json，用 default-type 让 Node 按 ESM 解析）
 *
 * 这些用例来自真实上游的返回形态，不是构造出来的极端值：
 * \r\n\r\n 来自经网关的响应，末条无空行来自部分中转，完整 JSON 来自忽略 stream 的服务。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { parseSseBlock, createSseParser } from '../app/src/main/assets/www/lib/agent.js'

const event = (obj) => 'data: ' + JSON.stringify(obj)
const toolEvent = (name, args, index = 0) =>
  event({ choices: [{ delta: { tool_calls: [{ index, id: 'call_1', function: { name, arguments: args } }] } }] })
const DONE = 'data: [DONE]'

/** 复刻 streamOnce 的累积逻辑：切块 → 逐块解析 → 合并 tool_calls */
function runStream(chunks) {
  const parser = createSseParser()
  const blocks = []
  for (const c of chunks) blocks.push(...parser.push(c))
  blocks.push(...parser.flush())

  const out = { content: '', toolCalls: [], usage: null, error: null, blocks: blocks.length }
  const calls = []
  for (const block of blocks) {
    const inc = parseSseBlock(block)
    if (inc.error) out.error = inc.error
    out.content += inc.content
    if (inc.usage) out.usage = inc.usage
    for (const tc of inc.toolCalls) {
      const i = tc.index
      if (!calls[i]) calls[i] = { id: '', name: '', args: '' }
      if (tc.id) calls[i].id = tc.id
      if (tc.name) calls[i].name += tc.name
      if (tc.args) calls[i].args += tc.args
    }
  }
  out.toolCalls = calls.filter(Boolean)
  return out
}

// ---------------------------------------------------------------- 单元：parseSseBlock

test('解析普通 content 分片', () => {
  const r = parseSseBlock(event({ choices: [{ delta: { content: '你好' } }] }))
  assert.equal(r.content, '你好')
  assert.equal(r.toolCalls.length, 0)
})

test('解析 tool_calls 分片（参数被切成两段）', () => {
  const a = parseSseBlock(toolEvent('create_todo', '{"title":"交房租",'))
  const b = parseSseBlock(toolEvent('', '"due_at":"2026-11-08 15:00"}'))
  assert.equal(a.toolCalls[0].name, 'create_todo')
  assert.equal(a.toolCalls[0].args, '{"title":"交房租",')
  assert.equal(b.toolCalls[0].args, '"due_at":"2026-11-08 15:00"}')
})

test('一个事件内多行 data: 按 \\n 拼接后解析', () => {
  const block = [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,',
    'data: "function":{"name":"create_todo","arguments":"{\\"title\\":\\"交房租\\"}"}}]}}]}',
  ].join('\n')
  const r = parseSseBlock(block)
  assert.equal(r.toolCalls.length, 1)
  assert.equal(r.toolCalls[0].name, 'create_todo')
  assert.equal(JSON.parse(r.toolCalls[0].args).title, '交房租')
})

test('[DONE] 与空块不产出任何内容', () => {
  assert.deepEqual(parseSseBlock(DONE), { content: '', usage: null, toolCalls: [], error: null })
  assert.deepEqual(parseSseBlock(''), { content: '', usage: null, toolCalls: [], error: null })
  assert.deepEqual(parseSseBlock('event: ping'), { content: '', usage: null, toolCalls: [], error: null })
})

test('上游 error 事件被识别为错误而不是静默丢弃', () => {
  const r = parseSseBlock(event({ error: { message: 'invalid api key' } }))
  assert.equal(r.error, 'invalid api key')
})

test('非流式整包（message 字段）也能取到 tool_calls', () => {
  const r = parseSseBlock(
    JSON.stringify({
      choices: [{ message: { tool_calls: [{ function: { name: 'create_todo', arguments: '{"title":"交房租"}' } }] } }],
      usage: { prompt_tokens: 12, completion_tokens: 3 },
    })
  )
  assert.equal(r.toolCalls.length, 1)
  assert.equal(r.toolCalls[0].name, 'create_todo')
  assert.equal(r.usage.input, 12)
  assert.equal(r.usage.output, 3)
})

// ---------------------------------------------------------------- 分帧：createSseParser

test('\\r\\n\\r\\n 也能切开（此前一条都切不开）', () => {
  const parser = createSseParser()
  const blocks = parser.push([toolEvent('create_todo', '{"title":"交房租"}'), DONE].map((x) => x + '\r\n\r\n').join(''))
  assert.equal(blocks.length, 2)
  assert.equal(parseSseBlock(blocks[0]).toolCalls.length, 1)
})

test('半包：事件被切成两段仍能还原', () => {
  const full = [toolEvent('create_todo', '{"title":"交房租"}'), DONE].map((x) => x + '\n\n').join('')
  const parser = createSseParser()
  const first = parser.push(full.slice(0, 30))
  const second = parser.push(full.slice(30))
  const blocks = first.concat(second)
  assert.equal(blocks.length, 2)
  assert.equal(parseSseBlock(blocks[0]).toolCalls[0].args, '{"title":"交房租"}')
})

test('末条事件没有结尾空行时，flush 必须把它交出来', () => {
  const parser = createSseParser()
  parser.push(toolEvent('create_todo', '{"title":"交房租"}'))
  const rest = parser.flush()
  assert.equal(rest.length, 1)
  assert.equal(parseSseBlock(rest[0]).toolCalls.length, 1)
})

// ---------------------------------------------------------------- 组合：真实形态端到端

const CASES = [
  {
    name: '官方 \\n\\n，参数分两片',
    chunks: [[toolEvent('create_todo', '{"title":"交房租",'), toolEvent('', '"due_at":"2026-11-08 15:00"}'), DONE].map((x) => x + '\n\n').join('')],
  },
  {
    name: '中转 \\r\\n\\r\\n',
    chunks: [[toolEvent('create_todo', '{"title":"交房租"}'), DONE].map((x) => x + '\r\n\r\n').join('')],
  },
  {
    name: '唯一一条事件、结尾无空行',
    chunks: [toolEvent('create_todo', '{"title":"交房租"}') + '\n'],
  },
  {
    name: '中转忽略 stream，回完整 JSON',
    chunks: [
      JSON.stringify({
        choices: [{ message: { tool_calls: [{ function: { name: 'create_todo', arguments: '{"title":"交房租"}' } }] } }],
      }),
    ],
  },
  {
    name: 'tool 事件有空行、[DONE] 没有',
    chunks: [toolEvent('create_todo', '{"title":"交房租"}') + '\n\n' + DONE],
  },
  {
    name: '事件被 TCP 切成两半',
    chunks: (() => {
      const full = [toolEvent('create_todo', '{"title":"交房租",'), toolEvent('', '"due_at":"2026-11-08 15:00"}'), DONE]
        .map((x) => x + '\n\n')
        .join('')
      return [full.slice(0, 40), full.slice(40)]
    })(),
  },
  {
    name: '同一事件内多行 data:',
    chunks: [
      [
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,',
        'data: "function":{"name":"create_todo","arguments":"{\\"title\\":\\"交房租\\"}"}}]}}]}',
        '',
        DONE,
        '',
      ].join('\n'),
    ],
  },
]

for (const c of CASES) {
  test('端到端分帧：' + c.name, () => {
    const r = runStream(c.chunks)
    assert.equal(r.error, null, '不应报错')
    assert.equal(r.toolCalls.length, 1, '必须解析出 1 个工具调用')
    assert.equal(r.toolCalls[0].name, 'create_todo')
    assert.equal(JSON.parse(r.toolCalls[0].args).title, '交房租')
  })
}

test('内容类响应（无工具调用）仍能逐片拼出完整文本', () => {
  const chunks = ['你', '好', '，这是', '分片'].map((t) => event({ choices: [{ delta: { content: t } }] }) + '\n\n')
  const r = runStream(chunks)
  assert.equal(r.toolCalls.length, 0)
  assert.equal(r.content, '你好，这是分片')
})

test('纯坏响应不会被当成「成功但为空」', () => {
  const r = runStream(['<html>502 Bad Gateway</html>'])
  assert.equal(r.toolCalls.length, 0)
  assert.equal(r.content, '')
  // 组合层拿到的是「零事件」，streamOnce 会据此抛「响应格式无法识别」
  assert.equal(r.blocks, 1)
})
