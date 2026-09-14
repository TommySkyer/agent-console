import type { SessionEvent } from '@/types/contract'

/**
 * 可手动驱动的 EventSource 替身。
 *
 * 需要它是因为原生 EventSource 只能靠真实网络驱动：没法在单测里表达
 * 「收到第 3 条事件后断线」「重连后从第 4 条接上」这类时序，而这些恰恰是
 * 实时层最该被测的部分。
 *
 * 只实现被测代码真正用到的那部分接口（addEventListener / removeEventListener /
 * close / readyState / onopen / onerror），不做完整实现——替身的价值在于
 * 可控，不在于逼真。
 *
 * 刻意**不**写 implements EventSource：原生接口有十几个成员，为了让编译器
 * 满意而补一堆永远不会被调用的空方法，只会让人分不清哪些是测试真正依赖的。
 * 注入点在工厂函数处做一次断言即可（见文件末尾 fakeEventSourceFactory）。
 */
export class FakeEventSource {
  static instances: FakeEventSource[] = []

  static reset(): void {
    FakeEventSource.instances = []
  }

  /** 最近一次创建的实例。测试里用它来派发事件。 */
  static get last(): FakeEventSource {
    const instance = FakeEventSource.instances.at(-1)
    if (!instance) throw new Error('还没有任何 FakeEventSource 被创建')
    return instance
  }

  /** 有多少条连接还没被 close。守 StrictMode 双连接回归用。 */
  static get openCount(): number {
    return FakeEventSource.instances.filter((i) => i.readyState !== 2).length
  }

  readyState = 0
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  closed = false

  private readonly listeners = new Map<string, Set<EventListener>>()

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: EventListener): void {
    let set = this.listeners.get(type)
    if (!set) this.listeners.set(type, (set = new Set()))
    set.add(listener)
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener)
  }

  close(): void {
    this.readyState = 2
    this.closed = true
  }

  // ── 测试驱动接口 ──

  open(): void {
    this.readyState = 1
    this.onopen?.()
  }

  /** 派发一条业务事件，模拟服务端推送。 */
  emit(event: SessionEvent): void {
    const listeners = this.listeners.get(event.type)
    if (!listeners) return
    const message = new MessageEvent(event.type, {
      data: JSON.stringify(event),
      lastEventId: String(event.seq),
    })
    for (const listener of listeners) listener(message)
  }

  /** 派发一条无法解析的消息，测健壮性。 */
  emitRaw(type: string, data: string): void {
    const listeners = this.listeners.get(type)
    if (!listeners) return
    for (const listener of listeners) listener(new MessageEvent(type, { data }))
  }

  /** 模拟浏览器正在自动重连（readyState 回到 CONNECTING）。 */
  simulateReconnecting(): void {
    this.readyState = 0
    this.onerror?.()
  }

  /** 模拟彻底失败，浏览器放弃重连。 */
  simulateFatal(): void {
    this.readyState = 2
    this.onerror?.()
  }
}

export const fakeEventSourceFactory = (url: string) =>
  new FakeEventSource(url) as unknown as EventSource
