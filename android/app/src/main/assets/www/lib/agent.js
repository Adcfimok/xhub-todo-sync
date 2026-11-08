/* AI 助手的待办工具与 agent 循环。
   工具定义与行为对齐 x-hub 桌面端 src-tauri/src/agent/builtin.rs（list/create/update/delete_todo），
   只是把"本机数据库"换成手机里的待办集合。 */

import { S, colRecords, newRecord, touch, softDelete } from './core.js'
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

  const nick = S.meta.nickname ? String(S.meta.nickname).trim() : ''

  return (
    '你是 x-hub 手机端的内置助手，可以直接操作这台手机上的待办：查看、创建、修改、删除。\n' +
    (nick ? '用户的名字是「' + nick + '」，称呼用户时用这个名字。\n' : '') +
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

/**
 * 解析一个 SSE 事件块。
 *
 * 这里曾经只做三件事：按 `\n\n` 切、取块内第一条 `data:`、结束时把残留丢掉。
 * 结果是只要上游不是「标准 \n\n + 每条都以空行结尾」，手机端就一个事件都解析不出来：
 *   - 经 Cloudflare / 多数中转网关后，分隔符会变成 `\r\n\r\n` → 一条都切不开
 *   - 最后一条事件不带结尾空行 → 被当成残留丢弃
 *   - 上游忽略 stream、直接回完整 JSON → 没有 `data:` 前缀，解析出空
 * 解析不出事件 = tool_calls 恒为空 = agent 循环在第 1 轮就 return，
 * 表现就是「AI 只聊天、不建待办」。桌面端走 Rust 侧实现，不经过这段，所以同场景正常。
 *
 * @param {string} block 已按空行切开、且 \r\n 已归一化的事件块
 * @returns {{content:string, usage:object|null, toolCalls:Array, error:string|null}}
 */
export function parseSseBlock(block) {
  const dataLines = []
  for (const rawLine of String(block).split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    // SSE 规范允许一个事件带多行 data:，需按 \n 拼接后再解析
    if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''))
  }
  const empty = { content: '', usage: null, toolCalls: [], error: null }
  if (!dataLines.length) {
    // 整块没有 data: 前缀 —— 上游忽略 stream 时会直接回一个完整 JSON，
    // 这时按非流式对象解析一次；解析不了（比如 502 的 HTML）就当空块跳过。
    const whole = String(block).trim()
    if (!whole) return empty
    return parseSsePayload(whole) || empty
  }
  const data = dataLines.join('\n').trim()
  if (!data || data === '[DONE]') return empty
  return parseSsePayload(data) || empty
}

/**
 * 把一段 JSON 文本解析成增量结果。流式的 delta 与非流式的 message 形状一致，
 * 用同一个出口处理，避免两套代码漂移。
 */
function parseSsePayload(text) {
  let obj
  try {
    obj = JSON.parse(text)
  } catch (e) {
    return null
  }
  // JSON.parse('null') 会返回 null；上游偶尔回一个裸 null，不能直接读字段
  if (!obj || typeof obj !== 'object') return null
  if (obj.error) {
    return {
      content: '',
      usage: null,
      toolCalls: [],
      error: typeof obj.error === 'string' ? obj.error : obj.error.message || '上游错误',
    }
  }

  const choice = obj.choices && obj.choices[0]
  // delta 是流式分片，message 是非流式整包，两者字段形状一致
  const src = (choice && (choice.delta || choice.message)) || null
  const out = { content: '', usage: obj.usage ? normalizeUsage(obj.usage) : null, toolCalls: [], error: null }
  if (!src) return out
  if (src.content) out.content = src.content
  if (Array.isArray(src.tool_calls)) {
    out.toolCalls = src.tool_calls
      // 数组里偶发 null 项：跳过，不能让一个坏元素把整轮对话打断
      .filter((tc) => tc && typeof tc === 'object')
      .map((tc, i) => ({
        index: typeof tc.index === 'number' ? tc.index : i,
        id: tc.id || '',
        name: (tc.function && tc.function.name) || '',
        args: (tc.function && tc.function.arguments) || '',
      }))
  }
  return out
}

/**
 * 增量 SSE 分帧器。把「累积 → 归一化 → 按空行切」这三步单独拎出来，
 * 好让分帧行为可以被单测直接覆盖（真实上游的 \r\n\r\n、半包、末条无空行都靠它兜住）。
 */
export function createSseParser() {
  let buf = ''
  return {
    /** @returns {string[]} 本次新切出的完整事件块 */
    push(chunk) {
      buf = (buf + chunk).replace(/\r\n/g, '\n')
      const parts = buf.split('\n\n')
      buf = parts.pop()
      return parts
    },
    /** 流结束时把残留当成一个事件交出去（很多中转的最后一条不带空行） */
    flush() {
      const rest = buf.trim() ? [buf] : []
      buf = ''
      return rest
    },
  }
}

