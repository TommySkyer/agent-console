import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useParams, useNavigate } from 'react-router-dom'
import { useThreadLive } from '@/hooks/useThreadLive'
import { LiveThreadProvider } from '@/store/liveThread/LiveThreadContext'
import { StepTimeline } from './StepTimeline'
import { ContextInspector } from './ContextInspector'
import { UsagePanel } from './UsagePanel'
import { TurnComposer } from './TurnComposer'
import { ConnectionBadge } from './ConnectionBadge'
import { Button, EmptyState, Spinner } from '@/components/primitives'
import { ApiError } from '@/api/errors'
import { queryKeys, useSnapshot } from '@/store/queries'
import { useStickToBottom } from '@/hooks/useStickToBottom'
import { useLiveSelector } from '@/store/liveThread/LiveThreadContext'
import { selectLastSeq, selectTurnCount, selectTurns } from '@/store/liveThread/selectors'
import { basename } from '@/lib/format'

export interface PendingTurn {
  input: string
  previousTurnCount: number
  accepted: boolean
  nonce: number
}

/**
 * 核心页面：一个会话的执行可视化面板。
 *
 * 这是**容器组件**——它负责取数据、处理副作用、决定布局；下面的展示组件
 * （StepTimeline、UsagePanel…）只从 store 订阅自己关心的那一小块，
 * 不发请求、不处理路由。这条分工让展示组件可以脱离真实后端测试。
 */
export function ThreadConsolePage() {
  const { threadId = '' } = useParams()
  const navigate = useNavigate()
  const { store, streamStatus, isLoading, error } = useThreadLive(threadId)
  const snapshot = useSnapshot(threadId)
  const queryClient = useQueryClient()
  const [tab, setTab] = useState<'timeline' | 'context'>('timeline')
  const [pendingTurn, setPendingTurn] = useState<PendingTurn | null>(null)

  // SSE 断开或迟迟未恢复时，POST 成功后仍要让页面自己追上服务端状态。
  useEffect(() => {
    if (!pendingTurn?.accepted) return
    const timer = window.setInterval(() => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.snapshot(threadId) })
    }, 1500)
    return () => window.clearInterval(timer)
  }, [pendingTurn?.accepted, pendingTurn?.nonce, queryClient, threadId])

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="text-ink-faint" />
      </div>
    )
  }

  if (error) {
    const notFound = error instanceof ApiError && error.code === 'thread_not_found'
    return (
      <EmptyState
        title={error instanceof ApiError ? error.message : '加载失败'}
        hint={
          notFound ? (
            <Button onClick={() => navigate('/')} className="mt-2">
              返回会话列表
            </Button>
          ) : undefined
        }
      />
    )
  }

  const meta = snapshot.data?.meta

  return (
    // Provider 里放的是 store 的**引用**（一个 Thread 的生命周期内不变），
    // 不是 store 里的状态。所以它不会因为 139 次/秒的事件而让全树重渲染。
    // 组件订阅状态走的是 useSyncExternalStore 的选择性订阅路径。
    <LiveThreadProvider store={store}>
      <PendingTurnObserver pendingTurn={pendingTurn} onConfirmed={() => setPendingTurn(null)} />
      <div className="flex h-full min-w-0">
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex shrink-0 items-center gap-3 border-b border-line px-5 py-3">
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-sm text-ink">
                {meta?.title || `会话 ${threadId.slice(0, 12)}`}
              </h1>
              <p
                className="truncate font-mono text-[11px] text-ink-faint"
                title={meta?.workspace}
              >
                {meta ? basename(meta.workspace) : ''}
              </p>
            </div>
            <ConnectionBadge status={streamStatus} />
          </header>

          {/* 快照落盘失败意味着这份历史有缺口，重启后恢复出来的会话是残缺的。
              后端把它放进 Snapshot 而不是只记日志，正是因为这直接影响
              用户能不能信任眼前这份历史——所以前端必须显示出来。 */}
          {snapshot.data?.persist_error && (
            <div className="shrink-0 border-b border-danger/30 bg-danger/5 px-5 py-2 text-[11px] text-danger">
              事件日志写入失败，这份历史可能不完整：{snapshot.data.persist_error}
            </div>
          )}

          <nav className="flex shrink-0 gap-1 border-b border-line px-4" role="tablist">
            <Tab active={tab === 'timeline'} onClick={() => setTab('timeline')}>
              对话与执行
            </Tab>
            <Tab active={tab === 'context'} onClick={() => setTab('context')}>
              模型上下文
            </Tab>
          </nav>

          <ScrollArea active={tab === 'timeline'} pendingNonce={pendingTurn?.nonce}>
            {tab === 'timeline' ? (
              <StepTimeline pendingTurn={pendingTurn} />
            ) : <ContextInspector threadId={threadId} />}
          </ScrollArea>

          <TurnComposer
            threadId={threadId}
            pendingTurn={pendingTurn}
            onPendingChange={(pending) => {
              setPendingTurn(pending)
              if (pending && !pending.accepted) setTab('timeline')
            }}
          />
        </div>

        <aside className="flex w-64 shrink-0 flex-col border-l border-line bg-surface/30">
          <div className="px-4 py-3 text-[11px] text-ink-muted">运行指标</div>
          <UsagePanel />
        </aside>
      </div>
    </LiveThreadProvider>
  )
}

