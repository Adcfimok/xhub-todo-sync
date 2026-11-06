// 运行：node --test _tools/release-upload/upload.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  parseVersion,
  compareVersion,
  buildPlan,
  discoverArtifacts,
  executePlan,
  summarize,
  tagForEntry,
  releaseNameFor,
  renderFallbackNotes,
  isPrerelease,
} from './lib.mjs';
import { createAdapter } from './adapters.mjs';
import { compareArtifactRelease, githubFacts } from './verify.mjs';

function memoryAdapter({ failOn = null, preset = [] } = {}) {
  const store = new Set(preset);
  return {
    name: 'memory',
    async exists(rec) {
      return store.has(rec.id);
    },
    async upload(rec) {
      if (failOn === rec.id) throw new Error('模拟目标软件包返回 HTTP 503');
      store.add(rec.id);
      return { url: `mem://${rec.id}` };
    },
  };
}

async function tempRoot(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xhub-release-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function entries(...ids) {
  return ids.map((id) => ({
    id,
    version: id.replace(/^[a-z-]+/, '').replace(/-/g, '.'),
    kind: id.startsWith('ext') ? 'xhub-extension' : 'android-apk',
    file: `${id}.bin`,
  }));
}

test('版本号按数值分段比较，2.10.0 新于 2.9.0，正式版新于预发布版', () => {
  const sorted = ['2.10.0', '2.9.0', '2.4.1', '2.4.0', 'v1.0.0', '2.8.0-rc.1', '2.8.0']
    .sort(compareVersion)
    .map((v) => v.replace(/^v/i, ''));
  assert.deepEqual(sorted, ['1.0.0', '2.4.0', '2.4.1', '2.8.0-rc.1', '2.8.0', '2.9.0', '2.10.0']);
  assert.equal(compareVersion('1.2', '1.2.0'), 0);
  assert.deepEqual(parseVersion('v2.8.0+build.5'), { major: 2, minor: 8, patch: 0, pre: [] });
});

test('清单未给顺序时，按版本号从旧到新排列', () => {
  const list = [
    { id: 'apk-2-8-0', version: '2.8.0', kind: 'android-apk', file: 'c.apk' },
    { id: 'ext-2-1-0', version: '2.1.0', kind: 'xhub-extension', file: 'a.zip' },
    { id: 'apk-2-4-1', version: '2.4.1', kind: 'android-apk', file: 'b.apk' },
  ];
  const { queue, orderSource, duplicates } = buildPlan(list);
  assert.equal(orderSource, 'version-asc');
  assert.deepEqual(queue.map((e) => e.id), ['ext-2-1-0', 'apk-2-4-1', 'apk-2-8-0']);
  assert.equal(duplicates.length, 0);
});

test('清单给定 order 时优先按 order，未标的条目按版本号排在其后', () => {
  const list = [
    { id: 'A', version: '2.8.0', kind: 'android-apk', file: 'a', order: 1 },
    { id: 'B', version: '2.1.0', kind: 'xhub-extension', file: 'b' },
    { id: 'C', version: '2.4.0', kind: 'android-apk', file: 'c', order: 2 },
    { id: 'D', version: '2.2.0', kind: 'xhub-extension', file: 'd' },
  ];
  const { queue, orderSource } = buildPlan(list);
  assert.equal(orderSource, 'manifest-order');
  assert.deepEqual(queue.map((e) => e.id), ['A', 'C', 'B', 'D']);
});

test('同一版本 + 同一类型去重，重复项记 skipped 且写明原因', () => {
  const list = [
    { id: 'X', version: '2.8.0', kind: 'android-apk', file: 'a.apk' },
    { id: 'Y', version: '2.8.0', kind: 'android-apk', file: 'b.apk' },
    { id: 'Z', version: '2.8.0', kind: 'xhub-extension', file: 'c.zip' },
  ];
  const { queue, duplicates } = buildPlan(list);
  assert.equal(queue.length, 2);
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0].id, 'Y');
  assert.equal(duplicates[0].status, 'skipped');
  assert.match(duplicates[0].reason, /重复/);
});

