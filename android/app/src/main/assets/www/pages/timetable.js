import { S, saveMeta } from '../lib/core.js'
import { h, toast, confirmAsync, openForm } from '../lib/ui.js'
import { writeClipboard } from '../lib/native.js'
import {
  weekOfTerm,
  coursesOnDay,
  WEEK_NAMES,
  WEEK_TYPE_LABEL,
  COURSE_COLORS,
  SLOT_TIMES,
  slotLabel,
  normalizeCourse,
  normalizeTimetable,
} from '../lib/timetable.js'

export const meta = { title: '课表', route: 'timetable' }

let rootEl = null
let weekOffset = 0

export function mount(root) {
  rootEl = root
  render()
  return () => {}
}

// ---------------------------------------------------------------- 数据

function tt() {
  return normalizeTimetable(S.meta.timetable)
}

function curWeekNum() {
  return weekOfTerm(tt().termStart) + weekOffset
}

function weekRange(offset) {
  const now = new Date()
  const wd = now.getDay() || 7
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (wd - 1) + offset * 7)
  const sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6)
  const fmt = (d) => d.getMonth() + 1 + '/' + d.getDate()
  return fmt(monday) + ' – ' + fmt(sunday)
}

// ---------------------------------------------------------------- 渲染

function render() {
  if (!rootEl) return
  rootEl.innerHTML = ''
  const scroll = h('div', { class: 'scroll' })
  rootEl.appendChild(scroll)

  const data = tt()
  const weekNum = curWeekNum()

  scroll.appendChild(weekNav(weekNum))
  if (!data.termStart) {
    scroll.appendChild(
      h('div', { class: 'banner warn' }, [
        h('b', { text: '还没有设置开学日期' }),
        h('div', { text: '设置后才知道现在是第几周，单双周课程才会正确显示。点下方「开学日期」设置。' }),
      ])
    )
  }

  if (!data.courses.length) {
    scroll.appendChild(
      h('div', { class: 'card' }, [
        h('div', { class: 'empty' }, [
          h('p', { class: 'empty-t', text: '课表还是空的' }),
          h('p', { class: 'empty-s', text: '点下方「添加课程」手动录入，或「导入」从剪贴板 / 教务系统导入。' }),
        ]),
      ])
    )
  } else {
    for (let day = 1; day <= 7; day++) {
      const list = coursesOnDay(data.courses, day, weekNum)
      if (!list.length) continue
      scroll.appendChild(dayCard(day, list, weekNum))
    }
  }

  scroll.appendChild(actions())
  scroll.appendChild(h('div', { class: 'list-pad' }))
}

function weekNav(weekNum) {
  return h('div', { class: 'card week-nav' }, [
    h('div', { class: 'week-nav-top' }, [
      h('button', { class: 'mini', type: 'button', text: '‹', onclick: () => shift(-1) }),
      h('div', { class: 'week-nav-mid' }, [
        h('b', { text: '第 ' + weekNum + ' 周' }),
        h('span', { text: weekRange(weekOffset) }),
      ]),
      h('button', { class: 'mini', type: 'button', text: '›', onclick: () => shift(1) }),
    ]),
    h('div', { class: 'week-nav-sub' }, [
      h('button', { class: 'mini' + (weekOffset === 0 ? ' on' : ''), type: 'button', text: '本周', onclick: () => (weekOffset = 0, render()) }),
      h('button', { class: 'mini', type: 'button', text: '开学日期', onclick: () => setTermStart() }),
    ]),
  ])
}

function shift(d) {
  weekOffset += d
  render()
}

function dayCard(day, list, weekNum) {
  const card = h('div', { class: 'card' }, [h('h2', { text: WEEK_NAMES[day] + ' · 第 ' + weekNum + ' 周' })])
  list.forEach((c) => card.appendChild(courseRow(c)))
  return card
}

