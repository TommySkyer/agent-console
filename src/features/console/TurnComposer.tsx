import { useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { useLiveSelector } from '@/store/liveThread/LiveThreadContext'
import { selectStatus, selectTurnCount } from '@/store/liveThread/selectors'
import { useCancelTurn, useStartTurn } from '@/store/queries'
import { Button, Spinner } from '@/components/primitives'
import { ApiError } from '@/api/errors'
import { useToast } from '@/app/ToastContext'
import type { PendingTurn } from './ThreadConsolePage'

/**
 * 输入区：提交任务 / 取消任务。
 *
 * ## 按钮状态的权威是事件流，不是这次 HTTP 响应
 *
 * running 取自 store（由 turn.started / turn.completed 事件驱动），
 * 而不是 mutation.isPending。区别很重要：
 *
 *   POST /turns 返回 202 时 Turn 才刚被准入，一步都没跑。mutation 在拿到 202
 *   的那一刻就 isPending=false 了，但 Agent 还要跑几十秒。用 isPending 当
 *   "正在执行"，按钮会在任务刚开始时就变回可点击。
 *
 * 反过来，取消之后 Thread 要等 turn.failed(cancelled) 事件到达才真正回到
 * idle，中间这段时间按钮也应当保持禁用。只有跟着事件流走才两头都对。
 */
export function TurnComposer({ threadId, pendingTurn, onPendingChange }: {
  threadId: string
  pendingTurn: PendingTurn | null
  onPendingChange: (pending: PendingTurn | null) => void
}) {
  const status = useLiveSelector(selectStatus)
  const turnCount = useLiveSelector(selectTurnCount)
  const [input, setInput] = useState('')
  const nextNonce = useRef(0)
  const startTurn = useStartTurn(threadId)
  const cancelTurn = useCancelTurn(threadId)
  const toast = useToast()

  const running = status === 'running'
  const canSubmit = input.trim().length > 0 && !running && !pendingTurn && !startTurn.isPending

  function submit(event?: FormEvent) {
    event?.preventDefault()
    if (!canSubmit) return
    const text = input
    const nonce = ++nextNonce.current
    onPendingChange({ input: text, previousTurnCount: turnCount, accepted: false, nonce })
    // 乐观清空：提交失败时下面 onError 会把内容放回去。
    // 不这么做的话用户得自己删掉刚发出去的文字，很别扭。
    setInput('')
    startTurn.mutate(text, {
      onSuccess: () => {
        onPendingChange({ input: text, previousTurnCount: turnCount, accepted: true, nonce })
      },
      onError: (error) => {
        onPendingChange(null)
        setInput(text)
        if (error instanceof ApiError && error.shouldToast) toast.show(error.message, 'error')
      },
    })
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Cmd/Ctrl+Enter 提交，单独 Enter 换行。
    // 任务描述经常是多行的，把 Enter 直接绑成提交会让人频繁误发。
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submit()
  }

  return (
    <form onSubmit={submit} className="border-t border-line bg-surface/60 px-4 py-3">
      <div className="flex items-end gap-2">
        <textarea
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={onKeyDown}
          disabled={running}
          rows={2}
          placeholder={running ? 'Agent 正在执行…' : '描述一个任务，⌘/Ctrl + Enter 提交'}
          aria-label="任务输入"
          className="min-h-[3.25rem] flex-1 resize-y rounded border border-line-strong bg-canvas px-3 py-2
                     text-[13px] leading-relaxed text-ink placeholder:text-ink-faint
                     focus:border-accent/60 focus:outline-none disabled:opacity-50"
        />
        {running ? (
          <Button
            type="button"
            variant="danger"
            onClick={() => cancelTurn.mutate()}
            disabled={cancelTurn.isPending}
          >
            {cancelTurn.isPending ? <Spinner /> : null}
            取消
          </Button>
        ) : (
          <Button type="submit" variant="primary" disabled={!canSubmit}>
            {startTurn.isPending ? <Spinner /> : null}
            提交
          </Button>
        )}
      </div>
    </form>
  )
}
