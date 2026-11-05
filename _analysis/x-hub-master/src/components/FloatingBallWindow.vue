<script setup lang="ts">
// 桌面悬浮球（ADR 0004）：透明置顶小窗（label=floating-ball），「全息能量核」视觉方案。
// 拖拽移动（系统原生拖动循环 + 松手贴边自动隐藏/记忆位置）、单击展开环形菜单
// （螺旋扫出/倒序收回）、双击显示主窗口、右键托盘同款菜单；开合由 Rust 以球心为锚
// 原子切换窗口几何（球态 100 ↔ 菜单态 260），重排滞后帧用整窗淡出掩盖。
// 贴边半隐/悬停滑出/离开隐回全部由 Rust 边缘监视循环移动窗口实现
// （floating_ball.rs edge_tick，参考 tiez-clipboard）——页面不再做任何 dock 平移。
// 视觉构成：canvas 粒子球（斐波那契点云 + 能量网 + 脉冲能量核 + 雷达刻度）
//          + CSS 3D 陀螺环（三环自旋 + 悬停指针倾转）+ 光晕呼吸 + 接触阴影 + 悬停微升起；
//          球体为玻璃质感、配色跟随设置「外观」的主题强调色（--fb-accent）。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, type CSSProperties } from 'vue'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { listen } from '@tauri-apps/api/event'
import { isTauri, tauriApi, type FloatingBallState } from '../api/tauri'
import { FLOATING_BALL_BUTTONS } from '../composables/floatingBallButtons'

// 透明窗口：body/#app 去底色（style.css 按此标记生效）。
// 本模块被 App.vue 静态引入，顶层代码会在所有窗口执行——只在悬浮球窗口
// （或浏览器预览）打标记，避免主窗/其他浮窗的 body 底色被误置透明。
if (!isTauri() || getCurrentWindow().label === 'floating-ball') {
  document.documentElement.dataset.floatingBall = ''
}

const st = ref<FloatingBallState | null>(null)
/** 窗口几何是否处于菜单展开态（与 Rust expand 同步） */
const menuOpen = ref(false)
/** 页面动画态：closed 无按钮 / open 螺旋扫出 / closing 倒序收回（收回期间几何仍展开） */
const menuVisual = ref<'closed' | 'open' | 'closing'>('closed')
const dragging = ref(false)
const hovered = ref(false)
/** 扫出动画播完后移除 animation（fill 覆盖 hover transform） */
const settledAll = ref(false)
/** 静止态暂停陀螺环自旋（与 drawFrame 的 isActiveFrame 同口径，见 CSS rings-idle 规则） */
const ringsIdle = ref(true)

const ballEl = ref<HTMLElement | null>(null)
const cvsEl = ref<HTMLCanvasElement | null>(null)

const buttons = computed(() =>
  (st.value?.buttons ?? [])
    .map((id) => ({ id, ...(FLOATING_BALL_BUTTONS[id] ?? { label: id, icon: null }) }))
    .filter((b) => b.label),
)

/** 按钮轨道半径：菜单窗 260 → 中心 130 - 按钮外沿 26 - 余量 14 = 90（与 Rust MENU_SIZE 匹配；
 *  余量给足 14px 吸收非整数 DPI 的视口取整误差，避免按钮外圈被窗口边缘裁出一条切痕） */
const ringR = computed(() => Math.round((st.value?.menu_size ?? 260) / 2) - 40)

/** 环形布局：第一个按钮在正上方顺时针均分；rotate/translate 链式定位，供螺旋动画插值 */
function btnVars(i: number): CSSProperties {
  const n = Math.max(buttons.value.length, 1)
  const angle = -90 + (360 / n) * i
  return {
    '--fa': `${angle}deg`,
    '--i': String(i),
    '--n': String(n),
    '--ring-r': `${ringR.value}px`,
  }
}

// ---- 菜单开合：窗口几何（球态 100 ↔ 菜单态 260）由 Rust expand 以球心为锚原子切换，
// 页面只管动画态。窗口 resize 时 WebView2 内容重排滞后一帧（旧帧按旧视口贴在新窗口
// 左上角渲染）——切换若发生在内容还未完全不可见时，球会「闪一下到左上角」（用户反馈，
// 上一版淡出仅 40/90ms 就切几何，残留半透明帧漏出跳动）。对策：整窗 opacity:0 且
// transition:none（隐藏立即生效），等两帧确保隐藏真正合成上屏后再发几何 IPC；
// 恢复时移除类按基础 0.09s transition 平滑淡入。总延迟≈两帧+IPC+落定等待 ----
const RESIZE_SETTLE_MS = 70
const resizing = ref(false)

function sleep(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms))
}

/** 收回动画总时长：末位按钮延迟 (n-1)*28ms + 时长 300ms，8 键 ≈ 496ms（含缓冲取 540） */
const RETREAT_MS = 540
let closeTimer: number | null = null
let settledTimer: number | null = null

function armSettled() {
  if (settledTimer != null) window.clearTimeout(settledTimer)
  const n = Math.max(buttons.value.length, 1)
  settledTimer = window.setTimeout(() => {
    settledTimer = null
    settledAll.value = true
  }, 380 + (n - 1) * 35 + 60)
}

/** 窗口操作超时兜底：Rust 侧意外卡住时也要继续走完开合流程，不能让球永久停在淡出态 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('window op timeout')), ms)
    p.then(
      (v) => {
        window.clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        window.clearTimeout(timer)
        reject(e)
      },
    )
  })
}

/** 等两帧实际合成上屏：rAF 回调在绘制前触发，第二帧回调时上一帧（opacity:0）已合成 */
function nextPaint(): Promise<void> {
  return new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  )
}

async function resizeSettle(expanded: boolean) {
  resizing.value = true
  await nextTick()
  await nextPaint()
  try {
    await withTimeout(tauriApi.floatingBallExpand(expanded), 1200)
  } catch {
    /* 几何切换失败/超时不阻塞动画态推进 */
  }
  await sleep(RESIZE_SETTLE_MS)
  resizing.value = false
  // 展开/收拢落定后校验一次视口：非整数 DPI 下窗口物理尺寸若仍偏小，
  // 按钮外圈会被窗口边缘裁切（携带实测视口宽让 Rust 反推真实缩放自愈）
  window.setTimeout(checkViewportSync, 50)
}