function courseRow(c) {
  const color = COURSE_COLORS[c.color % COURSE_COLORS.length]
  return h('div', { class: 'course', style: '--c:' + color }, [
    h('div', { class: 'course-bar' }),
    h('div', { class: 'course-main' }, [
      h('div', { class: 'course-name', text: c.name }),
      h('div', { class: 'course-sub', text: slotLabel(c) + ' · ' + (SLOT_TIMES[c.start - 1] || '') + ' · ' + WEEK_TYPE_LABEL[c.weekType] }),
      h('div', { class: 'course-sub', text: (c.location ? c.location : '') + (c.teacher ? (c.location ? ' · ' : '') + c.teacher : '') }),
    ]),
    h('div', { class: 'course-btns' }, [
      h('button', { class: 'mini', type: 'button', text: '编辑', onclick: () => editCourse(c) }),
      h('button', { class: 'mini', type: 'button', text: '删除', onclick: () => removeCourse(c) }),
    ]),
  ])
}

function actions() {
  return h('div', { class: 'card' }, [
    h('div', { class: 'act-grid' }, [
      h('button', { class: 'btn primary', type: 'button', text: '＋ 添加课程', onclick: () => editCourse(null) }),
      h('button', { class: 'btn', type: 'button', text: '导入', onclick: () => openImport() }),
      h('button', { class: 'btn', type: 'button', text: '导出', onclick: () => exportJson() }),
    ]),
  ])
}

// ---------------------------------------------------------------- 编辑

function setTermStart() {
  const cur = tt().termStart || ''
  const mask = h('div', { class: 'lib-mask' })
  const input = h('input', { class: 'input', type: 'date', value: cur })
  const box = h('div', { class: 'lib-card' }, [
    h('div', { class: 'lib-head' }, [h('b', { text: '开学日期' }), h('button', { class: 'mini', type: 'button', text: '取消', onclick: () => mask.remove() })]),
    h('p', { class: 'lib-hint', text: '选开学那周里的任意一天（按周一算第 1 周）。' }),
    input,
    h('button', {
      class: 'btn primary block',
      type: 'button',
      text: '保存',
      onclick: async () => {
        const v = input.value
        if (!v) {
          toast('请选择日期')
          return
        }
        const data = tt()
        await saveMeta('timetable', { termStart: v, courses: data.courses })
        mask.remove()
        render()
        toast('已设置开学日期')
      },
    }),
  ])
  mask.appendChild(box)
  document.body.appendChild(mask)
  mask.addEventListener('click', (e) => {
    if (e.target === mask) mask.remove()
  })
}

function editCourse(c) {
  const data = tt()
  const isNew = !c
  const base = c || { day: 1, start: 1, end: 2, weekStart: 1, weekEnd: 16, weekType: 0, name: '', teacher: '', location: '', color: 0 }

  openForm({
    title: isNew ? '添加课程' : '编辑课程',
    values: {
      name: base.name,
      teacher: base.teacher,
      location: base.location,
      day: base.day,
      start: base.start,
      end: base.end,
      weekStart: base.weekStart,
      weekEnd: base.weekEnd,
      weekType: base.weekType,
    },
    fields: [
      { key: 'name', label: '课程名', type: 'text', placeholder: '例如：高等数学' },
      {
        key: 'day',
        label: '星期',
        type: 'chips',
        options: WEEK_NAMES.slice(1).map((n, i) => ({ label: n, value: i + 1 })),
      },
      { key: 'start', label: '起始节次', type: 'number', placeholder: '1' },
      { key: 'end', label: '结束节次', type: 'number', placeholder: '2' },
      { key: 'weekStart', label: '起始周', type: 'number', placeholder: '1' },
      { key: 'weekEnd', label: '结束周', type: 'number', placeholder: '16' },
      {
        key: 'weekType',
        label: '周次类型',
        type: 'chips',
        options: WEEK_TYPE_LABEL.map((n, i) => ({ label: n, value: i })),
      },
      { key: 'location', label: '地点', type: 'text', placeholder: '例如：教3-201' },
      { key: 'teacher', label: '教师', type: 'text', placeholder: '例如：张三' },
    ],
    onSave: async (values) => {
      const rec = normalizeCourse({
        id: isNew ? null : base.id,
        name: values.name,
        teacher: values.teacher,
        location: values.location,
        day: values.day,
        start: values.start,
        end: values.end,
        weekStart: values.weekStart,
        weekEnd: values.weekEnd,
        weekType: values.weekType,
        color: isNew ? (Number(values.day) - 1) % COURSE_COLORS.length : base.color,
      })
      if (!rec) {
        toast('课程名不能为空')
        return
      }
      const courses = data.courses.filter((x) => x.id !== rec.id)
      courses.push(rec)
      await saveMeta('timetable', { termStart: data.termStart, courses })
      render()
      toast(isNew ? '已添加课程' : '已保存修改')
    },
  })
}

