/**
 * 多工具调用回归：确保「建了第 1 条待办就中断」不再复现。
 *
 * 运行：
 *   node --experimental-default-type=module --test android/tests/agent-tools.test.mjs
 *
 * 缺陷来自 runAgent 的循环：每执行完一个工具就 push 一条 role=tool 的消息，
 * 而 tool_call_id 却从 messages 的最后一条取 —— 第二轮取到的是 tool 消息，
 * 它没有 tool_calls，于是抛 `Cannot read properties of undefined (reading '1')`。
 * 下面直接针对抽出来的 runToolCalls 断言消息序列与编号对应关系。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { buildToolCalls, runToolCalls, parseSseBlock } from '../app/src/main/assets/www/lib/agent.js'

const fakeRun = (calls) => async (call) => {
  calls.push(call)
  return { ok: true, summary: '已创建「' + JSON.parse(call.args).title + '」', detail: '{"ok":true}' }
}

test('一轮 3 个工具调用：三个都执行，编号一一对应', async () => {
  const toolCalls = [
    { id: 'call_a', name: 'create_todo', args: '{"title":"第1天"}' },
    { id: 'call_b', name: 'create_todo', args: '{"title":"第2天"}' },
    { id: 'call_c', name: 'create_todo', args: '{"title":"第3天"}' },
  ]
  const assistantMsg = { role: 'assistant', content: null, tool_calls: buildToolCalls(1, toolCalls) }
  const messages = [{ role: 'user', content: '三天培训' }, assistantMsg]
  const ran = []
  const seen = []

  await runToolCalls({
    assistantMsg,
    toolCalls,
    messages,
    runOne: fakeRun(ran),
    onTool: (name, summary, ok) => seen.push([name, summary, ok]),
  })

  assert.equal(ran.length, 3, '三个工具都应执行')
  assert.equal(seen.length, 3)
  // 关键断言：第 2、3 条的 tool_call_id 仍来自 assistant 消息，而不是被后面 push 的 tool 消息带偏
  const toolMsgs = messages.filter((m) => m.role === 'tool')
  assert.deepEqual(
    toolMsgs.map((m) => m.tool_call_id),
    ['call_a', 'call_b', 'call_c']
  )
  // 消息顺序必须是 assistant(tool_calls) → tool × 3
  assert.equal(messages[1].role, 'assistant')
  assert.equal(messages[1].tool_calls.length, 3)
  assert.deepEqual(
    messages.slice(2).map((m) => m.role),
    ['tool', 'tool', 'tool']
  )
})

test('上游不给 id 时补可预测编号，tool 消息仍能对齐', async () => {
  const toolCalls = [
    { name: 'create_todo', args: '{"title":"A"}' },
    { name: 'create_todo', args: '{"title":"B"}' },
  ]
  const assistantMsg = { role: 'assistant', content: null, tool_calls: buildToolCalls(2, toolCalls) }
  const messages = [assistantMsg]

  await runToolCalls({ assistantMsg, toolCalls, messages, runOne: fakeRun([]) })

  assert.deepEqual(
    assistantMsg.tool_calls.map((c) => c.id),
    ['call_2_0', 'call_2_1']
  )
  assert.deepEqual(
    messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id),
    ['call_2_0', 'call_2_1']
  )
})

test('单个工具调用不回归', async () => {
  const toolCalls = [{ id: 'call_only', name: 'create_todo', args: '{"title":"一条"}' }]
  const assistantMsg = { role: 'assistant', content: null, tool_calls: buildToolCalls(1, toolCalls) }
  const messages = [assistantMsg]

  await runToolCalls({ assistantMsg, toolCalls, messages, runOne: fakeRun([]) })

  assert.equal(messages.filter((m) => m.role === 'tool').length, 1)
  assert.equal(messages[1].tool_call_id, 'call_only')
})

test('工具调用项为 null 时不崩，直接跳过', async () => {
  const toolCalls = [null, { id: 'call_ok', name: 'create_todo', args: '{"title":"有效"}' }]
  const assistantMsg = { role: 'assistant', content: null, tool_calls: buildToolCalls(1, toolCalls) }
  const messages = [assistantMsg]
  const ran = []

  await runToolCalls({ assistantMsg, toolCalls, messages, runOne: fakeRun(ran) })

  assert.equal(assistantMsg.tool_calls.length, 1)
  assert.equal(ran.length, 1)
})

test('assistant 消息缺 tool_calls 时用兜底编号，不抛异常', async () => {
  const messages = []
  await runToolCalls({
    assistantMsg: { role: 'assistant', content: 'x' },
    toolCalls: [{ name: 'create_todo', args: '{}' }],
    messages,
    runOne: fakeRun([]),
  })
  assert.equal(messages[0].tool_call_id, 'call_orphan_0')
})

test('本轮解析出的 3 个 tool_calls 能原样进入 assistant 消息', async () => {
  // 用一个含 3 个 tool_calls 的整包，串起「解析 → 组装 → 回填」全链路
  const body = JSON.stringify({
    choices: [
      {
        message: {
          content: '',
          tool_calls: [0, 1, 2].map((i) => ({
            id: 'call_' + i,
            function: { name: 'create_todo', arguments: JSON.stringify({ title: '第' + (i + 1) + '天' }) },
          })),
        },
      },
    ],
  })
  const parsed = parseSseBlock(body)
  assert.equal(parsed.toolCalls.length, 3)

  const assistantMsg = { role: 'assistant', content: null, tool_calls: buildToolCalls(1, parsed.toolCalls) }
  const messages = [assistantMsg]
  await runToolCalls({ assistantMsg, toolCalls: parsed.toolCalls, messages, runOne: fakeRun([]) })
  assert.deepEqual(
    messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id),
    ['call_0', 'call_1', 'call_2']
  )
})

test('畸形响应：null 包、null 工具项、usage-only 尾包', () => {
  assert.deepEqual(parseSseBlock('null').toolCalls, [])
  const withNull = parseSseBlock(
    JSON.stringify({
      choices: [{ delta: { tool_calls: [null, { index: 0, id: 'c', function: { name: 'create_todo', arguments: '{}' } }] } }],
    })
  )
  assert.equal(withNull.toolCalls.length, 1)
  assert.equal(withNull.toolCalls[0].name, 'create_todo')
  const usageOnly = parseSseBlock(JSON.stringify({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 1 } }))
  assert.ok(usageOnly.usage, 'usage 应被保留')
  assert.equal(usageOnly.toolCalls.length, 0)
})
