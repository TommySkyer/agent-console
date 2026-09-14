import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'

/** 距底部多少像素以内算「贴着底」。留一点余量，不然滚动条的亚像素误差会误判。 */
const STICK_THRESHOLD = 48

/**
 * 内容增长时自动滚到底，但**用户往回翻的时候不抢滚动条**。
 *
 * 这是日志/聊天类界面的经典需求，也是一个典型的"必须用 ref 而不是 state"的场景：
 * 要读写的是真实 DOM 的 scrollTop，不是 React 管理的数据。用 state 存滚动位置
 * 既会每帧触发重渲染，又永远慢 DOM 一拍。
 *
 * 用 useLayoutEffect 而不是 useEffect：滚动必须在浏览器绘制**之前**完成，
 * 否则用户会看到内容先跳出来、下一帧再滚下去的闪动。这正是两个 Hook 的
 * 分工——useLayoutEffect 同步跑在 DOM 变更之后、绘制之前。
 *
 * @param ref    滚动容器
 * @param trigger 变化时检查是否需要滚动的依赖（通常是内容长度或 seq）
 * @param enabled 关掉之后完全不干预滚动
 */
export function useStickToBottom(
  ref: RefObject<HTMLElement | null>,
  trigger: unknown,
  enabled = true,
): void {
  // 是否处于"贴底"状态。存在 ref 里而不是 state：它每次滚动都会变，
  // 放进 state 会把滚动变成一连串重渲染，而它根本不影响渲染输出。
  const stuck = useRef(true)

  useEffect(() => {
    const element = ref.current
    if (!element) return
    const onScroll = () => {
      const distance = element.scrollHeight - element.scrollTop - element.clientHeight
      stuck.current = distance <= STICK_THRESHOLD
    }
    element.addEventListener('scroll', onScroll, { passive: true })
    return () => element.removeEventListener('scroll', onScroll)
  }, [ref])

  useLayoutEffect(() => {
    const element = ref.current
    if (!enabled || !element || !stuck.current) return
    element.scrollTop = element.scrollHeight
  }, [ref, trigger, enabled])
}
