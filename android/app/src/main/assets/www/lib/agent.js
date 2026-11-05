/* AI 助手的待办工具与 agent 循环。
   工具定义与行为对齐 x-hub 桌面端 src-tauri/src/agent/builtin.rs（list/create/update/delete_todo），
   只是把"本机数据库"换成手机里的待办集合。 */

import { colRecords, newRecord, touch, softDelete } from './core.js'
import { streamHttp } from './native.js'
import { fmtDue, startOfDay } from './ui.js'

const MAX_ROUNDS = 6

// ---------------------------------------------------------------- 工具定义

export const TODO_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_todos',
      description:
        '列出未完成的待办（按 置顶/逾期/今天/有日期/无日期 分组，与界面一致）。仅当用户问到自己的待办/任务/安排时调用；不返回已完成项。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_todo',
      description:
        '新建待办。title 必填；due_at 支持「YYYY-MM-DD HH:mm」或毫秒时间戳；priority 0=普通 1=重要 2=紧急。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          due_at: { type: 'string', description: '截止时间：「YYYY-MM-DD HH:mm」24 小时制，或毫秒时间戳；不传 = 无截止日期' },
          priority: { type: 'integer', minimum: 0, maximum: 2, description: '0=普通（默认）1=重要 2=紧急' },
          description: { type: 'string', description: '备注，可选' },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_todo',
      description:
        '修改待办：标题/截止时间/优先级/完成态。字段缺省=不动，due_at 传 null=清除截止时间。todo_id 用 list_todos 返回的 [编号]。',
      parameters: {
        type: 'object',
        properties: {
          todo_id: { type: 'string', description: '待办编号，来自 list_todos 的 [xxx]' },
          title: { type: 'string' },
          due_at: { description: '新的截止时间（格式同 create_todo）；传 null 表示清除' },
          priority: { type: 'integer', minimum: 0, maximum: 2 },
          done: { type: 'boolean', description: '是否完成' },
        },
        required: ['todo_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_todo',
      description: '删除待办（执行前会向用户确认，不可恢复）。想保留记录请用 update_todo 把 done 设为 true。',
      parameters: {
        type: 'object',
        properties: { todo_id: { type: 'string', description: '待办编号，来自 list_todos 的 [xxx]' } },
        required: ['todo_id'],
      },
    },
  },
]

// ---------------------------------------------------------------- 系统提示词

export function buildSystemPrompt() {
  const d = new Date()
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const now = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') +
    ' 星期' + '日一二三四五六'[d.getDay()] + ' ' + hh + ':' + mm

  return (
    '你是 x-hub 手机端的内置助手，可以直接操作这台手机上的待办：查看、创建、修改、删除。\n' +
    '现在是 ' + now + '。\n\n' +
    '行为准则：\n' +
    '1. 先判断要不要查，再决定查什么。判断标准是「用户这句话的答案是否依赖待办数据」：\n' +
    '   - 依赖就查：「我有什么待办」「今天要做什么」这类必须调用 list_todos。\n' +
    '   - 不依赖就直接回答，不要为了「顺便看一眼」去调工具：闲聊、常识问答、写作润色都属于这一类。\n' +
    '2. 查一次就够：list_todos 已经按分组返回全部未完成项，没命中不要反复查。\n' +
    '3. 写操作必须**实际调用对应工具**才算完成：没有发出工具调用就宣称「已记录 / 已创建 / 已删除」是严格禁止的——' +
    '没调用工具就是没做成，用户那边什么都不会出现。工具报错时如实说明，不要假装成功。\n' +
    '4. 执行写操作前，用一句话说明你将要做什么（例如「我来把这条加进今天的待办」）。\n' +
    '5. 一次只做用户要求的事，不擅自扩大范围。\n' +
    '6. 删除是不可恢复的：只在用户明确要求删除时调用 delete_todo，执行前系统会再确认一次。\n' +
    '7. 跟随用户的语言回复。\n' +
    '8. 用户口中的数字可能只是标题的一部分而不是编号：先 list_todos 确认编号，不要直接猜。'
  )
}

