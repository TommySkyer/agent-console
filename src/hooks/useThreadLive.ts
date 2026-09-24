import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useApiClient } from '@/app/ApiClientContext'
import { queryKeys, useSnapshot } from '@/store/queries'
import { subscribeThreadEvents, type EventSourceFactory, type StreamStatus } from '@/realtime/eventStream'
import { LiveThreadStore } from '@/store/liveThread/store'
import { seedFromSnapshot } from '@/store/liveThread/state'
import { useLiveThread } from '@/store/liveThread/useLiveThread'

/**
 * 编排层：把 api / realtime / store 三层缝起来。
 *
 * 这三层互相不认识——api 不知道有 store，store 不知道事件从哪来，
 * realtime 不知道事件意味着什么。它们的接缝**只在这个 Hook 里**。
 * 换传输方式或换状态库时，要改的也只有这一个文件。
 *
 * 流程：
 *   ①  React Query 拉 GET /threads/{id}          → snapshot
 *   ②  用 snapshot 给 store 播种，记下 last_seq
 *   ③  EventSource 订阅 ?from_seq=last_seq+1
 *   ④  每条事件 → store.dispatch → applyEvent
 *   ⑤  desynced 置位 → 让快照失效 → 回到 ①
 *   ⑥  卸载 → 关闭 EventSource
 */
export interface ThreadLive {
  store: LiveThreadStore
  streamStatus: StreamStatus
  isLoading: boolean
  error: unknown
}

export function useThreadLive(
  threadId: string,
  // 测试注入点：真实 EventSource 只能靠网络驱动，没法在单测里模拟
  // "收到第 3 条事件后断线" 这种时序。
  eventSourceFactory?: EventSourceFactory,
): ThreadLive {
  const client = useApiClient()
  const queryClient = useQueryClient()
  const snapshot = useSnapshot(threadId)
  const [streamStatus, setStreamStatus] = useState<StreamStatus>('connecting')

  // ── store 实例的生命周期 ──
  //
  // 用 ref + 渲染期比较，而不是 useMemo：useMemo 在 React 的契约里是**性能提示**，
  // 允许被丢弃重算。丢一个缓存的计算结果无所谓，丢一个正在被订阅的 store
  // 会让已经收到的事件凭空消失。
  //
  // 渲染期创建对象是安全的（没有副作用，可重入）。另一个同样正确的做法是
  // 在路由层给页面组件加 key={threadId} 强制重新挂载，但那把这里的正确性
  // 依赖放到了一个很远的地方，不如自己管住。
  const storeRef = useRef<{ id: string; store: LiveThreadStore } | null>(null)
  if (!storeRef.current || storeRef.current.id !== threadId) {
    storeRef.current = { id: threadId, store: new LiveThreadStore(threadId) }
  }
  const store = storeRef.current.store

  const data = snapshot.data

  // ── 播种 + 订阅 ──
  useEffect(() => {
    if (!data) return

    // 顺序不能反：先播种再订阅。
    // 先订阅后播种的话，两者之间到达的事件会被 reset 冲掉；
    // 播种后订阅不带起点的话，中间的事件直接丢。
    store.reset(seedFromSnapshot(data))

    // +1 在前端做。后端 resolveFromSeq 里两个入口语义不同：
    //   Last-Event-ID: N  →  从 N+1 开始（「我已经收到了 N」）
    //   ?from_seq=N       →  从 N   开始（「我想要的第一个是 N」）
    // 快照的 last_seq 是"已经收到了"，所以传 last_seq + 1。
    const url = client.eventsUrl(threadId, data.last_seq + 1)

    // 返回的清理函数会 close() 掉连接。这不是可选项：
    // StrictMode 下开发模式会 mount → unmount → mount，不清理就留下两条 SSE，
    // 且两条都在往同一个 store 灌事件。第二条的事件会因 seq 重复被 reducer
    // 丢弃，于是表现为"偶尔丢字"而不是明显报错——很难查。
    return subscribeThreadEvents(
      url,
      { onEvent: store.dispatch, onStatus: setStreamStatus },
      eventSourceFactory,
    )
  }, [store, data, client, threadId, eventSourceFactory])

  // ── 缺口恢复 ──
  //
  // reducer 检测到 seq 跳号（后端丢事件或断线超出 2048 条补发缓冲）就置
  // desynced。追不回来，唯一正确的反应是整个重新同步：让快照失效 → Query
  // 重取 → data 变成新对象 → 上面那个 effect 重跑 → 重新播种 + 重新订阅。
  const desynced = useLiveThread(store, (s) => s.desynced)
  useEffect(() => {
    if (!desynced) return
    void queryClient.invalidateQueries({ queryKey: queryKeys.snapshot(threadId) })
  }, [desynced, queryClient, threadId])

  return {
    store,
    streamStatus,
    isLoading: snapshot.isLoading,
    // 恢复快照的请求失败时保留已播种的页面，不能让一次网络抖动清空时间线。
    error: snapshot.data ? null : snapshot.error,
  }
}
