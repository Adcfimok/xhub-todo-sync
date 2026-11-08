#!/usr/bin/env node
// 从 WakeUp课程表 6.5.2 的加密 assets 里解出「导入教务系统课表」学校列表。
//
// 用法（项目根目录执行）：
//   node _tools/extract-wakeup-schools.mjs
//   node _tools/extract-wakeup-schools.mjs --src "C:/Users/zhou/Desktop/WakeUp课程表_6.5.2" --out /tmp/schools.json
//   node _tools/extract-wakeup-schools.mjs --check        # 与 lib/schools.js 内置数据逐条核对
//
// 解密链（由 classes6.dex 字节码确认，不是猜的）：
//   1. SchoolListActivity$initSchoolList$1 读 assets/school_info_android_new.txt
//   2. 文本整体反转（Kotlin StringsKt.reversed，字节码里对应 Lkotlin/text/o0000O00;.o000Oo）
//   3. utils/o000O0Oo.OooO0OO: Base64.decode → AES/CBC/PKCS5Padding 解密 → String
//        key = IV = "wakeup-yzune1215"（16 字节，来自 dex 里的字符串常量，
//        由 SecretKeySpec([B,"AES"]) + IvParameterSpec([B]) 使用同一份字节）
//   4. utils/o000O0Oo.OooO0O0: 上一步结果再 Base64.decode → GZIPInputStream → 文本
//   5. Gson.fromJson → { data: [...], release, versionStatus, versionTimeLine }
//
// 本脚本只做解密与导出，不改写原始资源文件。

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const DEFAULT_SRC = 'C:/Users/zhou/Desktop/WakeUp课程表_6.5.2'
const KEY = 'wakeup-yzune1215'

function args() {
  const a = {}
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--check') a.check = true
    else if (argv[i] === '--src') a.src = argv[++i]
    else if (argv[i] === '--out') a.out = argv[++i]
  }
  return a
}

export function decryptSchoolList(text) {
  const joined = String(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .join('')
  const b64 = joined.split('').reverse().join('')
  const cipher = Buffer.from(b64, 'base64')
  const key = Buffer.from(KEY, 'utf8')
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, key) // IV 与 key 相同，默认 PKCS5/PKCS7 padding
  const inner = Buffer.concat([decipher.update(cipher), decipher.final()]).toString('utf8')
  const gz = Buffer.from(inner, 'base64')
  if (gz[0] !== 0x1f || gz[1] !== 0x8b) throw new Error('解密结果不是 gzip 数据，密钥或流程不匹配')
  const json = zlib.gunzipSync(gz).toString('utf8')
  return JSON.parse(json)
}

const opt = args()
const src = opt.src || DEFAULT_SRC
const file = path.join(src, 'assets/school_info_android_new.txt')
if (!fs.existsSync(file)) {
  console.error('找不到源文件：' + file)
  console.error('用 --src 指定 WakeUp课程表 的反编译目录')
  process.exit(1)
}

const raw = fs.readFileSync(file, 'utf8')
const parsed = decryptSchoolList(raw)
const rows = parsed.data || []
const withUrl = rows.filter((x) => x.url && String(x.url).trim())
const types = new Set(rows.map((x) => x.type || ''))

console.log('源文件      ', file)
console.log('文件字符数  ', raw.replace(/\s/g, '').length)
console.log('解出条数    ', rows.length, '（带教务网址 ' + withUrl.length + ' 条）')
console.log('教务类型数  ', types.size)
console.log('versionTimeLine', parsed.versionTimeLine, 'release', parsed.release)
console.log('前 3 条     ', JSON.stringify(rows.slice(0, 3).map((x) => ({ name: x.name, url: x.url, type: x.type }))))

if (opt.out) {
  fs.writeFileSync(opt.out, JSON.stringify(parsed))
  console.log('明文已导出  ', opt.out)
}

if (opt.check) {
  const mod = await import('../android/app/src/main/assets/www/lib/schools.js')
  const builtin = mod.SCHOOLS
  const expected = rows.map((x) => [
    String(x.name || ''), String(x.url || ''), String(x.type || ''),
    String(x.importType || ''), String(x.sortKey || ''),
  ])
  const same = builtin.length === expected.length &&
    builtin.every((r, i) => r.join('\u0001') === expected[i].join('\u0001'))
  console.log('内置数据    ', builtin.length, '条；逐条一致：' + (same ? '是' : '否'))
  if (!same) process.exit(1)
}
