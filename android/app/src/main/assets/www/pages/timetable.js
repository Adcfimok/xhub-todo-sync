import { S, saveMeta } from '../lib/core.js'
import { h, toast, confirmAsync, openForm } from '../lib/ui.js'
import { writeClipboard, hasEduBrowser, openEduImport, closeEduImport, waitEduCapture } from '../lib/native.js'
import { EDU_PRESETS, parseEduText, mergeTimetable } from '../lib/edu.js'
import { SCHOOLS, SCHOOL_SOURCE } from '../lib/schools.js'
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
      h('button', { class: 'imp-opt', type: 'button', onclick: () => { mask.remove(); importFromEdu() } }, [
        h('b', { text: '教务系统一键导入' }),
        h('span', { text: '内置浏览器登录教务 → 进课表页 → 点「导入当前页」' }),
      ]),
      h('button', { class: 'imp-opt', type: 'button', onclick: () => { mask.remove(); importFromClipboard() } }, [
        h('b', { text: '粘贴 JSON / 页面源码' }),
        h('span', { text: '导出的课表 JSON、教务表格 HTML 都能识别' }),
      ]),
      h('button', { class: 'imp-opt', type: 'button', onclick: () => { mask.remove(); importFromSource('') } }, [
        h('b', { text: '粘贴 HTML 源码' }),
        h('span', { text: '浏览器里「查看网页源代码」复制整页内容' }),
      ]),
    ]),
  ])
  mask.appendChild(box)
  document.body.appendChild(mask)
  mask.addEventListener('click', (e) => {
    if (e.target === mask) mask.remove()
  })
}

function openMask(box) {
  const mask = h('div', { class: 'lib-mask' })
  mask.appendChild(box)
  document.body.appendChild(mask)
  mask.addEventListener('click', (e) => {
    if (e.target === mask) mask.remove()
  })
  return mask
}

/** 以前导出的课表 JSON 直接吃（保留 termStart）；其它格式交给统一解析器 */
function importFromClipboard() {
  const input = h('textarea', { class: 'input', rows: 6, placeholder: '粘贴本 App 导出的课表 JSON' })
  const mask = openMask(
    h('div', { class: 'lib-card' }, [
      h('div', { class: 'lib-head' }, [h('b', { text: '粘贴课表 JSON' }), h('button', { class: 'mini', type: 'button', text: '取消', onclick: () => mask.remove() })]),
      input,
      h('button', {
        class: 'btn primary block',
        type: 'button',
        text: '解析',
        onclick: () => {
          const text = input.value.trim()
          if (!text) return toast('先粘贴内容')
          try {
            const direct = normalizeTimetable(JSON.parse(text))
            if (direct.courses.length) {
              mask.remove()
              showImportPreview({ courses: direct.courses, source: 'json', warnings: [] }, direct.termStart)
              return
            }
          } catch (e) {
            /* 不是本 App 的导出格式，往下走统一解析 */
          }
          const parsed = parseEduText(text)
          if (!parsed.courses.length) return toast(parsed.warnings[0] || '没有读到有效的课程')
          mask.remove()
          showImportPreview(parsed)
        },
      }),
    ])
  )
}

