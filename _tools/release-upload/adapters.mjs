// 目标软件包适配器。所有适配器实现同一接口：
//   { name, describe(), exists(rec) -> boolean, upload(rec, meta) -> { url } }
// 新增目标只需实现该接口并在 createAdapter 中登记，执行逻辑无需改动。

import fs from 'node:fs/promises';
import path from 'node:path';
import { tagForEntry, releaseNameFor, isPrerelease, KIND_META } from './lib.mjs';

function artifactName(rec) {
  return path.basename(rec.file);
}

/** 本地目录适配器：把产物复制到指定目录，用于预演、测试与离线归档。 */
function localAdapter(cfg) {
  const dir = path.resolve(cfg.local?.dir ?? '_tools/release-upload/outbox');
  return {
    name: 'local',
    describe() {
      return { package: cfg.package, dir };
    },
    async exists(rec) {
      try {
        await fs.access(path.join(dir, artifactName(rec)));
        return true;
      } catch {
        return false;
      }
    },
    async upload(rec, meta) {
      await fs.mkdir(dir, { recursive: true });
      const dest = path.join(dir, artifactName(rec));
      await fs.copyFile(meta.absolutePath, dest);
      return { url: `file:///${dest.replace(/\\/g, '/')}` };
    },
  };
}

/**
 * GitHub Releases 适配器：一个版本产物对应一条 Release，资产可下载。
 * 需要 GITHUB_TOKEN（repo 权限），Actions 里用内置令牌即可。
 *
 * 一致性保证：
 *   1. 标签按类型模板生成（如 xhub-ext-v2.1.0 / android-v2.8.0），一个版本一条；
 *   2. 建 Release 前先把标签显式打到「包含该产物的提交」上，
 *      避免 GitHub 默认把标签建到当时默认分支最新提交、导致代码与发布错位；
 *   3. Release 正文取版本说明文件，缺失时回退为事实型正文。
 * fetchImpl 可注入，便于在不联网的情况下做确定性单测。
 */
function githubAdapter(cfg, { fetchImpl = globalThis.fetch } = {}) {
  const token = process.env.GITHUB_TOKEN || cfg.github?.token;
  if (!token) {
    throw new Error('目标软件包为 GitHub Releases，但未提供 GITHUB_TOKEN 环境变量（需 repo 权限）');
  }
  const { owner, repo } = cfg.github ?? {};
  if (!owner || !repo) {
    throw new Error('github-releases 适配器需要 github.owner / github.repo');
  }
  const api = 'https://api.github.com';
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'xhub-release-uploader',
  };
  const jsonHeaders = { ...headers, 'Content-Type': 'application/json' };
  const releases = new Map();

  function tagFor(rec) {
    return rec.tag ?? tagForEntry(cfg, rec);
  }
  function nameFor(rec) {
    return rec.releaseName ?? releaseNameFor(cfg, rec);
  }

  async function readError(res) {
    try {
      return (await res.text()).slice(0, 300);
    } catch {
      return '<无响应正文>';
    }
  }

  /** 确保标签存在，且指向指定提交；不传 commit 时交给 GitHub 默认行为。 */
  async function ensureTag(tag, commit) {
    if (!commit) return null;
    const existing = await fetchImpl(`${api}/repos/${owner}/${repo}/git/ref/tags/${encodeURIComponent(tag)}`, { headers });
    if (existing.status === 200) return existing.json();
    if (existing.status !== 404) {
      throw new Error(`查询标签 ${tag} 失败：HTTP ${existing.status} ${await readError(existing)}`);
    }
    const created = await fetchImpl(`${api}/repos/${owner}/${repo}/git/refs`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ ref: `refs/tags/${tag}`, sha: commit }),
    });
    // 422 多为并发下已被另一进程创建，继续按已存在处理
    if (!created.ok && created.status !== 422) {
      throw new Error(`创建标签 ${tag}（指向 ${commit.slice(0, 7)}）失败：HTTP ${created.status} ${await readError(created)}`);
    }
    return created.ok ? created.json() : null;
  }

  async function fetchReleaseByTag(tag) {
    const res = await fetchImpl(`${api}/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`, { headers });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`查询 Release ${tag} 失败：HTTP ${res.status} ${await readError(res)}`);
    return res.json();
  }

  async function ensureRelease(rec) {
    const tag = tagFor(rec);
    if (releases.has(tag)) return releases.get(tag);
    let release = await fetchReleaseByTag(tag);
    if (!release) {
      const meta = KIND_META[rec.kind] ?? {};
      await ensureTag(tag, rec.commit);
      const body = {
        tag_name: tag,
        name: nameFor(rec),
        body: rec.notes ?? `## ${meta.label ?? rec.kind} ${rec.version}\n\n由 _tools/release-upload 发布。`,
        draft: false,
        prerelease: isPrerelease(rec.version),
      };
      if (rec.commit) body.target_commitish = rec.commit;
      const res = await fetchImpl(`${api}/repos/${owner}/${repo}/releases`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify(body),
      });
      if (res.status === 422) {
        // 并发创建时回读一次，仍拿不到才报错
        release = await fetchReleaseByTag(tag);
        if (!release) throw new Error(`创建 Release ${tag} 返回 422：${await readError(res)}`);
      } else if (!res.ok) {
        throw new Error(`创建 Release ${tag} 失败：HTTP ${res.status} ${await readError(res)}`);
      } else {
        release = await res.json();
      }
    }
    releases.set(tag, release);
    return release;
  }

  return {
    name: 'github-releases',
    describe() {
      return {
        package: cfg.package,
        owner,
        repo,
        strategy: 'per-version',
        tagTemplates: cfg.github.tagTemplates ?? { default: cfg.github.releaseTag ?? '{tagPrefix}-v{version}' },
      };
    },
    async exists(rec) {
      const release = await ensureRelease(rec);
      return (release.assets ?? []).some((a) => a.name === artifactName(rec));
    },
    async upload(rec, meta) {
      const release = await ensureRelease(rec);
      const name = artifactName(rec);
      const body = await fs.readFile(meta.absolutePath);
      const res = await fetchImpl(
        `https://uploads.github.com/repos/${owner}/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
        {
          method: 'POST',
          headers: {
            ...headers,
            'Content-Type': cfg.github.contentType ?? 'application/octet-stream',
          },
          body,
        },
      );
      if (!res.ok) {
        throw new Error(`上传资产 ${name} 到 Release ${tagFor(rec)} 失败：HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
      }
      const json = await res.json();
      return { url: json.browser_download_url };
    },
  };
}

export function createAdapter(cfg, options = {}) {
  switch (cfg.adapter) {
    case 'local':
      return localAdapter(cfg);
    case 'github-releases':
      return githubAdapter(cfg, options);
    default:
      throw new Error(`未知目标软件包适配器：${cfg.adapter}（可选 local / github-releases）`);
  }
}
