import http from 'node:http'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization,content-type',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
}

function sse(res, chunks, usage) {
  res.writeHead(200, Object.assign({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }, CORS))
  let i = 0
  const tick = () => {
    if (i >= chunks.length) {
      if (usage) res.write('data: ' + JSON.stringify({ choices: [], usage }) + '\n\n')
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    res.write('data: ' + JSON.stringify(chunks[i++]) + '\n\n')
    setTimeout(tick, 35)
  }
  tick()
}

const textChunks = (text) =>
  text.split('').reduce((acc, ch, i) => {
    acc.push({ choices: [{ delta: { content: ch } }] })
    return acc
  }, [])

function toolCallChunks(name, argsObj) {
  const args = JSON.stringify(argsObj)
  const head = args.slice(0, Math.ceil(args.length / 2))
  const tail = args.slice(head.length)
  return [
    { choices: [{ delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_' + name, type: 'function', function: { name, arguments: '' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: head } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: tail } }] } }] },
  ]
}

const srv = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') return res.writeHead(204, CORS).end()

  if (req.url.startsWith('/v1/models')) {
    res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, CORS))
    res.end(JSON.stringify({ data: [{ id: 'mock-agent' }, { id: 'mock-small' }] }))
    return
  }

  if (!req.url.startsWith('/v1/chat/completions')) return res.writeHead(404, CORS).end()

  let body = ''
  req.on('data', (d) => (body += d))
  req.on('end', () => {
    let p = {}
    try { p = JSON.parse(body) } catch (e) {}
    const msgs = p.messages || []

    if (!p.stream) {
      res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, CORS))
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'pong' } }] }))
      return
    }

    const usage = {
      prompt_tokens: 1240,
      completion_tokens: 86,
      prompt_tokens_details: { cached_tokens: 768 },
    }

    const hasToolResult = msgs.some((m) => m.role === 'tool')
    const userText = (msgs.filter((m) => m.role === 'user').pop() || {}).content || ''

    if (p.tools && !hasToolResult) {
      if (/删/.test(userText)) return sse(res, toolCallChunks('delete_todo', { todo_id: '交房租' }), usage)
      if (/紧急|重要/.test(userText)) return sse(res, toolCallChunks('update_todo', { todo_id: '交房租', priority: 2 }), usage)
      if (/待办|安排|任务/.test(userText) && !/建|新建|加|添加/.test(userText)) {
        return sse(res, toolCallChunks('list_todos', {}), usage)
      }
      if (/建|新建|加|添加|提醒我/.test(userText)) {
        return sse(
          res,
          toolCallChunks('create_todo', { title: '交房租', due_at: '2026-11-06 15:00', priority: 2 }),
          usage
        )
      }
    }

    sse(res, textChunks('好的，已经按你说的处理好了。'), usage)
  })
})

srv.listen(48999, '127.0.0.1', () => console.log('mock agent on 48999'))
