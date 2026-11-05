<script setup lang="ts">
import { computed, shallowRef, watch } from 'vue'
import { CalendarDays, ChevronLeft, ChevronRight, X } from 'lucide-vue-next'
import {
  DatePickerCalendar,
  DatePickerCell,
  DatePickerCellTrigger,
  DatePickerContent,
  DatePickerField,
  DatePickerGrid,
  DatePickerGridBody,
  DatePickerGridHead,
  DatePickerGridRow,
  DatePickerHeadCell,
  DatePickerHeader,
  DatePickerHeading,
  DatePickerInput,
  DatePickerNext,
  DatePickerPrev,
  DatePickerRoot,
  DatePickerTrigger,
  TimeFieldInput,
  TimeFieldRoot,
} from 'reka-ui'
import { CalendarDate, Time } from '@internationalized/date'
import type { DateValue, TimeValue } from 'reka-ui'

/**
 * 待办「截止 / 提醒」时刻字段：应用内日历（reka-ui DatePicker）+ 时间（TimeField）+ 快捷时间。
 * 用 reka 而不是原生 `<input type="datetime-local">`——原生控件弹出的是浏览器/系统日历，
 * 与客户端视觉不一致（样式、圆角、配色都不受主题控制）。这里与 CountdownCard 的
 * DatePicker 用同一套组件与样式口径。
 *
 * 值为毫秒时间戳（本地时区），null = 未设置（提醒未设置即不提醒）。
 */
const props = defineProps<{
  label: string
  modelValue: number | null
  /** 快捷时间：由父组件按语义生成（截止用当天末尾，提醒用「同截止 / 提前 N」等） */
  presets: Array<{ label: string; ms: number }>
  hint?: string
  /** 只选日期：隐藏时间字段，落库为所选当天 23:59:59.999（「到某日结束」含当天） */
  dateOnly?: boolean
}>()

const emit = defineEmits<{ 'update:modelValue': [number | null] }>()

const dateVal = shallowRef<DateValue | null>(null)
const timeVal = shallowRef<TimeValue | null>(null)
/** 回填与回写互斥：避免 watch(modelValue) → watch(date/time) → emit 的抖动。
 *  两个 watch 都必须 `flush: 'sync'` 这个标志才有效：默认的 pre-flush 回调是异步执行的，
 *  等它跑起来时 syncing 早已复位，父值回填会被当成用户改动回写一遍——
 *  而 combine 会把秒/毫秒规范化，于是 23:59:59.999 被静默改写成 23:59:00.000。 */
let syncing = false

function split(ms: number): { date: DateValue; time: TimeValue } {
  const d = new Date(ms)
  return {
    date: new CalendarDate(d.getFullYear(), d.getMonth() + 1, d.getDate()),
    time: new Time(d.getHours(), d.getMinutes()),
  }
}

/** 日期 → 落库时刻戳：dateOnly 落当天末尾（含当天），否则按所选时分（缺省 23:59） */
function combine(date: DateValue, time: TimeValue | null): number {
  if (props.dateOnly) {
    return new Date(date.year, date.month - 1, date.day, 23, 59, 59, 999).getTime()
  }
  const t = time ?? new Time(23, 59)
  return new Date(date.year, date.month - 1, date.day, t.hour, t.minute, 0, 0).getTime()
}

watch(
  () => props.modelValue,
  (ms) => {
    syncing = true
    if (ms == null) {
      dateVal.value = null
      timeVal.value = null
    } else {
      const p = split(ms)
      dateVal.value = p.date
      timeVal.value = p.time
    }
    syncing = false
  },
  { immediate: true, flush: 'sync' },
)

watch(
  [dateVal, timeVal],
  () => {
    if (syncing) return
    const d = dateVal.value
    if (d == null) {
      emit('update:modelValue', null)
      return
    }
    emit('update:modelValue', combine(d, timeVal.value))
  },
  { flush: 'sync' },
)

const hasValue = computed(() => props.modelValue != null)

function applyPreset(ms: number) {
  emit('update:modelValue', ms)
}
</script>