test('自动发现只收扩展 zip 与正式 APK，排除签名旁文件和构建中间产物', async (t) => {
  const root = await tempRoot(t);
  await fs.mkdir(path.join(root, 'dist'));
  await fs.mkdir(path.join(root, 'android', 'build'), { recursive: true });
  await fs.writeFile(path.join(root, 'dist', 'com.zhou.todo-relay-2.1.0.zip'), 'zip');
  await fs.writeFile(path.join(root, 'android', 'todo-link-2.8.0.apk'), 'apk');
  await fs.writeFile(path.join(root, 'android', 'todo-link-2.8.0.apk.idsig'), 'sig');
  await fs.writeFile(path.join(root, 'android', 'build', 'unsigned.apk'), 'tmp');
  const found = await discoverArtifacts(root);
  assert.equal(found.length, 2);
  assert.deepEqual(found.map((f) => f.id).sort(), ['android-apk-2.8.0', 'xhub-ext-2.1.0']);
});

test('自动发现补入清单外产物，覆盖所有版本且不重复', () => {
  const list = [{ id: 'ext-2.1.0', version: '2.1.0', kind: 'xhub-extension', file: 'dist/a.zip' }];
  const discovered = [
    { id: 'xhub-ext-2.1.0', version: '2.1.0', kind: 'xhub-extension', file: 'dist/a.zip' },
    { id: 'android-apk-2.8.0', version: '2.8.0', kind: 'android-apk', file: 'android/b.apk' },
  ];
  const { queue, duplicates } = buildPlan(list, { discovered });
  assert.equal(queue.length, 2);
  assert.equal(duplicates.length, 1);
  assert.deepEqual(queue.map((e) => e.id), ['ext-2.1.0', 'android-apk-2.8.0']);
});

test('全部成功时，实际上传顺序与汇总计数完整', async (t) => {
  const root = await tempRoot(t);
  const list = entries('ext-2-1-0', 'apk-2-7-0', 'apk-2-8-0');
  for (const e of list) await fs.writeFile(path.join(root, e.file), e.id);
  const { queue, orderSource } = buildPlan(list);
  const summary = await executePlan({
    queue,
    adapter: memoryAdapter(),
    options: { root, package: 'unit/package', orderSource },
  });
  assert.equal(summary.package, 'unit/package');
  assert.deepEqual(summary.actualOrder, ['ext-2-1-0', 'apk-2-7-0', 'apk-2-8-0']);
  assert.deepEqual(summary.counts, { total: 3, success: 3, failed: 0, skipped: 0, unprocessed: 0 });
  assert.equal(summary.integrity.allAccounted, true);
  assert.equal(summary.failure, null);
  assert.ok(summary.results.every((r) => r.sha256 && r.bytes === r.id.length));
});

test('目标已存在同名产物时幂等跳过，跳过数计入汇总', async (t) => {
  const root = await tempRoot(t);
  const list = entries('ext-2-1-0', 'apk-2-8-0');
  for (const e of list) await fs.writeFile(path.join(root, e.file), e.id);
  const { queue } = buildPlan(list);
  const summary = await executePlan({
    queue,
    adapter: memoryAdapter({ preset: ['ext-2-1-0'] }),
    options: { root, package: 'unit/package' },
  });
  assert.equal(summary.results[0].status, 'skipped');
  assert.equal(summary.results[1].status, 'success');
  assert.deepEqual(summary.counts, { total: 2, success: 1, failed: 0, skipped: 1, unprocessed: 0 });
});

test('产物文件缺失时立即停止，报告失败版本与原因，后续逐条记为未处理', async (t) => {
  const root = await tempRoot(t);
  const list = entries('ext-2-1-0', 'apk-2-7-0', 'apk-2-8-0');
  await fs.writeFile(path.join(root, list[0].file), 'ok');
  await fs.writeFile(path.join(root, list[2].file), 'ok'); // 故意不创建 list[1]
  const { queue } = buildPlan(list);
  const summary = await executePlan({ queue, adapter: memoryAdapter(), options: { root, package: 'unit/package' } });
  assert.equal(summary.results[1].status, 'failed');
  assert.equal(summary.failure.id, 'apk-2-7-0');
  assert.match(summary.failure.reason, /ENOENT|no such file|产物不是/);
  assert.equal(summary.results[2].status, 'unprocessed');
  assert.match(summary.results[2].reason, /失败即停/);
  assert.deepEqual(summary.counts, { total: 3, success: 1, failed: 1, skipped: 0, unprocessed: 1 });
});

