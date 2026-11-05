<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  Cloud,
  CloudDrizzle,
  CloudFog,
  CloudLightning,
  CloudRain,
  CloudSnow,
  CloudSun,
  Quote,
  Sun,
} from 'lucide-vue-next'
import { useStore } from '../stores/workbench'
import { randomLocalQuote } from '../utils/quotes'
import { describeWeather } from '../utils/weather'
import { toLunar } from '../utils/lunar'

const props = withDefaults(
  defineProps<{
    /** 形态：big 大时钟 / lunar 今日阴阳历 / minimal 极简时间 */
    variant?: string
    /** 编辑器缩略模式：纯展示，无交互副作用（时钟 tick 照常，成本极低） */
    preview?: boolean
  }>(),
  { variant: 'big', preview: false },
)

const store = useStore()

const now = ref(new Date())
let timer: ReturnType<typeof setTimeout> | null = null

onMounted(() => {
  const tick = () => {
    now.value = new Date()
    // 对齐下一秒边界触发，避免相位漂移导致的跳秒；每次读钟不自增，节流后回前台也能立即正确
    timer = setTimeout(tick, 1005 - (Date.now() % 1000))
  }
  tick()
})
onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
})

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'] as const

const pad = (n: number) => String(n).padStart(2, '0')

const timeText = computed(() => {
  const d = now.value
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
})

const timeHM = computed(() => {
  const d = now.value
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
})

const secText = computed(() => pad(now.value.getSeconds()))

