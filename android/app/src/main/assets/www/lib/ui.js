/* UI 小工具：DOM 构造、提示、确认、通用表单面板、日期格式化。 */

export function h(tag, attrs, children) {
  const el = document.createElement(tag)
  if (attrs) {
    for (const k in attrs) {
      const v = attrs[k]
      if (v == null || v === false) continue
      if (k === 'class') el.className = v
      else if (k === 'text') el.textContent = v
      else if (k === 'html') el.innerHTML = v
      else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v)
      else if (k === 'style') el.setAttribute('style', v)
      else el.setAttribute(k, v)
    }
  }
  ;(Array.isArray(children) ? children : children ? [children] : []).forEach((c) => {
    if (c == null || c === false) return
    el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c)
  })
  return el
}

export function toast(msg, ms = 2200) {
  const el = document.getElementById('toast')
  if (!el) return
  el.textContent = msg
  el.hidden = false
  clearTimeout(toast._t)
  toast._t = setTimeout(() => (el.hidden = true), ms)
}

export function confirmAsync(text, okText = '确定') {
  return new Promise((resolve) => {
    const mask = h('div', { class: 'modal-mask' })
    const box = h('div', { class: 'modal' }, [
      h('p', { class: 'modal-text', text }),
      h('div', { class: 'modal-btns' }, [
        h('button', { class: 'btn', type: 'button', text: '取消', onclick: () => done(false) }),
        h('button', { class: 'btn danger', type: 'button', text: okText, onclick: () => done(true) }),
      ]),
    ])
    document.body.appendChild(mask)
    document.body.appendChild(box)
    function done(v) {
      mask.remove()
      box.remove()
      resolve(v)
    }
    mask.addEventListener('click', () => done(false))
  })
}

// ---------------------------------------------------------------- 表单面板

/**
 * 通用编辑面板。
 * @param {{title:string, fields:Array, values:Object, onSave:Function, onDelete?:Function}} opt
 */
export function openForm(opt) {
  const sheet = document.getElementById('sheet')
  const mask = document.getElementById('sheet-mask')
  const body = document.getElementById('sheet-body')
  const titleEl = document.getElementById('sheet-title')
  const delBtn = document.getElementById('btn-delete')

  titleEl.textContent = opt.title || '编辑'
  body.innerHTML = ''
  const values = Object.assign({}, opt.values || {})
  const inputs = {}

  opt.fields.forEach((f) => {
    const wrap = h('label', { class: 'field' })
    let input
    if (f.type === 'textarea') {
      input = h('textarea', { rows: f.rows || 4, placeholder: f.placeholder || '', maxlength: f.maxlength || 20000 })
    } else if (f.type === 'select') {
      input = h('select', { class: 'input' })
      ;(f.options || []).forEach((o) => {
        const op = h('option', { value: o.value, text: o.label })
        input.appendChild(op)
      })
    } else {
      input = h('input', {
        class: 'input',
        type: f.type === 'date' ? 'date' : f.type === 'time' ? 'time' : f.type === 'number' ? 'number' : 'text',
        placeholder: f.placeholder || '',
        inputmode: f.type === 'number' ? 'decimal' : undefined,
      })
    }
    input.value = values[f.key] == null ? '' : values[f.key]
    input.addEventListener('input', () => (values[f.key] = input.value))
    inputs[f.key] = input

    // 标签行：可带一个行内动作（如从剪贴板粘贴）
    const labelRow = h('span', { class: 'field-label-row' })
    labelRow.appendChild(h('span', { class: 'field-label-text', text: f.label }))
    if (f.action) {
      const act = h('button', { class: 'field-act', type: 'button', text: f.action.text })
      act.addEventListener('click', (ev) => {
        ev.preventDefault()
        ev.stopPropagation()
        f.action.onClick(input, values, f.key)
      })
      labelRow.appendChild(act)
    }

    wrap.appendChild(labelRow)
    wrap.appendChild(input)
    body.appendChild(wrap)
  })

  delBtn.hidden = !opt.onDelete
  delBtn.onclick = async () => {
    closeSheet()
    if (await confirmAsync('删除后会在所有设备上同步移除，确定删除？', '删除')) opt.onDelete()
  }

  document.getElementById('btn-save').onclick = () => {
    closeSheet()
    opt.onSave(values)
  }
  document.getElementById('btn-cancel').onclick = closeSheet
  mask.onclick = closeSheet

  mask.hidden = false
  sheet.hidden = false
  setTimeout(() => {
    const first = body.querySelector('textarea, input')
    if (first && opt.focus !== false) first.focus()
  }, 120)
  return { values, close: closeSheet }
}

export function closeSheet() {
  const sheet = document.getElementById('sheet')
  const mask = document.getElementById('sheet-mask')
  if (sheet) sheet.hidden = true
  if (mask) mask.hidden = true
}

// ---------------------------------------------------------------- 日期

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

export function startOfDay(ms) {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

export function dayDiff(ms) {
  return Math.round((startOfDay(ms) - startOfDay(Date.now())) / 86400000)
}

export function fmtDue(ms) {
  if (!ms) return ''
  const d = new Date(ms)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const diff = dayDiff(ms)
  if (diff === 0) return '今天 ' + hh + ':' + mm
  if (diff === 1) return '明天 ' + hh + ':' + mm
  if (diff === -1) return '昨天 ' + hh + ':' + mm
  if (diff < -1) return '逾期 ' + -diff + ' 天'
  if (diff < 7) return WEEK[d.getDay()] + ' ' + hh + ':' + mm
  return d.getMonth() + 1 + '/' + d.getDate()
}

export function fmtClock(ms) {
  if (!ms) return '—'
  const d = new Date(ms)
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
}

export function fmtDateInput(ms) {
  if (!ms) return ''
  const d = new Date(ms)
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}

export function fmtTimeInput(ms) {
  if (!ms) return ''
  return fmtClock(ms)
}

export function fmtAgo(ms) {
  if (!ms) return '—'
  const s = Math.round((Date.now() - ms) / 1000)
  if (s < 60) return '刚刚'
  if (s < 3600) return Math.floor(s / 60) + ' 分钟前'
  if (s < 86400) return Math.floor(s / 3600) + ' 小时前'
  return Math.floor(s / 86400) + ' 天前'
}

export function emptyBlock(title, sub) {
  return h('div', { class: 'empty' }, [
    h('p', { class: 'empty-t', text: title }),
    sub ? h('p', { class: 'empty-s', text: sub }) : null,
  ])
}

export function statusChip(state, text) {
  return h('button', { class: 'status-chip', id: 'status-chip', type: 'button', 'data-state': state }, [
    h('i', { class: 'dot' }),
    h('span', { id: 'status-text', text }),
  ])
}
