# 主题跟随与 --xhub-* 变量

> **何时读我**：写任何 CSS 之前。扩展的**视觉正确性**几乎全在这一份里，也是踩坑最集中的地方。

宿主在加载入口 HTML 时注入全部主题变量，并在换主题/换强调色时实时更新。变量名 = `theme.get().tokens` 的 camelCase 字段转 kebab-case（`bgPage` → `--xhub-bg-page`）。

## 变量表

| CSS 变量 | 含义 |
|---|---|
| `--xhub-page-bg` | **扩展该铺的页面底（推荐用它）**：无壁纸时 = 宿主整页背景；**有壁纸时 = `transparent`** |
| `--xhub-bg-page` | 宿主**整页背景**（渐变，**alpha=1 不透明**）。⚠️ **别拿它铺扩展的页面底**——壁纸态下它会把壁纸整块盖住，透底态又因文字翻白而变成「白底白字」（实测踩过）；且它是 gradient，**不能当 `color:` 用**。要页面底请用上面的 `--xhub-page-bg` |
| `--xhub-bg-card` | 卡片底色（亮色态 ~0.88 白；**透底态会变成 `rgba(255,255,255,.2)`**）——适合做按钮/输入区的「井」底 |
| `--xhub-surface` | 玻璃表面（渐变，**已含玻璃透明度乘数**）——**扩展的卡片/面板底就用它** |
| `--xhub-text-1` / `--xhub-text-2` / `--xhub-text-3` | 主文字 / 次要 / 弱化 |
| `--xhub-border` | 边框 |
| `--xhub-accent` | 强调色（按钮、链接、高亮、数字） |
| `--xhub-brand` / `--xhub-brand-soft` | 品牌主色 / 品牌弱色（半透明底） |
| `--xhub-green` / `--xhub-red` / `--xhub-yellow` / `--xhub-blue` / `--xhub-orange` | 语义色 |
| `--xhub-radius-lg` | 大圆角 |

**所有颜色都要写成 `var(--xhub-*, fallback)`**——fallback 兜底首帧与无宿主预览。

## 明暗判断

宿主在入口的 `<html>` 上维护 `data-xhub-theme="light|dark"`，CSS 直接写：

```css
:root[data-xhub-theme="dark"] { … }
```

无需写任何 JS。

## 壁纸状态

宿主把壁纸状态转写成 `<html>` 上的三个属性（桥脚本 `applyTheme` 写入）：

| 属性 | 含义 |
|---|---|
| `data-xhub-wallpaper="1"` | 用户设置了壁纸 |
| `data-xhub-wallpaper-clear="1"` | **真实透底**（玻璃透明度 < 0.9 或沉浸模式）——此时宿主把 `--xhub-text-*` **整体翻白**、并让壁纸蒙版翻深（深底白字） |
| `data-xhub-immersive="1"` | 沉浸模式 |

**透底态照宿主 `.card` 的做法处理**：去掉白描边、只留中性落影（55% 白描边叠在照片上会呈「粉笔白框」）；文字加一档黑柔光晕；亮色主题的 `--xhub-accent` 是深色，叠在深蒙版壁纸上偏暗，运算符/图标这类小面积强调元素建议换成 `--xhub-brand-soft` 底 + 主文字色。

## 铁律：页面永远不铺不透明底

宿主 view/window 形态的容器链（`.view-extension` → `.extension-view` → `iframe[background:transparent]`）本来就全透明，**等着扩展自己画背景**——扩展一画不透明底，壁纸就被整块盖住。

页面底用专用令牌，一个写法两种形态都对：

```css
body { background: var(--xhub-page-bg, transparent); }  /* 无壁纸 = 宿主页面背景；有壁纸 = transparent */
```

内容表面再用 `--xhub-surface` 玻璃令牌。`module` 卡片同样透明（宿主已给它套玻璃卡）。`drawer` 形态：宿主的抽屉容器在壁纸态已是真实取景模糊 + 玻璃底，扩展用同款写法即可。

## 带自有 design token 的页面：双声明 fallback

转换场景常见——页面自带一套 token，要映射到宿主变量。`:root` 写浅色兜底、`:root[data-xhub-theme="dark"]` 重写深色兜底：宿主变量存在时两个块都解析到宿主值，无桥独立预览时各用各的兜底。

```css
:root {
  color-scheme: light;
  /* 页面底用 --xhub-page-bg（有壁纸时自动 transparent）；容器表面用宿主玻璃令牌 */
  --surface: var(--xhub-surface, oklch(0.97 0.005 40));
  --well: var(--xhub-bg-card, oklch(1 0 0));
  --ink: var(--xhub-text-1, oklch(0.24 0.014 40));
  --primary: var(--xhub-accent, oklch(0.51 0.142 40));
}
:root[data-xhub-theme="dark"] {
  color-scheme: dark;
  --surface: var(--xhub-surface, oklch(0.25 0.01 45));
  --well: var(--xhub-bg-card, oklch(0.20 0.01 45));
  --ink: var(--xhub-text-1, oklch(0.93 0.01 85));
  --primary: var(--xhub-accent, oklch(0.70 0.125 45));
}
```

只写一遍 fallback（不写 dark 块）的页面**在宿主里表现正常**，但无宿主预览时深色会露馅——强调色家族（`--primary` / `--primary-text` / `--primary-soft` 这类派生 token）最容易漏。

按钮/色块上叠字（`--on-primary` 这类）**按主题显式给**：宿主亮色主题的 `--xhub-accent` 是深色 → 白字；暗色主题的 accent 是浅色 → 深字。

**不要拿 `--xhub-bg-page` 当颜色用**——它是 gradient，`color: var(--xhub-bg-page)` 是无效声明，会静默退化成本身继承色（看着「碰巧对」，换个主题就错）。
