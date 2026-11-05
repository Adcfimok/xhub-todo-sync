import { ref, type ComputedRef, type Ref } from 'vue'
import type { Resource } from '../api/tauri'

/**
 * 速达卡片网格的长按拖拽排序（指针实现，#6）。
 *
 * 为什么不用 HTML5 DnD：Tauri 主窗口原生拖放拦截（`dragDropEnabled`）与 WebView 内 HTML5
 * 拖拽互斥（同 useTodoDrag / 笔记块拖拽，见 AGENTS.md 约定 14/38）——速达的「拖文件进来
 * 导入」走的就是那套原生通道，卡片排序只能走指针事件，两者才互不干扰。
 *
 * 同一原因，卡片内不能留任何可原生拖拽的元素：图标 `<img>` 必须 `draggable="false"`，
 * 卡片上再加 `@dragstart.prevent` 兜底。否则按住图标拖动会启动原生拖拽并被 Tauri 拦截，
 * Windows 上表现为光标变成「禁止」图标、卡片怎么拖都不动。
 *
 * 起拖有两条通道（卡片单击 = 启动资源，所以两条都必须与「点按」区分开）：
 * - 长按约 300ms：鼠标与触摸/笔都认；
 * - 鼠标移动超过起拖阈值：按住就拖同样是拖拽意图，不必等长按计时——曾经这里一律
 *   「放弃长按」，于是习惯「按住直接拖」的用户永远拎不起卡片（第一帧移动就超阈值），
 *   表现就是「拖不动」。触摸/笔不认这条，避免与列表滑动冲突。
 *
 * 交互：拎起后卡片跟手飞起，落点显示虚线插槽（「让位」效果）；松手把可见项的新 id 顺序
 * 交给 `reorder`（调用方负责并回全表顺序并持久化）。原地松开 = 不动顺序；
 * 拎起后的那次 click 会被吞掉，避免误启动资源。
 *
 * 调用方约定：
 * - 网格容器 `gridRef`，卡片 class 为 `.suda-card` 且是容器直接子元素；
 * - 被拖卡片的飞行位移由调用方按 `draggingId`/`dragOffset` 绑到 transform；
 * - 落点插槽由调用方按 `dropBeforeId`（插到该卡前）/`dropAtEnd`（插到末尾）渲染，
 *   两者只在拖拽中非空，同一时刻至多一个生效；
 * - 按最近使用排序的视图（「常用」）用 `enabled()` 关掉拖拽，手动排序只在
 *   维护 sort_order 顺序的视图开放。
 */
