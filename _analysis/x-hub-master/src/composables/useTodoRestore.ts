import type { RepeatRuleInput, Todo } from '../api/tauri'
import { useStore } from '../stores/workbench'

type Store = ReturnType<typeof useStore>

/**
 * 删除后的「撤销」恢复：把删除瞬间的快照整条写回。
 *
 * 删除走的是级联删除（父条目 + 子待办），恢复只能靠重建，因此这里按快照逐字段回填。
 * 早期版本只回填了标题/优先级/排期/完成态，描述、置顶、标签、周期规则会**静默丢失**
 * ——用户看到「已恢复待办」却拿到一条残缺的待办，属于数据丢失，故统一在这里补齐。
 *
 * 待办卡与待办视图共用这一份（两处各写一遍必然改一处漏一处）。
 *
 * 无法回填的字段：`repeat_done_count` / `repeat_last_done_at`（累计完成次数与上次完成时刻，
 * 没有对外写入命令）——恢复后从 0 重新累计，与 ADR 0009「不逐次留历史」的口径一致。
 */
export function useTodoRestore() {
  const store = useStore()
  return async function restoreTodo(
    parent: Todo,
    kids: readonly Todo[],
    parentTagIds: readonly number[],
  ): Promise<void> {
    await restoreOne(store, parent, null, parentTagIds)
    for (const k of kids) {
      await restoreOne(store, k, parent.id, [])
    }
  }
}

/** 回填单条：顺序有依赖——周期规则要求先有 due_at，标签要在条目存在之后才能关联 */
async function restoreOne(
  store: Store,
  src: Todo,
  parentId: number | null,
  tagIds: readonly number[],
): Promise<void> {
  const t = await store.createTodo(src.title, parentId, src.created_at)
  if (src.priority !== 0) await store.updateTodo(t.id, src.title, src.priority)
  if (src.due_at != null || src.remind_at != null) {
    await store.scheduleTodo(t.id, src.due_at, src.remind_at)
  }
  if (src.repeat_mode !== 'once') await store.setTodoRepeat(t.id, repeatInput(src))
  if (src.description) await store.setTodoDescription(t.id, src.description)
  if (src.pinned) await store.setTodoPinned(t.id, true)
  if (tagIds.length) await store.setTodoTags(t.id, [...tagIds])
  // 周期待办永远不置 done（勾选 = 完成本轮），只有一次性待办需要还原完成态
  if (src.done && src.repeat_mode === 'once') await store.toggleTodo(t.id)
}

/** Todo 的周期字段 → 写入用规则（字段名/口径与后端 RepeatRule 对齐） */
function repeatInput(t: Todo): RepeatRuleInput {
  return {
    mode: t.repeat_mode,
    every: t.repeat_every,
    unit: t.repeat_unit,
    weekdays: t.repeat_weekdays,
    month_day: t.repeat_month_day,
    month_nth: t.repeat_month_nth,
    end_mode: t.repeat_end_mode,
    end_at: t.repeat_end_at,
    count: t.repeat_count,
  }
}