// ---------------------------------------------------------------- 时间解析

/** 返回 { changed, value, error }；undefined = 不动，null = 清除 */
function parseTime(v) {
  if (v === undefined) return { changed: false, value: null }
  if (v === null) return { changed: true, value: null }
  if (typeof v === 'number') return { changed: true, value: v }
  const s = String(v).trim()
  if (!s) return { changed: true, value: null }
  if (/^\d{10,}$/.test(s)) return { changed: true, value: Number(s) }
  const full = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})/.exec(s)
  if (full) {
    return { changed: true, value: new Date(+full[1], +full[2] - 1, +full[3], +full[4], +full[5]).getTime() }
  }
  const dayOnly = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s)
  if (dayOnly) return { changed: true, value: new Date(+dayOnly[1], +dayOnly[2] - 1, +dayOnly[3], 9, 0).getTime() }
  return { changed: false, value: null, error: '时间格式看不懂：' + s }
}

// ---------------------------------------------------------------- 待办操作

function shortId(t) {
  return String(t.id || '').replace(/^todos:/, '')
}

/** 编号解析：完整 id / hostId / 标题片段（唯一才认） */
function resolveTodo(raw) {
  const s = String(raw == null ? '' : raw).trim()
  if (!s) return { error: '缺少 todo_id 参数' }
  const live = colRecords('todos')

  let hit = live.find((t) => t.id === s || t.id === 'todos:' + s)
  if (hit) return { todo: hit }

  if (/^\d+$/.test(s)) {
    hit = live.find((t) => Number(t.hostId) === Number(s))
    if (hit) return { todo: hit }
  }

  const byTitle = live.filter((t) => String(t.title || '').indexOf(s) >= 0)
  if (byTitle.length === 1) return { todo: byTitle[0] }
  if (byTitle.length > 1) {
    return {
      error:
        '有多条匹配「' + s + '」，请用编号指定：' +
        byTitle.slice(0, 5).map((t) => '[' + shortId(t) + '] ' + t.title).join('；'),
    }
  }
  return { error: '找不到待办「' + s + '」' }
}

function line(t) {
  const bits = ['[' + shortId(t) + ']', t.title || '（未命名）']
  if (t.dueAt) bits.push('· ' + fmtDue(t.dueAt))
  if (t.priority === 2) bits.push('（紧急）')
  else if (t.priority === 1) bits.push('（重要）')
  return bits.join(' ')
}

function listTodos() {
  const live = colRecords('todos')
  const undone = live.filter((t) => !t.done)
  const doneCount = live.length - undone.length
  const today = startOfDay(Date.now())
  const tomorrow = today + 86400000

  const buckets = { pinned: [], overdue: [], today: [], dated: [], undated: [] }
  undone.forEach((t) => {
    if (t.pinned) return buckets.pinned.push(line(t))
    if (!t.dueAt) return buckets.undated.push(line(t))
    if (t.dueAt < Date.now()) return buckets.overdue.push(line(t))
    if (t.dueAt >= today && t.dueAt < tomorrow) return buckets.today.push(line(t))
    buckets.dated.push(line(t))
  })

  const sections = []
  ;[['置顶', buckets.pinned], ['逾期', buckets.overdue], ['今天', buckets.today], ['有日期', buckets.dated], ['无日期', buckets.undated]].forEach(
    ([name, arr]) => {
      if (arr.length) sections.push('【' + name + '】\n' + arr.slice(0, 30).join('\n'))
    }
  )
  if (!sections.length) sections.push('（没有未完成的待办）')
  if (doneCount) sections.push('（另有 ' + doneCount + ' 条已完成，未列出）')

  const detail = sections.join('\n\n')
  const n = undone.length
  return { ok: true, summary: n ? '查到 ' + n + ' 条未完成' : '没有未完成待办', detail }
}

