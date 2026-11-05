<script setup lang="ts">
// 速达「应用内打开网页」主窗内嵌面板（ADR 0011）：
// 工具栏是本组件 DOM，网页内容区（.sw-content）是一块**空白位**——真正的页面由 Rust 侧
// 预创建、隐藏常驻的子 webview（label suda-panel，见 suda_browser.rs）负责：
// 挂载时按内容区矩形调 suda_panel_show（navigate + set_bounds + show），窗口缩放时经
// ResizeObserver 上报新矩形（rAF 合并），卸载即 suda_panel_hide。单页无 tab、单实例，
// 轻量 tab 条只属于独立浏览器窗口。
import { computed, inject, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { listen } from '@tauri-apps/api/event'
import { ArrowLeft, ArrowRight, ExternalLink, PictureInPicture2, RotateCw, X } from 'lucide-vue-next'
import { isTauri, tauriApi } from '../api/tauri'
import { useStore } from '../stores/workbench'

const props = defineProps<{
  resourceId: number
  url: string
  name: string
}>()

const emit = defineEmits<{ close: [] }>()

const store = useStore()

/** 工具栏显隐（设置 → 功能 → 速达，默认不显示）：隐藏时整个面板区域只渲染网页，
 * 内容区占满 → ResizeObserver 自动把子 webview 矩形同步成占满后的矩形 */
const toolbarVisible = computed(() => store.state.config.suda_panel_toolbar === true)

const showToast = inject<(msg: string, action?: { label: string; onClick: () => void }) => void>(
  'showToast',
  () => {},
)

const url = ref(props.url)
const inputUrl = ref(props.url)
const editingUrl = ref(false)
const contentRef = ref<HTMLElement | null>(null)

let ro: ResizeObserver | null = null
let rafId = 0
let unlistenNav: (() => void) | null = null
let unlistenNewWindow: (() => void) | null = null

function normalizeUrl(raw: string): string {
  const t = raw.trim()
  if (!t) return ''
  return /^https?:\/\//i.test(t) ? t : `https://${t}`
}

function contentRect() {
  const el = contentRef.value
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: r.left, y: r.top, w: r.width, h: r.height }
}

async function showPanel() {
  if (!isTauri()) return
  const rect = contentRect()
  if (!rect) return
  try {
    await tauriApi.sudaPanelShow(props.resourceId, rect.x, rect.y, rect.w, rect.h)
  } catch (e) {
    showToast(`应用内打开失败：${String(e)}`)
    emit('close')
  }
}

function syncBounds() {
  if (!isTauri()) return
  const rect = contentRect()
  if (!rect) return
  void tauriApi.sudaPanelBounds(rect.x, rect.y, rect.w, rect.h).catch(() => {})
}

function scheduleSync() {
  if (rafId) return
  rafId = requestAnimationFrame(() => {
    rafId = 0
    syncBounds()
  })
}

onMounted(async () => {
  await nextTick()
  void showPanel()
  ro = new ResizeObserver(scheduleSync)
  if (contentRef.value) ro.observe(contentRef.value)
  if (!isTauri()) return
  unlistenNav = await listen<string>('suda-panel-nav', (e) => {
    const u = e.payload ?? ''
    if (!u || u === 'about:blank') return
    url.value = u
    if (!editingUrl.value) inputUrl.value = u
  })
  unlistenNewWindow = await listen<string>('suda-panel-newwindow', (e) => {
    // 面板单页无 tab：新窗口请求（target=_blank）默认原地导航（待确认项，可改为转独立窗口）
    const u = e.payload ?? ''
    if (u) void navigateTo(u)
  })
})

onBeforeUnmount(() => {
  ro?.disconnect()
  if (rafId) cancelAnimationFrame(rafId)
  unlistenNav?.()
  unlistenNewWindow?.()
  if (isTauri()) void tauriApi.sudaPanelHide().catch(() => {})
})

async function navigateTo(raw: string) {
  const u = normalizeUrl(raw)
  if (!u) return
  url.value = u
  inputUrl.value = u
  try {
    await tauriApi.sudaPanelNavigate(u)
  } catch (e) {
    showToast(`无法打开：${String(e)}`)
  }
}

function submitUrl() {
  editingUrl.value = false
  void navigateTo(inputUrl.value)
}

async function goBack() {
  if (!isTauri()) return
  await tauriApi.sudaPanelBack().catch(() => {})
}

async function goForward() {
  if (!isTauri()) return
  await tauriApi.sudaPanelForward().catch(() => {})
}

async function reload() {
  if (!isTauri()) return
  await tauriApi.sudaPanelReload().catch(() => {})
}

/** 系统浏览器兜底出口（ADR 0011：银行/防盗链站必有应用内打不开的） */
async function openInSystem() {
  try {
    await tauriApi.openExternal(url.value)
  } catch (e) {
    showToast(String(e))
  }
}

/** 转独立浏览器窗口继续浏览（面板轻量、独立窗承载重浏览） */
async function promoteToWindow() {
  try {
    await tauriApi.sudaBrowserOpenUrl(url.value)
    emit('close')
  } catch (e) {
    showToast(String(e))
  }
}
</script>

<template>
  <div class="suda-web">
    <header v-if="toolbarVisible" class="sw-toolbar">
      <button class="icon-btn" type="button" title="后退" @click="goBack">
        <ArrowLeft :size="15" :stroke-width="2" />
      </button>
      <button class="icon-btn" type="button" title="前进" @click="goForward">
        <ArrowRight :size="15" :stroke-width="2" />
      </button>
      <button class="icon-btn" type="button" title="重新加载" @click="reload">
        <RotateCw :size="14" :stroke-width="2" />
      </button>
      <input
        v-model="inputUrl"
        class="sw-url"
        type="text"
        spellcheck="false"
        :title="url"
        @focus="editingUrl = true"
        @blur="submitUrl"
        @keydown.enter.prevent="submitUrl"
      />
      <button class="icon-btn" type="button" title="在独立窗口打开" @click="promoteToWindow">
        <PictureInPicture2 :size="15" :stroke-width="2" />
      </button>
      <button class="icon-btn" type="button" title="用系统浏览器打开" @click="openInSystem">
        <ExternalLink :size="15" :stroke-width="2" />
      </button>
      <button class="icon-btn" type="button" title="关闭" @click="emit('close')">
        <X :size="16" :stroke-width="2" />
      </button>
    </header>
    <!-- 空白位：子 webview 覆盖此矩形渲染外站页面；显示前的一瞬露出实底色 -->
    <div ref="contentRef" class="sw-content" aria-hidden="true" />
  </div>
</template>

<style scoped>
.suda-web {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.sw-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 10px 8px;
}

.sw-url {
  flex: 1;
  min-width: 0;
  height: 30px;
  margin: 0 4px;
  padding: 0 12px;
  border: 1px solid var(--border-soft);
  border-radius: 8px;
  background: var(--bg-card-soft);
  color: var(--text-1);
  font-size: 12px;
  outline: none;
  transition: border-color 0.18s, box-shadow 0.18s;
}

.sw-url:focus {
  border-color: var(--brand-500);
  box-shadow: 0 0 0 2px var(--brand-50);
}

.sw-content {
  flex: 1;
  min-height: 0;
  background: var(--bg-card-solid, var(--bg-card));
}
</style>
