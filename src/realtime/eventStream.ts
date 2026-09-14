import { EVENT_TYPES, type SessionEvent } from '@/types/contract'

/**
 * SSE 订阅层。
 *
 * 职责边界：**只收事件、解析、转发**。它不判断事件该如何改变状态（那是 reducer
 * 的事），也不决定断线后怎么办（那是编排层的事）。这一层唯一的业务知识是
 * 「后端的事件叫什么名字」。
 */

/** 连接状态。映射自 EventSource.readyState，但用语义化的名字。 */
export type StreamStatus = 'connecting' | 'open' | 'closed'

export interface StreamHandlers {
  onEvent: (event: SessionEvent) => void
  onStatus: (status: StreamStatus) => void
}

/**
 * EventSource 的构造函数类型。
 *
 * 抽出来是为了能在测试里注入一个可手动派发的替身——原生 EventSource 只能
 * 通过真实网络驱动，没法在单测里模拟"收到第 3 条事件后断线"这种时序。
 * 这是依赖注入在前端最典型的用武之地。
 */
export type EventSourceFactory = (url: string) => EventSource

const defaultFactory: EventSourceFactory = (url) => new EventSource(url)

/**
 * EventSource.readyState 的取值。
 *
 * 写成本地常量而不是引用全局的 EventSource.CLOSED，是因为那个全局在
 * jsdom（单测）和 Node（SSR）里根本不存在，一引用就是 ReferenceError。
 * 依赖一个「浏览器里一定有」的全局，等于让这段代码只能在浏览器里跑——
 * 而它本该是能被测试的纯逻辑。
 */
const READY_STATE_CLOSED = 2

/**
 * 订阅一个 Thread 的事件流，返回取消订阅的函数。
 *
 * 关于断线重连：**这里一行重连代码都没有，是故意的。** 浏览器原生
 * EventSource 自带指数退避重连，且重连时会自动在请求头带上 Last-Event-ID
 * （值来自服务端写的 `id:` 行），后端 resolveFromSeq 读到它就从断点之后补发。
 * 自己写重连不仅多余，还会和浏览器的重连打架，产生两条连接。
 *
 * 我们唯一要保证的是**首连**带对起点——原生 EventSource 建连时无法自定义
 * 任何请求头，拿不到 Last-Event-ID，所以首连只能靠 URL 上的 ?from_seq=。
 */
export function subscribeThreadEvents(
  url: string,
  handlers: StreamHandlers,
  factory: EventSourceFactory = defaultFactory,
): () => void {
  const source = factory(url)
  handlers.onStatus('connecting')

  source.onopen = () => handlers.onStatus('open')

  source.onerror = () => {
    // EventSource 的 onerror 有两种含义，必须靠 readyState 区分：
    //   CONNECTING(0) —— 连接断了，浏览器正在自动重连，这是**正常**的瞬时状态
    //   CLOSED(2)     —— 彻底失败（比如 404），浏览器放弃了，不会再重连
    // 把前者当成错误展示会让用户在每次网络抖动时看到红色报错。
    handlers.onStatus(source.readyState === READY_STATE_CLOSED ? 'closed' : 'connecting')
  }

  // 后端每条消息都带显式的 `event:` 行，所以按事件名注册即可，
  // 不需要在 onmessage 里解析 payload 再 switch。
  // 注意：具名事件**不会**触发 onmessage，两者是互斥的。
  const listeners = EVENT_TYPES.map((type) => {
    const listener = (raw: MessageEvent<string>) => {
      let event: SessionEvent
      try {
        event = JSON.parse(raw.data) as SessionEvent
      } catch {
        // 单条事件解析失败不应当拖垮整条流。丢掉它，后续的 seq 缺口检测
        // 会发现窟窿并触发重新同步——这条路径已经为丢事件准备好了。
        return
      }
      handlers.onEvent(event)
    }
    source.addEventListener(type, listener as EventListener)
    return [type, listener] as const
  })

  return () => {
    for (const [type, listener] of listeners) {
      source.removeEventListener(type, listener as EventListener)
    }
    // close() 之后浏览器不会再重连。这一行是 StrictMode 下不产生
    // 双份连接的关键，也是组件卸载后不继续收事件的关键。
    source.close()
    handlers.onStatus('closed')
  }
}
