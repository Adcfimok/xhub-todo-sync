/**
 * 加解密互通校验：反射调用真实的 FileTransfer（Android 侧实现），
 * 与 service/files.js（PC 侧实现）对同一组输入逐字节比对。
 *
 * 前置：android/build/classes 里已有编译产物（node android/build.sh 会生成）。
 * 运行：node _tools/crypto-interop-check.mjs
 */
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readdirSync, existsSync } from 'node:fs'
import path from 'node:path'

const require = createRequire('C:/Users/zhou/WorkBuddy/xhub/extensions/todo-relay/service/files.js')
const F = require('C:/Users/zhou/WorkBuddy/xhub/extensions/todo-relay/service/files.js')

const ROOT = 'C:/Users/zhou/WorkBuddy/xhub'
const PROBE = path.join(ROOT, '_tools', 'java-crypto-probe')
const CLASSES = path.join(ROOT, 'android', 'build', 'classes')
const PLATFORM = path.join(ROOT, '_toolchain', 'android-12', 'android.jar')
const JDK = readdirSync(path.join(ROOT, '_toolchain')).filter((n) => n.startsWith('jdk-'))[0]
const BIN = path.join(ROOT, '_toolchain', JDK, 'bin')

const TOKEN = 'ab'.repeat(32)
const ID = 'abcdef0123456789abcdef01'
const SIZE = 3000000
const INDEX = 1

let pass = 0
let fail = 0
function check(name, cond, extra) {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.log(`  ✗ ${name}${extra ? ' → ' + extra : ''}`)
  }
}

if (!existsSync(path.join(CLASSES, 'com', 'zhou', 'todolink', 'FileTransfer.class'))) {
  console.log('  ✗ 找不到 FileTransfer.class，请先运行 android/build.sh')
  process.exit(1)
}

execFileSync(path.join(BIN, 'javac.exe'), ['-encoding', 'UTF-8', '-cp', `${CLASSES};${PLATFORM}`, '-d', PROBE, path.join(PROBE, 'CryptoProbe.java')], {
  stdio: 'pipe',
})
const out = execFileSync(
  path.join(BIN, 'java.exe'),
  ['-cp', `${PROBE};${CLASSES};${PLATFORM}`, 'CryptoProbe', TOKEN, ID],
  { encoding: 'utf8' }
)
  .trim()
  .split(/\r?\n/)
const [javaKey, javaNonce, javaAad, javaSealed, javaRound] = out

const plain = Buffer.alloc(1024)
for (let i = 0; i < plain.length; i++) plain[i] = (i * 7 + 3) & 0xff
const key = F.keyFor(TOKEN, ID)
const nonce = F.nonceFor(ID, INDEX)
const aad = F.aadFor(ID, INDEX, SIZE)
const sealed = F.seal(key, nonce, aad, plain)

check('HKDF 派生密钥一致', javaKey === key.toString('hex'), javaKey?.slice(0, 16))
check('GCM nonce 一致', javaNonce === nonce.toString('hex'), javaNonce)
check('AAD 一致', javaAad === aad.toString('hex'), javaAad)
check('密文与认证标签逐字节一致', javaSealed === sealed.toString('hex'), (javaSealed || '').slice(0, 32))
check('Java 侧解密可还原', javaRound === 'true', javaRound)
check('Node 侧解密可还原', F.open(key, nonce, aad, sealed).equals(plain))

console.log(`\n加解密互通：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