async function openMenu() {
  if (buttons.value.length === 0) return
  if (resizing.value) return
  if (closeTimer != null) {
    // 收回动画期间再次展开：几何尚未收拢，直接复位动画态重播扫出
    window.clearTimeout(closeTimer)
    closeTimer = null
    menuVisual.value = 'open'
    settledAll.value = false
    armSettled()
    return
  }
  if (menuOpen.value) return
  menuOpen.value = true
  targetEnergy = 1
  await resizeSettle(true)
  if (!menuOpen.value) return
  menuVisual.value = 'open'
  armSettled()
}

function closeMenu() {
  if (!menuOpen.value || closeTimer != null || resizing.value) return
  resetTilt()
  menuVisual.value = 'closing'
  settledAll.value = false
  if (settledTimer != null) {
    window.clearTimeout(settledTimer)
    settledTimer = null
  }
  // 先播倒序收回，再收拢窗口几何（收早了收回动画会被窗口裁掉）；
  // 收拢时整窗淡出掩盖重排跳动，落定后切回 closed（按钮 v-show 卸下）
  closeTimer = window.setTimeout(() => {
    closeTimer = null
    menuOpen.value = false
    targetEnergy = hovered.value ? 1 : 0
    void resizeSettle(false).then(() => {
      menuVisual.value = 'closed'
    })
  }, RETREAT_MS)
}

// ---- 拖拽：指针事件只判「点/拖」，窗口移动交给系统原生拖动循环（零 IPC）----
// IPC 逐帧 set_position 的两条路（串行 await / rAF 单飞）在 Windows 透明窗口上
// 跟随指针都有滞后抖动（鬼畜）。根治：位移超阈值后调 startDragging 进入系统
// 模态拖动循环——以输入速率原生移动窗口，丝滑跟手；模态循环随松键退出，
// promise resolve 即拖拽结束，再做钳制进屏/贴边半隐/记忆位置。
interface DragCtx {
  startClientX: number
  startClientY: number
  /** 累计位移（物理 px），区分单击与拖拽 */
  moved: number
  /** 已进入系统原生拖动循环（此后指针事件被模态循环接管） */
  native: boolean
}
const DRAG_THRESHOLD = 6
// 单击展开前的双击甄别等待：压到 150ms（双击两段间隔通常 <150ms；稍慢的误双击
// 也只是菜单刚开又被 act:main 隐藏主窗联动收掉，代价可接受，换单击明显跟手）
const CLICK_DELAY_MS = 150

let drag: DragCtx | null = null
let menuClickArmed = false
let clickTimer: number | null = null

// ---- 悬停 3D 倾转（原型「全息粒子激发」的外层装饰）：指针相对球心的位置驱动陀螺环组 ----
// 菜单态/拖拽中冻结不更新，离球回正；CSS transition 0.18s 平滑跟随
const TILT_DEG = 16
const tiltX = ref(0)
const tiltY = ref(0)
const gyroStyle = computed<CSSProperties>(() => ({
  transform: `rotateX(${(-tiltY.value * TILT_DEG).toFixed(2)}deg) rotateY(${(tiltX.value * TILT_DEG).toFixed(2)}deg)`,
}))

function updateTilt(e: PointerEvent) {
  if (drag || menuOpen.value || !ballEl.value) return
  const r = ballEl.value.getBoundingClientRect()
  tiltX.value = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width) * 2 - 1))
  tiltY.value = Math.max(-1, Math.min(1, ((e.clientY - r.top) / r.height) * 2 - 1))
}

function resetTilt() {
  tiltX.value = 0
  tiltY.value = 0
}

function cancelPendingToggle() {
  if (clickTimer != null) {
    clearTimeout(clickTimer)
    clickTimer = null
  }
}

function onBallPointerDown(e: PointerEvent) {
  if (!isTauri() || e.button !== 0) return
  targetEnergy = 1
  if (menuOpen.value) {
    // 菜单态点球体 = 收起（ADR：再点球体收起）；不做拖拽
    menuClickArmed = true
    return
  }
  drag = { startClientX: e.clientX, startClientY: e.clientY, moved: 0, native: false }
  dragging.value = true
  ballEl.value?.setPointerCapture(e.pointerId)
}

function onBallPointerMove(e: PointerEvent) {
  updateTilt(e)
  if (!drag) return
  drag.moved = Math.max(
    drag.moved,
    Math.hypot(e.clientX - drag.startClientX, e.clientY - drag.startClientY) *
      (window.devicePixelRatio || 1),
  )
  // 兜底：捕获丢失/在窗外松键时 pointerup 不来，按键已抬起则立即收尾
  // （原生循环中除外：结束统一由 startDragging 的 promise 处理）
  if (e.buttons === 0) {
    if (!drag.native) void onBallPointerUp()
    return
  }
  // 位移超阈值 → 移交系统原生拖动
  if (!drag.native && drag.moved >= DRAG_THRESHOLD) {
    drag.native = true
    // 通知 Rust「拖拽开始」。真正的松手由后端边缘监视循环检测（左键释放后的第一跳
    // 统一钳制/吸附/落位/记忆，随后发 floating-ball-settled 事件）——
    // startDragging 的 promise 在拖动开始时就 resolve，不能当拖动结束信号：
    // 曾因此在松手钩子里读到拖动中途位置（与最终位置差几百 px），
    // 球被落位补齐搬回中途——表现为「拖到边缘松手，球弹回屏幕中间」
    void tauriApi.floatingBallDragBegin().catch(() => {})
    getCurrentWindow()
      .startDragging()
      .then(() => {
        drag = null
        dragging.value = false
        targetEnergy = hovered.value ? 1 : 0
      })
      .catch(() => {
        // 启动失败：清掉后端刚武装的落位标志（否则残留标志会把用户下一次无关的
        // 左键单击松开当成拖拽落位，球被无端吸附/落位），再回退指针收尾路径
        void tauriApi.floatingBallDragCancel().catch(() => {})
        if (drag) drag.native = false
      })
  }
}