export function useSudaDrag(opts: {
  gridRef: Ref<HTMLElement | null>
  items: ComputedRef<Resource[]>
  enabled: () => boolean
  reorder: (ids: number[]) => void
}) {
  const draggingId = ref<number | null>(null)
  /** 拖拽位移（px，指针相对按下点）；调用方叠加到被拖卡片的 transform 上跟手 */
  const dragOffset = ref({ x: 0, y: 0 })
  /**
   * 被拖卡片在网格里的原始左上角（px）。拖拽期间卡片脱离文档流（`position:absolute`），
   * 腾出的格子由落点插槽补上——这样网格项数恒为 N，不会多占一格把整片网格挤到下一行。
   * 调用方要先用它把卡片平移回原位，再叠加 `dragOffset`。
   */
  const dragOrigin = ref({ x: 0, y: 0 })
  /** 落点插槽：插到该 id 的卡片之前（不含被拖卡片自身） */
  const dropBeforeId = ref<number | null>(null)
  /** 落点插槽：插到全部可见卡片末尾 */
  const dropAtEnd = ref(false)

  /** 拎起后（含原地松开）的那次 click 要吞掉，防止误启动 */
  let blockClick = false

  const LONG_PRESS_MS = 300
  /** 触摸/笔的抖动容差：超过即放弃长按（当作滑动列表） */
  const SLOP_PX = 8
  /**
   * 鼠标起拖阈值，刻意比触摸小：鼠标没有「滑动列表」冲突，阈值越小卡片越早开始跟手。
   * 阈值过大时，卡片要等指针移开一段距离才被摆到指针处，看起来像「凭空闪现」而不是被拎起来。
   */
  const MOUSE_SLOP_PX = 4

  /** 卡片 @click 入口：返回 true 表示这次 click 应吞掉 */
  function swallowClick(): boolean {
    if (blockClick) {
      blockClick = false
      return true
    }
    return false
  }

  function onCardPointerDown(r: Resource, e: PointerEvent) {
    if (e.button !== 0 || !opts.enabled()) return
    const target = e.target as HTMLElement | null
    // 编辑/删除等按钮上按下不进入拖拽（它们自己处理点击）
    if (target?.closest('button, input, a, [data-no-drag]')) return
    blockClick = false
    const el = e.currentTarget as HTMLElement
    const startX = e.clientX
    const startY = e.clientY
    let armed = false
    let dead = false

    const armTimer = window.setTimeout(() => {
      if (dead) return
      begin()
      armed = true
    }, LONG_PRESS_MS)

    // 三个监听一律挂 window：不能只靠 setPointerCapture —— 一旦捕获没生效（或被 WebView2
    // 忽略），指针移出卡片后 pointermove 就再也不触发，表现为「拖到一半冻住、落点虚线框
    // 停在原地不动」，快速拖动时尤其明显。捕获成功时事件仍会冒泡到 window，双保险不冲突。
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)

    function begin() {
      // 捕获指针：拖出窗口松开也能收到 pointerup，不会悬挂在拖拽态
      try {
        el.setPointerCapture(e.pointerId)
      } catch {
        /* 指针已释放时忽略；移动与松开都由 window 监听兜底 */
      }
      draggingId.value = r.id
      // 先量原位再起拖：此时卡片还在文档流里，offsetLeft/Top 就是网格中的真实位置
      dragOrigin.value = { x: el.offsetLeft, y: el.offsetTop }
      dragOffset.value = { x: 0, y: 0 }
      dropBeforeId.value = null
      dropAtEnd.value = false
      document.body.classList.add('suda-dragging')
      document.getSelection()?.removeAllRanges()
    }

    function onMove(ev: PointerEvent) {
      if (dead) return
      // 鼠标在窗口外松开不派发 pointerup，这里按 buttons 归零视为松键
      if (ev.buttons === 0) {
        onUp()
        return
      }
      const dx = ev.clientX - startX
      const dy = ev.clientY - startY
      const isMouse = ev.pointerType === 'mouse'
      if (!armed) {
        if (Math.hypot(dx, dy) < (isMouse ? MOUSE_SLOP_PX : SLOP_PX)) return
        // 移动超过起拖阈值
        if (isMouse) {
          // 鼠标：按住就拖同样是拖拽意图，不必等长按计时。此前这里一律「放弃长按」，
          // 于是习惯「按住直接拖」的用户永远拎不起卡片（第一帧移动就超阈值），
          // 表现就是「拖不动」——只有先按住不动 300ms 才拖得动。
          // 必须先清掉长按计时：否则 300ms 后再 begin() 一次会重读 dragOrigin，
          // 而那时卡片已是 absolute、offsetLeft/offsetTop 为 0，卡片会跳到左上角。
          window.clearTimeout(armTimer)
          begin()
          armed = true
        } else {
          // 触摸 / 笔：保留长按语义，避免与列表滑动冲突。既然已经移动过，这次松手必须
          // 吞掉 click —— 否则浏览器照常派发 click，卡片会直接启动资源
          // （「想拖动排序，结果打开了程序」）。
          dead = true
          blockClick = true
          cleanup()
          return
        }
      }
      dragOffset.value = { x: dx, y: dy }
      updateDrop(ev.clientX, ev.clientY)
    }

    function onUp() {
      if (dead) return
      dead = true
      cleanup()
      if (!armed) return
      // 拎起过就算「拖拽过」：吞掉随后的 click，原地松开也不会误启动
      blockClick = true
      finishDrag()
    }

    function cleanup() {
      window.clearTimeout(armTimer)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }

    /** 指针位置 → 落点插槽（以「不含被拖项」的可见数组为下标基准） */
    function updateDrop(x: number, y: number) {
      const grid = opts.gridRef.value
      if (!grid) return
      // 命中检测排除被拖卡片：它的 getBoundingClientRect 被 transform 带走，不是布局位；
      // 用 data-id 而不是 is-dragging 类——类是渲染绑定，事件处理跑在重渲染前可能还没挂上
      const cards = Array.from(
        grid.querySelectorAll<HTMLElement>(':scope > .suda-card'),
      ).filter((c) => c.dataset.id !== String(draggingId.value))
      // 阅读序找插入点：落在某卡所在行之前 → 插它前面；同行按中心分左右
      let insert = cards.length
      for (let i = 0; i < cards.length; i++) {
        const rect = cards[i].getBoundingClientRect()
        const sameRow = y >= rect.top && y <= rect.bottom
        if (
          (!sameRow && y < rect.top + rect.height / 2) ||
          (sameRow && x < rect.left + rect.width / 2)
        ) {
          insert = i
          break
        }
      }
      const without = opts.items.value.filter((x2) => x2.id !== draggingId.value)
      if (insert >= without.length) {
        dropBeforeId.value = null
        dropAtEnd.value = true
      } else {
        dropBeforeId.value = without[insert]?.id ?? null
        dropAtEnd.value = false
      }
    }

    /** 松开落点：把被拖项插回调用方给的新顺序 */
    function finishDrag() {
      const id = draggingId.value
      draggingId.value = null
      dragOffset.value = { x: 0, y: 0 }
      const before = dropBeforeId.value
      const atEnd = dropAtEnd.value
      dropBeforeId.value = null
      dropAtEnd.value = false
      document.body.classList.remove('suda-dragging')
      if (id == null) return
      const beforeIds = opts.items.value.map((x2) => x2.id)
      const without = beforeIds.filter((x2) => x2 !== id)
      let insert: number
      if (atEnd) {
        insert = without.length
      } else {
        const idx = without.indexOf(before as number)
        if (idx < 0) return
        insert = idx
      }
      const next = without.slice()
      next.splice(insert, 0, id)
      // 同位松手（含原地长按松开）：不动顺序
      if (next.every((v, i) => v === beforeIds[i])) return
      opts.reorder(next)
    }
  }

  return { draggingId, dragOffset, dragOrigin, dropBeforeId, dropAtEnd, onCardPointerDown, swallowClick }
}
