<script setup lang="ts">
import { computed } from 'vue'
import {
  Cloud,
  CloudDrizzle,
  CloudFog,
  CloudLightning,
  CloudRain,
  CloudSnow,
  CloudSun,
  Sun,
  Thermometer,
  Droplets,
  Wind,
} from 'lucide-vue-next'
import { useStore } from '../stores/workbench'
import { describeWeather } from '../utils/weather'

/**
 * 天气卡片（工作台独立模块，v0.5.x 形态化新增）
 * 形态：now 简版（图标+温度+城市）/ detail 详情版（体感/湿度/风/状况）。
 * 容器查询单位 + clamp 双保险：真实工作台保持现有观感，编辑器缩略按比例缩印。
 */
const props = withDefaults(
  defineProps<{
    /** 形态：now 简版 / detail 详情版 */
    variant?: string
    /** 编辑器缩略模式：纯展示，无交互 */
    preview?: boolean
  }>(),
  { variant: 'now', preview: false },
)

const store = useStore()

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

const iconProps = { size: 22, strokeWidth: 1.8 }

const tempText = computed(() =>
  weather.value ? `${Math.round(weather.value.temperature)}°` : '--',
)
const feelText = computed(() =>
  weather.value ? `${Math.round(weather.value.apparent_temperature)}°` : '--',
)
const humidityText = computed(() =>
  weather.value ? `${Math.round(weather.value.relative_humidity)}%` : '--',
)
const windText = computed(() =>
  weather.value ? `${Math.round(weather.value.wind_speed)} km/h` : '--',
)
const cityText = computed(() => weather.value?.city ?? '')
const descLabel = computed(() => weatherDesc.value?.label ?? '--')
</script>

<template>
  <section class="card weather-card" :class="`variant-${variant}`" aria-label="天气">
    <!-- 形态 · 简版 -->
    <template v-if="variant === 'now'">
      <div class="w-now">
        <component :is="weatherIcon" class="w-ic" v-bind="iconProps" aria-hidden="true" />
        <span class="w-temp">{{ tempText }}</span>
        <div class="w-meta">
          <span class="w-desc">{{ descLabel }}</span>
          <span v-if="cityText" class="w-city">{{ cityText }}</span>
        </div>
      </div>
    </template>

    <!-- 形态 · 详情版 -->
    <template v-else>
      <div class="wd-head">
        <component :is="weatherIcon" class="wd-ic" v-bind="iconProps" aria-hidden="true" />
        <div class="wd-title">
          <span class="wd-temp">{{ tempText }}</span>
          <span class="wd-desc">{{ descLabel }}</span>
        </div>
        <span v-if="cityText" class="wd-city">{{ cityText }}</span>
      </div>
      <div class="wd-grid">
        <div class="wd-item">
          <Thermometer :size="14" :stroke-width="1.8" aria-hidden="true" />
          <span class="k">体感温度</span>
          <span class="v">{{ feelText }}</span>
        </div>
        <div class="wd-item">
          <Droplets :size="14" :stroke-width="1.8" aria-hidden="true" />
          <span class="k">相对湿度</span>
          <span class="v">{{ humidityText }}</span>
        </div>
        <div class="wd-item">
          <Wind :size="14" :stroke-width="1.8" aria-hidden="true" />
          <span class="k">风速</span>
          <span class="v">{{ windText }}</span>
        </div>
        <div class="wd-item">
          <component :is="weatherIcon" :size="14" :stroke-width="1.8" aria-hidden="true" />
          <span class="k">天气状况</span>
          <span class="v">{{ descLabel }}</span>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.weather-card {
  display: flex;
  flex-direction: column;
  gap: clamp(4px, 4.8cqh, 8px);
  padding: clamp(8px, 6cqh, 16px);
  overflow: hidden;
}

/* ---- 简版：图标 + 温度 + 描述/城市，横向排布 ---- */
.w-now {
  height: 100%;
  display: flex;
  align-items: center;
  gap: clamp(6px, 8cqw, 14px);
  min-width: 0;
}
.w-ic {
  flex-shrink: 0;
  width: clamp(16px, 26cqh, 30px);
  height: clamp(16px, 26cqh, 30px);
  color: var(--brand-500);
}
.w-temp {
  flex-shrink: 0;
  font-size: clamp(14px, 22cqh, 26px);
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--text-1);
  line-height: 1;
}
.w-meta {
  display: flex;
  flex-direction: column;
  gap: clamp(1px, 1.5cqh, 2px);
  min-width: 0;
}
.w-desc {
  font-size: clamp(9px, 8.5cqh, 13px);
  font-weight: 600;
  color: var(--text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.w-city {
  font-size: clamp(8px, 7cqh, 11px);
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ---- 详情版：头部 + 2×2 指标格 ---- */
.wd-head {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: clamp(6px, 6cqh, 10px);
  min-width: 0;
}
.wd-ic {
  flex-shrink: 0;
  width: clamp(14px, 20cqh, 22px);
  height: clamp(14px, 20cqh, 22px);
  color: var(--brand-500);
}
.wd-title {
  display: flex;
  align-items: baseline;
  gap: clamp(4px, 3cqh, 8px);
  min-width: 0;
}
.wd-temp {
  font-size: clamp(14px, 22cqh, 26px);
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: var(--text-1);
  line-height: 1;
}
.wd-desc {
  font-size: clamp(9px, 7cqh, 12px);
  font-weight: 500;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.wd-city {
  margin-left: auto;
  font-size: clamp(8px, 6cqh, 11px);
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.wd-grid {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 1fr 1fr;
  grid-auto-rows: 1fr;
  gap: clamp(3px, 3cqh, 6px);
}
.wd-item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  gap: clamp(1px, 1.2cqh, 2px);
  padding: clamp(4px, 4cqh, 8px) clamp(5px, 4cqh, 8px);
  background: var(--bg-card-soft);
  border-radius: clamp(4px, 3cqh, 8px);
  min-width: 0;
  overflow: hidden;
}
.wd-item :deep(svg) {
  flex-shrink: 0;
  width: clamp(9px, 7cqh, 13px);
  height: clamp(9px, 7cqh, 13px);
  color: var(--brand-500);
}
.wd-item .k {
  font-size: clamp(8px, 5cqh, 10px);
  color: var(--text-3);
  white-space: nowrap;
}
.wd-item .v {
  font-size: clamp(11px, 9cqh, 15px);
  font-weight: 700;
  color: var(--text-1);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
