// 底部导航几何校验：不同屏宽/屏高下测量胶囊位置、内容留白、浮层避让。
// 运行：node _tools/navbar-check.mjs [--shots]
// 依赖：_tools/node_modules 里的 playwright（chromium 用本机 Edge 内核）
//
// 判定口径（全部为像素、与设备无关的 CSS px）：
//   1. 胶囊下沿到视口底边的距离 == clamp(44px, 7vh, 64px)，误差 ≤1px；
//   2. 滚动到底后，最后一块内容与胶囊上沿至少留 20px，不被遮住；
//   3. AI 页输入胶囊底边与底栏上沿至少留 8px；
//   4. 提示条不与底栏、不与 AI 输入胶囊重叠。
// 退出码：任一不满足为 1。

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const WEB = path.join(ROOT, 'android/app/src/main/assets/www');
const require = createRequire(path.join(HERE, 'node_modules/'));
const { chromium } = require('playwright');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
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

const DEVICES = [
  { name: 'small-360x740', width: 360, height: 740, dpr: 3 },
  { name: 'iphone-390x844', width: 390, height: 844, dpr: 3 },
  { name: 'pixel-412x915', width: 412, height: 915, dpr: 2.6 },
  { name: 'large-430x932', width: 430, height: 932, dpr: 3 },
  { name: 'landscape-740x360', width: 740, height: 360, dpr: 2 },
];

const expectedLift = (h) => (h <= 480 ? 10 : Math.min(64, Math.max(44, h * 0.07)));

async function measure(page, route) {
  await page.evaluate((r) => {
    location.hash = '#/' + r;
  }, route);
  await page.waitForTimeout(450);
  return page.evaluate(() => {
    const rect = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, height: r.height, left: r.left, right: r.right };
    };
    const scroll = document.querySelector('.scroll');
    let lastContentBottom = null;
    if (scroll) {
      scroll.scrollTop = scroll.scrollHeight;
      const pad = scroll.lastElementChild;
      const last = pad && pad.classList.contains('list-pad') ? pad.previousElementSibling : pad;
      if (last) lastContentBottom = last.getBoundingClientRect().bottom;
    }
    const toast = document.getElementById('toast');
    toast.hidden = false;
    toast.textContent = '保存成功';
    const toastRect = toast.getBoundingClientRect();
    // AI 页未配置 Key 时不渲染输入胶囊；用同名 class 的探针元素测同一条 margin 规则
    let composer = document.querySelector('.composer');
    let composerMode = 'real';
    if (!composer && document.body.dataset.route === 'ai') {
      const probe = document.createElement('div');
      probe.className = 'composer';
      probe.style.height = '58px';
      document.getElementById('page').appendChild(probe);
      composer = probe;
      composerMode = 'injected';
    }
    const composerRect = rect(composer);
    if (composerMode === 'injected') composer.remove();
    const css = getComputedStyle(document.documentElement);
    return {
      innerHeight: window.innerHeight,
      innerWidth: window.innerWidth,
      dock: rect(document.getElementById('tabbar')),
      liftVar: css.getPropertyValue('--dock-lift').trim(),
      dockH: css.getPropertyValue('--dock-h').trim(),
      listPad: rect(document.querySelector('.list-pad')),
      lastContentBottom,
      composer: composerRect,
      composerMode,
      toast: { top: toastRect.top, bottom: toastRect.bottom },
      bodyRoute: document.body.dataset.route ?? null,
    };
  });
}

const problems = [];
function check(device, kind, ok, detail) {
  if (!ok) problems.push(`${device} · ${kind}：${detail}`);
}

const server = await serve();
const port = server.address().port;
const base = `http://127.0.0.1:${port}/index.html`;
const browser = await chromium.launch({ channel: 'msedge' });
const shots = process.argv.includes('--shots');

try {
  for (const d of DEVICES) {
    const ctx = await browser.newContext({
      viewport: { width: d.width, height: d.height },
      deviceScaleFactor: d.dpr,
      isMobile: d.width < 600,
      hasTouch: true,
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript(() => {
      window.Android = {
        originPort: () => 47830,
        originChanged: () => false,
        appVersion: () => '2.8.1',
        deviceName: () => 'Layout Probe',
        readClipboard: () => '',
        writeClipboard: () => {},
        vibrate: () => {},
        toast: () => {},
        openUrl: () => {},
      };
    });
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(700);

    const home = await measure(page, 'home');
    const expect = expectedLift(home.innerHeight);
    const gap = home.innerHeight - home.dock.bottom;
    check(d.name, '胶囊下沿间距', Math.abs(gap - expect) <= 1, `实测 ${gap.toFixed(1)}px，预期 ${expect.toFixed(1)}px`);
    check(d.name, '胶囊高度', Math.abs(home.dock.height - 58) <= 1, `实测 ${home.dock.height}px`);
    check(
      d.name,
      '列表留白',
      home.listPad && home.listPad.height >= home.dock.height + gap + 20,
      `list-pad ${home.listPad?.height}px，底栏上沿在 ${(home.innerHeight - home.dock.top).toFixed(1)}px`,
    );
    check(
      d.name,
      '内容不被遮',
      // 留白按 20px 设计；scrollTop 在高 DPR 下按 0.5px 取整，最后一块可能差 0.2~0.5px，故留 1px 容差
      home.lastContentBottom === null || home.lastContentBottom <= home.dock.top - 19,
      `末块内容底边 ${home.lastContentBottom?.toFixed(1)}，胶囊上沿 ${home.dock.top.toFixed(1)}`,
    );
    check(d.name, '提示条不与底栏重叠', home.toast.bottom <= home.dock.top - 8, `提示条底边 ${home.toast.bottom.toFixed(1)}，胶囊上沿 ${home.dock.top.toFixed(1)}`);

    const ai = await measure(page, 'ai');
    check(d.name, 'AI 页路由标记', ai.bodyRoute === 'ai', `body[data-route]=${ai.bodyRoute}`);
    check(
      d.name,
      '输入胶囊不压底栏',
      ai.composer && ai.composer.bottom <= ai.dock.top - 8,
      `输入区底边 ${ai.composer?.bottom.toFixed(1)}，胶囊上沿 ${ai.dock.top.toFixed(1)}`,
    );
    check(
      d.name,
      '提示条不压输入胶囊',
      ai.toast.bottom <= ai.composer.top - 4,
      `提示条底边 ${ai.toast.bottom.toFixed(1)}，输入区上沿 ${ai.composer.top.toFixed(1)}`,
    );

    if (shots) {
      await page.evaluate(() => {
        document.getElementById('toast').hidden = true;
        location.hash = '#/home';
      });
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(HERE, `nav-${d.name}.png`) });
    }
    if (errors.length) problems.push(`${d.name} · 脚本错误：${errors.join(' | ')}`);

    console.log(
      JSON.stringify({
        device: d.name,
        viewport: `${d.width}x${d.height}`,
        lift: Number(gap.toFixed(1)),
        expected: Number(expect.toFixed(1)),
        dockTop: Number(home.dock.top.toFixed(1)),
        listPad: home.listPad?.height ?? null,
        composerBottom: ai.composer ? Number(ai.composer.bottom.toFixed(1)) : null,
        errors: errors.length,
      }),
    );
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
  console.error('\n全部通过：胶囊间距、列表留白、AI 输入区、提示条在 5 种视口下均满足。');
}