test('上传通道报错时不静默忽略，失败原因原样进入汇总', async (t) => {
  const root = await tempRoot(t);
  const list = entries('ext-2-1-0', 'apk-2-7-0', 'apk-2-8-0');
  for (const e of list) await fs.writeFile(path.join(root, e.file), e.id);
  const { queue } = buildPlan(list);
  const summary = await executePlan({
    queue,
    adapter: memoryAdapter({ failOn: 'apk-2-7-0' }),
    options: { root, package: 'unit/package' },
  });
  assert.equal(summary.failure.id, 'apk-2-7-0');
  assert.match(summary.failure.reason, /HTTP 503/);
  assert.equal(summary.counts.unprocessed, 1);
  assert.equal(summary.counts.failed, 1);
});

test('重复项与未处理项都进入汇总，四类计数之和等于总条目数', async (t) => {
  const root = await tempRoot(t);
  const list = [
    ...entries('ext-2-1-0', 'apk-2-7-0', 'apk-2-8-0'),
    { id: 'apk-2-8-0-dup', version: '2.8.0', kind: 'android-apk', file: 'apk-2-8-0.bin' },
  ];
  for (const e of list.slice(0, 3)) await fs.writeFile(path.join(root, e.file), e.id);
  const plan = buildPlan(list);
  const summary = await executePlan({ ...plan, adapter: memoryAdapter(), options: { root, package: 'unit/package' } });
  const c = summary.counts;
  assert.equal(c.total, summary.results.length);
  assert.equal(c.success + c.failed + c.skipped + c.unprocessed, c.total);
  assert.equal(c.skipped, 1);
  assert.equal(summary.integrity.allAccounted, true);
  assert.equal(summary.integrity.uniqueIds, true);
});

test('非法版本号与未知状态在计划/汇总阶段直接报错', () => {
  assert.throws(
    () => buildPlan([{ id: 'bad', version: 'not-a-version', kind: 'android-apk', file: 'a.apk' }]),
    /无法解析版本号/,
  );
  assert.throws(
    () => summarize({ results: [{ id: 'x', status: 'pending' }] }),
    /未知状态/,
  );
});

test('预演模式不调用适配器写入，且仍记录成功状态', async (t) => {
  const root = await tempRoot(t);
  const list = entries('ext-2-1-0');
  await fs.writeFile(path.join(root, list[0].file), 'ok');
  let uploads = 0;
  const adapter = {
    name: 'memory',
    async exists() { return false; },
    async upload() { uploads += 1; return { url: 'mem://x' }; },
  };
  const { queue } = buildPlan(list);
  const summary = await executePlan({ queue, adapter, options: { root, dryRun: true, package: 'unit/package' } });
  assert.equal(uploads, 0);
  assert.equal(summary.counts.success, 1);
  assert.match(summary.results[0].reason, /预演/);
});

// ---- GitHub Releases 适配器（注入假 fetch，不联网）----

function releasesConfig(extra = {}) {
  return {
    package: 'unit/releases',
    adapter: 'github-releases',
    github: { owner: 'unit', repo: 'repo', releaseTag: 'version-archive', token: 'unit-token', ...extra },
  };
}

function fakeReleasesFetch(state) {
  return async (url, init = {}) => {
    const method = init.method ?? 'GET';
    state.calls.push(`${method} ${url}`);
    if (url.includes('/releases/tags/')) {
      if (!state.releaseCreated) {
        return { status: 404, ok: false, async text() { return 'not found'; } };
      }
      return { status: 200, ok: true, async json() { return { id: 7, assets: state.assets }; } };
    }
    if (url.endsWith('/releases') && method === 'POST') {
      state.releaseCreated = true;
      return { status: 201, ok: true, async json() { return { id: 7, assets: [] }; } };
    }
    if (url.includes('uploads.github.com')) {
      if (state.failUpload) {
        return { status: 503, ok: false, async text() { return 'release asset service unavailable'; } };
      }
      const name = new URL(url).searchParams.get('name');
      state.assets.push({ name });
      return {
        status: 201,
        ok: true,
        async json() { return { browser_download_url: `https://github.com/unit/repo/releases/download/version-archive/${name}` }; },
      };
    }
    throw new Error(`意外的请求：${method} ${url}`);
  };
}

test('Releases 目标缺少访问令牌时直接报错，不静默降级', () => {
  const cfg = releasesConfig({ token: undefined });
  const saved = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  try {
    assert.throws(() => createAdapter(cfg), /GITHUB_TOKEN/);
  } finally {
    if (saved !== undefined) process.env.GITHUB_TOKEN = saved;
  }
});