async function removeCourse(c) {
  if (!(await confirmAsync('删除「' + c.name + '」？', '删除'))) return
  const data = tt()
  const courses = data.courses.filter((x) => x.id !== c.id)
  await saveMeta('timetable', { termStart: data.termStart, courses })
  render()
  toast('已删除')
}

// ---------------------------------------------------------------- 导入导出

function openImport() {
  const mask = h('div', { class: 'lib-mask' })
  const box = h('div', { class: 'lib-card' }, [
    h('div', { class: 'lib-head' }, [h('b', { text: '导入课表' }), h('button', { class: 'mini', type: 'button', text: '取消', onclick: () => mask.remove() })]),
    h('div', { class: 'imp-opts' }, [
      h('button', { class: 'imp-opt', type: 'button', onclick: () => { mask.remove(); importFromClipboard() } }, [
        h('b', { text: '从剪贴板粘贴 JSON' }),
        h('span', { text: '把之前导出的课表 JSON 粘贴进来' }),
      ]),
      h('button', { class: 'imp-opt', type: 'button', onclick: () => { mask.remove(); importFromEdu() } }, [
        h('b', { text: '教务系统一键导入' }),
        h('span', { text: '登录学校教务系统抓取课表（需账号）' }),
      ]),
    ]),
  ])
  mask.appendChild(box)
  document.body.appendChild(mask)
  mask.addEventListener('click', (e) => {
    if (e.target === mask) mask.remove()
  })
}

function importFromClipboard() {
  const mask = h('div', { class: 'lib-mask' })
  const input = h('textarea', { class: 'input', rows: 6, placeholder: '粘贴课表 JSON' })
  const box = h('div', { class: 'lib-card' }, [
    h('div', { class: 'lib-head' }, [h('b', { text: '粘贴 JSON' }), h('button', { class: 'mini', type: 'button', text: '取消', onclick: () => mask.remove() })]),
    input,
    h('button', {
      class: 'btn primary block',
      type: 'button',
      text: '导入',
      onclick: async () => {
        let parsed
        try {
          parsed = JSON.parse(input.value)
        } catch (e) {
          toast('JSON 格式不对，无法解析')
          return
        }
        const data = normalizeTimetable(parsed)
        if (!data.courses.length) {
          toast('没有读到有效的课程')
          return
        }
        await saveMeta('timetable', data)
        mask.remove()
        render()
        toast('已导入 ' + data.courses.length + ' 门课程')
      },
    }),
  ])
  mask.appendChild(box)
  document.body.appendChild(mask)
  mask.addEventListener('click', (e) => {
    if (e.target === mask) mask.remove()
  })
}

async function exportJson() {
  const data = tt()
  if (!data.courses.length) {
    toast('课表是空的，先添加课程')
    return
  }
  try {
    await writeClipboard(JSON.stringify(data))
    toast('课表 JSON 已复制到剪贴板，可粘贴保存')
  } catch (e) {
    toast('复制失败，请手动复制')
  }
}

/** 教务系统导入：框架。真实对接需要学校账号与具体教务系统接口，这里给出接入位。 */
function importFromEdu() {
  const mask = h('div', { class: 'lib-mask' })
  const box = h('div', { class: 'lib-card' }, [
    h('div', { class: 'lib-head' }, [h('b', { text: '教务系统一键导入' }), h('button', { class: 'mini', type: 'button', text: '取消', onclick: () => mask.remove() })]),
    h('p', { class: 'lib-hint', text: '支持正方教务、URP、强智等主流系统。因各校接口不同，需要先登录学校教务系统。' }),
    h('p', { class: 'lib-hint', text: '当前版本暂未内置教务抓取引擎，请优先用「从剪贴板导入」或手动录入；教务直连会在后续版本接入。' }),
  ])
  mask.appendChild(box)
  document.body.appendChild(mask)
  mask.addEventListener('click', (e) => {
    if (e.target === mask) mask.remove()
  })
}
