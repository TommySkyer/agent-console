import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'

/** 距底部多少像素以内算「贴着底」。留余量是因为滚动条有亚像素误差。 */
const STICK_THRESHOLD = 48

export interface StickState {
  /** 当前是否贴着底。用来决定要不要显示「有新内容」按钮。 */
  atBottom: boolean
  /** 有新内容但用户不在底部。 */
  hasNewBelow: boolean
  /** 强制滚到底并重新开始跟随。 */
  scrollToBottom: () => void
}

/**
 * 跟随底部，但不抢用户的滚动条。
 *
 * ## 这里修的是一个真实 bug
 *
 * 最初的实现只有一条规则：「内容变长时，如果用户贴着底就滚到底」。
 * 这条规则对**流入的内容**是对的，但对**用户自己发出的内容**是错的 ——
 *
 *   用户往回翻看历史（很自然）→ 提交新一轮 → 新内容（含他自己刚发的那句话）
 *   渲染在视口外 → 页面纹丝不动 → 看起来就像「提交没反应」。
 *   刷新页面后首屏会自动滚到底，于是「刷新才能看到结果」。
 *
 * 实测过：往回翻 400px 之后提交，新内容落在视口外 316px 处，自己发的那句话
 * 完全在屏幕外。这就是「必须手动刷新」的真正原因 —— 事件一直在实时到达，
 * 只是视图从不跟随。
 *
 * 所以现在有**两种**触发：
 *   follow —— 内容增长。只在用户贴着底时跟随。
 *   jump   —— 用户自己的动作（发了一轮）。无条件滚到底并重新开始跟随。
 *             「我发的东西我要看见」是聊天界面的通用预期，没有例外。
 *
 * 另外把 atBottom 暴露出去，让界面能在用户翻到上面时显示「有新内容 ↓」，
 * 而不是默默地把内容堆在看不见的地方。
 */
export function useStickToBottom(
  ref: RefObject<HTMLElement | null>,
  follow: unknown,
  jump: unknown,
  enabled = true,
): StickState {
  // 贴底状态同时存 ref 和 state：
  //   ref 供 effect 同步读取（滚动事件高频，读 state 会拿到闭包里的旧值）
  //   state 供渲染「有新内容」按钮（低频，只在跨越阈值时变）
  const stuck = useRef(true)
  const [atBottom, setAtBottom] = useState(true)
  const [hasNewBelow, setHasNewBelow] = useState(false)

  const sync = useCallback((element: HTMLElement) => {
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight
    const next = distance <= STICK_THRESHOLD
    stuck.current = next
    // 只在跨越阈值时 setState，避免每个滚动事件都触发重渲染。
    setAtBottom((previous) => (previous === next ? previous : next))
    if (next) setHasNewBelow(false)
  }, [])

  const scrollToBottom = useCallback(() => {
    const element = ref.current
    if (!element) return
    element.scrollTop = element.scrollHeight
    stuck.current = true
    setAtBottom(true)
    setHasNewBelow(false)
  }, [ref])

  useEffect(() => {
    const element = ref.current
    if (!element) return
    const onScroll = () => sync(element)
    element.addEventListener('scroll', onScroll, { passive: true })
    return () => element.removeEventListener('scroll', onScroll)
  }, [ref, sync])

  // 内容增长：贴底才跟随，否则只标记「下面有新东西」。
  //
  // useLayoutEffect 而不是 useEffect：滚动必须在浏览器绘制**之前**完成，
  // 否则会看到内容先跳出来、下一帧才滚下去的闪动。
  useLayoutEffect(() => {
    const element = ref.current
    if (!enabled || !element) return
    if (stuck.current) element.scrollTop = element.scrollHeight
    else setHasNewBelow(true)
  }, [ref, follow, enabled])

  // 用户自己的动作：无条件滚到底。
  useLayoutEffect(() => {
    if (!enabled) return
    scrollToBottom()
  }, [jump, enabled, scrollToBottom])

  return { atBottom, hasNewBelow, scrollToBottom }
}