test('Releases 目标：Release 不存在时先创建，再按版本顺序上传三个资产', async (t) => {
  const root = await tempRoot(t);
  const list = entries('ext-2-1-0', 'apk-2-7-0', 'apk-2-8-0');
  for (const e of list) await fs.writeFile(path.join(root, e.file), e.id);
  const state = { releaseCreated: false, assets: [], calls: [], failUpload: false };
  const adapter = createAdapter(releasesConfig(), { fetchImpl: fakeReleasesFetch(state) });
  const { queue, orderSource } = buildPlan(list);
  const summary = await executePlan({
    queue,
    adapter,
    options: { root, package: 'unit/releases', orderSource },
  });
  assert.equal(summary.adapter, 'github-releases');
  assert.equal(summary.counts.success, 3);
  assert.equal(summary.counts.failed, 0);
  assert.equal(state.releaseCreated, true);
  assert.equal(state.assets.length, 3);
  assert.equal(state.calls.filter((c) => c.includes('uploads.github.com')).length, 3);
  assert.ok(summary.results.every((r) => r.target?.includes('releases/download/')));
});

test('Releases 目标：同名资产已存在时幂等跳过，不重复上传', async (t) => {
  const root = await tempRoot(t);
  const list = entries('ext-2-1-0', 'apk-2-8-0');
  for (const e of list) await fs.writeFile(path.join(root, e.file), e.id);
  const state = {
    releaseCreated: true,
    assets: [{ name: 'ext-2-1-0.bin' }],
    calls: [],
    failUpload: false,
  };
  const adapter = createAdapter(releasesConfig(), { fetchImpl: fakeReleasesFetch(state) });
  const { queue } = buildPlan(list);
  const summary = await executePlan({ queue, adapter, options: { root, package: 'unit/releases' } });
  assert.equal(summary.results[0].status, 'skipped');
  assert.equal(summary.results[1].status, 'success');
  assert.equal(state.calls.filter((c) => c.includes('uploads.github.com')).length, 1);
  assert.deepEqual(summary.counts, { total: 2, success: 1, failed: 0, skipped: 1, unprocessed: 0 });
});

test('Releases 目标：上传接口报错时失败即停，原因与未处理项完整', async (t) => {
  const root = await tempRoot(t);
  const list = entries('ext-2-1-0', 'apk-2-7-0', 'apk-2-8-0');
  for (const e of list) await fs.writeFile(path.join(root, e.file), e.id);
  const state = { releaseCreated: true, assets: [], calls: [], failUpload: true };
  const adapter = createAdapter(releasesConfig(), { fetchImpl: fakeReleasesFetch(state) });
  const { queue } = buildPlan(list);
  const summary = await executePlan({ queue, adapter, options: { root, package: 'unit/releases' } });
  assert.equal(summary.failure.id, 'ext-2-1-0');
  assert.match(summary.failure.reason, /HTTP 503/);
  assert.deepEqual(summary.counts, { total: 3, success: 0, failed: 1, skipped: 0, unprocessed: 2 });
  assert.equal(summary.integrity.allAccounted, true);
});

test('Releases 目标按类型解析标签，一版一标签，未知类型回退到前缀模板', () => {
  const cfg = {
    ...releasesConfig(),
    github: {
      owner: 'unit',
      repo: 'repo',
      token: 'unit-token',
      tagTemplates: { 'xhub-extension': 'xhub-ext-v{version}', 'android-apk': 'android-v{version}' },
      nameTemplates: { 'android-apk': '待办同步 安卓端 v{version}' },
    },
  };
  assert.equal(tagForEntry(cfg, { kind: 'xhub-extension', version: '2.1.0' }), 'xhub-ext-v2.1.0');
  assert.equal(tagForEntry(cfg, { kind: 'android-apk', version: '2.8.0' }), 'android-v2.8.0');
  assert.equal(tagForEntry(cfg, { kind: 'unknown-kind', version: '1.0.0' }), 'unknown-kind-v1.0.0');
  assert.equal(tagForEntry(cfg, { kind: 'android-apk', version: '2.8.0', tag: 'custom-tag' }), 'custom-tag');
  assert.equal(releaseNameFor(cfg, { kind: 'android-apk', version: '2.8.0' }), '待办同步 安卓端 v2.8.0');
  assert.equal(releaseNameFor(cfg, { kind: 'xhub-extension', version: '2.1.0' }), 'x-hub 待办同步扩展 v2.1.0');
  assert.equal(isPrerelease('2.9.0-rc.1'), true);
  assert.equal(isPrerelease('2.9.0'), false);
});