function streamOnce(opt) {
  return new Promise((resolve, reject) => {
    const parser = createSseParser()
    let raw = ''
    let content = ''
    let usage = null
    let fail = null
    let sawEvent = false
    const calls = []

    const mergeCall = (tc) => {
      const i = typeof tc.index === 'number' ? tc.index : 0
      if (!calls[i]) calls[i] = { id: '', name: '', args: '' }
      if (tc.id) calls[i].id = tc.id
      if (tc.name) calls[i].name += tc.name
      if (tc.args) calls[i].args += tc.args
    }

    const consume = (block) => {
      const inc = parseSseBlock(block)
      if (inc.error) {
        fail = new Error(inc.error)
        return
      }
      if (inc.usage) {
        // 只有用量、choices 为空的尾包也是合法事件，不能当成「什么都没收到」
        sawEvent = true
        usage = inc.usage
      }
      if (inc.content) {
        sawEvent = true
        content += inc.content
        if (opt.onDelta) opt.onDelta(inc.content)
      }
      if (inc.toolCalls && inc.toolCalls.length) {
        sawEvent = true
        inc.toolCalls.forEach(mergeCall)
      }
    }

    streamHttp({
      url: opt.url,
      headers: { Authorization: 'Bearer ' + opt.apiKey },
      body: JSON.stringify(opt.body),
      signal: opt.signal,
      onChunk: (chunk) => {
        if (fail) return
        raw += chunk
        for (const part of parser.push(chunk)) {
          if (fail) return
          consume(part)
        }
      },
    })
      .then(() => {
        if (fail) return reject(fail)

        // 末条事件常不带结尾空行，残留必须当事件处理，否则最后一个 tool_calls 直接丢
        for (const part of parser.flush()) {
          if (fail) return reject(fail)
          consume(part)
        }
        if (fail) return reject(fail)

        // 上游忽略 stream、直接回完整 JSON：按非流式取一次
        if (!sawEvent && raw.trim()) {
          try {
            const j = JSON.parse(raw.replace(/^data:\s*/, '').trim())
            const choice = j && j.choices && j.choices[0]
            const msg = choice && (choice.message || choice.delta)
            if (msg) {
              if (msg.content) {
                content += msg.content
                if (opt.onDelta) opt.onDelta(msg.content)
              }
              if (Array.isArray(msg.tool_calls)) {
                msg.tool_calls.forEach((tc, i) =>
                  mergeCall({ index: i, id: tc.id, name: tc.function && tc.function.name, args: tc.function && tc.function.arguments })
                )
              }
              if (j.usage) usage = normalizeUsage(j.usage)
              sawEvent = true
            }
          } catch (e) {
            /* 确实不是 JSON，落到下面统一报错 */
          }
        }

        // 拿到字节却什么也没解析出来：不要静默返回空，否则界面只会显示「没有返回内容」
        if (!sawEvent && raw.trim()) {
          return reject(
            new Error('响应格式无法识别：上游返回的既不是 SSE 事件流，也不是完整的 chat/completions JSON。请检查接口地址，或换用支持流式的服务。')
          )
        }

        resolve({ content, usage, toolCalls: calls.filter(Boolean) })
      })
      .catch(reject)
  })
}

// ---------------------------------------------------------------- 工具调用消息

/**
 * 把本轮解析出的工具调用整理成 OpenAI 兼容的 assistant.tool_calls。
 * 上游可能不给 id，这里补一个可预测的（call_<轮次>_<序号>），
 * 保证随后的 tool 消息能一一对上。
 */
export function buildToolCalls(round, toolCalls) {
  return (toolCalls || []).filter(Boolean).map((c, i) => ({
    id: c.id || 'call_' + round + '_' + i,
    type: 'function',
    function: { name: c.name, arguments: c.args || '{}' },
  }))
}

/**
 * 依次执行工具，并把结果按 tool_call_id 回填到消息数组。
 *
 * 这里必须从传入的 assistantMsg 取编号，**不能**从 messages 的最后一条取：
 * 每执行完一个工具就会 push 一条 role=tool 的消息，它的结构里没有 tool_calls，
 * 第二轮取就会抛 `Cannot read properties of undefined (reading '1')`。
 * 一轮里有 3 条待办时，表现为「第 1 条建成、随后整轮中断」。
 */
export async function runToolCalls({ assistantMsg, toolCalls, messages, confirmDelete, onTool, runOne }) {
  // runOne 仅用于测试注入；生产路径走模块内的 execTool
  const run = runOne || execTool
  // 与 buildToolCalls 用同一条过滤规则，保证下标与 assistant.tool_calls 一一对应
  const list = (toolCalls || []).filter(Boolean)
  for (let i = 0; i < list.length; i++) {
    const call = list[i]
    const tc = assistantMsg && assistantMsg.tool_calls ? assistantMsg.tool_calls[i] : null
    // 理论上不会缺；真缺了也要给出可用的编号，而不是让整轮对话崩在取下标上
    const callId = tc && tc.id ? tc.id : 'call_orphan_' + i
    const res = await run(call, { confirmDelete })
    if (onTool) onTool(call.name, res.summary, res.ok)
    messages.push({ role: 'tool', tool_call_id: callId, content: res.detail })
  }
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
    const assistantMsg = {
      role: 'assistant',
      content: out.content || null,
      tool_calls: buildToolCalls(round, out.toolCalls),
    }
    opt.messages.push(assistantMsg)

    await runToolCalls({
      assistantMsg,
      toolCalls: out.toolCalls,
      messages: opt.messages,
      confirmDelete: opt.confirmDelete,
      onTool: opt.onTool,
    })
  }

  return { content, usage }
}