async function createTodo(args) {
  const title = String(args.title || '').trim()
  if (!title) return { ok: false, summary: '缺少标题', detail: 'create_todo 缺少 title 参数。' }

  const due = parseTime(args.due_at)
  if (due.error) return { ok: false, summary: '时间格式错误', detail: due.error }

  const p = Number(args.priority)
  const rec = newRecord('todos', {
    title: title.slice(0, 500),
    dueAt: due.value,
    priority: p === 1 || p === 2 ? p : 0,
    description: String(args.description || '').slice(0, 200),
    done: false,
    pinned: false,
    repeatMode: 'once',
    completedAt: null,
  })
  await touch(rec, {})

  return {
    ok: true,
    summary: '已创建「' + rec.title + '」',
    detail: '已创建待办 ' + line(rec) + '。' + (rec.dueAt ? '' : '（没有截止时间）'),
  }
}

async function updateTodo(args) {
  const r = resolveTodo(args.todo_id)
  if (r.error) return { ok: false, summary: '没找到待办', detail: r.error }
  const t = r.todo

  const fields = {}
  const changes = []
  if (args.title != null) {
    const title = String(args.title).trim()
    if (title) {
      fields.title = title.slice(0, 500)
      changes.push('标题')
    }
  }
  if (args.priority != null) {
    const p = Number(args.priority)
    if (p === 1 || p === 2 || p === 0) {
      fields.priority = p
      changes.push('优先级')
    }
  }
  const due = parseTime(args.due_at)
  if (due.error) return { ok: false, summary: '时间格式错误', detail: due.error }
  if (due.changed) {
    fields.dueAt = due.value
    changes.push('截止时间')
  }
  if (args.done != null) {
    const want = !!args.done
    if (want !== !!t.done) {
      fields.done = want
      fields.completedAt = want ? Date.now() : null
      changes.push('完成态')
    }
  }

  if (!changes.length) return { ok: true, summary: '没有改动', detail: '没有需要改动的字段（或值与现状一致）。' }

  await touch(t, fields)
  return {
    ok: true,
    summary: '已更新（' + changes.join('/') + '）',
    detail: '已更新待办 ' + line(t) + '。改动了：' + changes.join('、') + '。',
  }
}

async function deleteTodo(args, ctx) {
  const r = resolveTodo(args.todo_id)
  if (r.error) return { ok: false, summary: '没找到待办', detail: r.error }
  const t = r.todo

  if (ctx && ctx.confirmDelete) {
    const yes = await ctx.confirmDelete(t)
    if (!yes) {
      return { ok: false, summary: '已取消删除', detail: '用户拒绝删除「' + t.title + '」，未做任何改动。不要重试，也不要说已删除。' }
    }
  }

  await softDelete(t)
  return {
    ok: true,
    summary: '已删除「' + t.title + '」',
    detail: '待办 [' + shortId(t) + ']「' + t.title + '」已删除，同步后电脑上也会消失。',
  }
}

async function execTool(call, ctx) {
  let args = {}
  try {
    args = JSON.parse(call.args || '{}')
  } catch (e) {
    return { ok: false, summary: '参数解析失败', detail: '工具参数不是合法 JSON：' + String(call.args).slice(0, 200) }
  }
  switch (call.name) {
    case 'list_todos':
      return listTodos()
    case 'create_todo':
      return createTodo(args)
    case 'update_todo':
      return updateTodo(args)
    case 'delete_todo':
      return deleteTodo(args, ctx)
    default:
      return {
        ok: false,
        summary: '没有这个工具',
        detail: '没有名为 ' + call.name + ' 的工具。可用：list_todos / create_todo / update_todo / delete_todo。',
      }
  }
}

// ---------------------------------------------------------------- 单轮流式请求

function normalizeUsage(u) {
  if (!u) return null
  const cached =
    (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) ||
    (u.prompt_cache_hit_tokens != null ? u.prompt_cache_hit_tokens : 0) ||
    0
  return {
    input: Number(u.prompt_tokens) || 0,
    output: Number(u.completion_tokens) || 0,
    cached: Number(cached) || 0,
  }
}

