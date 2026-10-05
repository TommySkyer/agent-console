import { act } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClient } from '@/api/client'
import { ApiError } from '@/api/errors'
import { ApiClientProvider } from '@/app/ApiClientContext'
import { FakeEventSource } from '@/test/FakeEventSource'
import type { SessionEvent, Snapshot } from '@/types/contract'
import { ThreadConsolePage } from './ThreadConsolePage'

const usage = {
  uncached_input_tokens: 0, cache_read_tokens: 0, output_tokens: 0,
  reasoning_tokens: 0, total_tokens: 0, model_calls: 0,
}

describe('ThreadConsolePage submission', () => {
  beforeEach(() => {
    FakeEventSource.reset()
    vi.stubGlobal('EventSource', FakeEventSource)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('后端没有上下文接口时显示可操作的原因', async () => {
    const snapshot: Snapshot = {
      meta: { id: 'th_1', workspace: '/tmp/ws', created_at: '2026-01-01T00:00:00Z' },
      status: 'idle', items: [], turns: [], last_seq: 0, usage,
    }
    const client = new ApiClient('')
    client.request = (async (path: string) => {
      if (path === '/api/threads/th_1') return snapshot
      if (path === '/api/threads/th_1/model-context') throw new ApiError('endpoint_not_found', 404, 'Not Found')
      throw new Error(`unexpected request: ${path}`)
    }) as ApiClient['request']

    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ApiClientProvider client={client}>
          <MemoryRouter initialEntries={['/threads/th_1']}>
            <Routes><Route path="/threads/:threadId" element={<ThreadConsolePage />} /></Routes>
          </MemoryRouter>
        </ApiClientProvider>
      </QueryClientProvider>,
    )

    fireEvent.click(await screen.findByRole('tab', { name: '模型上下文' }))
    expect(await screen.findByText('接口不存在；请重启后端服务以加载最新代码')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
  })

  it('提交后立即显示消息，SSE 未送达时无需刷新也能从快照恢复', async () => {
    const input = '检查这个项目'
    let resolvePost!: (value: { turn_id: string }) => void
    const post = new Promise<{ turn_id: string }>((resolve) => { resolvePost = resolve })
    let snapshotRequests = 0
    let snapshot: Snapshot = {
      meta: { id: 'th_1', workspace: '/tmp/ws', created_at: '2026-01-01T00:00:00Z' },
      status: 'idle', items: [], turns: [], last_seq: 1, usage,
    }
    const client = new ApiClient('')
    client.request = (async (path: string) => {
      if (path.endsWith('/turns')) return post
      if (path === '/api/threads/th_1') {
        snapshotRequests++
        return snapshot
      }
      throw new Error(`unexpected request: ${path}`)
    }) as ApiClient['request']

    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ApiClientProvider client={client}>
          <MemoryRouter initialEntries={['/threads/th_1']}>
            <Routes><Route path="/threads/:threadId" element={<ThreadConsolePage />} /></Routes>
          </MemoryRouter>
        </ApiClientProvider>
      </QueryClientProvider>,
    )

    const composer = await screen.findByRole('textbox', { name: '任务输入' })
    fireEvent.change(composer, { target: { value: input } })
    fireEvent.click(screen.getByRole('button', { name: '提交' }))

    expect(screen.getByText(input)).toBeInTheDocument()
    expect(screen.getByText('正在发送…')).toBeInTheDocument()

    snapshot = {
      ...snapshot,
      status: 'running',
      last_seq: 3,
      turns: [{ id: 'turn_1', input, status: 'running', started_at: '2026-01-01T00:00:01Z', usage }],
    }
    await act(async () => resolvePost({ turn_id: 'turn_1' }))
    expect(screen.getByText('已提交，正在同步…')).toBeInTheDocument()

    await waitFor(() => expect(snapshotRequests).toBeGreaterThan(1), { timeout: 3000 })
    await waitFor(() => expect(screen.queryByText('已提交，正在同步…')).not.toBeInTheDocument())
    expect(screen.getAllByText(input)).toHaveLength(1)
    expect(screen.getByText('执行中')).toBeInTheDocument()
  })

  it('刷新后从服务端读取完整的下一次模型请求基底', async () => {
    const snapshot: Snapshot = {
      meta: { id: 'th_1', workspace: '/tmp/ws', created_at: '2026-01-01T00:00:00Z' },
      status: 'idle', items: [], last_seq: 8, usage,
      turns: [{ id: 'turn_1', input: '问题', status: 'completed', started_at: '2026-01-01T00:00:01Z', usage }],
    }
    let answer = '完整答案'
    let contextStatus: 'idle' | 'running' = 'idle'
    let contextReads = 0
    const client = new ApiClient('')
    client.request = (async (path: string) => {
      if (path === '/api/threads/th_1') return snapshot
      if (path === '/api/threads/th_1/model-context') {
        contextReads++
        return {
        model: 'test-model', max_tokens: 1024, reasoning_effort: 'high',
        context_window: 1000, last_model_input_tokens: 90, last_cache_read_tokens: 60, status: contextStatus, last_seq: 8,
        messages: [
          { role: 'system', content: 'SYSTEM_CURRENT' },
          { role: 'user', content: '问题' },
          { role: 'assistant', content: answer },
        ],
        tools: [{ name: 'bash', description: '运行命令', parameters: { type: 'object' } }],
        history: [{ kind: 'summary', at: '2026-01-01T00:00:00Z', estimated_before: 700, estimated_after: 200, message_count: 2 }],
        }
      }
      if (path === '/api/threads/th_1/model-context/revisions/0') {
        return { kind: 'summary', at: '2026-01-01T00:00:00Z', estimated_before: 700, estimated_after: 200,
          before: [{ role: 'system', content: 'SYSTEM_OLD' }, { role: 'user', content: '旧任务' }] }
      }
      throw new Error(`unexpected request: ${path}`)
    }) as ApiClient['request']

    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ApiClientProvider client={client}>
          <MemoryRouter initialEntries={['/threads/th_1']}>
            <Routes><Route path="/threads/:threadId" element={<ThreadConsolePage />} /></Routes>
          </MemoryRouter>
        </ApiClientProvider>
      </QueryClientProvider>,
    )

    fireEvent.click(await screen.findByRole('tab', { name: '模型上下文' }))
    expect(await screen.findByText('SYSTEM_CURRENT')).toBeInTheDocument()
    expect(screen.getByText('完整答案')).toBeInTheDocument()
    expect(screen.getByText('bash')).toBeInTheDocument()
    expect(screen.getByText(/90 tokens/)).toBeInTheDocument()
    expect(screen.getByText(/其中缓存命中：60 tokens/)).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: '对话与执行' })).toBeInTheDocument()
    fireEvent.click(screen.getByText(/窗口 1 · 摘要压缩前/))
    const current = screen.getByText('SYSTEM_CURRENT')
    const old = await screen.findByText('SYSTEM_OLD')
    expect(current.compareDocumentPosition(old) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByText(/下一条用户输入会在提交时追加/)).toBeInTheDocument()

    const initialReads = contextReads
    contextStatus = 'running'
    act(() => {
      FakeEventSource.last.emit({
        seq: 9, thread_id: 'th_1', turn_id: 'turn_2', at: '2026-01-01T00:00:02Z',
        type: 'turn.started', payload: { input: '新问题' },
      } as SessionEvent)
    })
    await waitFor(() => expect(contextReads).toBeGreaterThan(initialReads))
    answer = '新的回答'
    contextStatus = 'idle'
    act(() => {
      FakeEventSource.last.emit({
        seq: 10, thread_id: 'th_1', turn_id: 'turn_2', at: '2026-01-01T00:00:03Z',
        type: 'turn.completed', payload: { usage, final_text: answer },
      } as SessionEvent)
    })
    expect(await screen.findByText('新的回答')).toBeInTheDocument()
  })
})
