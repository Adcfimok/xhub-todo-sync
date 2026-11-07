import { openTodoForm } from './todoform.js'

/**
 * 底栏中央「+」的当前动作。
 *
 * 底栏只有一个加号。它有两层含义：
 *   1. 当前页面自己注册了动作（待办页建待办、笔记页建笔记、日历页按选中日期建待办）；
 *   2. 没注册时（首页 / 我的 / AI），弹出「待办 / 笔记 / 提示词」类型选择，选完再进表单。
 *
 * 第 2 条是笔记移出底栏后的必要路径：三个集合的入口不再各自占一个格子，
 * 加号必须能到达它们，否则用户只能从「我的」逐层点进去。
 */
let handler = null
let fallback = null

export function setQuickAdd(fn) {
  handler = typeof fn === 'function' ? fn : null
}

/** 由路由层注入类型选择器，避免 quickadd 反向 import 各个页面（会形成循环依赖） */
export function setQuickAddFallback(fn) {
  fallback = typeof fn === 'function' ? fn : null
}

export function resetQuickAdd() {
  handler = null
}

/** 没有页面注册时退回类型选择；连选择器都没注入（异常情况）才兜底新建待办 */
export function runQuickAdd() {
  if (handler) {
    handler()
    return
  }
  if (fallback) {
    fallback()
    return
  }
  openTodoForm(null)
}
