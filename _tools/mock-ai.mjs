import http from 'node:http'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization,content-type',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
}

const srv = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS).end()
    return
  }
  if (req.url.startsWith('/v1/models')) {
    res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, CORS))
    res.end(JSON.stringify({ data: [{ id: 'mock-small' }, { id: 'mock-large' }, { id: 'mock-vision' }] }))
    return
  }
  if (req.url.startsWith('/v1/chat/completions')) {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      let payload = {}
      try { payload = JSON.parse(body) } catch (e) {}
      if (!payload.stream) {
        res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, CORS))
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'pong' } }], usage: { total_tokens: 2 } }))
        return
      }
      res.writeHead(200, Object.assign({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }, CORS))
      const parts = ['你好', '，我是', ' mock 模型。']
      let i = 0
      const t = setInterval(() => {
        if (i >= parts.length) {
          res.write('data: [DONE]\n\n')
          res.end()
          clearInterval(t)
          return
        }
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: parts[i++] } }] }) + '\n\n')
      }, 80)
    })
    return
  }
  res.writeHead(404, CORS).end()
})

srv.listen(48999, '127.0.0.1', () => console.log('mock ai on 48999'))