async function onBallPointerUp() {
  if (menuClickArmed) {
    menuClickArmed = false
    closeMenu()
    return
  }
  if (!drag || drag.native) return // 原生拖动中：结束统一由 startDragging 的 promise 处理
  const moved = drag.moved
  drag = null
  dragging.value = false
  cancelPendingToggle()
  if (moved < DRAG_THRESHOLD) {
    // 单击展开（延迟以区分双击）；双击由 onBallDblClick 取消并显示主窗
    clickTimer = window.setTimeout(() => {
      clickTimer = null
      void openMenu()
    }, CLICK_DELAY_MS)
  } else {
    // 非原生回退路径：松手后窗口位置由后端监视循环统一落位（drag begin 已武装），
    // 落位完成会发 floating-ball-settled 事件刷新停靠边
    targetEnergy = hovered.value ? 1 : 0
  }
}

/** pointerup 正常路径会先清 drag；drag 仍在说明捕获被系统夺走，兜底收尾 */
function onBallLostCapture() {
  if (drag && !drag.native) void onBallPointerUp()
}

function onBallDblClick() {
  cancelPendingToggle()
  void tauriApi.floatingBallTrigger('act:main')
}

function onBallPointerEnter() {
  hovered.value = true
  if (!drag) targetEnergy = 1
}

function onBallPointerLeave() {
  hovered.value = false
  menuClickArmed = false
  resetTilt()
  if (!drag && !menuOpen.value) {
    targetEnergy = 0
  }
}

// ---- 贴边停靠：露出/隐回由 Rust 边缘监视循环直接移动窗口（见 floating_ball.rs
// edge_tick）；页面不再参与——旧的 CSS 平移方案依赖 pointerenter/leave，在原生拖拽
// 模态循环吞指针事件、半截屏外窗口命中不稳等场景下时好时坏，已整体移除 ----

function refreshState() {
  tauriApi
    .floatingBallGetState()
    .then((s) => {
      st.value = s
    })
    .catch(() => {})
}

// ---- 动作分发：先收起菜单再触发（剪贴板/视图等互不遮挡） ----
function onButton(id: string) {
  closeMenu()
  tauriApi.floatingBallTrigger(id).catch(() => {
    // 忽略：动作失败静默（如目标窗口不存在）
  })
}

function onContextMenu(e: MouseEvent) {
  e.preventDefault()
  if (isTauri()) void tauriApi.floatingBallContextMenu()
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') closeMenu()
}

// ---- 主题强调色：球体/粒子/陀螺环配色跟随设置「外观」的强调色 ----
// 启动时经 get_theme_config 自取初始值（独立窗口不经过主窗 useTheme），
// 主窗主题变化经 'floating-ball-theme' 推送；canvas 内绘制颜色同步跟随
let accentRgb = { r: 124, g: 108, b: 255 }

/** 未自定义强调色时跟随主窗主题默认（亮 #5B5BF5 / 暗 #8b8bff，对齐 style.css）；
 * mode=system 时按系统偏好判断 */
function resolveAccent(accent: string | null | undefined, mode: string | null | undefined): string {
  if (accent) return accent
  const m = (mode ?? '').toLowerCase()
  const dark =
    m === 'dark' ||
    (m === 'system' && !!window.matchMedia?.('(prefers-color-scheme: dark)').matches)
  return dark ? '#8b8bff' : '#5b5bf5'
}

