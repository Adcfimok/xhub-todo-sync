// 扩展「安卓客户端下载」卡片校验：位置、文案、点击跳转、复制、样式对齐。
// 运行：node _tools/extension-download-check.mjs [--shots]
// 依赖：_tools/node_modules 里的 playwright（chromium 用本机 Edge 内核）
//
// 判定口径：
//   1. 卡片位于左栏，且在「设备」面板之后（DOM 顺序与视觉顺序一致）；
//   2. 文案含真实版本号，副标题含文件大小；
//   3. 点击整卡调用 xhub.openExternal(apk 直链)，点「版本说明」调用 openExternal(Release 页)；
//   4. 「复制链接」把 apk 直链写进剪贴板；
//   5. 卡片左右边界与同栏「设备」面板对齐（宽度差 ≤1px），无脚本错误。
// 退出码：任一不满足为 1。

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const WEB = path.join(ROOT, 'extensions/todo-relay/view');
const EXT = path.join(ROOT, 'extensions/todo-relay');
const require = createRequire(path.join(HERE, 'node_modules/'));
const { chromium } = require('playwright');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

function serve() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const rel = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.join(WEB, rel);
    if (!file.startsWith(WEB)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const buf = await fs.readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
      res.end(buf);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// 宿主桥的最小可用替身：让页面能跑完整轮询，同时把 openExternal 的调用暴露出来
const HOST_STUB = () => {
  window.__calls = { openExternal: [], clipboard: [] };
  const adminState = {
    serverTime: Date.now(),
    pairCode: '123456',
    port: 47821,
    addresses: [{ address: '192.168.1.20', iface: 'WLAN', primary: true, virtual: false }],
    primary: '192.168.1.20',
    devices: [],
    records: [],
    conflicts: [],
    collections: [],
    stats: { total: 0, seq: 0, conflicts: 0 },
    stat: { total: 0, seq: 0 },
  };
  const ok = (body) => Promise.resolve({
    status: 200,
    ok: true,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
  const listApi = { list: () => Promise.resolve([]) };
  // 页面里的复制走 navigator.clipboard（不是宿主桥），单独替身才观测得到
  try {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (t) => { window.__calls.clipboard.push(t); return Promise.resolve(); },
        readText: () => Promise.resolve(''),
      },
    });
  } catch { /* 老内核忽略，退化路径不影响其余断言 */ }
  window.xhub = {
    runtime: { version: 'test' },
    data: {
      todos: listApi, notes: listApi, stickies: listApi, resources: listApi, snippets: listApi,
    },
    config: { all: () => Promise.resolve({}), get: () => Promise.resolve(null), set: () => Promise.resolve() },
    clipboard: {
      writeText: (t) => { window.__calls.clipboard.push(t); return Promise.resolve(); },
      readText: () => Promise.resolve(''),
    },
    service: {
      request: (p) => {
        if (p.includes('/api/admin/state')) return ok(adminState);
        if (p.includes('/api/local/outbound')) return ok({ items: [] });
        if (p.includes('/api/local/bridge/pending')) return ok({ items: [] });
        if (p.includes('/api/local/ingest')) return ok({ ok: true, applied: 0 });
        return ok({ ok: true });
      },
    },
    openExternal: (u) => { window.__calls.openExternal.push(u); return Promise.resolve(); },
    openPermissions: () => Promise.resolve(),
    events: { on: () => () => {} },
  };
};

const server = await serve();
const port = server.address().port;
const browser = await chromium.launch({ channel: 'msedge' });
const shots = process.argv.includes('--shots');
const problems = [];

function check(kind, ok, detail) {
  if (!ok) problems.push(`${kind}：${detail}`);
}

