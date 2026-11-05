const B = 'http://127.0.0.1:47821'
const post = (p, b) => fetch(B + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json())
const t = (d = 0) => new Date(Date.now() + d).toISOString().slice(0, 19).replace('T', ' ') + '.000'

// 本地时间构造：故意不用 toISOString，避免 UTC 偏移把日期挪一天
const day = (offset, hh = 9, mm = 0) => {
  const d = new Date()
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset, hh, mm).getTime()
}

const todo = (id, title, off, hh, mm, extra = {}) =>
  Object.assign({ id, title, done: 0, priority: 0, due_at: day(off, hh, mm), version: 0, description: '', pinned: 0, repeat_mode: 'once', created_at: t(-86400e3), updated_at: t(-86400e3) }, extra)

await post('/api/local/ingest', { col: 'todos', full: true, records: [
  todo(1, '写周报', 0, 18, 0, { priority: 1, description: '把本周进展整理成三条' }),
  todo(2, '买牛奶', 1, 20, 0),
  todo(3, '交房租', -1, 12, 0, { priority: 2, repeat_mode: 'monthly' }),
  todo(4, '读完《设计系统》', -3, 21, 0, { done: 1 }),
  todo(5, '团队周会', 3, 10, 0),
  todo(6, '季度复盘材料', 3, 14, 0, { priority: 1 }),
  todo(7, '提交报销单', 3, 17, 30),
  todo(8, '预约体检', 3, 19, 0),
  todo(9, '续保车险', 5, 11, 0, { priority: 2 }),
  todo(10, '换机油', 10, 15, 0),
  todo(11, '整理照片', 10, 21, 0),
  todo(12, '看完纪录片', 2, 22, 0, { done: 1 }),
  { id: 13, title: '网购洗衣液', done: 0, priority: 0, due_at: null, version: 0, description: '', pinned: 0, repeat_mode: 'once', created_at: t(-7200e3), updated_at: t(-7200e3) },
]})

await post('/api/local/ingest', { col: 'notes', full: true, records: [
  { id: 1, title: '周会纪要', content: '1. 同步方案定稿\n2. 下周开始灰度\n3. 需要补一份协议文档', created_at: t(-86400e3), updated_at: t(-3600e3) },
  { id: 2, title: '读书笔记：卡片设计', content: '信息密度不是越多越好，而是每一屏只回答一个问题。', created_at: t(-86400e3 * 2), updated_at: t(-86400e3 * 2) },
  { id: 3, title: '购物清单', content: '牛奶、鸡蛋、面包、咖啡豆', created_at: t(-7200e3), updated_at: t(-7200e3) },
]})

await post('/api/local/ingest', { col: 'stickies', full: true, records: [
  { id: 1, slot: 1, content: '记得给客户回邮件\n——周三前', version: 1, updated_at: t(-3600e3) },
  { id: 2, slot: 2, content: '灵感：把待办按「精力」而不是「时间」排序', version: 1, updated_at: t(-86400e3) },
]})

await post('/api/local/ingest', { col: 'resources', full: true, records: [
  { id: 1, kind: 'web', name: 'GitHub', target: 'https://github.com', category: 'dev', sort_order: 1, created_at: t(), updated_at: t() },
  { id: 2, kind: 'web', name: '掘金', target: 'https://juejin.cn', category: 'read', sort_order: 2, created_at: t(), updated_at: t() },
  { id: 3, kind: 'web', name: 'Figma', target: 'https://figma.com', category: 'design', sort_order: 3, created_at: t(), updated_at: t() },
  { id: 4, kind: 'app', name: 'VS Code', target: 'code.exe', category: null, sort_order: 4, created_at: t(), updated_at: t() },
]})

await post('/api/local/ingest', { col: 'snippets', full: true, records: [
  { id: 1, title: '周报开头', content: '本周主要完成了以下三件事：', is_pinned: 1, copy_count: 3, created_at: t(), updated_at: t() },
  { id: 2, title: '礼貌拒绝', content: '感谢邀请，这个时间我已有安排，我们下次再约。', is_pinned: 0, copy_count: 0, created_at: t(), updated_at: t() },
]})

const st = await fetch(B + '/api/admin/state').then(r => r.json())
console.log('seeded:', st.stats.byCol)
console.log('pairCode:', st.pairCode)
