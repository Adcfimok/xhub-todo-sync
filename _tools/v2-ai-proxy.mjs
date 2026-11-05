import http from 'node:http'

// 假 OpenAI 兼容服务：分三块吐出 SSE
const fake = http.createServer((req, res) => {
  if (!req.url.endsWith('/chat/completions')) {
    res.writeHead(404).end()
    return
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const parts = ['你好', '，这是', '流式返回。']
  let i = 0
  const t = setInterval(() => {
    if (i >= parts.length) {
      res.write('data: [DONE]\n\n')
      res.end()
      clearInterval(t)
      return
    }
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: parts[i++] } }] }) + '\n\n')
  }, 60)
})
await new Promise((r) => fake.listen(48999, '127.0.0.1', r))

const B = 'http://127.0.0.1:47821'
const code = (await (await fetch(B + '/api/admin/state')).json()).pairCode
const pair = await (await fetch(B + '/api/v1/pair', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ code, device: { id: 'ai-test', name: 'AI 测试' } }),
})).json()

const r = await fetch(B + '/api/ai/chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + pair.token },
  body: JSON.stringify({
    baseURL: 'http://127.0.0.1:48999/v1',
    apiKey: 'sk-test',
    model: 'fake-model',
    messages: [{ role: 'user', content: 'hi' }],
  }),
})
console.log('status', r.status, r.headers.get('content-type'))
const reader = r.body.getReader()
const dec = new TextDecoder()
let buf = ''
let acc = ''
for (;;) {
  const { done, value } = await reader.read()
  if (done) break
  buf += dec.decode(value, { stream: true })
  for (const line of buf.split('\n')) {
    if (!line.startsWith('data:')) continue
    const d = line.slice(5).trim()
    if (!d || d === '[DONE]') continue
    const o = JSON.parse(d)
    acc += o.choices?.[0]?.delta?.content || ''
  }
  buf = ''
}
console.log('accumulated:', JSON.stringify(acc))
console.log(acc === '你好，这是流式返回。' ? '✓ 流式透传正确' : '✗ 内容不一致')
fake.close()
process.exit(0)
