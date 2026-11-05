import { openTodoForm } from './todoform.js'

/**
 * 底栏中央「+」的当前动作。
 *
 * 底栏只有一个加号，含义跟着页面走：待办页建待办、笔记页建笔记、
 * 日历页按选中日期建待办……页面在 mount 时注册，切页时由路由层重置，
 * 避免上一个页面的处理器残留到没有注册的页面（首页 / 设置等）。
 */
let handler = null

export function setQuickAdd(fn) {
  handler = typeof fn === 'function' ? fn : null
}

export function resetQuickAdd() {
  handler = null
}

/** 没有页面注册时退回「新建待办」——这是整个 App 最常用的新建动作 */
export function runQuickAdd() {
  if (handler) {
    handler()
    return
  }
  openTodoForm(null)
}
