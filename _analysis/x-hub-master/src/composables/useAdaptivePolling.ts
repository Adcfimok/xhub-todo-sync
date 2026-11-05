import { onBeforeUnmount, onMounted, type Ref } from 'vue'

interface AdaptivePollingOptions {
  /** 页面可见且窗口聚焦时的轮询间隔 */
  activeMs: number
  /** 页面可见但窗口失焦时的轮询间隔；不传则失焦时暂停 */
  idleMs?: number
  /** 可选：元素滚出视口时暂停（如工作台卡片随网格滚走） */
  viewport?: Ref<HTMLElement | null>
}

/**
 * 自适应轮询：按「页面可见性 × 窗口聚焦 × 视口内」三重门控调整轮询节奏。
 * - 页面隐藏（收托盘/最小化）：完全停止
 * - 可见但失焦：idleMs 慢速档（未传则停止）
 * - 可见且聚焦：activeMs 常速档
 * - viewport 元素滚出视口：同隐藏处理
 *
 * 从「完全停止」恢复（重新可见/聚焦/回到视口）时立即补采一次，避免数据
 * 停留在暂停前。摘除 --disable-background-timer-throttling 后浏览器对隐藏页
 * 的节流只能兜底（钳到 ≥1s、长期隐藏降到每分钟 1 次），重量级轮询必须自行
 * 停干净，不能依赖浏览器节流。
 */
export function useAdaptivePolling(poll: () => unknown, options: AdaptivePollingOptions) {
  let timer: ReturnType<typeof setInterval> | null = null
  let intersecting = true
  let io: IntersectionObserver | null = null

  /** 当前档位；null = 暂停（隐藏 / 滚出视口 / 失焦且未配 idleMs） */
  function currentInterval(): number | null {
    if (document.hidden || !intersecting) return null
    if (!document.hasFocus()) return options.idleMs ?? null
    return options.activeMs
  }

  /**
   * 按当前档位重排定时器。fresh=事件语义上的「恢复」：从停止态拉起时立即补采
   * 一次；纯降速（active→idle）不补采，避免失焦瞬间多打一跳。
   */
  function apply(fresh: boolean) {
    const next = currentInterval()
    if (next === null) {
      if (timer !== null) {
        clearInterval(timer)
        timer = null
      }
      return
    }
    if (timer === null && fresh) void poll()
    if (timer !== null) clearInterval(timer)
    timer = setInterval(poll, next)
  }

  function onVisibility() {
    apply(true)
  }
  function onFocus() {
    apply(true)
  }
  function onBlur() {
    apply(false)
  }
  function onIntersect(entries: IntersectionObserverEntry[]) {
    intersecting = entries[0]?.isIntersecting ?? true
    // 进出视口都以 fresh 语义处理：回视口立即补采；首次回调 intersecting=true 时
    // 定时器已在 mounted 拉起，这里最多重排一次相位，无副作用
    apply(true)
  }

  onMounted(() => {
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    if (options.viewport) {
      io = new IntersectionObserver(onIntersect)
      // viewport 是静态模板 ref：mounted 时必有值；万一为空则退化为纯可见性门控
      if (options.viewport.value) io.observe(options.viewport.value)
    }
    apply(true)
  })

  onBeforeUnmount(() => {
    document.removeEventListener('visibilitychange', onVisibility)
    window.removeEventListener('focus', onFocus)
    window.removeEventListener('blur', onBlur)
    io?.disconnect()
    io = null
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  })
}