// ---- 一版一 Release：标签钉提交、正文取说明 ----

function fakeTaggedFetch(state) {
  return async (url, init = {}) => {
    const method = init.method ?? 'GET';
    const u = new URL(url);
    state.calls.push(`${method} ${u.pathname}`);

    if (u.hostname === 'uploads.github.com') {
      const name = u.searchParams.get('name');
      const id = Number(u.pathname.split('/')[5]);
      state.releaseAssets.get(id).push({ name, browser_download_url: `https://example.invalid/${name}` });
      return { status: 201, ok: true, async json() { return { browser_download_url: `https://example.invalid/${name}` }; } };
    }
    if (u.pathname.includes('/git/ref/tags/')) {
      const tag = decodeURIComponent(u.pathname.split('/').pop());
      if (state.refs.has(tag)) {
        return { status: 200, ok: true, async json() { return { object: { type: 'commit', sha: state.refs.get(tag) } }; } };
      }
      return { status: 404, ok: false, async text() { return 'Not Found'; } };
    }
    if (u.pathname.endsWith('/git/refs') && method === 'POST') {
      const body = JSON.parse(init.body);
      const tag = body.ref.replace('refs/tags/', '');
      state.refs.set(tag, body.sha);
      return { status: 201, ok: true, async json() { return { object: { type: 'commit', sha: body.sha } }; } };
    }
    if (u.pathname.includes('/releases/tags/')) {
      const tag = decodeURIComponent(u.pathname.split('/').pop());
      const rel = state.byTag.get(tag);
      if (!rel) return { status: 404, ok: false, async text() { return 'Not Found'; } };
      return { status: 200, ok: true, async json() { return { ...rel, assets: state.releaseAssets.get(rel.id) }; } };
    }
    if (u.pathname.endsWith('/releases') && method === 'POST') {
      const body = JSON.parse(init.body);
      const id = 100 + state.byTag.size;
      const rel = {
        id,
        tag_name: body.tag_name,
        name: body.name,
        body: body.body,
        target_commitish: body.target_commitish,
        prerelease: body.prerelease,
        html_url: `https://example.invalid/${body.tag_name}`,
      };
      state.byTag.set(body.tag_name, rel);
      state.releaseAssets.set(id, []);
      return { status: 201, ok: true, async json() { return { ...rel, assets: [] }; } };
    }
    throw new Error(`意外请求：${method} ${url}`);
  };
}

test('每个版本各建一条 Release，标签钉在产物提交上，正文取版本说明', async (t) => {
  const root = await tempRoot(t);
  const list = entries('ext-2-1-0', 'apk-2-8-0');
  list[0].commit = 'a'.repeat(40);
  list[1].commit = 'b'.repeat(40);
  list[0].notes = '# 扩展 2.1.0 说明';
  list[1].notes = '# 安卓 2.8.0 说明';
  for (const e of list) await fs.writeFile(path.join(root, e.file), e.id);

  const cfg = {
    ...releasesConfig(),
    github: {
      owner: 'unit',
      repo: 'repo',
      token: 'unit-token',
      tagTemplates: { 'xhub-extension': 'xhub-ext-v{version}', 'android-apk': 'android-v{version}' },
      nameTemplates: { 'android-apk': '待办同步 安卓端 v{version}' },
    },
  };
  const state = { calls: [], refs: new Map(), byTag: new Map(), releaseAssets: new Map() };
  const adapter = createAdapter(cfg, { fetchImpl: fakeTaggedFetch(state) });
  const { queue } = buildPlan(list);
  const summary = await executePlan({ queue, adapter, options: { root, package: 'unit/releases' } });

  assert.equal(summary.counts.success, 2);
  assert.deepEqual([...state.refs.keys()].sort(), ['android-v2.8.0', 'xhub-ext-v2.1.0']);
  assert.equal(state.refs.get('xhub-ext-v2.1.0'), 'a'.repeat(40));
  assert.equal(state.refs.get('android-v2.8.0'), 'b'.repeat(40));

  const ext = state.byTag.get('xhub-ext-v2.1.0');
  const apk = state.byTag.get('android-v2.8.0');
  assert.equal(ext.body, '# 扩展 2.1.0 说明');
  assert.equal(apk.body, '# 安卓 2.8.0 说明');
  assert.equal(apk.name, '待办同步 安卓端 v2.8.0');
  assert.equal(apk.target_commitish, 'b'.repeat(40));
  assert.equal(state.releaseAssets.get(ext.id).length, 1);
  assert.equal(state.releaseAssets.get(apk.id).length, 1);
  // 两条 Release 各自独立，不能复用同一个 id
  assert.notEqual(ext.id, apk.id);
});

