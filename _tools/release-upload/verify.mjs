#!/usr/bin/env node
// 一致性校验：仓库代码 ↔ Release ↗ 资产 是否对得上。
//
// 校验项（每个版本产物）：
//   1. 产物文件存在，且已提交进仓库；
//   2. 该版本有对应 Release（标签按类型模板生成）；
//   3. Release 里有同名资产，大小与 SHA-256 与本地一致；
//   4. 标签指向的提交 == 最后修改该产物的提交（代码与发布同源）；
//   5. 该提交已在远端分支上（不是本地未推送的孤岛）；
//   6. 有版本说明文件（缺失记为警告，不阻断）。
//
// 用法：
//   node _tools/release-upload/verify.mjs                 # 走 GitHub API，需要 GITHUB_TOKEN
//   node _tools/release-upload/verify.mjs --offline       # 只用 git ls-remote 比对标签，无需令牌
//   node _tools/release-upload/verify.mjs --json out.json
//
// 退出码：存在 drift 级问题时为 1，仅 warning 时为 0。

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { buildPlan, discoverArtifacts, entryKey, tagForEntry, notesRelPath, readNotes } from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

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

function git(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

async function sha256File(file) {
  const h = createHash('sha256');
  const fh = await fs.open(file, 'r');
  try {
    for await (const chunk of fh.createReadStream()) h.update(chunk);
  } finally {
    await fh.close();
  }
  return h.digest('hex');
}

function normalizeDigest(value) {
  return String(value ?? '').toLowerCase().replace(/^sha256:/, '');
}

/**
 * 纯判定函数：只看「本地产物事实」与「远端发布事实」，不联网、不读盘。
 * 返回问题清单，severity 为 drift（必须修）或 warn（提醒）。
 */
export function compareArtifactRelease({ artifact, release = null, asset = null, tagCommit = null, notesPresent = null }) {
  const issues = [];
  const hasNotes = notesPresent ?? artifact.notesPresent ?? true;
  if (!release) {
    issues.push({ code: 'missing-release', severity: 'drift', message: '该版本没有对应的 Release' });
  } else if (!asset) {
    issues.push({ code: 'missing-asset', severity: 'drift', message: 'Release 里没有同名可下载资产' });
  } else {
    if (Number.isFinite(asset.size) && asset.size !== artifact.bytes) {
      issues.push({
        code: 'size-mismatch',
        severity: 'drift',
        message: `资产大小 ${asset.size} 与本地 ${artifact.bytes} 不一致`,
      });
    }
    if (asset.digest && normalizeDigest(asset.digest) !== artifact.sha256) {
      issues.push({
        code: 'digest-mismatch',
        severity: 'drift',
        message: `资产 SHA-256 ${normalizeDigest(asset.digest)} 与本地 ${artifact.sha256} 不一致`,
      });
    }
  }
  if (tagCommit && artifact.commit && tagCommit !== artifact.commit) {
    issues.push({
      code: 'tag-mismatch',
      severity: 'drift',
      message: `标签指向 ${tagCommit.slice(0, 7)}，产物来自 ${artifact.commit.slice(0, 7)}`,
    });
  }
  if (artifact.pushed === false) {
    issues.push({ code: 'not-pushed', severity: 'drift', message: '产物所在提交尚未推送到远端分支' });
  }
  if (!hasNotes) {
    issues.push({ code: 'missing-notes', severity: 'warn', message: `缺少版本说明 ${artifact.notesPath}` });
  }
  return issues;
}

function summarize(items) {
  const counts = { total: items.length, ok: 0, drift: 0, warn: 0 };
  for (const item of items) {
    if (item.issues.some((i) => i.severity === 'drift')) {
      item.status = 'drift';
      counts.drift += 1;
    } else if (item.issues.length) {
      item.status = 'warn';
      counts.warn += 1;
    } else {
      item.status = 'ok';
      counts.ok += 1;
    }
  }
  return { counts, ok: counts.drift === 0 };
}

async function collectEntries(root, manifestPath) {
  const cfg = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const known = new Set((cfg.versions ?? []).map(entryKey));
  const discovered = (await discoverArtifacts(root)).filter((e) => !known.has(entryKey(e)));
  const plan = buildPlan(cfg.versions ?? [], { discovered });
  return { cfg, entries: plan.queue, extra: discovered };
}

async function localFacts(root, cfg, entry) {
  const file = path.resolve(root, entry.file);
  const bytes = await fs.stat(file).then((s) => (s.isFile() ? s.size : null)).catch(() => null);
  const sha256 = bytes === null ? null : await sha256File(file);
  return {
    file: entry.file,
    bytes,
    sha256,
    commit: git(['log', '-1', '--format=%H', '--', entry.file], root),
    notesPath: notesRelPath(entry),
    notesPresent: Boolean(await readNotes(root, entry)),
    tag: entry.tag ?? tagForEntry(cfg, entry),
  };
}

/** 标签是否已推到远端；返回 {exists, sha}。轻量标签与附注标签都兼容。 */
function remoteTags(root, repoUrl) {
  const out = git(['ls-remote', '--tags', repoUrl], root);
  const map = new Map();
  if (!out) return map;
  for (const line of out.split('\n')) {
    const [sha, ref] = line.split('\t');
    if (!sha || !ref) continue;
    const name = ref.replace('refs/tags/', '');
    const peeled = name.endsWith('^{}');
    const key = peeled ? name.slice(0, -3) : name;
    if (!map.has(key) || peeled) map.set(key, sha); // 附注标签取解引用后的提交
  }
  return map;
}

function isOnRemoteBranch(root, commit, branch) {
  if (!commit) return null;
  const fetched = git(['fetch', '--quiet', '--no-tags', 'origin', branch], root);
  if (fetched === null) return null; // 拿不到远端状态就不下结论
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', commit, 'FETCH_HEAD'], {
      cwd: root,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

export async function githubFacts({ cfg, tag, token, fetchImpl = globalThis.fetch, api = 'https://api.github.com' }) {
  const { owner, repo } = cfg.github ?? {};
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'xhub-release-verify',
  };
  const enc = encodeURIComponent;
  const relRes = await fetchImpl(`${api}/repos/${owner}/${repo}/releases/tags/${enc(tag)}`, { headers });
  if (relRes.status === 404) return { release: null, tagCommit: null };
  if (!relRes.ok) throw new Error(`查询 Release ${tag} 失败：HTTP ${relRes.status}`);
  const release = await relRes.json();

  let tagCommit = null;
  const refRes = await fetchImpl(`${api}/repos/${owner}/${repo}/git/ref/tags/${enc(tag)}`, { headers });
  if (refRes.ok) {
    const ref = await refRes.json();
    if (ref.object?.type === 'commit') tagCommit = ref.object.sha;
    else if (ref.object?.type === 'tag') {
      const tagRes = await fetchImpl(`${api}/repos/${owner}/${repo}/git/tags/${ref.object.sha}`, { headers });
      if (tagRes.ok) tagCommit = (await tagRes.json()).object?.sha ?? null;
    }
  }
  return { release, tagCommit };
}

async function main() {
  const { flags, values } = parseArgs(process.argv.slice(2));
  const manifestPath = path.resolve(values.manifest ?? path.join(HERE, 'versions.json'));
  const root = path.resolve(values.root ?? path.resolve(path.dirname(manifestPath), '..', '..'));
  const offline = flags.has('offline');
  const { cfg, entries } = await collectEntries(root, manifestPath);

  const remote = git(['remote', 'get-url', 'origin'], root);
  const branch = cfg.github?.branch ?? 'main';
  const tags = offline && remote ? remoteTags(root, remote) : new Map();

  const token = process.env.GITHUB_TOKEN || cfg.github?.token;
  if (!offline && !token) {
    console.error('[提示] 未提供 GITHUB_TOKEN，改用离线模式（只比对本地提交与远端标签）。');
    process.exitCode = await run({ offline: true });
    return;
  }

  async function run(opts) {
    const items = [];
    for (const entry of entries) {
      const art = await localFacts(root, cfg, entry);
      const issues = [];
      let release = null;
      let asset = null;
      let tagCommit = null;

      if (art.bytes === null) {
        issues.push({ code: 'missing-local', severity: 'drift', message: `本地缺少产物 ${entry.file}` });
      } else if (opts.offline) {
        const hit = tags.get(art.tag);
        if (!hit) {
          issues.push({ code: 'missing-release', severity: 'drift', message: `远端没有标签 ${art.tag}，该版本未发布` });
        } else {
          tagCommit = hit;
          if (art.commit && hit !== art.commit) {
            issues.push({
              code: 'tag-mismatch',
              severity: 'drift',
              message: `标签 ${art.tag} 指向 ${hit.slice(0, 7)}，产物来自 ${art.commit.slice(0, 7)}`,
            });
          }
        }
        if (!art.notesPresent) {
          issues.push({ code: 'missing-notes', severity: 'warn', message: `缺少版本说明 ${art.notesPath}` });
        }
        art.pushed = isOnRemoteBranch(root, art.commit, branch);
        if (art.pushed === false) {
          issues.push({ code: 'not-pushed', severity: 'drift', message: '产物所在提交尚未推送到远端分支' });
        }
      } else {
        const facts = await githubFacts({ cfg, tag: art.tag, token: process.env.GITHUB_TOKEN || cfg.github?.token });
        release = facts.release;
        tagCommit = facts.tagCommit;
        asset = (release?.assets ?? []).find((a) => a.name === path.basename(entry.file)) ?? null;
        art.pushed = isOnRemoteBranch(root, art.commit, branch);
        issues.push(...compareArtifactRelease({ artifact: art, release, asset, tagCommit, notesPresent: art.notesPresent }));
      }

      items.push({
        id: entry.id,
        version: entry.version,
        kind: entry.kind,
        tag: art.tag,
        file: entry.file,
        status: 'pending',
        artifact: { bytes: art.bytes, sha256: art.sha256, commit: art.commit, pushed: art.pushed ?? null },
        release: release
          ? { url: release.html_url, tag: release.tag_name, assets: (release.assets ?? []).map((a) => a.name) }
          : null,
        assetUrl: asset?.browser_download_url ?? null,
        tagCommit,
        issues,
      });
    }

    const verdict = summarize(items);
    const result = {
      repo: cfg.github ? `${cfg.github.owner}/${cfg.github.repo}` : cfg.package,
      mode: opts.offline ? 'offline' : 'api',
      checkedAt: new Date().toISOString(),
      counts: verdict.counts,
      ok: verdict.ok,
      items,
    };
    const text = JSON.stringify(result, null, 2);
    process.stdout.write(`${text}\n`);
    if (values.json) {
      const out = path.resolve(values.json);
      await fs.mkdir(path.dirname(out), { recursive: true });
      await fs.writeFile(out, `${text}\n`, 'utf8');
    }
    for (const item of items) {
      if (item.status === 'ok') {
        console.error(`[一致] ${item.tag} | ${item.file}`);
      } else {
        console.error(`[${item.status === 'drift' ? '不一致' : '提醒'}] ${item.tag} | ${item.issues.map((i) => i.message).join('；')}`);
      }
    }
    return verdict.ok ? 0 : 1;
  }

  process.exitCode = await run({ offline });
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  main().catch((err) => {
    console.error(`[中止] ${err?.message ?? err}`);
    process.exitCode = 1;
  });
}