function streamOnce(opt) {
  return new Promise((resolve, reject) => {
    let buf = ''
    let content = ''
    let usage = null
    let fail = null
    const calls = []

    streamHttp({
      url: opt.url,
      headers: { Authorization: 'Bearer ' + opt.apiKey },
      body: JSON.stringify(opt.body),
      signal: opt.signal,
      onChunk: (chunk) => {
        if (fail) return
        buf += chunk
        const parts = buf.split('\n\n')
        buf = parts.pop()
        for (const part of parts) {
          const line = part.split('\n').find((l) => l.startsWith('data:'))
          if (!line) continue
          const data = line.slice(5).trim()
          if (!data || data === '[DONE]') continue
          let obj
          try {
            obj = JSON.parse(data)
          } catch (e) {
            continue
          }
          if (obj.error) {
            fail = new Error(typeof obj.error === 'string' ? obj.error : obj.error.message || '上游错误')
            return
          }
          if (obj.usage) usage = normalizeUsage(obj.usage)
          const delta = obj.choices && obj.choices[0] && obj.choices[0].delta
          if (!delta) continue
          if (delta.content) {
            content += delta.content
            if (opt.onDelta) opt.onDelta(delta.content)
          }
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const i = typeof tc.index === 'number' ? tc.index : 0
              if (!calls[i]) calls[i] = { id: '', name: '', args: '' }
              if (tc.id) calls[i].id = tc.id
              if (tc.function) {
                if (tc.function.name) calls[i].name += tc.function.name
                if (tc.function.arguments) calls[i].args += tc.function.arguments
              }
            }
          }
        }
      },
    })
      .then(() => {
        if (fail) return reject(fail)
        resolve({ content, usage, toolCalls: calls.filter(Boolean) })
      })
      .catch(reject)
  })
}

// ---------------------------------------------------------------- agent 循环

/**
 * 跑一轮完整对话（可能包含多次工具调用）。
 *
 * @param {{url:string, apiKey:string, model:string, messages:Array, onDelta?:Function,
 *          onTool?:Function, onUsage?:Function, confirmDelete?:Function, signal?:AbortSignal}} opt
 * @returns {Promise<{content:string, usage:{input:number,output:number,cached:number}}>}
 */
export async function runAgent(opt) {
  const usage = { input: 0, output: 0, cached: 0 }
  let round = 0
  let content = ''

  while (round < MAX_ROUNDS) {
    round += 1
    // 末轮强制不带工具，逼模型收尾（不然可能无限调工具）
    const passTools = round < MAX_ROUNDS
    const body = {
      model: opt.model,
      stream: true,
      stream_options: { include_usage: true },
      messages: opt.messages,
    }
    if (passTools) {
      body.tools = TODO_TOOLS
      body.tool_choice = 'auto'
    }
    if (opt.temperature != null) body.temperature = opt.temperature

    const out = await streamOnce({
      url: opt.url,
      apiKey: opt.apiKey,
      body,
      onDelta: opt.onDelta,
      signal: opt.signal,
    })

    if (out.usage) {
      usage.input += out.usage.input
      usage.output += out.usage.output
      usage.cached += out.usage.cached
    }
    if (opt.onUsage) opt.onUsage(usage)

    content = out.content || content

    if (!out.toolCalls.length) {
      opt.messages.push({ role: 'assistant', content: out.content })
      return { content: out.content, usage }
    }

    // 中间 assistant 消息要带 tool_calls（与随后的 tool 消息成对，缺一边上游会 400）
    opt.messages.push({
      role: 'assistant',
      content: out.content || null,
      tool_calls: out.toolCalls.map((c, i) => ({
        id: c.id || 'call_' + round + '_' + i,
        type: 'function',
        function: { name: c.name, arguments: c.args || '{}' },
      })),
    })

    for (let i = 0; i < out.toolCalls.length; i++) {
      const call = out.toolCalls[i]
      const callId = opt.messages[opt.messages.length - 1].tool_calls[i].id
      const res = await execTool(call, { confirmDelete: opt.confirmDelete })
      if (opt.onTool) opt.onTool(call.name, res.summary, res.ok)
      opt.messages.push({ role: 'tool', tool_call_id: callId, content: res.detail })
    }
  }

  return { content, usage }
}