/** 粘贴教务页源码 / 接口 JSON：与内置浏览器抓到的内容走同一套解析器 */
function importFromSource(prefill) {
  const input = h('textarea', { class: 'input', rows: 7, placeholder: '粘贴课表页 HTML 源码，或教务接口返回的 JSON' })
  input.value = prefill || ''
  const mask = openMask(
    h('div', { class: 'lib-card' }, [
      h('div', { class: 'lib-head' }, [h('b', { text: '粘贴页面源码' }), h('button', { class: 'mini', type: 'button', text: '取消', onclick: () => mask.remove() })]),
      h('p', { class: 'lib-hint', text: '在电脑浏览器打开课表页 → 右键「查看网页源代码」→ 全选复制粘贴到这里。内容只在本机解析，不会上传。' }),
      input,
      h('button', {
        class: 'btn primary block',
        type: 'button',
        text: '解析',
        onclick: () => {
          const parsed = parseEduText(input.value)
          if (!parsed.courses.length) return toast(parsed.warnings[0] || '没有识别到课程')
          mask.remove()
          showImportPreview(parsed)
        },
      }),
    ])
  )
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

// ---------------------------------------------------------------- 教务系统一键导入

/**
 * 流程照搬 WakeUp 课程表（其 assets/empty.html 的提示）：
 * 选学校/填教务网址 → 内置浏览器打开 → 用户自己登录 → 点到课表界面 → 点「导入当前页」。
 * 3.4.0 起内置了从该 App 解密出的 3570 条学校列表（3091 条带教务网址），
 * 选学校会自动填网址；网址仍可手改，因为是离线快照，网址可能失效。详见 lib/schools.js 与 docs/16。
 */
function importFromEdu() {
  let preset = S.meta.eduPreset || 'other'
  let chosen = null
  const urlInput = h('input', { class: 'input', type: 'url', inputmode: 'url', placeholder: 'https://jw.xxx.edu.cn', value: S.meta.eduUrl || '' })
  const hint = h('p', { class: 'lib-hint', text: presetHint(preset) })
  const chips = h('div', { class: 'edu-presets' })
  const chipEls = []
  EDU_PRESETS.forEach((p) => {
    const b = h('button', {
      class: 'edu-chip' + (p.id === preset ? ' on' : ''),
      type: 'button',
      text: p.name,
      onclick: () => {
        preset = p.id
        hint.textContent = presetHint(preset)
        chipEls.forEach((x, i) => x.classList.toggle('on', EDU_PRESETS[i].id === preset))
      },
    })
    chipEls.push(b)
    chips.appendChild(b)
  })

  const mask = openMask(
    h('div', { class: 'lib-card' }, [
      h('div', { class: 'lib-head' }, [h('b', { text: '教务系统一键导入' }), h('button', { class: 'mini', type: 'button', text: '取消', onclick: () => mask.remove() })]),
      h('p', { class: 'lib-hint', text: '从内置的学校列表里选学校（自动填教务网址），或自己填教务首页地址；点「打开」进入内置浏览器。' }),
      h('button', {
        class: 'btn block school-pick-btn',
        type: 'button',
        text: '从学校列表选择（' + SCHOOL_SOURCE.withUrl + ' 所带网址）',
        onclick: () =>
          openSchoolPicker((row) => {
            chosen = row
            // 源数据里有 9 所学校把多个备选网址用换行拼在一起，只取第一个可用地址
            const parts = String(row[1]).split(/[\r\n]+/)
            const first = parts[0].trim()
            // 原列表里约 50 条不是标准 http(s)：有裸域名/内网 IP（可用），
            // 也有「是」「校外http://…校内http://…」这类脏值（不能塞进地址栏）。
            const looksUrl = /^(https?:\/\/)?[a-z0-9.-]+(:\d+)?(\/|$)/i.test(first) || /^(\d{1,3}\.){3}\d{1,3}/.test(first)
            const head = '已选「' + row[0] + '」· 教务类型 ' + row[2] + ' · 导入方式 ' + row[3] + '。'
            if (!looksUrl) {
              urlInput.value = ''
              hint.textContent = head + '来源列表里这项的网址不是有效地址（原值：' + first.slice(0, 30) + '），请手动填写学校教务网址。'
              return
            }
            urlInput.value = first
            hint.textContent = head + '网址已自动填入，仍可手动修改。' +
              (parts.length > 1 ? '该校有 ' + parts.length + ' 个备选网址，已取第一个。' : '')
          }),
      }),
      chips,
      hint,
      urlInput,
      h('button', {
        class: 'btn primary block',
        type: 'button',
        text: '打开教务系统',
        onclick: () => {
          const url = urlInput.value.trim()
          if (!url) return toast('先选学校或填学校教务系统网址')
          saveMeta('eduSchool', chosen ? chosen[0] : '')
          mask.remove()
          if (!hasEduBrowser()) {
            toast('这版没有内置浏览器，改用「粘贴页面源码」导入')
            importFromSource('')
            return
          }
          confirmEduSteps(url, preset)
        },
      }),
      h('p', { class: 'lib-hint', text: '账号密码只输在教务系统自己的页面里，本 App 不读取、不保存、不上传；抓取到的页面只在本机解析。' }),
      h('p', { class: 'lib-hint', text: '学校与教务网址来自 ' + SCHOOL_SOURCE.app + ' 内置列表（共 ' + SCHOOL_SOURCE.total + ' 条，' + SCHOOL_SOURCE.withUrl + ' 条带网址），是离线快照，网址可能失效，可随时手动改。' }),
    ])
  )
}

/**
 * 学校选择器：3570 条一次全渲染会卡，所以按关键词过滤 + 每次只画 60 条，
 * 「加载更多」可以一路翻完整个列表；没有匹配时仍可回到输入框手填网址。
 * onPick 收到 [name, url, type, importType, sortKey]。
 */
function openSchoolPicker(onPick) {
  const mask = h('div', { class: 'school-mask' })
  const panel = h('div', { class: 'school-panel' })
  const search = h('input', { class: 'input school-search', type: 'search', placeholder: '输入学校名称，或拼音首字母（如 A）' })
  const count = h('span', { class: 'school-count' })
  const list = h('div', { class: 'school-list' })
  let matches = []
  let shown = 0
  let moreBtn = null

  function more() {
    const slice = matches.slice(shown, shown + 60)
    slice.forEach((r) => {
      list.appendChild(
        h('button', { class: 'school-row', type: 'button', onclick: () => { mask.remove(); onPick(r) } }, [
          h('div', { class: 'school-row-top' }, [
            h('b', { text: r[0] }),
            h('span', { class: 'school-type', text: r[2] || '通用' }),
          ]),
          h('span', { class: 'school-url', text: r[1] }),
        ])
      )
    })
    shown += slice.length
    if (!matches.length) list.appendChild(h('p', { class: 'lib-hint', text: '没有匹配的学校，可以直接在输入框里填教务网址。' }))
    if (moreBtn) {
      moreBtn.hidden = shown >= matches.length
      moreBtn.textContent = '加载更多（还有 ' + Math.max(0, matches.length - shown) + ' 所）'
    }
  }

  function filter(q) {
    const s = String(q || '').trim().toLowerCase()
    // 只列带教务网址的具体学校；无网址的是「正方教务 / URP 系统」这类通用导入方式
    matches = SCHOOLS.filter(
      (r) => r[1] && (!s || r[0].toLowerCase().indexOf(s) >= 0 || String(r[4] || '').toLowerCase().indexOf(s) === 0)
    )
    shown = 0
    list.innerHTML = ''
    count.textContent = '共 ' + matches.length + ' 所学校 · ' + SCHOOL_SOURCE.app + ' 内置列表'
    more()
  }

  moreBtn = h('button', { class: 'btn block', type: 'button', text: '加载更多', onclick: more })
  panel.appendChild(
    h('div', { class: 'school-head' }, [
      h('b', { text: '选择学校' }),
      h('button', { class: 'mini', type: 'button', text: '关闭', onclick: () => mask.remove() }),
    ])
  )
  panel.appendChild(search)
  panel.appendChild(count)
  panel.appendChild(list)
  panel.appendChild(moreBtn)
  panel.appendChild(h('p', { class: 'school-src', text: '数据来源：WakeUp课程表 6.5.2 内置「导入教务系统课表」列表，共 ' + SCHOOL_SOURCE.total + ' 条；其中 ' + SCHOOL_SOURCE.withUrl + ' 条带教务网址，此处只显示这些。' }))
  mask.appendChild(panel)
  document.body.appendChild(mask)
  mask.addEventListener('click', (e) => { if (e.target === mask) mask.remove() })
  search.addEventListener('input', () => filter(search.value))
  filter('')
  setTimeout(() => search.focus(), 120)
}

function presetHint(id) {
  const p = EDU_PRESETS.filter((x) => x.id === id)[0] || EDU_PRESETS[EDU_PRESETS.length - 1]
  return p.hint
}

/** 打开前把 WakeUp 式的操作提示讲清楚，避免用户在登录页就点「导入」 */
function confirmEduSteps(url, preset) {
  const mask = openMask(
    h('div', { class: 'lib-card' }, [
      h('div', { class: 'lib-head' }, [h('b', { text: '接下来这样操作' })]),
      h('p', { class: 'lib-hint', text: '1. 在打开的内置浏览器里登录教务系统（账号密码不经过本 App）。' }),
      h('p', { class: 'lib-hint', text: '2. 一路点到「课表 / 本学期课表」那一页，等课程名都显示出来。' }),
      h('p', { class: 'lib-hint', text: '3. 点顶部「导入当前页」，页面会自动关闭并列出识别到的课程，确认后再写入。' }),
      h('p', { class: 'lib-hint', text: '没收录贵校网址也没关系：填自己学校教务首页即可；登录页点导入识别不到课程，回到课表页再点一次。' }),
      h('div', { class: 'act-grid' }, [
        h('button', { class: 'btn primary', type: 'button', text: '知道了，打开', onclick: () => { mask.remove(); startEduCapture(url, preset) } }),
        h('button', { class: 'btn', type: 'button', text: '取消', onclick: () => mask.remove() }),
      ]),
    ])
  )
}

function startEduCapture(url, preset) {
  saveMeta('eduUrl', url)
  saveMeta('eduPreset', preset)
  // 先订阅再打开：原生按钮点下的那一刻就会把源码送回来
  const cap = waitEduCapture()
  if (!openEduImport(url)) {
    cap.cancel()
    toast('打不开内置浏览器，改用粘贴源码导入')
    importFromSource('')
    return
  }
  cap.promise
    .then((cap2) => {
      closeEduImport()
      const parsed = parseEduText(cap2.html, cap2.url)
      if (!parsed.courses.length) {
        toast(parsed.warnings[0] || '没识别到课程')
        importFromSource(cap2.html.slice(0, 20000))
        return
      }
      showImportPreview(parsed)
    })
    .catch((err) => {
      closeEduImport()
      if (err && err.message !== '已取消') toast(err.message || '导入失败')
    })
}

/** 预览 → 覆盖 / 追加 → 写入；开学日期可顺手补上 */
function showImportPreview(parsed, presetTermStart) {
  const courses = parsed.courses || []
  const data = tt()
  const termInput = h('input', { class: 'input', type: 'date', value: presetTermStart || data.termStart || '' })
  const list = h('div', { class: 'edu-preview' })
  courses.slice(0, 12).forEach((c) => {
    const wt = WEEK_TYPE_LABEL[c.weekType] || '每周'
    const wk = c.weekStart === c.weekEnd ? '第 ' + c.weekStart + ' 周' : c.weekStart + '-' + c.weekEnd + ' 周'
    list.appendChild(
      h('div', { class: 'edu-row' }, [
        h('b', { text: c.name }),
        h('span', { text: WEEK_NAMES[c.day] + ' · ' + slotLabel(c) + ' · ' + wk + (wt === '每周' ? '' : ' · ' + wt) }),
      ])
    )
  })
  if (courses.length > 12) list.appendChild(h('div', { class: 'edu-row' }, [h('span', { text: '…… 还有 ' + (courses.length - 12) + ' 条' })]))

  const mask = openMask(
    h('div', { class: 'lib-card' }, [
      h('div', { class: 'lib-head' }, [h('b', { text: '识别到 ' + courses.length + ' 条课程' }), h('button', { class: 'mini', type: 'button', text: '取消', onclick: () => mask.remove() })]),
      parsed.warnings && parsed.warnings.length ? h('p', { class: 'lib-hint', text: parsed.warnings.join('；') }) : null,
      list,
      h('p', { class: 'lib-hint', text: '开学日期（那周的周一），用于计算第几周与单双周：' }),
      termInput,
      h('div', { class: 'act-grid' }, [
        h('button', { class: 'btn primary', type: 'button', text: '覆盖导入', onclick: () => applyImport('replace') }),
        h('button', { class: 'btn', type: 'button', text: '追加到现有', onclick: () => applyImport('append') }),
      ]),
    ])
  )

  async function applyImport(mode) {
    const merged = mergeTimetable(tt(), parsed, mode, termInput.value)
    await saveMeta('timetable', merged)
    mask.remove()
    render()
    toast('已导入 ' + courses.length + ' 条课程')
  }
}
