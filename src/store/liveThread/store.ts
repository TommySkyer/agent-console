import type { SessionEvent } from '@/types/contract'
import { applyEvent } from './apply'
import { initialState, type LiveThreadState } from './state'

/**
 * 通知调度器。默认合并到下一帧，测试里换成同步执行。
 *
 * 抽成参数而不是直接调 requestAnimationFrame，是为了让测试不必 await 帧——
 * 断言"dispatch 之后立刻能读到新状态"比等一帧再断言要稳定得多。
 */
export type Scheduler = (callback: () => void) => void

const rafScheduler: Scheduler = (callback) => {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(callback)
  else setTimeout(callback, 16)
}

export const syncScheduler: Scheduler = (callback) => callback()

/**
 * 一个 Thread 的实时状态容器。
 *
 * 它是 useSyncExternalStore 意义上的"外部 store"：自己管状态和订阅者，
 * React 只是它的一个消费者。三个方法构成完整契约——
 * subscribe / getState 给 React 用，dispatch 给编排层用。
 *
 * 为什么不用 Zustand：这个类加上合并逻辑一共不到 90 行，而 useSyncExternalStore
 * 正是 Zustand 内部用的那个官方原语。自己写一遍能完全讲清每一行，合并逻辑也能
 * 直接写进 dispatch 而不是包一层 middleware。需要多 store 互引、devtools 或
 * 持久化时再换——useLiveThread 的签名和 Zustand 的 useStore(selector) 一致，
 * 换实现不影响任何组件。
 */
export class LiveThreadStore {
  private state: LiveThreadState
  private readonly listeners = new Set<() => void>()
  private notifyScheduled = false

  constructor(
    threadId: string,
    private readonly schedule: Scheduler = rafScheduler,
  ) {
    this.state = initialState(threadId)
  }

  /**
   * getState 必须返回引用稳定的值：useSyncExternalStore 每次渲染都会调用它
   * 并比较引用，返回新对象会导致无限重渲染。所以这里直接返回字段，
   * 不做任何即时计算。
   */
  getState = (): LiveThreadState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * 消费一条事件。
   *
   * **写入同步、通知合并**：状态立刻更新（getState 永远不滞后），
   * 但只有 item.delta 把"叫 React 来读"推迟到下一帧。
   *
   * 只对 delta 合并的理由：实测流式输出 139 条/秒，而屏幕只有 60Hz，
   * 多出来的唤醒全是白干。其余事件（step.started、item.completed、
   * turn.completed）都是低频的状态跃迁，立刻通知，响应不打折。
   *
   * 后台标签页里 requestAnimationFrame 不触发，于是不通知 React——
   * 但事件照收、状态照更新（上面那一行是同步的），切回来时一次性追上。
   * 这正是想要的行为：后台标签页本来就不该花 CPU 渲染。
   */
  dispatch = (event: SessionEvent): void => {
    const next = applyEvent(this.state, event)
    if (next === this.state) return // reducer 判定无变化（重复事件），不惊动 React
    this.state = next

    if (event.type === 'item.delta') this.scheduleNotify()
    else this.notifyNow()
  }

  /** 用快照重置。重新同步（desynced）和首次播种都走这里。 */
  reset = (state: LiveThreadState): void => {
    this.state = state
    this.notifyNow()
  }

  private notifyNow(): void {
    // 已经排了队的合并通知作废：现在就通知，等价且更及时。
    this.notifyScheduled = false
    for (const listener of this.listeners) listener()
  }

  private scheduleNotify(): void {
    if (this.notifyScheduled) return
    this.notifyScheduled = true
    this.schedule(() => {
      if (!this.notifyScheduled) return // 期间被 notifyNow 抢先了
      this.notifyScheduled = false
      for (const listener of this.listeners) listener()
    })
  }
}
