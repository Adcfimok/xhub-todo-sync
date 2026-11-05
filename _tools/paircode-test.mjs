import assert from 'node:assert'
import { parsePairPayload } from './paircode.mjs'

// v3：多候选
let r = parsePairPayload('xhub://3/457165/10.31.67.56:47821,192.168.1.20:47821')
assert.strictEqual(r.code, '457165')
assert.deepStrictEqual(r.hosts, ['10.31.67.56:47821', '192.168.1.20:47821'])
assert.strictEqual(r.version, 3)
console.log('✓ v3 多地址：', r.hosts.join(' , '))

// v3：缺端口自动补 47821
r = parsePairPayload('xhub://3/000123/10.0.0.5')
assert.deepStrictEqual(r.hosts, ['10.0.0.5:47821'])
console.log('✓ v3 缺端口补默认端口')

// v2 / v1 兼容
r = parsePairPayload('xhub://2/192.168.1.8:47821/654321')
assert.strictEqual(r.code, '654321')
assert.deepStrictEqual(r.hosts, ['192.168.1.8:47821'])
console.log('✓ v2 兼容')
r = parsePairPayload('xhub://1/192.168.1.9/111222')
assert.strictEqual(r.version, 2)
console.log('✓ v1 兼容')

// 超量截断到 6 个
r = parsePairPayload('xhub://3/123456/' + Array.from({ length: 9 }, (_, i) => '10.0.0.' + (i + 1) + ':47821').join(','))
assert.strictEqual(r.hosts.length, 6)
console.log('✓ 候选地址上限 6')

// 无效输入
for (const bad of ['', 'hello', 'xhub://3/12345/1.2.3.4:47821', 'xhub://3/123456/', 'https://x.com']) {
  assert.strictEqual(parsePairPayload(bad), null, bad)
}
console.log('✓ 无效载荷返回 null')

console.log('\npaircode: 6/6 通过')
