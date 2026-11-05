const assert = require('assert')
const { rankAddresses } = require('../extensions/todo-relay/service/netinfo.js')

const real = [
  { iface: 'vgate0', address: '172.30.238.207' },
  { iface: 'WLAN', address: '10.31.67.56' },
  { iface: 'VMware Network Adapter VMnet1', address: '192.168.21.1' },
  { iface: 'VMware Network Adapter VMnet8', address: '192.168.128.1' },
]

// 1. 默认路由地址必须是主地址，虚拟网卡排后面
let r = rankAddresses(real, '10.31.67.56')
assert.strictEqual(r[0].address, '10.31.67.56')
assert.strictEqual(r[0].primary, true)
assert.strictEqual(r[0].virtual, false)
assert.ok(r.slice(1).every((x) => x.virtual), '其余应全部标记为虚拟网卡')
console.log('✓ 默认路由优先：' + r.map((x) => x.iface + '/' + x.address).join(' → '))

// 2. 探测失败时按「非虚拟 + 网段」兜底，也要能选出主地址
r = rankAddresses(real, '')
assert.strictEqual(r[0].address, '10.31.67.56')
assert.strictEqual(r[0].primary, true)
console.log('✓ 探测失败兜底：' + r[0].iface)

// 3. Hyper-V / WSL / Docker 也要识别成虚拟
r = rankAddresses(
  [
    { iface: 'vEthernet (WSL)', address: '172.29.0.1' },
    { iface: '以太网', address: '192.168.1.20' },
    { iface: 'docker0', address: '172.17.0.1' },
  ],
  ''
)
assert.strictEqual(r[0].address, '192.168.1.20')
assert.ok(r.filter((x) => /WSL|docker/i.test(x.iface)).every((x) => x.virtual))
console.log('✓ 虚拟网卡识别：WSL / docker')

// 4. 链路本地地址应被丢弃
r = rankAddresses([{ iface: '以太网', address: '169.254.10.5' }], '')
assert.strictEqual(r.length, 0)
console.log('✓ 169.254 被过滤')

// 5. 只有虚拟网卡时，仍然给出一个候选（并标记 primary，UI 会提示风险）
r = rankAddresses([{ iface: 'OpenVPN TAP', address: '10.8.0.6' }], '')
assert.strictEqual(r.length, 1)
assert.strictEqual(r[0].virtual, true)
console.log('✓ 纯虚拟环境下仍返回候选')

console.log('\nnetinfo: 5/5 通过')