test('缺说明文件时用事实型兜底正文，明确写出缺失并附校验和', () => {
  const entry = { id: 'android-apk-2.8.0', version: '2.8.0', kind: 'android-apk', file: 'android/todo-link-2.8.0.apk' };
  const body = renderFallbackNotes({ entry, bytes: 187105, sha256: 'c'.repeat(64), commit: 'd'.repeat(40) });
  assert.match(body, /未找到版本说明文件/);
  assert.match(body, /notes\/android-apk-2\.8\.0\.md/);
  assert.match(body, /187105 字节/);
  assert.match(body, new RegExp('c'.repeat(64)));
  assert.match(body, /ddddddd/);
  // 不编造变更内容
  assert.doesNotMatch(body, /修复|新增|优化/);
});

test('一致性判定：缺 Release、缺资产、大小/摘要/标签不符都算 drift，缺说明只算提醒', () => {
  const artifact = { bytes: 10, sha256: 'a'.repeat(64), commit: 'f'.repeat(40), notesPresent: true, notesPath: 'n.md' };
  const rel = { html_url: 'u', tag_name: 't', assets: [] };

  assert.deepEqual(compareArtifactRelease({ artifact, release: rel, asset: { name: 'x', size: 10 } }), []);
  assert.equal(compareArtifactRelease({ artifact, release: null })[0].code, 'missing-release');
  assert.equal(compareArtifactRelease({ artifact, release: rel, asset: null })[0].code, 'missing-asset');
  assert.equal(
    compareArtifactRelease({ artifact, release: rel, asset: { size: 11 } })[0].code,
    'size-mismatch',
  );
  assert.equal(
    compareArtifactRelease({ artifact, release: rel, asset: { size: 10, digest: `sha256:${'b'.repeat(64)}` } })[0].code,
    'digest-mismatch',
  );
  assert.equal(
    compareArtifactRelease({ artifact, release: rel, asset: { size: 10, digest: `sha256:${'A'.repeat(64)}` } }).length,
    0,
    '摘要比较应忽略大小写与 sha256: 前缀',
  );
  const mismatch = compareArtifactRelease({ artifact, release: rel, asset: { size: 10 }, tagCommit: 'e'.repeat(40) });
  assert.equal(mismatch[0].code, 'tag-mismatch');
  const warned = compareArtifactRelease({ artifact: { ...artifact, notesPresent: false }, release: rel, asset: { size: 10 } });
  assert.equal(warned[0].severity, 'warn');
});


test('校验器能解析 Release、资产与附注标签指向的提交', async () => {
  const calls = [];
  const fake = async (url) => {
    calls.push(url);
    if (url.includes('/releases/tags/')) {
      return {
        status: 200,
        ok: true,
        async json() {
          return {
            id: 1,
            tag_name: 'android-v2.8.0',
            html_url: 'https://example.invalid/r',
            assets: [{ name: 'todo-link-2.8.0.apk', size: 187105, digest: `sha256:${'a'.repeat(64)}` }],
          };
        },
      };
    }
    if (url.includes('/git/ref/tags/')) {
      return { status: 200, ok: true, async json() { return { object: { type: 'tag', sha: 'tag-object' } }; } };
    }
    if (url.includes('/git/tags/')) {
      return { status: 200, ok: true, async json() { return { object: { type: 'commit', sha: 'commit-sha' } }; } };
    }
    throw new Error(`意外请求：${url}`);
  };
  const facts = await githubFacts({
    cfg: { github: { owner: 'unit', repo: 'repo' } },
    tag: 'android-v2.8.0',
    token: 'unit-token',
    fetchImpl: fake,
  });
  assert.equal(facts.release.assets[0].name, 'todo-link-2.8.0.apk');
  assert.equal(facts.tagCommit, 'commit-sha');
  assert.equal(calls.length, 3);
});
