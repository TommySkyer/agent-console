import { useRef, useState } from 'react'
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
import { useSnapshot } from '@/store/queries'
import { useStickToBottom } from '@/hooks/useStickToBottom'
import { useLiveSelector } from '@/store/liveThread/LiveThreadContext'
import { selectLastSeq } from '@/store/liveThread/selectors'
import { basename } from '@/lib/format'

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
  const [tab, setTab] = useState<'timeline' | 'context'>('timeline')

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
              执行步骤
            </Tab>
            <Tab active={tab === 'context'} onClick={() => setTab('context')}>
              模型上下文
            </Tab>
          </nav>

          <ScrollArea active={tab === 'timeline'}>
            {tab === 'timeline' ? <StepTimeline /> : <ContextInspector />}
          </ScrollArea>

          <TurnComposer threadId={threadId} />
        </div>

        <aside className="flex w-64 shrink-0 flex-col border-l border-line bg-surface/30">
          <div className="px-4 py-3 text-[11px] text-ink-muted">运行指标</div>
          <UsagePanel />
        </aside>
      </div>
    </LiveThreadProvider>
  )
}

/**
 * 滚动容器。抽成组件是因为 useStickToBottom 需要订阅 lastSeq，
 * 而那必须在 LiveThreadProvider **内部**才能调用 —— 写在 ThreadConsolePage
 * 里会比 Provider 更早执行，useLiveSelector 会抛"必须在 Provider 内使用"。
 *
 * 这是 Context 最常见的一个使用陷阱：Provider 和 consumer 写在同一个组件里
 * 是不行的，必须隔一层组件边界。
 */
function ScrollArea({ active, children }: { active: boolean; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  // 用 lastSeq 当触发器：它每条事件都前进，正好等价于"内容可能变长了"，
  // 而且是个 number，引用天然稳定，不会让选择器出问题。
  const lastSeq = useLiveSelector(selectLastSeq)
  useStickToBottom(ref, lastSeq, active)

  return (
    <div ref={ref} className="min-h-0 flex-1 overflow-auto">
      {children}
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
