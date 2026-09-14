import { useSyncExternalStore } from 'react'
import type { LiveThreadStore } from './store'
import type { LiveThreadState } from './state'

/**
 * 把外部 store 接到 React 上。
 *
 * ## 为什么是 useSyncExternalStore 而不是 useState + useEffect
 *
 * 朴素写法：
 *   const [s, setS] = useState(store.getState())
 *   useEffect(() => store.subscribe(() => setS(store.getState())), [])
 *
 * 它在 React 18+ 的并发渲染下有个真实缺陷，叫 **tearing（撕裂）**：并发渲染
 * 允许 React 渲染到一半让出主线程。外部 store 恰好在这个间隙变了的话，
 * 已渲染完的组件用旧值、还没渲染的用新值，同一帧里画出两个不一致的状态。
 *
 * useSyncExternalStore 就是 React 为这个问题提供的官方原语：它在渲染期间
 * 检查 store 是否变过，变了就丢弃这次渲染重来，保证一帧内所有组件读到同一个版本。
 *
 * ## 使用约束：selector 必须引用稳定
 *
 * React 每次渲染都会调 getSnapshot 并比较引用。返回新对象就永远不等于上一个，
 * 于是判定"又变了"，无限重渲染：
 *
 *   useLiveThread(store, s => s.turns.map(t => t.id))   // ✗ 每次都是新数组
 *   useLiveThread(store, s => ({ a: s.status }))         // ✗ 每次都是新对象
 *
 * 所以本项目的 selector 只允许两种返回值：
 *   1. 原始值（number / string / boolean）
 *   2. 由 reducer 保证结构共享的对象引用（s.turns、s.items.get(id)）
 *
 * 需要派生数组时在组件里用 useMemo 算，不在 selector 里算。
 */
export function useLiveThread<T>(
  store: LiveThreadStore,
  selector: (state: LiveThreadState) => T,
): T {
  return useSyncExternalStore(
    store.subscribe,
    () => selector(store.getState()),
    // 第三个参数是 SSR 快照。这里和客户端取同一个值：本项目没有 SSR，
    // 但省略它会在某些工具链（比如 Vitest 的 jsdom 环境预渲染）下报错。
    () => selector(store.getState()),
  )
}