<template>
  <div class="tdt-field">
    <span class="tdt-lab">
      {{ label }}
      <button v-if="hasValue" type="button" class="tdt-clear" title="清除" @click="emit('update:modelValue', null)">
        <X :size="10" :stroke-width="2.5" />
      </button>
    </span>

    <div class="tdt-row">
      <DatePickerRoot v-model="dateVal" locale="zh-CN" granularity="day" class="tdt-date">
        <DatePickerField v-slot="{ segments }" class="tdt-date-field">
          <template v-for="segment in segments" :key="segment.part">
            <span v-if="segment.part === 'literal'" class="tdt-literal">{{ segment.value }}</span>
            <DatePickerInput v-else :part="segment.part" class="tdt-segment">{{ segment.value }}</DatePickerInput>
          </template>
          <DatePickerTrigger class="tdt-trigger" title="打开日历">
            <CalendarDays :size="14" :stroke-width="2" />
          </DatePickerTrigger>
        </DatePickerField>
        <DatePickerContent class="tdt-calendar-content" :side-offset="4">
          <DatePickerCalendar v-slot="{ weekDays, grid }" class="tdt-calendar">
            <DatePickerHeader class="tdt-calendar-header">
              <DatePickerPrev class="tdt-calendar-nav">
                <ChevronLeft :size="16" :stroke-width="2" />
              </DatePickerPrev>
              <DatePickerHeading class="tdt-calendar-heading" />
              <DatePickerNext class="tdt-calendar-nav">
                <ChevronRight :size="16" :stroke-width="2" />
              </DatePickerNext>
            </DatePickerHeader>
            <DatePickerGrid class="tdt-calendar-grid">
              <DatePickerGridHead>
                <DatePickerGridRow class="tdt-calendar-row">
                  <DatePickerHeadCell v-for="day in weekDays" :key="day" class="tdt-calendar-weekday">
                    {{ day }}
                  </DatePickerHeadCell>
                </DatePickerGridRow>
              </DatePickerGridHead>
              <DatePickerGridBody>
                <DatePickerGridRow
                  v-for="(monthGrid, monthIndex) in grid"
                  :key="monthIndex"
                  class="tdt-calendar-row"
                >
                  <DatePickerCell
                    v-for="cell in monthGrid.cells"
                    :key="cell.toString()"
                    :date="cell"
                    class="tdt-calendar-cell"
                  >
                    <DatePickerCellTrigger
                      :day="cell"
                      :month="cell"
                      class="tdt-calendar-cell-trigger"
                    />
                  </DatePickerCell>
                </DatePickerGridRow>
              </DatePickerGridBody>
            </DatePickerGrid>
          </DatePickerCalendar>
        </DatePickerContent>
      </DatePickerRoot>

      <TimeFieldRoot
        v-if="!dateOnly"
        v-model="timeVal"
        locale="zh-CN"
        :hour-cycle="24"
        granularity="minute"
        class="tdt-time"
      >
        <template #default="{ segments }">
          <TimeFieldInput
            v-for="segment in segments"
            :key="segment.part"
            :part="segment.part"
            class="tdt-segment"
          >
            {{ segment.value }}
          </TimeFieldInput>
        </template>
      </TimeFieldRoot>
    </div>

    <div v-if="presets.length" class="tdt-presets">
      <button
        v-for="p in presets"
        :key="p.label"
        type="button"
        class="tdt-preset"
        @click="applyPreset(p.ms)"
      >
        {{ p.label }}
      </button>
    </div>

    <p v-if="hint" class="tdt-hint">{{ hint }}</p>
  </div>
</template>

