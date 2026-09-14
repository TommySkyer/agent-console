import { useLiveSelector } from '@/store/liveThread/LiveThreadContext'
import { selectDesynced, selectLastSeq } from '@/store/liveThread/selectors'
import { Badge, LiveDot } from '@/components/primitives'
import type { StreamStatus } from '@/realtime/eventStream'

/**
 * SSE 连接状态。
 *
 * 三种状态对应的用户心智完全不同，不能混成一个"在线/离线"：
 *
 *   open        事件正常推送
 *   connecting  浏览器正在自动重连。**这是正常的瞬时状态**，不是错误——
 *               EventSource 自带指数退避重连，重连时会带 Last-Event-ID，
 *               服务端从断点续发，用户什么都不会丢。用红色报错渲染它
 *               会让人在每次网络抖动时以为出事了。
 *   closed      浏览器放弃了（比如 404、会话被删），需要用户介入
 *
 * desynced 是另一码事：连接可能好好的，但中间丢了事件（后端队列满时会
 * 丢弃慢消费者的事件，或断线超出了 2048 条的补发缓冲）。此时本地状态
 * 已经不可信，正在重新拉快照。
 */
export function ConnectionBadge({ status }: { status: StreamStatus }) {
  const desynced = useLiveSelector(selectDesynced)
  const lastSeq = useLiveSelector(selectLastSeq)

  if (desynced) {
    return (
      <Badge tone="running">
        <LiveDot /> 重新同步中
      </Badge>
    )
  }

  return (
    <span className="flex items-center gap-2">
      {status === 'open' && (
        <Badge tone="success">
          <span className="size-1.5 rounded-full bg-success" /> 已连接
        </Badge>
      )}
      {status === 'connecting' && (
        <Badge tone="running">
          <LiveDot /> 连接中
        </Badge>
      )}
      {status === 'closed' && <Badge tone="danger">连接已断开</Badge>}
      {/* 暴露 seq 是给排查用的：它能直接回答"前端到底收到第几条事件了"，
          和后端日志里的 seq 一对就知道是谁的问题。 */}
      <span className="font-mono text-[10px] text-ink-faint" title="已消费的事件序号">
        seq {lastSeq}
      </span>
    </span>
  )
}
