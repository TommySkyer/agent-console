import type { LiveThreadState } from './state'

/**
 * 选择器集合。
 *
 * ## 唯一的规则：返回值必须引用稳定
 *
 * useSyncExternalStore 每次渲染都会调用选择器并比较引用。返回新创建的
 * 数组或对象就永远不等于上一次，React 判定"又变了"，无限重渲染。
 *
 * 所以这里只允许两种返回值：
 *   1. 原始值（number / string / boolean / null）
 *   2. 由 reducer 保证结构共享的现成引用（state.turns、state.items.get(id)）
 *
 * 需要派生数组（比如"所有失败的命令"）时，在组件里用 useMemo 算，
 * 不要写进选择器。把这条规则写在这里，是因为它是本文件唯一容易踩的坑。
 */

export const selectStatus = (s: LiveThreadState) => s.status
export const selectTurns = (s: LiveThreadState) => s.turns
export const selectHistoryItems = (s: LiveThreadState) => s.historyItems
export const selectMessages = (s: LiveThreadState) => s.messages
export const selectDesynced = (s: LiveThreadState) => s.desynced
export const selectTurnUsage = (s: LiveThreadState) => s.turnUsage
export const selectContextWindow = (s: LiveThreadState) => s.contextWindow
export const selectSessionTokens = (s: LiveThreadState) => s.sessionTokens
export const selectLastSeq = (s: LiveThreadState) => s.lastSeq

/** 按 ID 取单个 Item。这是"只有正在流的那张卡片重渲染"的实现入口。 */
export const selectItem = (id: string) => (s: LiveThreadState) => s.items.get(id)

/** 卡片总数，给概览用。返回 number，引用天然稳定。 */
export const selectItemCount = (s: LiveThreadState) => s.items.size