<style scoped>
.tdt-field {
  display: block;
  margin-bottom: 12px;
}
.tdt-lab {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-bottom: 5px;
  font-size: 0.72rem;
  font-weight: 700;
  color: var(--text-3);
}
.tdt-clear {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 15px;
  height: 15px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: var(--bg-card-soft);
  color: var(--text-4);
  cursor: pointer;
}
.tdt-clear:hover {
  color: var(--c-red-ink);
}
.tdt-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.tdt-date {
  flex: 1;
  min-width: 0;
}
.tdt-date-field {
  display: flex;
  align-items: center;
  gap: 4px;
  min-height: 32px;
  padding: 6px 8px;
  font-size: 0.78rem;
  color: var(--text-1);
  background: var(--bg-card-soft);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-md);
}
.tdt-date-field:focus-within {
  border-color: var(--brand-500);
}
.tdt-time {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  min-height: 32px;
  padding: 6px 9px;
  font-size: 0.78rem;
  color: var(--text-1);
  background: var(--bg-card-soft);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-md);
  flex: 0 0 auto;
}
.tdt-time:focus-within {
  border-color: var(--brand-500);
}
.tdt-segment {
  color: var(--text-1);
  font-variant-numeric: tabular-nums;
  outline: none;
  border-radius: 3px;
  padding: 0 1px;
}
.tdt-segment:focus {
  background: var(--brand-500);
  color: var(--text-on-accent);
}
.tdt-literal {
  color: var(--text-4);
  padding: 0 2px;
}
.tdt-trigger {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  background: transparent;
  border-radius: var(--radius-sm);
  color: var(--text-3);
  cursor: pointer;
  flex-shrink: 0;
}
.tdt-trigger:hover {
  color: var(--brand-500);
  background: var(--bg-card-soft);
}
.tdt-presets {
  display: flex;
  align-items: center;
  gap: 5px;
  flex-wrap: wrap;
  margin-top: 6px;
}
.tdt-preset {
  padding: 2px 9px;
  font-size: 0.68rem;
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-pill);
  background: var(--bg-card-soft);
  color: var(--text-3);
  cursor: pointer;
}
.tdt-preset:hover {
  border-color: var(--brand-500);
  color: var(--text-1);
}
.tdt-hint {
  margin: 5px 0 0;
  font-size: 0.68rem;
  color: var(--text-4);
}
:deep([data-reka-date-picker-field-segment][data-placeholder]),
:deep([data-reka-time-field-segment][data-placeholder]),
:deep([data-reka-date-picker-field-segment][data-reka-date-picker-field-segment='literal']),
:deep([data-reka-time-field-segment][data-reka-time-field-segment='literal']) {
  color: var(--text-4);
}

/* 日历弹出层：reka-ui 经 Portal 渲染到 <body>，容器不继承 scoped 属性 → 必须 :global() */
:global(.tdt-calendar-content) {
  background: var(--frost-surface);
  border: 1px solid var(--border-soft);
  border-radius: var(--radius-lg);
  box-shadow: var(--frost-edge), var(--shadow-dock);
  padding: 12px;
  z-index: 130;
  min-width: 260px;
  -webkit-backdrop-filter: blur(18px) saturate(160%);
  backdrop-filter: blur(18px) saturate(160%);
}
.tdt-calendar {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.tdt-calendar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.tdt-calendar-nav {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  background: transparent;
  border-radius: var(--radius-sm);
  color: var(--text-3);
  cursor: pointer;
}
.tdt-calendar-nav:hover {
  color: var(--text-1);
  background: var(--bg-card-soft);
}
.tdt-calendar-heading {
  flex: 1;
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--text-1);
  text-align: center;
}
.tdt-calendar-grid {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.tdt-calendar-row {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 2px;
}
.tdt-calendar-weekday {
  padding: 4px 0;
  font-size: 0.6875rem;
  font-weight: 500;
  color: var(--text-4);
  text-align: center;
}
.tdt-calendar-cell {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
}
.tdt-calendar-cell-trigger {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border: none;
  background: transparent;
  border-radius: 8px;
  color: var(--text-1);
  font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
}
.tdt-calendar-cell-trigger:hover {
  background: var(--bg-card-soft);
  color: var(--text-1);
}
.tdt-calendar-cell-trigger[data-selected] {
  background: var(--brand-500);
  color: var(--text-on-accent);
}
.tdt-calendar-cell-trigger[data-today] {
  color: var(--brand-500);
  font-weight: 600;
}
.tdt-calendar-cell-trigger[data-today][data-selected] {
  color: var(--text-on-accent);
}
.tdt-calendar-cell-trigger[data-outside-view] {
  color: var(--text-4);
  opacity: 0.5;
}
</style>
