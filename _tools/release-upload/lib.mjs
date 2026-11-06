// 版本顺序、去重、执行与汇总的纯逻辑层。
// 设计要点：清单给定顺序优先；未指定时按版本号从旧到新；
// 同一「版本 + 类型」只上传一次；任一失败立即停止且后续逐条记为未处理；
// 每个条目都有状态记录，汇总中 success + failed + skipped + unprocessed === total。

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const STATUSES = ['success', 'failed', 'skipped', 'unprocessed'];

/** 解析版本号：支持 v 前缀、1 / 1.2 / 1.2.3、预发布标签、构建元数据。 */
export function parseVersion(raw) {
  const s = String(raw ?? '').trim().replace(/^v/i, '');
  const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(s);
  if (!m) throw new Error(`无法解析版本号: ${JSON.stringify(raw)}`);
  return {
    major: Number(m[1]),
    minor: Number(m[2] ?? 0),
    patch: Number(m[3] ?? 0),
    pre: m[4] ? m[4].split('.') : [],
  };
}

function compareIdentifier(a, b) {
  const na = /^\d+$/.test(a);
  const nb = /^\d+$/.test(b);
  if (na && nb) {
    const x = Number(a);
    const y = Number(b);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  if (na) return -1; // 数字标识符优先级低于非数字标识符
  if (nb) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 语义化版本比较，返回 -1 / 0 / 1，可直接用于 Array.sort（旧到新）。 */
export function compareVersion(a, b) {
  const A = typeof a === 'string' ? parseVersion(a) : a;
  const B = typeof b === 'string' ? parseVersion(b) : b;
  for (const key of ['major', 'minor', 'patch']) {
    if (A[key] !== B[key]) return A[key] < B[key] ? -1 : 1;
  }
  if (A.pre.length === 0 && B.pre.length === 0) return 0;
  if (A.pre.length === 0) return 1; // 正式版新于预发布版
  if (B.pre.length === 0) return -1;
  const n = Math.max(A.pre.length, B.pre.length);
  for (let i = 0; i < n; i += 1) {
    if (A.pre[i] === undefined) return -1;
    if (B.pre[i] === undefined) return 1;
    const c = compareIdentifier(A.pre[i], B.pre[i]);
    if (c !== 0) return c;
  }
  return 0;
}

/** 同一版本 + 同一类型视为同一产物，用于去重与幂等判定。 */
export function entryKey(entry) {
  return `${String(entry.version).replace(/^v/i, '')}::${entry.kind}`;
}

/** 产物类型元信息：标签前缀、中文名、产物目录，供标签/标题/说明文件命名复用。 */
export const KIND_META = {
  'xhub-extension': { label: 'x-hub 待办同步扩展', tagPrefix: 'xhub-ext', dir: 'dist' },
  'android-apk': { label: '待办同步 安卓端', tagPrefix: 'android', dir: 'android' },
};

function baseRecord(entry) {
  const rec = {
    id: entry.id,
    version: entry.version,
    kind: entry.kind,
    file: entry.file,
    source: entry.source ?? 'manifest',
    order: Number.isFinite(entry.order) ? entry.order : null,
    status: 'pending',
    reason: null,
    bytes: null,
    sha256: null,
    target: null,
    uploadedAt: null,
  };
  // 发布信息向下传递：适配器需要 tag / 提交 / 说明正文才能建出与代码一致的 Release
  for (const key of ['tag', 'commit', 'notes', 'releaseName']) {
    if (entry[key]) rec[key] = entry[key];
  }
  return rec;
}

/** 填充模板占位符：{version} / {kind} / {tagPrefix} / {label}。 */
export function fillTemplate(template, entry) {
  const meta = KIND_META[entry.kind] ?? {};
  return String(template)
    .replaceAll('{version}', String(entry.version).replace(/^v/i, ''))
    .replaceAll('{kind}', entry.kind)
    .replaceAll('{tagPrefix}', meta.tagPrefix ?? entry.kind)
    .replaceAll('{label}', meta.label ?? entry.kind);
}

/**
 * 解析某个产物的 Release 标签。
 * 优先级：条目自带 tag > 按类型的 tagTemplates > 全局 releaseTag（固定值，兼容旧的归档式发布）。
 */
export function tagForEntry(cfg, entry) {
  if (entry.tag) return entry.tag;
  const templates = cfg?.github?.tagTemplates ?? {};
  const tpl = templates[entry.kind] ?? cfg?.github?.releaseTag ?? '{tagPrefix}-v{version}';
  return fillTemplate(tpl, entry);
}

/** 解析 Release 标题，可按类型配置 nameTemplates。 */
export function releaseNameFor(cfg, entry) {
  const templates = cfg?.github?.nameTemplates ?? {};
  const tpl = templates[entry.kind] ?? '{label} v{version}';
  return fillTemplate(tpl, entry);
}

/** 版本说明文件的仓库相对路径。 */
export function notesRelPath(entry) {
  return `_tools/release-upload/notes/${entry.kind}-${String(entry.version).replace(/^v/i, '')}.md`;
}

/** 读取版本说明；没有就返回 null，由调用方决定用事实型兜底正文。 */
export async function readNotes(root, entry) {
  try {
    const text = await fs.readFile(path.resolve(root, notesRelPath(entry)), 'utf8');
    return text.trim() ? text.trim() : null;
  } catch {
    return null;
  }
}

/**
 * 兜底正文：只写可核验的事实（产物信息 + 来源提交），不编造变更内容。
 * 缺说明文件时用它，避免发布出空白的 Release 说明。
 */
export function renderFallbackNotes({ entry, bytes = null, sha256 = null, commit = null }) {
  const meta = KIND_META[entry.kind] ?? {};
  const lines = [
    `> 未找到版本说明文件 \`${notesRelPath(entry)}\`，以下为产物事实信息（不含推测性变更描述）。`,
    '',
    '## 产物',
    '',
    '| 项目 | 值 |',
    '| --- | --- |',
    `| 类型 | ${meta.label ?? entry.kind} |`,
    `| 版本 | ${entry.version} |`,
    `| 文件 | \`${path.basename(entry.file)}\` |`,
    bytes === null ? null : `| 大小 | ${bytes} 字节 |`,
    sha256 ? `| SHA-256 | \`${sha256}\` |` : null,
    commit ? `| 来源提交 | \`${commit.slice(0, 7)}\` |` : null,
    '',
  ].filter(Boolean);
  return lines.join('\n');
}

/** 预发布版本（带 -rc / -beta 等）自动标记，避免正式用户误装。 */
export function isPrerelease(version) {
  return parseVersion(version).pre.length > 0;
}

function validate(entry, index) {
  for (const field of ['id', 'version', 'kind', 'file']) {
    if (!entry[field] || typeof entry[field] !== 'string') {
      throw new Error(`清单第 ${index + 1} 条缺少字段 ${field}：${JSON.stringify(entry)}`);
    }
  }
  parseVersion(entry.version); // 非法版本号在计划阶段就暴露，不静默忽略
  if (Number.isFinite(entry.order) && !Number.isInteger(entry.order)) {
    throw new Error(`清单第 ${index + 1} 条的 order 必须是整数：${entry.id}`);
  }
}

/**
 * 生成上传计划。
 * - 清单条目在前，自动发现条目在后；同键去重，重复项记为 skipped。
 * - 只要清单里出现任一显式 order，就有 order 的按 order 升序优先；
 *   没有 order 的按版本号从旧到新排在其后。
 * - 完全没有 order 时，全部按版本号从旧到新；同版本按 kind、原始下标稳定排序。
 */
export function buildPlan(entries, { discovered = [] } = {}) {
  const all = [
    ...entries.map((e, i) => ({ ...e, source: 'manifest', _index: i })),
    ...discovered.map((e, i) => ({ ...e, source: 'discovered', _index: entries.length + i })),
  ];
  all.forEach(validate);

  const seen = new Map();
  const queue = [];
  const duplicates = [];
  for (const entry of all) {
    const key = entryKey(entry);
    if (seen.has(key)) {
      const rec = baseRecord(entry);
      rec.status = 'skipped';
      rec.reason = `重复条目：与 ${seen.get(key).id} 指向同一版本与类型，跳过以避免重复上传`;
      duplicates.push(rec);
      continue;
    }
    seen.set(key, entry);
    queue.push(entry);
  }

  const hasExplicitOrder = queue.some((e) => Number.isFinite(e.order));
  queue.sort((a, b) => {
    if (hasExplicitOrder) {
      const ao = Number.isFinite(a.order) ? a.order : Number.POSITIVE_INFINITY;
      const bo = Number.isFinite(b.order) ? b.order : Number.POSITIVE_INFINITY;
      if (ao !== bo) return ao < bo ? -1 : 1;
    }
    const c = compareVersion(a.version, b.version);
    if (c !== 0) return c;
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    return a._index - b._index;
  });

  return {
    queue,
    duplicates,
    orderSource: hasExplicitOrder ? 'manifest-order' : 'version-asc',
  };
}

/** 扫描实际存在的分发产物；只收 dist 根目录的扩展包与 android 根目录的正式 APK。 */
export async function discoverArtifacts(root = process.cwd()) {
  const found = [];
  const extDir = path.join(root, 'dist');
  const apkDir = path.join(root, 'android');
  for (const [dir, matcher, kind, idPrefix] of [
    [extDir, (n) => /^com\.zhou\.todo-relay-(\d+(?:\.\d+)*)\.zip$/i.exec(n)?.[1] ?? null, 'xhub-extension', 'xhub-ext'],
    [apkDir, (n) => /^todo-link-(\d+(?:\.\d+)*)\.apk$/i.exec(n)?.[1] ?? null, 'android-apk', 'android-apk'],
  ]) {
    let names;
    try {
      names = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      const version = matcher(name);
      if (!version) continue;
      const rel = path.relative(root, path.join(dir, name)).replace(/\\/g, '/');
      found.push({ id: `${idPrefix}-${version}`, version, kind, file: rel });
    }
  }
  return found;
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

/**
 * 依次执行上传。adapter 需实现 { name, exists(rec), upload(rec) }。
 * 失败即停：首个失败条目标记为 failed 并写入 failure；后续条目逐个记为 unprocessed。
 * onEvent 在每条记录定稿后调用一次，供命令行实时打印。
 */
export async function executePlan({ queue, duplicates = [], adapter, options = {}, onEvent = () => {} }) {
  const startedAt = new Date().toISOString();
  const root = options.root ?? process.cwd();
  const results = [...duplicates];
  let failure = null;

  for (const entry of queue) {
    const rec = baseRecord(entry);
    if (failure) {
      rec.status = 'unprocessed';
      rec.reason = `前置版本 ${failure.id} 上传失败（${failure.reason}），按失败即停策略未处理`;
      results.push(rec);
      onEvent(rec);
      continue;
    }

    try {
      const absolutePath = path.resolve(root, entry.file);
      const st = await fs.stat(absolutePath);
      if (!st.isFile()) throw new Error(`产物不是普通文件：${entry.file}`);
      rec.bytes = st.size;
      rec.sha256 = await sha256File(absolutePath);
      // 说明正文在拿到大小/校验和之后再兜底，正文里的事实才是准确的
      if (!rec.notes && typeof options.notesFor === 'function') rec.notes = options.notesFor(rec);

      if (options.dryRun) {
        rec.status = 'success';
        rec.reason = '预演模式：产物与校验和已校验，未写入目标软件包';
      } else if (!options.force && (await adapter.exists(rec))) {
        rec.status = 'skipped';
        rec.reason = '目标软件包已存在同名产物，幂等跳过';
      } else {
        const out = await adapter.upload(rec, { absolutePath, force: Boolean(options.force) });
        rec.status = 'success';
        rec.target = out?.url ?? out?.path ?? null;
        rec.uploadedAt = new Date().toISOString();
      }
    } catch (err) {
      rec.status = 'failed';
      rec.reason = err?.message ?? String(err);
      failure = { id: rec.id, version: rec.version, kind: rec.kind, file: rec.file, reason: rec.reason };
    }

    results.push(rec);
    onEvent(rec);
  }

  return summarize({
    packageName: options.package,
    adapterName: adapter.name,
    orderSource: options.orderSource,
    results,
    failure,
    startedAt,
    finishedAt: new Date().toISOString(),
  });
}

/** 构造结构化汇总，并校验四类计数之和等于总条目数（防止遗漏）。 */
export function summarize({ packageName, adapterName, orderSource, results, failure, startedAt, finishedAt }) {
  const counts = { total: results.length, success: 0, failed: 0, skipped: 0, unprocessed: 0 };
  for (const rec of results) {
    if (!STATUSES.includes(rec.status)) throw new Error(`未知状态：${rec.id} -> ${rec.status}`);
    counts[rec.status] += 1;
  }
  const sum = counts.success + counts.failed + counts.skipped + counts.unprocessed;
  const ids = results.map((r) => r.id);
  return {
    package: packageName,
    adapter: adapterName,
    orderSource,
    actualOrder: ids,
    results,
    counts,
    failure: failure ?? null,
    integrity: {
      allAccounted: sum === counts.total,
      uniqueIds: new Set(ids).size === ids.length,
    },
    startedAt,
    finishedAt,
  };
}
