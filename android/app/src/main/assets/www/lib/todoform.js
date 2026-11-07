/* 待办编辑面板：待办页与日历页共用一个实现，避免两处校验/时间处理漂移。 */

import { newRecord, touch, softDelete } from './core.js'
import { openForm, fmtDateInput, fmtTimeInput, toast } from './ui.js'
import { readClipboard } from './native.js'

/**
 * 提醒预设。值就是「提前多少分钟」，和记录里的 remindLead 一一对应：
 *   -1 = 不提醒，0 = 准时提醒，null = 自定义绝对时刻（只用 remindAt）。
 * 服务端 todos 白名单里已有 remindLead / remindAt，PC 端也能看到。
 */
const REMIND_PRESETS = [
  { value: '-1', label: '不提醒' },
  { value: '0', label: '准时' },
  { value: '15', label: '提前15分钟' },
  { value: '30', label: '提前30分钟' },
  { value: '60', label: '提前1小时' },
  { value: '1440', label: '提前1天' },
  { value: '4320', label: '提前3天' },
  { value: '10080', label: '提前7天' },
  { value: 'custom', label: '自定义' },
]

const PRESET_MINUTES = [0, 15, 30, 60, 1440, 4320, 10080]

/** 把记录里的提醒设置还原成「选中的 chip + 自定义输入值」 */
function readRemind(base) {
  if (!base) return { remind: '-1', remind_custom: '' }
  if (Number(base.remindLead) === -1) return { remind: '-1', remind_custom: '' }
  if (base.remindAt && (base.remindLead == null || base.remindLead === '')) {
    // 只有绝对时刻：自定义
    return { remind: 'custom', remind_custom: fmtDateTimeInput(base.remindAt) }
  }
  if (base.remindLead != null) {
    const lead = Number(base.remindLead)
    if (PRESET_MINUTES.indexOf(lead) >= 0) return { remind: String(lead), remind_custom: '' }
    return { remind: 'custom', remind_custom: base.remindAt ? fmtDateTimeInput(base.remindAt) : '' }
  }
  if (base.remindAt) return { remind: 'custom', remind_custom: fmtDateTimeInput(base.remindAt) }
  // 老记录没有提醒字段：沿用历史上「到期前 15 分钟」的行为，但把选择显式化
  return { remind: '15', remind_custom: '' }
}

function fmtDateTimeInput(ms) {
  if (!ms) return ''
  return fmtDateInput(ms) + 'T' + fmtTimeInput(ms)
}

function parseDateTimeInput(v) {
  if (!v) return null
  const d = new Date(String(v).replace(' ', 'T'))
  const t = d.getTime()
  return Number.isFinite(t) ? t : null
}

/**
 * @param {object|null} base 编辑已有记录，null 为新建
 * @param {{date?:string, time?:string}} [preset] 新建时的预填（日历里点某一天进来）
 */
export function openTodoForm(base, preset) {
  const p = preset || {}
  const defTime = p.time || '09:00'
  const remindInit = readRemind(base)

  openForm({
    title: base ? '编辑待办' : '新建待办',
    fields: [
      {
        key: 'title',
        label: '标题',
        type: 'textarea',
        rows: 2,
        maxlength: 500,
        placeholder: '要做什么？',
        // 从系统剪贴板一键带入，省去在手机上长按选择
        action: {
          text: '粘贴',
          onClick: (input) => {
            const t = readClipboard().trim()
            if (!t) return toast('剪贴板里没有文字')
            input.value = t.slice(0, 500)
            input.dispatchEvent(new Event('input'))
            toast('已粘贴')
          },
        },
      },
      { key: 'date', label: '截止日期', type: 'date' },
      { key: 'time', label: '时间', type: 'time' },
      {
        key: 'remind',
        label: '提醒时间',
        type: 'chips',
        options: REMIND_PRESETS,
        custom: { key: 'remind_custom', when: 'custom', type: 'datetime-local' },
        hint: '到点会发系统通知并震动；「提前」是相对截止时间计算',
      },
      {
        key: 'priority',
        label: '优先级',
        type: 'select',
        options: [
          { value: '0', label: '普通' },
          { value: '1', label: '重要' },
          { value: '2', label: '紧急' },
        ],
      },
      { key: 'description', label: '备注', type: 'textarea', rows: 3, maxlength: 20000, placeholder: '可选，最多 2 万字' },
    ],
    values: {
      title: base ? base.title || '' : p.title || '',
      date: base && base.dueAt ? fmtDateInput(base.dueAt) : p.date || '',
      time: base && base.dueAt ? fmtTimeInput(base.dueAt) : p.date ? defTime : '',
      remind: remindInit.remind,
      remind_custom: remindInit.remind_custom,
      priority: String(base ? base.priority || 0 : 0),
      description: base ? base.description || '' : '',
    },
    async onSave(v) {
      const title = String(v.title || '').trim()
      if (!title) return toast('标题不能为空')

      let dueAt = null
      if (v.date) {
        const parts = v.date.split('-').map(Number)
        const tp = (v.time || defTime).split(':').map(Number)
        dueAt = new Date(parts[0], parts[1] - 1, parts[2], tp[0] || 0, tp[1] || 0).getTime()
        // 日期时间没动过就保留原时间戳：编辑只该改内容，不该把秒/毫秒抹平
        if (base && base.dueAt && fmtDateInput(base.dueAt) === v.date && fmtTimeInput(base.dueAt) === (v.time || defTime)) {
          dueAt = base.dueAt
        }
      }

      // 提醒解析：预设按「截止时间 - 提前量」，自定义用绝对时刻
      let remindLead = null
      let remindAt = null
      const pick = String(v.remind || '-1')
      if (pick === '-1') {
        remindLead = -1
      } else if (pick === 'custom') {
        remindAt = parseDateTimeInput(v.remind_custom)
        remindLead = null
        if (!remindAt) {
          remindLead = -1
          toast('自定义提醒时间无效，已改为不提醒')
        }
      } else {
        const lead = Number(pick)
        remindLead = lead
        if (dueAt) remindAt = dueAt - lead * 60000
        else {
          // 没有截止日期就没有「提前」的基准：明确降级为不提醒，而不是静默存个无效值
          remindLead = -1
          toast('没有截止日期，已改为不提醒')
        }
      }

      const fields = {
        title,
        dueAt,
        remindLead,
        remindAt,
        priority: Number(v.priority) || 0,
        description: String(v.description || '').trim(),
      }
      if (base) await touch(base, fields)
      else await touch(newRecord('todos', fields))
    },
    onDelete: base
      ? async () => {
          await softDelete(base)
          toast('已删除')
        }
      : null,
  })
}