function PendingTurnObserver({ pendingTurn, onConfirmed }: {
  pendingTurn: PendingTurn | null
  onConfirmed: () => void
}) {
  const turns = useLiveSelector(selectTurns)
  useEffect(() => {
    if (!pendingTurn?.accepted) return
    if (turns.slice(pendingTurn.previousTurnCount).some((turn) => turn.input === pendingTurn.input)) {
      onConfirmed()
    }
  }, [pendingTurn, turns, onConfirmed])
  return null
}

/**
 * 滚动容器。抽成组件是因为 useStickToBottom 需要订阅 lastSeq，
 * 而那必须在 LiveThreadProvider **内部**才能调用 —— 写在 ThreadConsolePage
 * 里会比 Provider 更早执行，useLiveSelector 会抛"必须在 Provider 内使用"。
 *
 * 这是 Context 最常见的一个使用陷阱：Provider 和 consumer 写在同一个组件里
 * 是不行的，必须隔一层组件边界。
 */
function ScrollArea({ active, pendingNonce, children }: { active: boolean; pendingNonce?: number; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  // follow 用 lastSeq：每条事件都前进，正好等价于"内容可能变长了"。
  // jump 用轮次数和本地提交序号：消息刚提交就滚到底，不用等 turn.started。
  //
  // 已知的不精确：turns.length 是"用户提交了"的**代理信号**，不是那件事本身。
  // 另一个标签页或 API 客户端往同一个会话发起的轮次同样会让它加一，
  // 于是这边也会被强制滚到底。要做精确需要从 TurnComposer 往下传一个显式信号，
  // 那会在两个本来互不认识的组件之间拉一条线。单用户的本地工具里这个代价
  // 不值得 —— 但它是个真实的泄漏，写在这里免得以后有人以为它是精确的。
  //
  // 两个 selector 都返回 number，引用天然稳定，不会让选择器出问题。
  const lastSeq = useLiveSelector(selectLastSeq)
  const turnCount = useLiveSelector(selectTurnCount)
  const { hasNewBelow, scrollToBottom } = useStickToBottom(ref, lastSeq, `${turnCount}:${pendingNonce ?? ''}`, active)

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={ref} className="h-full overflow-auto">
        {children}
      </div>
      {/* 用户翻到上面时，别让新内容默默堆在看不见的地方。 */}
      {active && hasNewBelow && (
        <button
          type="button"
          onClick={scrollToBottom}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full border border-line-strong
                     bg-surface-raised px-3 py-1.5 text-[11px] text-ink shadow-lg hover:bg-surface"
        >
          有新内容 ↓
        </button>
      )}
    </div>
  )
}

function Tab({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`border-b-2 px-3 py-2 text-[12px] transition-colors ${
        active
          ? 'border-accent text-ink'
          : 'border-transparent text-ink-faint hover:text-ink-muted'
      }`}
    >
      {children}
    </button>
  )
}
