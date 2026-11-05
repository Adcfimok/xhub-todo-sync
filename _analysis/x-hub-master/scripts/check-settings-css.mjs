/**
 * 校验设置页样式的「前缀口径」（见 AGENTS.md 约定 50）
 *
 * 为什么需要它：`settings/shared.css` 的规则统一带 `.settings-view` 前缀，但
 * **写错的前缀在 CSS 里是合法的**——`.settings-view .settings-view .sv-body` 这种自嵌套
 * 选择器不会报任何错，只是永不匹配。症状是「设置页某块布局/样式莫名失效」，
 * 排查成本极高（本次搬迁连踩三次：前缀套前缀、@keyframes 打乱切分、注释被插前缀）。
 *
 * 所以把口径固化成构建期检查：`npm run build` 的 prebuild 会跑它，违规直接失败。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILE = join(root, "src/components/settings/shared.css");
const css = readFileSync(FILE, "utf8");

const sels = [...css.matchAll(/^([^{}\n]+)\{/gm)]
  .map((m) => m[1].trim())
  .filter(
    (s) =>
      s &&
      !s.startsWith("/*") &&
      !s.startsWith("@") &&
      !s.startsWith("*") &&
      !/^[\d.]+%$/.test(s) && // @keyframes 的关键帧
      s !== "from" &&
      s !== "to"
  );

const problems = [];
for (const s of sels) {
  const count = (s.match(/\.settings-view/g) ?? []).length;
  if (count === 0) {
    problems.push(`缺前缀：${s}`);
  } else if (count > 1) {
    problems.push(`前缀重复（自嵌套，永不匹配）：${s}`);
  }
}
// `.settings-view` 自身的规则不能带前缀（`.settings-view .settings-view` 永不匹配）
for (const s of sels) {
  if (/^\.settings-view\s+\.settings-view/.test(s)) problems.push(`自嵌套：${s}`);
}

if (problems.length) {
  console.error(`[settings-css] 前缀口径违规 ${problems.length} 条：`);
  for (const p of problems.slice(0, 20)) console.error(`  ✗ ${p}`);
  console.error("  规则：每条顶层规则带且仅带一层 `.settings-view ` 前缀（.settings-view 自身除外）");
  process.exit(1);
}
console.log(`[settings-css] 前缀口径正常（${sels.length} 条顶层规则）`);
