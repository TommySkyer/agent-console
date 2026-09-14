import { StrictMode, type ReactNode } from 'react'
import { renderHook, waitFor, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it } from 'vitest'
import { useThreadLive } from './useThreadLive'
import { ApiClientProvider } from '@/app/ApiClientContext'
import { ApiClient } from '@/api/client'
import { FakeEventSource, fakeEventSourceFactory } from '@/test/FakeEventSource'
import { loadRealSession } from '@/test/fixtures'
import type { Snapshot } from '@/types/contract'

const EMPTY_USAGE = {
  uncached_input_tokens: 0, cache_read_tokens: 0, output_tokens: 0,
  reasoning_tokens: 0, total_tokens: 0, model_calls: 0,
}

function snapshotWithLastSeq(lastSeq: number): Snapshot {
  return {
    meta: { id: 'th_1', workspace: '/tmp/ws', created_at: '2026-01-01T00:00:00Z' },
    status: 'idle',
    items: [],
    last_seq: lastSeq,
    usage: EMPTY_USAGE,
    context_window: 128000,
  }
}

/** 只替换 request，其余（eventsUrl）沿用真实实现，这样 URL 拼接也被测到。 */
function stubClient(snapshot: Snapshot, onRequest?: () => void): ApiClient {
  const client = new ApiClient('')
  client.request = (async () => {
    onRequest?.()
    return snapshot
  }) as ApiClient['request']
  return client
}

function wrapper(client: ApiClient, strict = false) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return function Wrapper({ children }: { children: ReactNode }) {
    const tree = (
      <QueryClientProvider client={queryClient}>
        <ApiClientProvider client={client}>{children}</ApiClientProvider>
      </QueryClientProvider>
    )
    return strict ? <StrictMode>{tree}</StrictMode> : tree
  }
}

describe('useThreadLive', () => {
  beforeEach(() => FakeEventSource.reset())

  it('订阅起点是 last_seq + 1', async () => {
    // 这条守的是前后端最容易错位的一处约定：后端 resolveFromSeq 里
    // ?from_seq=N 的语义是「我想要的第一个是 N」，而快照的 last_seq 是
    // 「我已经收到了 N」，所以 +1 必须由前端做。
    const client = stubClient(snapshotWithLastSeq(7))
    renderHook(() => useThreadLive('th_1', fakeEventSourceFactory), {
      wrapper: wrapper(client),
    })

    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0))
    expect(FakeEventSource.last.url).toContain('from_seq=8')
  })

  it('卸载时关闭连接（StrictMode 下不留双份）', async () => {
    // StrictMode 故意 mount → unmount → mount 来暴露没写清理函数的副作用。
    // 不清理的话这里会留下两条 SSE，且都在往同一个 store 灌事件——
    // 第二条的事件会因 seq 重复被 reducer 丢弃，表现为"偶尔丢字"，极难查。
    const client = stubClient(snapshotWithLastSeq(0))
    const { unmount } = renderHook(() => useThreadLive('th_1', fakeEventSourceFactory), {
      wrapper: wrapper(client, true),
    })

    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0))
    expect(FakeEventSource.openCount).toBe(1)

    unmount()
    expect(FakeEventSource.openCount).toBe(0)
  })

  it('收到的事件进入 store', async () => {
    const events = loadRealSession()
    const client = stubClient(snapshotWithLastSeq(0))
    const { result } = renderHook(() => useThreadLive('th_1', fakeEventSourceFactory), {
      wrapper: wrapper(client),
    })

    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0))

    act(() => {
      FakeEventSource.last.open()
      for (const event of events.slice(0, 16)) FakeEventSource.last.emit(event)
    })

    const state = result.current.store.getState()
    expect(state.lastSeq).toBe(16)
    expect(state.turns).toHaveLength(1)
    expect(state.turns[0]?.status).toBe('completed')
    expect(state.contextWindow).toBe(128000)
  })

  it('连接状态区分「正在重连」和「彻底失败」', async () => {
    // EventSource 的 onerror 有两种含义，只能靠 readyState 区分。
    // 把"浏览器正在自动重连"当成错误展示，会让用户在每次网络抖动时看到红框。
    const client = stubClient(snapshotWithLastSeq(0))
    const { result } = renderHook(() => useThreadLive('th_1', fakeEventSourceFactory), {
      wrapper: wrapper(client),
    })
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0))

    act(() => FakeEventSource.last.open())
    await waitFor(() => expect(result.current.streamStatus).toBe('open'))

    act(() => FakeEventSource.last.simulateReconnecting())
    await waitFor(() => expect(result.current.streamStatus).toBe('connecting'))

    act(() => FakeEventSource.last.simulateFatal())
    await waitFor(() => expect(result.current.streamStatus).toBe('closed'))
  })

  it('无法解析的消息不会打断整条流', async () => {
    const events = loadRealSession()
    const client = stubClient(snapshotWithLastSeq(0))
    const { result } = renderHook(() => useThreadLive('th_1', fakeEventSourceFactory), {
      wrapper: wrapper(client),
    })
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0))

    act(() => {
      FakeEventSource.last.emit(events[0]!)
      FakeEventSource.last.emitRaw('turn.started', '{ 这不是合法 JSON')
      FakeEventSource.last.emit(events[1]!)
    })

    // 坏消息被丢掉，好消息照常处理。
    expect(result.current.store.getState().lastSeq).toBe(2)
  })

  it('检测到 seq 缺口后重新拉快照', async () => {
    const events = loadRealSession()
    let requests = 0
    const client = stubClient(snapshotWithLastSeq(0), () => requests++)
    const { result } = renderHook(() => useThreadLive('th_1', fakeEventSourceFactory), {
      wrapper: wrapper(client),
    })
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0))
    expect(requests).toBe(1)

    act(() => {
      FakeEventSource.last.emit(events[0]!) // seq 1
      FakeEventSource.last.emit(events[9]!) // seq 10，跳号
    })

    expect(result.current.store.getState().desynced).toBe(true)
    // 缺口置位应当触发一次重新取快照（→ 重新播种 → 重新订阅）。
    await waitFor(() => expect(requests).toBe(2))
  })
})
