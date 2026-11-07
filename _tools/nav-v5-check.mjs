/**
 * 底栏改 5 格后的回归：格子对齐、三处笔记入口、类型选择、放大与色散。
 *
 * 运行：node _tools/nav-v5-check.mjs [--shots]
 * 依赖：_tools/node_modules 里的 playwright（用本机 Edge 内核）
 *
 * 为什么单独写一个：navbar-check.mjs 管的是「底栏离屏幕多远、内容会不会被压」，
 * 和格子数量无关。这里管的是「5 格之后高亮块还对不对得上格子」以及笔记的三个入口，
 * 两件事的失败原因完全不同，混在一个脚本里会互相掩盖。
 */

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
};

function serve() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const rel = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.join(WEB, rel);
    if (!file.startsWith(WEB)) return res.writeHead(403).end();
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

const problems = [];
const info = [];
function check(name, ok, detail) {
  if (!ok) problems.push(`${name}：${detail}`);
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

const server = await serve();
const port = server.address().port;
const base = `http://127.0.0.1:${port}/index.html`;
const browser = await chromium.launch({ channel: 'msedge' });
const shots = process.argv.includes('--shots');
const dark = process.argv.includes('--dark');
const themeTag = dark ? 'dark' : 'light';

const VIEWPORTS = [
  { name: 'small-360', width: 360, height: 740, dpr: 3 },
  { name: 'iphone-390', width: 390, height: 844, dpr: 3 },
  { name: 'large-430', width: 430, height: 932, dpr: 3 },
];

try {
  for (const v of VIEWPORTS) {
    const ctx = await browser.newContext({
      viewport: { width: v.width, height: v.height },
      deviceScaleFactor: v.dpr,
      isMobile: true,
      hasTouch: true,
      colorScheme: dark ? 'dark' : 'light',
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript(() => {
      window.Android = {
        originPort: () => 47830,
        originChanged: () => false,
        appVersion: () => '3.0.0',
        deviceName: () => 'Nav Probe',
        readClipboard: () => '',
        writeClipboard: () => {},
        vibrate: () => {},
        toast: () => {},
        openUrl: () => {},
      };
    });
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);

    // ---------- 1. 结构：4 个 tab + 1 个加号 ----------
    const struct = await page.evaluate(() => ({
      tabs: [...document.querySelectorAll('.tab')].map((t) => t.getAttribute('data-route')),
      addCount: document.querySelectorAll('.tab-add').length,
      cols: getComputedStyle(document.getElementById('tabbar')).gridTemplateColumns.split(' ').length,
      notesTab: !!document.querySelector('.tab[data-route="notes"]'),
    }));
    check(`${v.name} 底栏 4 个页面格`, struct.tabs.length === 4, `实际 ${struct.tabs.join('/')}`);
    check(`${v.name} 底栏 5 列`, struct.cols === 5, `grid-template-columns 共 ${struct.cols} 列`);
    check(`${v.name} 笔记已移出底栏`, !struct.notesTab, struct.notesTab ? '仍有 notes 格' : '无 notes 格');
    check(`${v.name} 加号仍在`, struct.addCount === 1, `add 按钮 ${struct.addCount} 个`);

    // ---------- 2. 高亮块与格子对齐（这是「错位」的唯一判据） ----------
    const align = [];
    for (const route of ['todos', 'ai', 'more', 'home']) {
      await page.evaluate((r) => (location.hash = '#/' + r), route);
      await page.waitForTimeout(520);
      const one = await page.evaluate((r) => {
        const bar = document.getElementById('tabbar');
        const ind = document.getElementById('tab-indicator');
        const tab = bar.querySelector(`.tab[data-route="${r}"]`);
        const ir = ind.getBoundingClientRect();
        const tr = tab.getBoundingClientRect();
        return {
          route: r,
          slot: bar.style.getPropertyValue('--tab-i').trim(),
          indCenter: ir.left + ir.width / 2,
          tabCenter: tr.left + tr.width / 2,
          indWidth: ir.width,
          barWidth: bar.clientWidth,
          expectedWidth: (bar.clientWidth - 12) / 5,
        };
      }, route);
      align.push(one);
      check(
        `${v.name} 高亮块对齐 ${route}`,
        Math.abs(one.indCenter - one.tabCenter) <= 2,
        `格心 ${one.tabCenter.toFixed(1)} / 块心 ${one.indCenter.toFixed(1)}，slot=${one.slot}`
      );
    }
    const w = align[0];
    check(
      `${v.name} 高亮块宽度 = 1/5 栏宽`,
      Math.abs(w.indWidth - w.expectedWidth) <= 1,
      `实测 ${w.indWidth.toFixed(1)}，预期 ${w.expectedWidth.toFixed(1)}`
    );

    // ---------- 3. 动效：放大 + 色散 ----------
    const fx = await page.evaluate(async () => {
      const bar = document.getElementById('tabbar');
      const inner = document.querySelector('.tab-indicator > i');
      const glow = getComputedStyle(inner, '::before');

      const scaleNow = () => {
        const m = getComputedStyle(inner).transform;
        if (!m || m === 'none') return 1;
        const nums = m.match(/matrix\(([^)]+)\)/);
        return nums ? parseFloat(nums[1].split(',')[0]) : 1;
      };

      bar.style.setProperty('--drag-p', '0');
      await new Promise((r) => setTimeout(r, 60));
      const s0 = scaleNow();

      bar.style.setProperty('--drag-p', '0.5');
      await new Promise((r) => setTimeout(r, 260));
      const s05 = scaleNow();

      bar.style.setProperty('--drag-p', '1');
      await new Promise((r) => setTimeout(r, 260));
      const s1 = scaleNow();

      bar.classList.add('switching');
      await new Promise((r) => setTimeout(r, 260));
      const sSwitch = scaleNow();
      const glowOnSwitch = getComputedStyle(inner, '::before').opacity;
      bar.classList.remove('switching');

      bar.style.setProperty('--drag-p', '0');
      await new Promise((r) => setTimeout(r, 260));
      const glowIdle = getComputedStyle(inner, '::before').opacity;

      return { s0, s05, s1, sSwitch, glowOnSwitch, glowIdle, hasConic: glow.backgroundImage.includes('conic-gradient') };
    });
    check(`${v.name} 静止不放大`, Math.abs(fx.s0 - 1) < 0.02, `scale=${fx.s0.toFixed(3)}`);
    check(`${v.name} 拖动 50% 放大`, fx.s05 > 1.05 && fx.s05 < 1.10, `scale=${fx.s05.toFixed(3)}（期望 1.075）`);
    check(`${v.name} 拖满放大 15%`, Math.abs(fx.s1 - 1.15) < 0.02, `scale=${fx.s1.toFixed(3)}`);
    check(`${v.name} 切页脉冲放大到 1.14`, Math.abs(fx.sSwitch - 1.14) < 0.02, `scale=${fx.sSwitch.toFixed(3)}`);
    check(`${v.name} 色散用 conic-gradient`, fx.hasConic, fx.hasConic ? '是' : '缺失');
    check(`${v.name} 静止时色散不可见`, Number(fx.glowIdle) < 0.05, `opacity=${fx.glowIdle}`);
    check(`${v.name} 切页时色散可见`, Number(fx.glowOnSwitch) > 0.5, `opacity=${fx.glowOnSwitch}`);

    // ---------- 4. 三处笔记入口 ----------
    const entries = [];

    // 4a 「我的」菜单
    await page.evaluate(() => (location.hash = '#/more'));
    await page.waitForTimeout(400);
    const moreOk = await page.evaluate(() => {
      const items = [...document.querySelectorAll('.menu-item')];
      const hit = items.find((el) => (el.textContent || '').includes('笔记'));
      if (!hit) return { found: false };
      hit.click();
      return { found: true };
    });
    await page.waitForTimeout(420);
    entries.push({ name: '「我的」菜单', ok: moreOk.found && (await page.evaluate(() => location.hash)) === '#/notes' });

    // 4b 首页统计格
    await page.evaluate(() => (location.hash = '#/home'));
    await page.waitForTimeout(400);
    const statOk = await page.evaluate(() => {
      const hit = [...document.querySelectorAll('.stat')].find((el) => (el.textContent || '').includes('笔记'));
      if (!hit) return { found: false };
      hit.click();
      return { found: true };
    });
    await page.waitForTimeout(420);
    entries.push({ name: '首页统计格', ok: statOk.found && (await page.evaluate(() => location.hash)) === '#/notes' });

    // 4c 首页「最近笔记 → 全部」
    await page.evaluate(() => (location.hash = '#/home'));
    await page.waitForTimeout(400);
    const allOk = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('.card')];
      const card = cards.find((c) => (c.querySelector('h2')?.textContent || '').trim().startsWith('最近笔记'));
      if (!card) return { found: false };
      const btn = [...card.querySelectorAll('button.mini')].find((b) => (b.textContent || '').trim() === '全部');
      if (!btn) return { found: false };
      btn.click();
      return { found: true };
    });
    await page.waitForTimeout(420);
    entries.push({ name: '首页「最近笔记→全部」', ok: allOk.found && (await page.evaluate(() => location.hash)) === '#/notes' });

    for (const e of entries) check(`${v.name} 笔记入口 · ${e.name}`, e.ok, e.ok ? '可进入' : '未进入 #/notes');

    // ---------- 5. 返回键从笔记回到来源 ----------
    await page.evaluate(() => (location.hash = '#/more'));
    await page.waitForTimeout(360);
    await page.evaluate(() => (location.hash = '#/notes'));
    await page.waitForTimeout(360);
    const backTo = await page.evaluate(() => {
      window.__handleBack();
      return location.hash;
    });
    await page.waitForTimeout(300);
    check(`${v.name} 从「我的」进笔记后返回回「我的」`, backTo === '#/more', `返回到了 ${backTo}`);

    // ---------- 6. 加号类型选择 ----------
    await page.evaluate(() => (location.hash = '#/home'));
    await page.waitForTimeout(360);
    await page.click('#btn-quick-add');
    await page.waitForTimeout(260);
    const picker = await page.evaluate(() => {
      const box = document.getElementById('add-picker');
      const items = [...document.querySelectorAll('.add-item')].map((b) => b.getAttribute('data-type'));
      const r = box.getBoundingClientRect();
      const dock = document.getElementById('tabbar').getBoundingClientRect();
      return { visible: !box.hidden, items, top: r.top, bottom: r.bottom, dockTop: dock.top };
    });
    check(`${v.name} 加号弹出类型选择`, picker.visible, picker.visible ? '可见' : '不可见');
    check(`${v.name} 三个类型齐全`, picker.items.join(',') === 'todos,notes,snippets', picker.items.join(','));
    check(`${v.name} 类型面板不盖底栏`, picker.bottom <= picker.dockTop - 4, `面板底 ${picker.bottom.toFixed(0)} / 底栏顶 ${picker.dockTop.toFixed(0)}`);

    await page.click('.add-item[data-type="notes"]');
    await page.waitForTimeout(360);
    const noteSheet = await page.evaluate(() => ({
      sheetOpen: !document.getElementById('sheet').hidden,
      title: document.getElementById('sheet-title').textContent,
      pickerClosed: document.getElementById('add-picker').hidden,
    }));
    check(`${v.name} 选「笔记」进入新建面板`, noteSheet.sheetOpen && noteSheet.title === '新建笔记', `${noteSheet.title} / 面板 ${noteSheet.sheetOpen}`);
    check(`${v.name} 选完类型后面板收起`, noteSheet.pickerClosed, noteSheet.pickerClosed ? '已收起' : '仍开着');

    if (shots) {
      await page.evaluate(() => {
        document.getElementById('btn-cancel').click();
        location.hash = '#/home';
      });
      await page.waitForTimeout(420);
      await page.screenshot({ path: path.join(HERE, `nav5-${v.name}-${themeTag}.png`) });

      // 拖动到一半的画面：高亮块放大 + 色散
      await page.evaluate(() => {
        const bar = document.getElementById('tabbar');
        bar.classList.add('dragging');
        bar.style.setProperty('--drag', '34px');
        bar.style.setProperty('--drag-p', '0.62');
      });
      await page.waitForTimeout(320);
      await page.screenshot({ path: path.join(HERE, `nav5-${v.name}-drag-${themeTag}.png`) });
      await page.evaluate(() => {
        const bar = document.getElementById('tabbar');
        bar.classList.remove('dragging');
        bar.style.setProperty('--drag', '0px');
        bar.style.setProperty('--drag-p', '0');
      });
    }

    if (errors.length) problems.push(`${v.name} 脚本错误：${errors.join(' | ')}`);
    info.push({ device: v.name, tabs: struct.tabs, align: align.map((a) => Number((a.indCenter - a.tabCenter).toFixed(2))) });
    await ctx.close();
  }
} finally {
  await browser.close();
  server.close();
}

console.log('\n' + JSON.stringify(info));
if (problems.length) {
  console.error('\n失败项：');
  problems.forEach((p) => console.error(' - ' + p));
  process.exit(1);
}
console.log('\n全部通过');