const dateText = computed(() => {
  const d = now.value
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 周${WEEKDAYS[d.getDay()]}`
})

/** 分钟级 tick：农历按天变化，用分钟取整的原始数值驱动——秒级 tick 的
 *  重算在分钟未变时被 computed 缓存短路（不能用新 Date 对象：引用每秒都变，照样重算） */
const minuteTick = computed(() => Math.floor(now.value.getTime() / 60_000))

/** 今日农历（阴阳历形态） */
const lunar = computed(() => toLunar(new Date(minuteTick.value * 60_000)))

// ---- 语录（炫彩 + 点击随机） ----
const currentQuote = ref(randomLocalQuote())

// 在线金句拉取成功后同步到当前显示
watch(
  () => store.state.quote,
  (q) => {
    if (q && store.state.config.quote_source === 'online' && store.state.online) {
      currentQuote.value = { content: q.content, from: q.from }
    }
  },
)

const displayQuote = computed(() => {
  const custom = store.state.config.clock_quote?.trim()
  if (custom) return { content: custom, from: '' }
  return currentQuote.value
})

async function nextQuote() {
  if (props.preview) return
  const custom = store.state.config.clock_quote?.trim()
  if (custom) return
  const before = currentQuote.value.content
  if (store.state.config.quote_source === 'online' && store.state.online) {
    await store.refreshQuote()
    // 在线拉取未带来新内容（失败或重复）时，本地语料兜底换一条，保证点击总有反馈
    if (currentQuote.value.content === before) {
      currentQuote.value = randomLocalQuote()
    }
  } else {
    currentQuote.value = randomLocalQuote()
  }
}

// ---- 天气（big 形态右上角） ----
const weather = computed(() => store.state.weather)
const weatherDesc = computed(() =>
  weather.value ? describeWeather(weather.value.weather_code) : null,
)

const weatherIcon = computed(() => {
  switch (weatherDesc.value?.icon) {
    case 'sun':
      return Sun
    case 'cloud-sun':
      return CloudSun
    case 'cloud-fog':
      return CloudFog
    case 'cloud-drizzle':
      return CloudDrizzle
    case 'cloud-rain':
      return CloudRain
    case 'cloud-snow':
      return CloudSnow
    case 'cloud-lightning':
      return CloudLightning
    default:
      return Cloud
  }
})

const tempText = computed(() =>
  weather.value ? `${Math.round(weather.value.temperature)}°` : '',
)

const weatherSubText = computed(() => {
  if (!weather.value || !weatherDesc.value) return ''
  const city = weather.value.city ? ` · ${weather.value.city}` : ''
  return `${weatherDesc.value.label}${city}`
})

</script>

<template>
  <section class="card clock-card" :class="`variant-${variant}`" aria-label="时钟">
    <!-- 形态 · 大时钟：时间 + 日期 + 天气 + 语录 -->
    <template v-if="variant === 'big'">
      <div class="clock-top">
        <div class="clock-main">
          <div class="clock-time">{{ timeText }}</div>
          <div class="clock-date">{{ dateText }}</div>
        </div>
        <!-- 天气（右上角） -->
        <div v-if="weather" class="clock-weather" :title="`${tempText} ${weatherSubText}`">
          <component
            :is="weatherIcon"
            class="cw-icon"
            :size="22"
            :stroke-width="1.8"
            aria-hidden="true"
          />
          <div class="cw-temp">{{ tempText }}</div>
          <div class="cw-label">{{ weatherSubText }}</div>
        </div>
      </div>
      <!-- 金句：占满整行（可延伸到天气区下方） -->
      <button
        class="clock-quote"
        type="button"
        :title="displayQuote.content"
        :aria-label="props.preview ? undefined : '点击换一条语录'"
        @click="nextQuote"
      >
        <Quote :size="13" :stroke-width="2" aria-hidden="true" />
        <span>{{ displayQuote.content }}</span>
      </button>
    </template>

    <!-- 形态 · 今日阴阳历 -->
    <template v-else-if="variant === 'lunar'">
      <div class="lunar-time">{{ timeHM }}</div>
      <div class="lunar-solar">{{ dateText }}</div>
      <div v-if="lunar" class="lunar-date">{{ lunar.monthName }}{{ lunar.dayName }}</div>
      <hr v-if="lunar" class="lunar-div" />
      <div v-if="lunar" class="lunar-extra">
        {{ lunar.ganZhiYear }}年 · 属{{ lunar.zodiac }}
      </div>
    </template>

    <!-- 形态 · 极简时间 -->
    <template v-else>
      <div class="mini-time">
        {{ timeHM }}<span class="mini-sec">{{ secText }}</span>
      </div>
    </template>
  </section>
</template>

<style scoped>
/* ===== 容器查询弹性基准 =====
 * 卡片内容以 cq（容器查询单位，cqh = 格子高度的 1%）+ clamp 双保险：
 * 真实工作台格子（典型 4×3 ≈ 165px 高）下 clamp 上限保住现有观感；
 * 编辑器缩略格子（几十 px）下按比例缩印，所见即所得。 */
.clock-card {
  display: flex;
  flex-direction: column;
  gap: clamp(4px, 4.8cqh, 8px);
  padding: clamp(8px, 6cqh, 16px);
  overflow: hidden;
}

/* ---- 大时钟 ---- */
.clock-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: clamp(6px, 4cqh, 16px);
}
.clock-main {
  display: flex;
  flex-direction: column;
  gap: clamp(3px, 3.6cqh, 6px);
  min-width: 0;
  flex: 1;
}
.clock-time {
  font-size: clamp(16px, 18.2cqh, 30px);
  font-weight: 700;
  line-height: 1.05;
  letter-spacing: -0.03em;
  font-variant-numeric: tabular-nums;
  color: var(--text-1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.clock-date {
  font-size: clamp(10px, 7.9cqh, 13px);
  font-weight: 500;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.clock-quote {
  display: flex;
  align-items: flex-start;
  gap: clamp(3px, 3.6cqh, 6px);
  width: 100%;
  padding: clamp(4px, 3cqh, 8px) 0 0;
  border: 0;
  border-top: 1px solid var(--border-soft);
  background: none;
  cursor: pointer;
  text-align: left;
  font: inherit;
  color: inherit;
  margin-top: auto;
}
.clock-quote :deep(svg) {
  flex-shrink: 0;
  width: clamp(9px, 7.9cqh, 13px);
  height: clamp(9px, 7.9cqh, 13px);
  margin-top: clamp(1px, 2cqh, 4px);
  color: var(--brand-500);
}
.clock-quote span {
  font-size: clamp(10px, 8.5cqh, 14px);
  line-height: 1.5;
  font-weight: 600;
  white-space: normal;
  overflow-wrap: break-word;
  /* 炫彩渐变文字：品牌色 → 粉 → 蓝 */
  background: linear-gradient(100deg, var(--brand-500), #f472b6 45%, #38bdf8 80%);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  color: transparent;
  transition: opacity 0.2s ease;
}
.clock-quote:hover span {
  opacity: 0.75;
}
.clock-quote:active span {
  opacity: 0.55;
}

/* 天气（无独立底色：直接融进时钟卡片表面） */
.clock-weather {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: clamp(1px, 1.2cqh, 2px);
}
.cw-icon {
  width: clamp(14px, 13.3cqh, 22px);
  height: clamp(14px, 13.3cqh, 22px);
  color: var(--brand-500);
}
.cw-temp {
  font-size: clamp(12px, 12.1cqh, 20px);
  font-weight: 700;
  line-height: 1;
  color: var(--text-1);
  font-variant-numeric: tabular-nums;
}
.cw-label {
  font-size: clamp(8px, 6.7cqh, 11px);
  color: var(--text-3);
  white-space: nowrap;
  max-width: clamp(70px, 40cqw, 110px);
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ---- 今日阴阳历 ---- */
.lunar-time {
  font-size: clamp(16px, 18cqh, 30px);
  font-weight: 700;
  line-height: 1.05;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
  color: var(--text-1);
  white-space: nowrap;
}
.lunar-solar {
  font-size: clamp(10px, 6.4cqh, 13px);
  font-weight: 500;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.lunar-date {
  margin-top: auto;
  font-size: clamp(12px, 9.7cqh, 19px);
  font-weight: 700;
  color: var(--brand-500);
  white-space: nowrap;
}
.lunar-div {
  border: none;
  border-top: 1px solid var(--border-soft);
  margin: clamp(3px, 2.4cqh, 6px) 0;
}
.lunar-extra {
  font-size: clamp(9px, 6cqh, 12px);
  color: var(--text-3);
  line-height: 1.5;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ---- 极简时间 ---- */
.mini-time {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: clamp(2px, 2.4cqh, 4px);
  font-size: clamp(18px, 22cqh, 34px);
  font-weight: 700;
  letter-spacing: -0.03em;
  font-variant-numeric: tabular-nums;
  color: var(--text-1);
  white-space: nowrap;
}
.mini-sec {
  font-size: clamp(11px, 12cqh, 18px);
  font-weight: 600;
  color: var(--brand-500);
}
</style>
