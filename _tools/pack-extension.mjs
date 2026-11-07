#!/usr/bin/env node
// 把 extensions/todo-relay 打成 x-hub 可安装的 zip。
//
// 用法：
//   node _tools/pack-extension.mjs            # 按 manifest.json 的版本打包
//   node _tools/pack-extension.mjs --check    # 只校验产物是否与源码一致，不写文件
//
// 产物：dist/<id>-<version>/ 与 dist/<id>-<version>.zip
// 排除：.data（本地运行时数据）、.permissions.json（授权状态）、node_modules
// 打包用 python 的 zipfile：不压缩目录项、保留文件顺序，和历史上传的包结构一致。

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SRC = path.join(ROOT, 'extensions/todo-relay');
const MANIFEST = path.join(SRC, 'manifest.json');

const SKIP = new Set(['.data', '.permissions.json', 'node_modules']);

async function copyDir(from, to, rel = '') {
  await fs.mkdir(to, { recursive: true });
  const entries = await fs.readdir(from, { withFileTypes: true });
  const copied = [];
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const src = path.join(from, e.name);
    const dst = path.join(to, e.name);
    const relPath = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      copied.push(...(await copyDir(src, dst, relPath)));
    } else {
      await fs.copyFile(src, dst);
      copied.push(relPath);
    }
  }
  return copied;
}

async function listRel(dir, rel = '') {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    const relPath = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await listRel(path.join(dir, e.name), relPath)));
    else out.push(relPath);
  }
  return out.sort();
}

const args = new Set(process.argv.slice(2));
const manifest = JSON.parse(await fs.readFile(MANIFEST, 'utf8'));
const id = manifest.id;
const version = manifest.version;
const stem = `${id}-${version}`;
const outDir = path.join(ROOT, 'dist', stem);
const outZip = path.join(ROOT, 'dist', `${stem}.zip`);

const files = await copyDir(SRC, outDir);

const py = `
import zipfile, os, sys
root, out = sys.argv[1], sys.argv[2]
names = sorted(os.path.relpath(os.path.join(d, f), root).replace(os.sep, '/')
               for d, _, fs in os.walk(root) for f in fs)
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for n in names:
        z.write(os.path.join(root, n), n)
print(len(names))
`;

if (args.has('--check')) {
  const existing = await fs.readdir(path.join(ROOT, 'dist')).catch(() => []);
  const zipName = `${stem}.zip`;
  console.log(JSON.stringify({ id, version, expected: files.length, zipPresent: existing.includes(zipName) }));
} else {
  const count = execFileSync('python', ['-c', py, outDir, outZip], { encoding: 'utf8' }).trim();
  const st = await fs.stat(outZip);
  const names = await listRel(outDir);
  console.log(JSON.stringify({
    id, version,
    dir: path.relative(ROOT, outDir).replace(/\\/g, '/'),
    zip: path.relative(ROOT, outZip).replace(/\\/g, '/'),
    files: Number(count),
    bytes: st.size,
    entries: names,
  }, null, 2));
}
