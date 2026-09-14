import { createContext, useContext, type ReactNode } from 'react'
import type { LiveThreadStore } from './store'
import type { LiveThreadState } from './state'
import { useLiveThread } from './useLiveThread'

/**
 * 把 store **实例**放进 Context。
 *
 * ## 这里藏着本项目关于 Context 最重要的一条区分
 *
 * 放进 Context 的是 store 的**引用**，不是 store 里的**状态**。
 *
 *   store 引用：一个 Thread 的整个生命周期都不变 → Context 的完美用例
 *   store 状态：139 次/秒 → 放进 Context 会让所有 consumer 每秒重渲染 139 次
 *
 * 于是既拿到了 Context 的好处（不用把 store 一层层 props 传到每张卡片上），
 * 又完全避开了它的代价（value 一变全体重渲染）。组件订阅状态走的是
 * useSyncExternalStore 的选择性订阅路径，和 Context 的广播机制没有关系。
 *
 * 能讲清"什么进 Context、什么不进"，比会用 Context 更重要。
 */
const LiveThreadContext = createContext<LiveThreadStore | null>(null)

export function LiveThreadProvider({
  store,
  children,
}: {
  store: LiveThreadStore
  children: ReactNode
}) {
  return <LiveThreadContext value={store}>{children}</LiveThreadContext>
}

function useLiveThreadStore(): LiveThreadStore {
  const store = useContext(LiveThreadContext)
  if (!store) {
    // 显式报错而不是返回 null 让调用方各自判空：漏包 Provider 是结构性错误，
    // 应当在第一次渲染就炸掉，而不是让每个组件写一遍防御代码。
    throw new Error('useLiveSelector 必须在 <LiveThreadProvider> 内使用')
  }
  return store
}

/**
 * 订阅实时状态的一个切片。
 *
 * selector 必须返回**引用稳定**的值——原始值，或由 reducer 保证结构共享的
 * 对象引用。返回新数组/新对象会导致无限重渲染，原因见 useLiveThread.ts。
 */
export function useLiveSelector<T>(selector: (state: LiveThreadState) => T): T {
  return useLiveThread(useLiveThreadStore(), selector)
}
