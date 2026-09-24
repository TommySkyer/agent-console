import { useMemo, useState } from 'react'
import { useLiveSelector } from '@/store/liveThread/LiveThreadContext'
import { selectHistoryItems, selectTurns } from '@/store/liveThread/selectors'
import { ItemCard } from './ItemCard'
import { Badge, Disclosure, EmptyState, LiveDot } from '@/components/primitives'
import { TURN_FAILURE_CODES, type TurnFailureCode, type TurnView } from './types'
import { compactNumber, plainPreview } from '@/lib/format'
import type { LiveThreadState } from '@/store/liveThread/state'
import type { PendingTurn } from './ThreadConsolePage'

/**
 * 「执行步骤可视化」：把事件流还原成 Turn → Step → Item 的层次。
 *
 * ## 它订阅的是结构，不是内容
 *
 * selectTurns 返回 state.turns，而 reducer 保证一条 item.delta **不会**改动
 * 这棵树的引用（步骤里存的是 itemId 字符串，不是 Item 对象）。所以流式输出
 * 期间这个组件一次都不重渲染——重渲染的只有对应的那张 ItemCard。
 * apply.test.ts 里有一条测试专门守着它。
 */
export function StepTimeline({ pendingTurn = null }: {
  pendingTurn?: PendingTurn | null
}) {
  const turns = useLiveSelector(selectTurns)
  const historyItems = useLiveSelector(selectHistoryItems)
  const confirmed = pendingTurn !== null && turns
    .slice(pendingTurn.previousTurnCount)
    .some((turn) => turn.input === pendingTurn.input)

  const showPending = pendingTurn !== null && !confirmed

  if (turns.length === 0 && historyItems.length === 0 && !showPending) {
    return (
      <EmptyState
        title="还没有执行记录"
        hint="在下方输入任务，Agent 的每一步推理与命令执行都会实时出现在这里。"
      />
    )
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-7 px-5 py-5">
      {historyItems.length > 0 && <HistorySection itemIds={historyItems.map((i) => i.id)} />}
      {turns.map((turn, index) => (
        <TurnSection key={turn.id || index} turn={turn} index={index + 1} />
      ))}
      {showPending && (
        <div className="flex justify-end">
          <div className="flex max-w-[85%] flex-col items-end gap-1">
            <div className="rounded-2xl rounded-br-sm bg-accent/15 px-3.5 py-2.5 text-[13px] leading-relaxed whitespace-pre-wrap text-ink ring-1 ring-accent/25">
              {pendingTurn.input}
            </div>
            <span className="pr-1 text-[10px] text-ink-faint">
              {pendingTurn.accepted ? '已提交，正在同步…' : '正在发送…'}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

/** 快照里归不了组的 Item，只有连老版本后端时才非空。 */
function HistorySection({ itemIds }: { itemIds: string[] }) {
  const [open, setOpen] = useState(false)
  return (
    <section className="rounded border border-line bg-surface/40 px-3 py-2">
      <Disclosure
        open={open}
        onToggle={() => setOpen(!open)}
        summary={
          <span className="text-[11px] text-ink-faint">
            本次加载前的历史（{itemIds.length} 条，无步骤信息）
          </span>
        }
      >
        <div className="flex flex-col gap-2">
          {itemIds.map((id) => (
            <ItemCard key={id} itemId={id} />
          ))}
        </div>
      </Disclosure>
    </section>
  )
}

/**
 * 一轮对话：用户提问靠右，Agent 的过程与回答靠左。
 *
 * 左右分栏是聊天界面的通用语汇，用户不需要学 —— 一眼就知道哪句是自己说的。
 * 之前所有东西左对齐、只靠一个 #N 徽章区分，读起来像日志而不像对话。
 */
function TurnSection({ turn, index }: { turn: TurnView; index: number }) {
  return (
    <section>
      {/* ── 用户提问：靠右、实心气泡 ── */}
      <div className="mb-4 flex justify-end">
        <div className="flex max-w-[85%] flex-col items-end gap-1">
          <div className="rounded-2xl rounded-br-sm bg-accent/15 px-3.5 py-2.5 text-[13px] leading-relaxed whitespace-pre-wrap text-ink ring-1 ring-accent/25">
            {turn.input || <span className="text-ink-faint italic">历史轮次（快照未保留输入）</span>}
          </div>
          <div className="flex items-center gap-2 pr-1 text-[10px] text-ink-faint">
            <span>#{index}</span>
            <TurnMeta turn={turn} />
          </div>
        </div>
      </div>

      {/* ── Agent 侧：靠左 ── */}
      <div className="flex flex-col gap-2.5">
        {turn.steps.map((step, position) => (
          <StepBlock
            key={step.index}
            step={step}
            // 默认只展开每一轮的**最后一步**：那里是结论。
            // 中间步骤是「怎么得到结论的」，想看再点开 —— 否则一轮五步的任务
            // 会把屏幕铺满命令和中间话术，真正的答案被挤到看不见的地方。
            defaultOpen={position === turn.steps.length - 1}
          />
        ))}
        {turn.failure && <FailureNotice failure={turn.failure} />}
      </div>
    </section>
  )
}

/**
 * 一个 Step。折叠时把该步的正文当成摘要显示在标题行上。
 *
 * 摘要用的是这一步 agent_message 的正文（"I'll take a look at the current
 * directory..."）—— 那正是模型对这一步在做什么的自我说明，比我们自己编一句
 * "2 次工具调用" 要准确得多。
 */
function StepBlock({
  step,
  defaultOpen,
}: {
  step: TurnView['steps'][number]
  defaultOpen: boolean
}) {
  const [manual, setManual] = useState<boolean | null>(null)
  const open = manual ?? defaultOpen

  // 从 store 里取这一步的 agent_message 当摘要。
  // 用 useMemo + 组件内计算，不写进 selector —— selector 返回新对象会让
  // useSyncExternalStore 无限重渲染（见 selectors.ts 的文件头说明）。
  const ids = step.itemIds
  const summary = useLiveSelector(
    useMemo(
      () => (state: LiveThreadState) => {
        for (const id of ids) {
          const item = state.items.get(id)
          if (item?.type === 'agent_message' && item.text) return item.text
        }
        return ''
      },
      [ids],
    ),
  )
  const commandCount = useLiveSelector(
    useMemo(
      () => (state: LiveThreadState) =>
        ids.reduce((n, id) => n + (state.items.get(id)?.type === 'command_execution' ? 1 : 0), 0),
      [ids],
    ),
  )

  // 摘要要去掉 Markdown 语法：折叠行上出现「## 目录概览 | 项目 | 值 | --- |」
  // 比不给摘要还糟。展开之后完全不显示摘要 —— 完整正文就在下面两行，
  // 再放一份半透明的重复内容只是噪音。
  const preview = open ? '' : plainPreview(summary)

  return (
    <div>
      <button
        type="button"
        onClick={() => setManual(!open)}
        aria-expanded={open}
        className="group flex w-full items-start gap-2 rounded px-1 py-1 text-left hover:bg-surface/50"
      >
        <svg
          className={`mt-1 size-3 shrink-0 text-ink-faint transition-transform ${open ? 'rotate-90' : ''}`}
          viewBox="0 0 12 12"
          fill="currentColor"
        >
          <path d="M4 2.5 8 6l-4 3.5z" />
        </svg>
        <span className="mt-0.5 shrink-0 font-mono text-[10px] text-ink-faint">Step {step.index}</span>
        <span className="min-w-0 flex-1 text-[12px] leading-relaxed text-ink-muted">
          {open ? null : preview ? (
            <span className="line-clamp-2">{preview}</span>
          ) : ids.length === 0 ? (
            <span className="text-ink-faint">等待模型响应…</span>
          ) : (
            <span className="text-ink-faint">{commandCount > 0 ? '执行了工具调用' : '思考中'}</span>
          )}
        </span>
        {commandCount > 0 && !open && (
          <span className="mt-0.5 shrink-0 rounded bg-surface-raised px-1.5 py-0.5 text-[10px] text-ink-faint">
            {commandCount} 次调用
          </span>
        )}
      </button>

      {open && (
        <div className="mt-1.5 flex flex-col gap-2 pl-6">
          {ids.map((id) => (
            <ItemCard key={id} itemId={id} />
          ))}
        </div>
      )}
    </div>
  )
}

function TurnMeta({ turn }: { turn: TurnView }) {
  if (turn.status === 'running') {
    return (
      <Badge tone="running">
        <LiveDot /> 执行中
      </Badge>
    )
  }
  if (turn.status === 'failed') {
    const code = turn.failure?.code as TurnFailureCode | undefined
    // cancelled 不按错误渲染：那是用户自己按的取消按钮。
    return (
      <Badge tone={code === 'cancelled' ? 'neutral' : 'danger'}>
        {code ? (TURN_FAILURE_CODES[code] ?? code) : '失败'}
      </Badge>
    )
  }
  return turn.usage ? (
    <span className="font-mono">
      {compactNumber(turn.usage.total_tokens)} tok · {turn.usage.model_calls} 步
    </span>
  ) : null
}

function FailureNotice({ failure }: { failure: { code: string; message: string } }) {
  const cancelled = failure.code === 'cancelled'
  return (
    <div
      className={`rounded-lg border px-3 py-2 text-[12px] ${
        cancelled ? 'border-line bg-surface text-ink-muted' : 'border-danger/30 bg-danger/5 text-danger'
      }`}
    >
      <div className="font-medium">
        {TURN_FAILURE_CODES[failure.code as TurnFailureCode] ?? failure.code}
      </div>
      {/* 原始 message 只作为次要信息，分支判断一律依据 code。 */}
      {!cancelled && failure.message && (
        <div className="mt-1 font-mono text-[11px] break-all opacity-70">{failure.message}</div>
      )}
    </div>
  )
}
