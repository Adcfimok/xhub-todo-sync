// 目标软件包适配器。所有适配器实现同一接口：
//   { name, describe(), exists(rec) -> boolean, upload(rec, meta) -> { url } }
// 新增目标只需实现该接口并在 createAdapter 中登记，执行逻辑无需改动。

import fs from 'node:fs/promises';
import path from 'node:path';

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

/** GitHub Releases 适配器：把每个产物作为 Release 资产上传。需要 GITHUB_TOKEN。 */
function githubAdapter(cfg) {
  const token = process.env.GITHUB_TOKEN || cfg.github?.token;
  if (!token) {
    throw new Error('目标软件包为 github-releases，但未提供 GITHUB_TOKEN 环境变量（需 repo 权限）');
  }
  const { owner, repo, releaseTag } = cfg.github ?? {};
  if (!owner || !repo || !releaseTag) {
    throw new Error('github-releases 适配器需要 github.owner / github.repo / github.releaseTag');
  }
  const api = 'https://api.github.com';
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'xhub-release-uploader',
  };
  let cachedRelease = null;

  async function ensureRelease() {
    if (cachedRelease) return cachedRelease;
    let res = await fetch(`${api}/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(releaseTag)}`, { headers });
    if (res.status === 404) {
      res = await fetch(`${api}/repos/${owner}/${repo}/releases`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tag_name: releaseTag,
          name: cfg.github.releaseName ?? releaseTag,
          body: 'x-hub 扩展与安卓端历史版本产物，由 _tools/release-upload 按版本顺序上传。',
          draft: false,
          prerelease: false,
        }),
      });
    }
    if (!res.ok) {
      throw new Error(`获取或创建 Release 失败：HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    }
    cachedRelease = await res.json();
    return cachedRelease;
  }

  return {
    name: 'github-releases',
    describe() {
      return { package: cfg.package, owner, repo, releaseTag };
    },
    async exists(rec) {
      const release = await ensureRelease();
      return (release.assets ?? []).some((a) => a.name === artifactName(rec));
    },
    async upload(rec, meta) {
      const release = await ensureRelease();
      const name = artifactName(rec);
      const body = await fs.readFile(meta.absolutePath);
      const res = await fetch(
        `https://uploads.github.com/repos/${owner}/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
        {
          method: 'POST',
          headers: {
            ...headers,
            'Content-Type': cfg.github.contentType ?? 'application/octet-stream',
            'Content-Length': String(body.length),
          },
          body,
        },
      );
      if (!res.ok) {
        throw new Error(`上传资产 ${name} 失败：HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
      }
      const json = await res.json();
      return { url: json.browser_download_url };
    },
  };
}

export function createAdapter(cfg) {
  switch (cfg.adapter) {
    case 'local':
      return localAdapter(cfg);
    case 'github-releases':
      return githubAdapter(cfg);
    default:
      throw new Error(`未知目标软件包适配器：${cfg.adapter}（可选 local / github-releases）`);
  }
}