function applyAccent(hex: string) {
  const v = hex.trim()
  if (!/^#[0-9a-f]{6}$/i.test(v)) return
  document.documentElement.style.setProperty('--fb-accent', v)
  const n = parseInt(v.slice(1), 16)
  accentRgb = { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

/** accent 的 rgba 字符串；lift > 0 时向白色提亮（lift 0..1） */
function accentRgba(a: number, lift = 0): string {
  const { r, g, b } = accentRgb
  if (lift > 0) {
    const mix = (c: number) => Math.round(c + (255 - c) * lift)
    return `rgba(${mix(r)},${mix(g)},${mix(b)},${a.toFixed(3)})`
  }
  return `rgba(${r},${g},${b},${a.toFixed(3)})`
}

// ---- 全息粒子球：斐波那契球面点云 + 近邻连线 + 能量核心 + 雷达刻度 ----
// 画布内部分辨率 240（CSS 显示 120，绘制时整体缩 0.5）；ORB/线宽等均为 240 空间数值
const CANVAS_PX = 240
const CORE = 120
const ORB = 50
const LINE_D = Math.sqrt(460)
const DOT_N = 150
const GOLDEN = Math.PI * (3 - Math.sqrt(5))

interface P3 {
  x: number
  y: number
  z: number
}
const pts: P3[] = []
for (let i = 0; i < DOT_N; i++) {
  const y = 1 - (i / (DOT_N - 1)) * 2
  const r = Math.sqrt(1 - y * y)
  const th = GOLDEN * i
  pts.push({ x: Math.cos(th) * r, y, z: Math.sin(th) * r })
}

let yaw = 0
let pitch = -0.28
let energy = 0
let targetEnergy = 0
let corePhase = 0
let lastT = 0
let rafId = 0
let ctx2d: CanvasRenderingContext2D | null = null
/** 上一帧的交互态：变化时才写 ringsIdle，避免每帧触碰响应式 */
let lastActive = false

// ---- 渲染节流（笔记本发热治理）----
// 静止态（无拖拽/无菜单/能量已稳定）降到 24fps，交互/动画过渡期保持 60fps：
// 悬浮球是常驻窗口，60fps 常开在笔记本上是不小的 CPU/GPU 开销（低配集显尤甚）。
// 「静止时保持转动」开启（炫酷模式）时不降帧、环不停转，完整回到旧版行为。
const IDLE_FPS = 24
const IDLE_FRAME_MS = 1000 / IDLE_FPS
let lastFrameT = 0

/** 是否有需要满帧的交互/动画：拖拽、菜单展开、几何切换、能量过渡、用户选了静止常转 */
function isActiveFrame() {
  return (
    dragging.value ||
    menuOpen.value ||
    resizing.value ||
    Math.abs(energy - targetEnergy) > 0.002 ||
    (st.value?.idle_spin ?? false)
  )
}

// 预计算潜在连线对：点在单位球上，3D 弦距固定不随旋转变化；投影是刚性旋转 +
// 轻透视，屏幕距离被 3D 弦距 × 最大投影系数（ORB/0.78 ≈ 64）约束。
// 只有 3D 弦距可能落进 LINE_D 的对才逐帧做屏幕距离判定，把每帧 O(n²) 的
// 全量判定降到预计算的候选子集（约 1/10），静止渲染成本显著下降。
const PAIR_3D_MAX = (LINE_D / (ORB / 0.78)) * 1.35
const linePairs: Array<[number, number]> = []
for (let i = 0; i < DOT_N; i++) {
  for (let j = i + 1; j < DOT_N; j++) {
    const dx = pts[i].x - pts[j].x
    const dy = pts[i].y - pts[j].y
    const dz = pts[i].z - pts[j].z
    if (dx * dx + dy * dy + dz * dz < PAIR_3D_MAX * PAIR_3D_MAX) {
      linePairs.push([i, j])
    }
  }
}

function project(p: P3) {
  const cy = Math.cos(yaw)
  const sy = Math.sin(yaw)
  const cp = Math.cos(pitch)
  const sp = Math.sin(pitch)
  const x1 = p.x * cy - p.z * sy
  const z1 = p.x * sy + p.z * cy
  const y2 = p.y * cp - z1 * sp
  const z2 = p.y * sp + z1 * cp
  const s = ORB / (1 - z2 * 0.22) // 轻透视：近大远小
  return { sx: CORE + x1 * s, sy: CORE + y2 * s, z: z2, sc: s / ORB }
}

function drawDot(ctx: CanvasRenderingContext2D, p: { sx: number; sy: number; sc: number }, a: number) {
  ctx.fillStyle = accentRgba(a)
  ctx.beginPath()
  ctx.arc(p.sx, p.sy, 0.85 + p.sc * 1.4, 0, 6.2832)
  ctx.fill()
}

function drawFrame(t: number) {
  // 窗口隐藏（如主窗可见时球被隐藏）：立即停掉 rAF 链，等可见时重启，
  // 而不是继续以 60fps 空转（旧实现每帧都 reschedule，隐藏时 CPU 照样空烧）
  if (document.hidden || !ctx2d) {
    cancelAnimationFrame(rafId)
    rafId = 0
    return
  }
  if (!lastT) {
    lastT = t
    lastFrameT = t
    rafId = requestAnimationFrame(drawFrame)
    return
  }
  const dt = Math.min(0.05, (t - lastT) / 1000)
  lastT = t
  const ctx = ctx2d

  // 静止态降帧：能量已稳定且无交互时无需满帧重绘，跳过中间帧
  const active = isActiveFrame()
  if (!active) {
    if (t - lastFrameT < IDLE_FRAME_MS) {
      rafId = requestAnimationFrame(drawFrame)
      return
    }
  }
  lastFrameT = t
  // 交互态变化 → 同步陀螺环暂停/恢复（transition 无跳变，见 CSS rings-idle 注释）
  if (active !== lastActive) {
    lastActive = active
    ringsIdle.value = !active
  }

  energy += (targetEnergy - energy) * Math.min(1, dt * 7)
  yaw += dt * (0.45 + energy * 1.2) // 悬停/拖拽/菜单态能量激发，自转加快
  corePhase += dt * (1.6 + energy * 2.4)

  ctx.clearRect(0, 0, CANVAS_PX, CANVAS_PX)
  ctx.save()
  ctx.translate(CORE, CORE)
  ctx.scale(0.5, 0.5) // 240 → 120
  ctx.translate(-CORE, -CORE)

  const proj = pts.map(project)

  for (const p of proj) {
    if (p.z < 0) drawDot(ctx, p, 0.32) // 背面半球（暗）
  }
  for (const [i, j] of linePairs) {
    const a = proj[i]
    const b = proj[j]
    if (a.z <= 0 || b.z <= 0) continue
    const dx = a.sx - b.sx
    const dy = a.sy - b.sy
    const d2 = dx * dx + dy * dy
    if (d2 < LINE_D * LINE_D) {
      ctx.strokeStyle = accentRgba((1 - Math.sqrt(d2) / LINE_D) * (0.16 + energy * 0.32))
      ctx.lineWidth = 0.8
      ctx.beginPath()
      ctx.moveTo(a.sx, a.sy)
      ctx.lineTo(b.sx, b.sy)
      ctx.stroke()
    }
  }
  for (const p of proj) {
    if (p.z >= 0) drawDot(ctx, p, 0.6 + p.z * 0.38) // 正面半球（亮）
  }

  // 脉冲能量核：外辉 + 核盘 + X 徽记
  const pulse = 0.86 + Math.sin(corePhase) * 0.1 + energy * 0.06
  const cr = 20 * pulse
  let g = ctx.createRadialGradient(CORE, CORE, 0, CORE, CORE, cr * 2.6)
  g.addColorStop(0, accentRgba(0.3 + energy * 0.2))
  g.addColorStop(1, accentRgba(0))
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.arc(CORE, CORE, cr * 2.6, 0, 6.2832)
  ctx.fill()
  g = ctx.createRadialGradient(CORE - 3, CORE - 3, 1, CORE, CORE, cr)
  g.addColorStop(0, 'rgba(240,238,255,0.95)')
  g.addColorStop(0.5, accentRgba(0.55, 0.1))
  g.addColorStop(1, accentRgba(0.12))
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.arc(CORE, CORE, cr, 0, 6.2832)
  ctx.fill()
  ctx.strokeStyle = 'rgba(255,255,255,0.95)'
  ctx.lineWidth = 2.2
  ctx.lineCap = 'round'
  const k = 6.5 * pulse
  ctx.beginPath()
  ctx.moveTo(CORE - k, CORE - k)
  ctx.lineTo(CORE + k, CORE + k)
  ctx.moveTo(CORE + k, CORE - k)
  ctx.lineTo(CORE - k, CORE + k)
  ctx.stroke()

  // 雷达刻度环（随自转慢速旋转）
  ctx.save()
  ctx.translate(CORE, CORE)
  ctx.rotate(yaw * 0.6)
  for (let i = 0; i < 24; i++) {
    ctx.rotate(Math.PI / 12)
    const long = i % 6 === 0
    ctx.strokeStyle = accentRgba((long ? 0.4 : 0.16) * (0.7 + energy * 0.6), 0.35)
    ctx.lineWidth = long ? 1.4 : 1
    ctx.beginPath()
    ctx.moveTo(ORB + 5, 0)
    ctx.lineTo(ORB + 5 + (long ? 5 : 3), 0)
    ctx.stroke()
  }
  ctx.restore()

  ctx.restore()

  // 画完必须续上下一帧：旧实现在函数开头 reschedule，799f4b6 改「隐藏停 rAF」时
  // 只留了各提前返回分支的 reschedule，漏了这一处 → 循环画完一帧就断，球体冻结
  // （ringsIdle 永不更新，「静止时保持转动」开关因此失效）。
  rafId = requestAnimationFrame(drawFrame)
}

let unlistenShown: (() => void) | null = null
let unlistenConfig: (() => void) | null = null
let unlistenSettled: (() => void) | null = null
let unlistenFocus: (() => void) | null = null
let unlistenTheme: (() => void) | null = null

// ---- 视口失配自检（DPI 自愈兜底，Rust 侧机制见 floating_ball.rs「DPI 自愈」注释）----
// 非整数系统缩放（如 110% → scale 1.104166…）下，悬浮球隐藏期间错过 DPI 变化会让
// 窗口物理尺寸与 WebView2 视口失配，球体陀螺环被窗口边缘裁掉一截。Rust 侧在开合/
// 显示/ScaleFactorChanged 时已自愈，这里兜底捕获「几何未被触发修正」的漏网场景：
// 视口与期望逻辑尺寸差超容差 → 让 Rust 按当前态重算几何。clientWidth 虽取整，
// 但取整误差 <1px、容差 1.5px 下不影响判定（正常 110% 换算差仅 ~0.4px，失配差 ~9px）。
const VIEWPORT_TOLERANCE = 1.5
let viewportTimer: number | null = null

function checkViewportSync() {
  if (!isTauri() || !st.value || resizing.value) return
  const expected = menuOpen.value
    ? (st.value.menu_size ?? 260)
    : (st.value.ball_size ?? 100)
  if (
    Math.abs(document.documentElement.clientWidth - expected) > VIEWPORT_TOLERANCE ||
    Math.abs(document.documentElement.clientHeight - expected) > VIEWPORT_TOLERANCE
  ) {
    tauriApi.floatingBallReapply(document.documentElement.clientWidth).catch(() => {})
  }
}

function onWindowResize() {
  if (viewportTimer != null) window.clearTimeout(viewportTimer)
  viewportTimer = window.setTimeout(() => {
    viewportTimer = null
    checkViewportSync()
  }, 250)
}

// 窗口重新可见（隐藏→显示，主窗收起球又出现）时重启 rAF 链；
// drawFrame 在 document.hidden 时已停掉循环，这里负责拉起
function onVisibilityChange() {
  if (!document.hidden && rafId === 0 && ctx2d) {
    lastT = 0
    lastFrameT = 0
    rafId = requestAnimationFrame(drawFrame)
  }
}

onMounted(async () => {
  window.addEventListener('resize', onWindowResize)
  document.addEventListener('keydown', onKeydown)
  document.addEventListener('visibilitychange', onVisibilityChange)
  ctx2d = cvsEl.value?.getContext('2d') ?? null
  rafId = requestAnimationFrame(drawFrame)
  if (!isTauri()) return
  try {
    st.value = await tauriApi.floatingBallGetState()
  } catch {
    st.value = null
  }
  // 主题强调色：独立窗口自取初始值 + 监听主窗 useTheme 的运行时推送
  try {
    const t = await tauriApi.getThemeConfig()
    applyAccent(resolveAccent(t.accent, t.mode))
  } catch {
    /* 无后端时保持默认色 */
  }
  unlistenTheme = await listen<{ accent?: string | null; dark?: boolean }>(
    'floating-ball-theme',
    (e) => {
      applyAccent(resolveAccent(e.payload?.accent, e.payload?.dark ? 'dark' : 'light'))
    },
  )
  const appWindow = getCurrentWindow()
  // 主窗重新显示会把球隐藏（Rust 侧已收拢几何）：页面复位菜单/动画态
  unlistenShown = await listen('floating-ball-shown', () => {
    if (closeTimer != null) {
      window.clearTimeout(closeTimer)
      closeTimer = null
    }
    if (settledTimer != null) {
      window.clearTimeout(settledTimer)
      settledTimer = null
    }
    menuOpen.value = false
    menuVisual.value = 'closed'
    settledAll.value = false
    targetEnergy = 0
    // 兜底重启渲染链：tao hide/show 重建 ex-style 可能不触发 visibilitychange，
    // 这里显式拉起（drawFrame 隐藏时已把 rafId 清零）
    if (rafId === 0 && ctx2d) {
      lastT = 0
      lastFrameT = 0
      rafId = requestAnimationFrame(drawFrame)
    }
    // 隐藏期间可能错过 DPI 变化且收拢几何不触发 resize 事件：显示后主动校验视口
    window.setTimeout(checkViewportSync, 100)
  })
  // 设置页调整按钮集/贴边自动隐藏开关后即时生效：整体重拉（含停靠边）
  unlistenConfig = await listen('floating-ball-config-changed', () => refreshState())
  // 拖拽落位完成（后端监视循环在左键释放后统一钳制/吸附/记忆）→ 重拉停靠边
  unlistenSettled = await listen('floating-ball-settled', () => refreshState())
  // 窗口失焦收起菜单（ADR：窗口失焦为四种收起方式之一）
  unlistenFocus = await appWindow.onFocusChanged(({ payload }) => {
    if (!payload) closeMenu()
  })
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', onWindowResize)
  document.removeEventListener('keydown', onKeydown)
  document.removeEventListener('visibilitychange', onVisibilityChange)
  if (viewportTimer != null) window.clearTimeout(viewportTimer)
  cancelAnimationFrame(rafId)
  cancelPendingToggle()
  if (closeTimer != null) window.clearTimeout(closeTimer)
  if (settledTimer != null) window.clearTimeout(settledTimer)
  unlistenShown?.()
  unlistenConfig?.()
  unlistenSettled?.()
  unlistenFocus?.()
  unlistenTheme?.()
})
</script>

<template>
  <div
    class="fb-root"
    :class="{ open: menuVisual !== 'closed', dragging, hovered, resizing, 'rings-idle': ringsIdle }"
  >
    <!-- 菜单态底座：点击环形外空白收起（ADR 收起方式之一） -->
    <div v-if="menuVisual === 'open'" class="fb-backdrop" @pointerdown="closeMenu"></div>

    <!-- 双层轨道环（菜单态装饰） -->
    <div v-show="menuVisual !== 'closed'" class="fb-arc fb-arc1"></div>
    <div v-show="menuVisual !== 'closed'" class="fb-arc fb-arc2"></div>

    <!-- 环形快捷菜单按钮：沿圆弧螺旋扫出 / 倒序收回 -->
    <button
      v-for="(b, i) in buttons"
      v-show="menuVisual !== 'closed'"
      :key="b.id"
      type="button"
      class="fb-btn"
      :class="{ closing: menuVisual === 'closing', settled: settledAll && menuVisual === 'open' }"
      :style="btnVars(i)"
      :aria-label="b.label"
      @click.stop="onButton(b.id)"
    >
      <component :is="b.icon" v-if="b.icon" :size="20" :stroke-width="1.9" />
      <span class="fb-btn-label">{{ b.label }}</span>
    </button>

    <!-- 球体容器（纯布局层；贴边露出/隐回由 Rust 移动窗口实现，这里无平移逻辑） -->
    <div class="fb-dock">
      <!-- 接触阴影（悬停收窄 / 拖拽摊开）+ 光晕呼吸 -->
      <div class="fb-shadow"></div>
      <div class="fb-halo"></div>

      <!-- 球体：全息能量核（canvas 粒子球 + CSS 3D 陀螺环） -->
      <div
        ref="ballEl"
        class="fb-ball"
        @pointerdown="onBallPointerDown"
        @pointermove="onBallPointerMove"
        @pointerup="onBallPointerUp"
        @pointercancel="onBallPointerUp"
        @lostpointercapture="onBallLostCapture"
        @pointerenter="onBallPointerEnter"
        @pointerleave="onBallPointerLeave"
        @dblclick.stop="onBallDblClick"
        @contextmenu.prevent.stop="onContextMenu"
      >
        <canvas ref="cvsEl" class="fb-canvas" width="240" height="240"></canvas>
        <!-- 陀螺环组：三环不同轴自旋 + 悬停随指针倾转（最外层全息装饰） -->
        <div class="fb-gyro" :style="gyroStyle" aria-hidden="true">
          <div class="fb-oring fb-or1"></div>
          <div class="fb-oring fb-or2"></div>
          <div class="fb-oring fb-or3"></div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.fb-root {
  position: fixed;
  inset: 0;
  pointer-events: none;
  transition: opacity 0.09s ease;
}
/* 几何切换期间整窗隐藏：transition:none 让隐藏帧立即生效——窗口尺寸切换必须发生在
   完全不可见时，否则 WebView2 旧帧会把球画到新窗口左上角（闪一下）；
   恢复时移除本类，按基础 transition 平滑淡入 */
.fb-root.resizing {
  opacity: 0;
  transition: none;
}
.fb-root.resizing .fb-ball,
.fb-root.resizing .fb-btn,
.fb-root.resizing .fb-backdrop {
  pointer-events: none;
}

/* ---- 球体容器：绝对定位布局层（贴边露出/隐回由 Rust 移动窗口实现，无平移动画） ---- */
.fb-dock {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

/* ---- 菜单态底座 ---- */
.fb-backdrop {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  pointer-events: auto;
}

/* ---- 双层轨道环（菜单态装饰）：arc1 直径 = 2 × ringR（按钮轨道），arc2 为内衬环；
   调整 MENU_SIZE / ringR 时同步这里 ---- */
.fb-arc {
  position: absolute;
  left: 50%;
  top: 50%;
  border-radius: 50%;
  pointer-events: none;
}
.fb-arc1 {
  width: 180px;
  height: 180px;
  margin: -90px 0 0 -90px;
  border: 1px dashed color-mix(in srgb, var(--fb-accent, #7c6cff) 28%, transparent);
  animation: fb-arc-in 0.4s ease-out both;
}
.fb-arc2 {
  width: 120px;
  height: 120px;
  margin: -60px 0 0 -60px;
  border: 1px solid color-mix(in srgb, var(--fb-accent, #7c6cff) 10%, transparent);
  animation: fb-arc-in 0.4s ease-out both;
}
@keyframes fb-arc-in {
  from {
    opacity: 0;
    transform: scale(0.6);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}

/* ---- 环形菜单按钮（暗色玻璃，浮于任意桌面壁纸之上） ---- */
.fb-btn {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 52px;
  height: 52px;
  margin: -26px 0 0 -26px;
  border-radius: 50%;
  border: 1px solid color-mix(in srgb, var(--fb-accent, #7c6cff) 38%, rgba(255, 255, 255, 0.22));
  /* 暗色烟玻璃打底（以强调色着色）：白玻璃渐变在亮色壁纸上与浅色文字一起消失，
     实底保证亮/暗壁纸下按钮与文字都有稳定对比 */
  background: linear-gradient(
    160deg,
    color-mix(in srgb, var(--fb-accent, #7c6cff) 30%, rgba(30, 27, 62, 0.9)),
    color-mix(in srgb, var(--fb-accent, #7c6cff) 14%, rgba(15, 13, 36, 0.94))
  );
  color: #eceaf8;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1px;
  cursor: pointer;
  padding: 0;
  pointer-events: auto;
  box-shadow:
    0 6px 18px rgba(0, 0, 0, 0.4),
    inset 0 1px 1px rgba(255, 255, 255, 0.15);
  transform: rotate(var(--fa)) translateY(calc(-1 * var(--ring-r))) rotate(calc(-1 * var(--fa)));
  transition:
    transform 0.15s ease,
    box-shadow 0.14s ease,
    border-color 0.14s ease,
    color 0.14s ease;
  animation: fb-sweep 0.38s cubic-bezier(0.3, 1.4, 0.45, 1) both;
  animation-delay: calc(var(--i) * 35ms);
}
/* 播完后移除 animation：fill 会盖住 hover 的 transform */
.fb-btn.settled {
  animation: none;
}
.fb-btn:hover {
  transform: rotate(var(--fa)) translateY(calc(-1 * var(--ring-r))) rotate(calc(-1 * var(--fa)))
    scale(1.14);
  border-color: var(--fb-accent, #a78bfa);
  background: linear-gradient(
    160deg,
    color-mix(in srgb, var(--fb-accent, #7c6cff) 44%, rgba(34, 30, 70, 0.92)),
    color-mix(in srgb, var(--fb-accent, #7c6cff) 22%, rgba(18, 16, 42, 0.95))
  );
  box-shadow:
    0 8px 22px rgba(0, 0, 0, 0.5),
    0 0 16px color-mix(in srgb, var(--fb-accent, #7c6cff) 55%, transparent);
  color: #fff;
}
/* 收回：沿原轨迹倒序逐个螺旋退回球心 */
.fb-btn.closing {
  pointer-events: none;
  animation: fb-retreat 0.3s cubic-bezier(0.5, 0, 0.75, 0.4) both;
  animation-delay: calc((var(--n) - 1 - var(--i)) * 28ms);
}
.fb-btn-label {
  font-size: 9px;
  line-height: 1;
  color: rgba(236, 234, 248, 0.9);
  white-space: nowrap;
  transition: color 0.14s ease;
}
.fb-btn:hover .fb-btn-label {
  color: var(--fb-accent, #a78bfa);
}
@keyframes fb-sweep {
  0% {
    opacity: 0;
    transform: rotate(calc(var(--fa) - 120deg)) translateY(-14px)
      rotate(calc(-1 * (var(--fa) - 120deg))) scale(0.4);
  }
  55% {
    opacity: 1;
  }
  100% {
    opacity: 1;
    transform: rotate(var(--fa)) translateY(calc(-1 * var(--ring-r)))
      rotate(calc(-1 * var(--fa))) scale(1);
  }
}
@keyframes fb-retreat {
  0% {
    opacity: 1;
    transform: rotate(var(--fa)) translateY(calc(-1 * var(--ring-r)))
      rotate(calc(-1 * var(--fa))) scale(1);
  }
  45% {
    opacity: 1;
  }
  100% {
    opacity: 0;
    transform: rotate(calc(var(--fa) - 120deg)) translateY(-14px)
      rotate(calc(-1 * (var(--fa) - 120deg))) scale(0.4);
  }
}

/* ---- 接触阴影：悬停收窄变淡，拖拽摊开 ---- */
.fb-shadow {
  position: absolute;
  left: 50%;
  top: calc(50% + 18px);
  width: 46px;
  height: 9px;
  margin-left: -23px;
  border-radius: 50%;
  background: radial-gradient(ellipse at center, rgba(0, 0, 0, 0.55) 0%, rgba(0, 0, 0, 0) 68%);
  filter: blur(5px);
  pointer-events: none;
  opacity: 0.85;
  transition:
    transform 0.25s ease,
    opacity 0.25s ease;
}
.fb-root.hovered .fb-shadow {
  transform: scaleX(0.86);
  opacity: 0.78;
}
.fb-root.dragging .fb-shadow {
  transform: scaleX(1.14) scaleY(0.8);
  opacity: 0.5;
}

/* ---- 光晕呼吸：常显微光保证可见度，悬停/拖拽/菜单展开时增强 ---- */
.fb-halo {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 68px;
  height: 68px;
  margin: -34px 0 0 -34px;
  border-radius: 50%;
  background: radial-gradient(
    circle,
    color-mix(in srgb, var(--fb-accent, #7c6cff) 55%, transparent) 0%,
    color-mix(in srgb, var(--fb-accent, #7c6cff) 25%, transparent) 40%,
    transparent 68%
  );
  opacity: 0.4;
  transform: scale(0.9);
  transition: opacity 0.3s ease;
  pointer-events: none;
}
.fb-root.hovered .fb-halo,
.fb-root.dragging .fb-halo,
.fb-root.open .fb-halo {
  opacity: 1;
  animation: fb-halo-breathe 2.6s ease-in-out infinite;
}
@keyframes fb-halo-breathe {
  0%,
  100% {
    transform: scale(0.97);
    filter: brightness(1);
  }
  50% {
    transform: scale(1.07);
    filter: brightness(1.3);
  }
}

/* ---- 球体：玻璃质感球（主题强调色着色） ----
   内部按 68px 布局绘制（canvas 240 内部分辨率），整体 scale(48/68) 缩到 48px 视觉；
   改球体尺寸时改这个 scale 值（及 Rust 侧 BALL_R 的球缘假定） */
.fb-ball {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 68px;
  height: 68px;
  perspective: 453px; /* 陀螺环 3D 透视（原型 320px ÷ scale 0.706 补偿） */
  transform: translate(-50%, -50%) scale(0.706);
  border-radius: 50%;
  cursor: grab;
  touch-action: none;
  user-select: none;
  pointer-events: auto;
  /* 球面明暗：左上受光、右下背光，基色 = 主题强调色压暗；边缘略透出玻璃感 */
  background: radial-gradient(
    circle at 40% 32%,
    color-mix(in srgb, var(--fb-accent, #7c6cff) 58%, #fff) 0%,
    color-mix(in srgb, var(--fb-accent, #7c6cff) 55%, #171153) 30%,
    color-mix(in srgb, var(--fb-accent, #7c6cff) 42%, #0b0838) 56%,
    color-mix(in srgb, var(--fb-accent, #7c6cff) 30%, #060419) 78%,
    color-mix(in srgb, var(--fb-accent, #7c6cff) 20%, #050313) 94%,
    color-mix(in srgb, var(--fb-accent, #7c6cff) 10%, transparent) 100%
  );
  box-shadow:
    inset 0 0 0 1.5px color-mix(in srgb, var(--fb-accent, #7c6cff) 52%, transparent),
    inset 2px 4px 6px rgba(255, 255, 255, 0.28),
    inset -6px -10px 18px color-mix(in srgb, var(--fb-accent, #7c6cff) 38%, transparent),
    0 0 18px color-mix(in srgb, var(--fb-accent, #7c6cff) 38%, transparent);
  transition: transform 0.2s ease;
}
/* 底缘主题色透光（玻璃球底部折射），垫在 canvas 粒子之下 */
.fb-ball::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: radial-gradient(
    64% 44% at 50% 102%,
    color-mix(in srgb, var(--fb-accent, #7c6cff) 52%, transparent) 0%,
    transparent 72%
  );
  pointer-events: none;
}
/* 斜向镜面高光条（玻璃反光），盖在粒子与陀螺环之上 */
.fb-ball::after {
  content: '';
  position: absolute;
  left: 17%;
  top: 9%;
  width: 22%;
  height: 40%;
  border-radius: 50%;
  background: linear-gradient(rgba(255, 255, 255, 0.65), rgba(255, 255, 255, 0.04));
  filter: blur(2.5px);
  transform: rotate(40deg);
  pointer-events: none;
}
/* 悬停微升起 */
.fb-root.hovered .fb-ball {
  transform: translate(-50%, calc(-50% - 2px)) scale(0.706);
}
.fb-root.dragging .fb-ball {
  cursor: grabbing;
}

.fb-canvas {
  position: absolute;
  left: calc(50% - 60px);
  top: calc(50% - 60px);
  width: 120px;
  height: 120px;
  pointer-events: none;
}

/* ---- 陀螺环组：三环不同轴自旋，悬停随指针倾转（原型「全息粒子激发」最外层装饰） ----
   布局尺寸 = 原型视觉尺寸 × (68/48)，经 .fb-ball 的 scale(0.706) 还原为 82/66/94px 视觉；
   最外环视觉 94px → 球态窗口需 ≥ 100（Rust BALL_SIZE），否则被窗口裁切 */
.fb-gyro {
  position: absolute;
  inset: 0;
  pointer-events: none;
  transform-style: preserve-3d;
  transition: transform 0.18s ease-out;
}
.fb-oring {
  position: absolute;
  left: 50%;
  top: 50%;
  border-radius: 50%;
}
.fb-or1 {
  width: 116px;
  height: 116px;
  margin: -58px 0 0 -58px;
  border: 2px solid color-mix(in srgb, var(--fb-accent, #7c6cff) 30%, transparent);
  border-top-color: color-mix(in srgb, var(--fb-accent, #7c6cff) 55%, #fff);
  border-right-color: color-mix(in srgb, var(--fb-accent, #7c6cff) 70%, transparent);
  filter: drop-shadow(0 0 4px color-mix(in srgb, var(--fb-accent, #7c6cff) 80%, transparent));
  animation: fb-gyro-a 7s linear infinite;
}
.fb-or2 {
  width: 93px;
  height: 93px;
  margin: -46.5px 0 0 -46.5px;
  border: 2px solid color-mix(in srgb, var(--fb-accent, #7c6cff) 22%, transparent);
  border-top-color: color-mix(in srgb, var(--fb-accent, #7c6cff) 40%, #fff);
  border-left-color: color-mix(in srgb, var(--fb-accent, #7c6cff) 55%, transparent);
  filter: drop-shadow(0 0 4px color-mix(in srgb, var(--fb-accent, #7c6cff) 70%, transparent));
  animation: fb-gyro-b 4.6s linear infinite reverse;
}
.fb-or3 {
  width: 133px;
  height: 133px;
  margin: -66.5px 0 0 -66.5px;
  border: 1.5px dashed color-mix(in srgb, var(--fb-accent, #7c6cff) 42%, transparent);
  animation: fb-gyro-c 12s linear infinite;
}
@keyframes fb-gyro-a {
  from {
    transform: rotateX(66deg) rotateZ(0deg);
  }
  to {
    transform: rotateX(66deg) rotateZ(360deg);
  }
}
@keyframes fb-gyro-b {
  from {
    transform: rotateY(64deg) rotateX(14deg) rotateZ(360deg);
  }
  to {
    transform: rotateY(64deg) rotateX(14deg) rotateZ(0deg);
  }
}
@keyframes fb-gyro-c {
  from {
    transform: rotateX(76deg) rotateY(-14deg) rotateZ(0deg);
  }
  to {
    transform: rotateX(76deg) rotateY(-14deg) rotateZ(-360deg);
  }
}
/* 静止态暂停陀螺环自旋：三环是合成器常驻 60fps 的 transform 动画（or1/or2 还各挂
   drop-shadow 滤镜层），球体可见但无人交互时属纯 GPU 空转，笔记本上持续发热。
   悬浮球是常驻窗口，静止远多于交互；canvas 粒子仍以 24fps 慢速自转，静止观感基本
   不变。animation-play-state 暂停=冻结当前角度，恢复从原角度继续，无跳变 */
.fb-root.rings-idle .fb-oring {
  animation-play-state: paused;
}

</style>
