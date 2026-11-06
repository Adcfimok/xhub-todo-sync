#!/usr/bin/env node
// 本地发布前哨：把新产物登记进版本清单并推到远端，交给 Actions 建 Release。
//
// 用法：
//   node _tools/release-upload/sync.mjs            # 只体检：有哪些产物还没发布
//   node _tools/release-upload/sync.mjs --push     # 登记新产物 + 提交 + 推送（触发自动发布）
//   node _tools/release-upload/sync.mjs --push --dry-run   # 只看会提交什么
//
// 为什么不在本地直接建 Release：本机没有长期有效的 GITHUB_TOKEN。
// 推送后由 .github/workflows/publish-releases.yml 用平台令牌建 Release，
// 这样令牌不落地，标签也能钉在正确的提交上。
//
// 退出码：0 正常；1 执行失败（推送被拒、git 状态异常等）。

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { discoverArtifacts, entryKey, readNotes, notesRelPath, KIND_META } from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const MANIFEST = path.join(HERE, 'versions.json');

function parseArgs(argv) {
  const flags = new Set();
  const values = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    const key = arg.slice(2, eq === -1 ? undefined : eq);
    if (eq !== -1) values[key] = arg.slice(eq + 1);
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) values[key] = argv[++i];
    else flags.add(key);
  }
  return { flags, values };
}

function git(args, { allowFail = false } = {}) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    if (allowFail) return null;
    throw new Error(`git ${args.join(' ')} 失败：${(err.stderr ?? err.message ?? '').toString().trim()}`);
  }
}

async function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  const dryRun = flags.has('dry-run');
  const shouldPush = flags.has('push');

  const cfg = JSON.parse(await fs.readFile(MANIFEST, 'utf8'));
  const declared = cfg.versions ?? [];
  const known = new Map(declared.map((e) => [entryKey(e), e]));
  const found = await discoverArtifacts(ROOT);

  const rows = [];
  const missing = [];
  for (const art of found) {
    const key = entryKey(art);
    const inManifest = known.has(key);
    const hasNotes = Boolean(await readNotes(ROOT, art));
    rows.push({ ...art, inManifest, hasNotes, notesPath: notesRelPath(art) });
    if (!inManifest) missing.push(art);
  }
  const missingNotes = rows.filter((r) => !r.hasNotes);

  const dirty = git(['status', '--porcelain'], { allowFail: true }) ?? '';
  const result = {
    root: ROOT,
    checkedAt: new Date().toISOString(),
    manifest: path.relative(ROOT, MANIFEST).replace(/\\/g, '/'),
    artifacts: rows.map((r) => ({
      file: r.file,
      kind: r.kind,
      version: r.version,
      inManifest: r.inManifest,
      hasNotes: r.hasNotes,
      notesPath: r.notesPath,
    })),
    missingFromManifest: missing.map((m) => m.file),
    missingNotes: missingNotes.map((r) => r.notesPath),
    workingTreeDirty: Boolean(dirty),
    needsPush: missing.length > 0,
    pushed: false,
    commit: null,
  };

  if (shouldPush && missing.length) {
    const added = missing.map((m) => ({
      id: m.id,
      version: m.version,
      kind: m.kind,
      file: m.file,
    }));
    cfg.versions = [...declared, ...added];
    if (!dryRun) {
      await fs.writeFile(MANIFEST, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
      const paths = [
        path.relative(ROOT, MANIFEST).replace(/\\/g, '/'),
        ...missing.map((m) => m.file),
        '_tools/release-upload/notes',
      ];
      git(['add', '--', ...paths]);
      const stamp = added.map((a) => `${KIND_META[a.kind]?.label ?? a.kind} v${a.version}`).join('、');
      git(['commit', '-m', `release: 新增 ${stamp}`]);
      // 远端可能已有 Actions 回写的提交，先 rebase 再推，避免非快进被拒
      git(['pull', '--rebase', '--autostash', '--quiet', 'origin', cfg.github?.branch ?? 'main']);
      git(['push', 'origin', `HEAD:${cfg.github?.branch ?? 'main'}`]);
      result.pushed = true;
      result.commit = git(['rev-parse', 'HEAD']);
      result.needsPush = false;
    }
  }

  const text = JSON.stringify(result, null, 2);
  process.stdout.write(`${text}\n`);

  if (!dryRun) {
    if (missing.length === 0) {
      console.error('[就绪] 版本清单已覆盖全部产物，无需推送。');
    } else if (shouldPush) {
      console.error(`[已推送] 登记 ${missing.length} 个新产物，Actions 将创建对应 Release。`);
    } else {
      console.error(`[待发布] ${missing.length} 个产物未登记：${missing.map((m) => m.file).join('、')}`);
      console.error('         加上 --push 即可登记并推送，触发自动发布。');
    }
    if (missingNotes.length) {
      console.error(`[提醒] ${missingNotes.length} 个版本缺说明文件，Release 正文会退化为事实型兜底：`);
      for (const r of missingNotes) console.error(`        ${r.notesPath}`);
    }
  }
}

main().catch((err) => {
  console.error(`[中止] ${err?.message ?? err}`);
  process.exitCode = 1;
});
