#!/usr/bin/env node
// 按版本顺序把已存在的产物上传到指定软件包。
//
// 用法（在项目根目录执行，默认上传到 GitHub Releases，需要 GITHUB_TOKEN）：
//   GITHUB_TOKEN=xxx node _tools/release-upload/upload.mjs
//   node _tools/release-upload/upload.mjs --dry-run                  # 只校验顺序与产物
//   node _tools/release-upload/upload.mjs --discover --out last-summary.json
//   node _tools/release-upload/upload.mjs --manifest versions.ordered.json
//   node _tools/release-upload/upload.mjs --adapter local           # 离线写入本地目录
//
// 参数：
//   --manifest <path>   版本清单（默认同目录 versions.json）
//   --package <name>    覆盖目标软件包标识
//   --adapter <name>    覆盖适配器：github-releases（默认） | local
//   --dir <path>        覆盖 local 适配器的目标目录
//   --root <path>       产物相对路径的根目录（默认由清单位置推导项目根）
//   --discover          扫描实际存在的 zip / apk 补入清单，避免遗漏
//   --dry-run           只校验产物与顺序，不写入目标软件包
//   --force             忽略幂等检查，覆盖已存在的同名产物
//   --out <path>        把结构化汇总写入 JSON 文件
//   --quiet             不打印逐条状态
//
// 输出：stdout 为纯 JSON 汇总；逐条状态与失败原因写 stderr。
// 退出码：出现 failed 或 unprocessed 时为 1，否则为 0。

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPlan, discoverArtifacts, executePlan, entryKey } from './lib.mjs';
import { createAdapter } from './adapters.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const flags = new Set();
  const values = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    const key = arg.slice(2, eq === -1 ? undefined : eq);
    if (eq !== -1) {
      values[key] = arg.slice(eq + 1);
    } else if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
      values[key] = argv[++i];
    } else {
      flags.add(key);
    }
  }
  return { flags, values };
}

const LABEL = {
  success: '[成功]',
  failed: '[失败]',
  skipped: '[跳过]',
  unprocessed: '[未处理]',
};

async function main() {
  const { flags, values } = parseArgs(process.argv.slice(2));
  const manifestPath = path.resolve(values.manifest ?? path.join(HERE, 'versions.json'));
  const cfg = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  if (values.package) cfg.package = values.package;
  if (values.adapter) cfg.adapter = values.adapter;
  if (values.dir) cfg.local = { ...(cfg.local ?? {}), dir: values.dir };
  // GitHub Actions 等托管环境会提供仓库全名，优先于清单里写死的 owner/repo
  if (process.env.GITHUB_REPOSITORY && cfg.github) {
    const [owner, repo] = process.env.GITHUB_REPOSITORY.split('/');
    if (owner && repo) cfg.github = { ...cfg.github, owner, repo };
  }

  const root = path.resolve(values.root ?? path.resolve(path.dirname(manifestPath), '..', '..'));
  // 自动发现只补入清单里没有的「版本 + 类型」，清单已列出的产物不重复登记
  const knownKeys = new Set((cfg.versions ?? []).map(entryKey));
  const discovered = flags.has('discover')
    ? (await discoverArtifacts(root)).filter((e) => !knownKeys.has(entryKey(e)))
    : [];
  const plan = buildPlan(cfg.versions ?? [], { discovered });
  // 目标软件包不可用时也输出结构化汇总：首个版本记为失败，其余记为未处理，原因原样上报
  let adapter;
  try {
    adapter = createAdapter(cfg);
  } catch (err) {
    const message = err?.message ?? String(err);
    adapter = {
      name: flags.has('dry-run') ? `${cfg.adapter}(dry-run)` : `${cfg.adapter}(unavailable)`,
      async exists() { return false; },
      async upload() { throw new Error(message); },
    };
    if (!flags.has('quiet')) {
      console.error(`[配置] ${message}${flags.has('dry-run') ? '（预演不接触目标，忽略）' : ''}`);
    }
  }

  if (!flags.has('quiet')) {
    console.error(`目标软件包：${cfg.package}（${adapter.name}）`);
    console.error(`顺序依据：${plan.orderSource === 'manifest-order' ? '清单给定顺序' : '版本号从旧到新'}`);
    console.error(`计划条目：${plan.queue.length} 个上传项 + ${plan.duplicates.length} 个重复跳过项`);
    if (discovered.length) console.error(`自动发现产物：${discovered.length} 个（与清单合并去重）`);
    console.error('---');
  }

  const summary = await executePlan({
    queue: plan.queue,
    duplicates: plan.duplicates,
    adapter,
    options: {
      root,
      package: cfg.package,
      orderSource: plan.orderSource,
      dryRun: flags.has('dry-run'),
      force: flags.has('force'),
    },
    onEvent(rec) {
      if (flags.has('quiet')) return;
      const line = `${LABEL[rec.status]} ${rec.id} | ${rec.version} | ${rec.kind} | ${rec.file}${rec.reason ? ` | ${rec.reason}` : ''}`;
      console.error(line);
    },
  });

  if (summary.failure) {
    console.error(`--- 上传中止：版本 ${summary.failure.id} 失败，原因：${summary.failure.reason}`);
  }
  const out = JSON.stringify(summary, null, 2);
  process.stdout.write(`${out}\n`);
  if (values.out) {
    const outPath = path.resolve(values.out);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, `${out}\n`, 'utf8');
  }
  process.exitCode = summary.counts.failed + summary.counts.unprocessed > 0 ? 1 : 0;
}

main().catch((err) => {
  // 计划阶段或配置阶段的错误同样不静默忽略
  console.error(`[中止] ${err?.message ?? err}`);
  process.exitCode = 1;
});
