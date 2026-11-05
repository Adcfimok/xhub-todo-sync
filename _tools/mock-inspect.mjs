import { chromium } from 'playwright'
const b = await chromium.launch({ channel: 'msedge' })
const p = await b.newPage({ viewport: { width: 1200, height: 800 } })
await p.goto('http://127.0.0.1:8099/view/index.html?theme=dark', { waitUntil: 'networkidle' })
await p.waitForTimeout(800)
const info = await p.evaluate(async () => {
  const x = window.xhub
  const count = async (fn) => { try { const r = await fn(); return Array.isArray(r) ? r.length : 'not-array' } catch (e) { return 'ERR ' + e.message } }
  return {
    mockFlag: !!x && !!x.data,
    todos: await count(() => x.data.todos.list()),
    notes: await count(() => x.data.notes.list()),
    stickies: await count(() => x.data.stickies.list()),
    resources: await count(() => x.data.resources.list()),
    snippets: await count(() => x.data.snippets.list()),
    resourcesIds: (await x.data.resources.list()).map((r) => r.id).join(','),
    todosIds: (await x.data.todos.list()).map((r) => r.id).join(','),
  }
})
console.log(JSON.stringify(info, null, 1))
await b.close()