try {
  for (const theme of ['light', 'dark']) {
    const ctx = await browser.newContext({ viewport: { width: 1180, height: 760 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript(HOST_STUB);
    await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'domcontentloaded' });
    if (theme === 'dark') {
      await page.evaluate(() => document.documentElement.setAttribute('data-xhub-theme', 'dark'));
    }
    await page.waitForTimeout(900);

    const facts = await page.evaluate(() => {
      const dl = document.getElementById('btn-download');
      const left = document.querySelector('.col-left');
      const panels = [...left.querySelectorAll('.panel')];
      const dlPanel = dl.closest('.panel');
      const devPanel = panels.find((p) => p.querySelector('#devices'));
      const r = (el) => { const b = el.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom, w: b.width, h: b.height }; };
      return {
        exists: Boolean(dl),
        visible: Boolean(dl && dl.offsetParent !== null),
        inLeft: Boolean(left && left.contains(dl)),
        panelIndex: panels.indexOf(dlPanel),
        devIndex: panels.indexOf(devPanel),
        title: document.getElementById('dl-title').textContent,
        sub: document.getElementById('dl-sub').textContent,
        dl: r(dl),
        dev: devPanel ? r(devPanel) : null,
        style: getComputedStyle(dl),
      };
    });

    check(`${theme} · 卡片存在`, facts.exists && facts.visible, JSON.stringify(facts));
    check(`${theme} · 位于左栏`, facts.inLeft, '不在 .col-left 内');
    check(`${theme} · 排在设备之后`, facts.panelIndex > facts.devIndex && facts.devIndex >= 0,
      `下载面板 ${facts.panelIndex}，设备面板 ${facts.devIndex}`);
    check(`${theme} · 版本文案`, /2\.9\.0/.test(facts.title), `标题为「${facts.title}」`);
    check(`${theme} · 大小文案`, /KB/.test(facts.sub), `副标题为「${facts.sub}」`);
    check(`${theme} · 与设备面板等宽`, facts.dev && Math.abs(facts.dl.w - (facts.dev.w - 28)) <= 2,
      `卡片 ${facts.dl.w}px，设备面板内容区约 ${facts.dev ? facts.dev.w - 28 : '?'}px`);
    check(`${theme} · 圆角与设备卡一致`, Math.abs(parseFloat(facts.style.borderRadius) - 9) <= 0.5,
      `圆角 ${facts.style.borderRadius}`);

    // 点击整卡 → 直链
    await page.click('#btn-download');
    await page.waitForTimeout(120);
    const afterDl = await page.evaluate(() => window.__calls.openExternal.slice());
    check(`${theme} · 点卡跳直链`,
      afterDl.length === 1 && /releases\/download\/android-v2\.9\.0\/todo-link-2\.9\.0\.apk$/.test(afterDl[0]),
      `openExternal 收到 ${JSON.stringify(afterDl)}`);

    // 版本说明 → Release 页
    await page.click('#btn-dl-notes');
    await page.waitForTimeout(120);
    const afterNotes = await page.evaluate(() => window.__calls.openExternal.slice());
    check(`${theme} · 说明跳 Release 页`,
      afterNotes.length === 2 && /releases\/tag\/android-v2\.9\.0$/.test(afterNotes[1]),
      `openExternal 收到 ${JSON.stringify(afterNotes)}`);

    // 复制链接 → 剪贴板
    await page.click('#btn-copy-dl');
    await page.waitForTimeout(120);
    const clip = await page.evaluate(() => window.__calls.clipboard.slice());
    check(`${theme} · 复制直链`,
      clip.length >= 1 && /todo-link-2\.9\.0\.apk$/.test(clip[0]),
      `剪贴板收到 ${JSON.stringify(clip)}`);

    check(`${theme} · 无脚本错误`, errors.length === 0, errors.join(' | '));

    if (shots) {
      await page.evaluate(() => document.documentElement.removeAttribute('data-xhub-theme'));
      if (theme === 'dark') await page.evaluate(() => document.documentElement.setAttribute('data-xhub-theme', 'dark'));
      await page.waitForTimeout(200);
      await page.screenshot({ path: path.join(HERE, `ext-download-${theme}.png`) });
    }

    console.log(JSON.stringify({
      theme,
      title: facts.title,
      sub: facts.sub,
      cardW: Number(facts.dl.w.toFixed(1)),
      radius: facts.style.borderRadius,
      openExternal: afterNotes.length,
      clipboard: clip.length,
      errors: errors.length,
    }));
    await ctx.close();
  }
} finally {
  await browser.close();
  server.close();
}

if (problems.length) {
  console.error('\n未通过：');
  for (const p of problems) console.error(' - ' + p);
  process.exitCode = 1;
} else {
  console.error('\n全部通过：位置、文案、跳转、复制、宽度对齐（浅色/深色）均满足。');
}
