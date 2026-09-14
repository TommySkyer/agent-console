import { useState } from 'react'
import { useLiveSelector } from '@/store/liveThread/LiveThreadContext'
import { selectHistoryItems, selectTurns } from '@/store/liveThread/selectors'
import { ItemCard } from './ItemCard'
import { Badge, Disclosure, EmptyState, LiveDot } from '@/components/primitives'
import { TURN_FAILURE_CODES, type TurnFailureCode, type TurnView } from './types'
import { compactNumber } from '@/lib/format'

/**
 * 「执行步骤可视化」：把事件流还原成 Turn → Step → Item 的层次。
 *
 * ## 它订阅的是结构，不是内容
 *
 * selectTurns 返回 state.turns，而 reducer 保证一条 item.delta **不会**改动
 * 这棵树的引用（步骤里存的是 itemId 字符串，不是 Item 对象）。所以流式输出
 * 期间这个组件一次都不重渲染——重渲染的只有对应的那张 ItemCard。
 *
 * 这不是巧合，是状态形状设计出来的结果。src/store/liveThread/state.ts 有完整说明，
 * apply.test.ts 里有一条测试专门守着它（"流式过程中 turns 引用保持不变"）。
 */
export function StepTimeline() {
  const turns = useLiveSelector(selectTurns)
  const historyItems = useLiveSelector(selectHistoryItems)

  if (turns.length === 0 && historyItems.length === 0) {
    return (
      <EmptyState
        title="还没有执行记录"
        hint="在下方输入任务，Agent 的每一步推理与命令执行都会实时出现在这里。"
      />
    )
  }

  return (
    <div className="flex flex-col gap-6 px-5 py-4">
      {historyItems.length > 0 && <HistorySection itemIds={historyItems.map((i) => i.id)} />}
      {turns.map((turn, index) => (
        <TurnSection key={turn.id || index} turn={turn} index={index + 1} />
      ))}
    </div>
  )
}

/**
 * 快照带来的、无法归组的历史。
 *
 * 只有连的是**老版本后端**（Item 不带 turn_id/step）时才会非空。新版后端
 * 的快照能还原完整层次，这一段就不出现。保留它是为了前端不绑死在某个
 * 后端版本上——两边独立部署时，前端先上线的窗口期里不能白屏。
 */
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

function TurnSection({ turn, index }: { turn: TurnView; index: number }) {
  return (
    <section>
      {/* 用户这一轮的输入 */}
      <div className="mb-3 flex items-start gap-2.5">
        <span className="mt-0.5 shrink-0 rounded bg-surface-raised px-1.5 py-0.5 font-mono text-[10px] text-ink-faint">
          #{index}
        </span>
        <p className="min-w-0 flex-1 text-[13px] leading-relaxed whitespace-pre-wrap text-ink">
          {turn.input || <span className="text-ink-faint italic">历史轮次（快照未保留输入）</span>}
        </p>
        <TurnStatus turn={turn} />
      </div>

      <div className="ml-2 flex flex-col gap-4 border-l border-line pl-4">
        {turn.steps.map((step) => (
          <div key={step.index}>
            <div className="mb-2 flex items-center gap-2">
              {/* Step 标记。后端每次模型调用前发一条 step.started，
                  所以"第几步"等于"第几次模型调用"。 */}
              <span className="-ml-[25px] flex size-4 items-center justify-center rounded-full border border-line-strong bg-canvas font-mono text-[9px] text-ink-faint">
                {step.index}
              </span>
              <span className="text-[11px] text-ink-faint">
                Step {step.index}
                <span className="ml-1.5 text-ink-faint/60">
                  {step.itemIds.length === 0 ? '等待模型响应…' : ''}
                </span>
              </span>
            </div>
            <div className="flex flex-col gap-2">
              {step.itemIds.map((id) => (
                <ItemCard key={id} itemId={id} />
              ))}
            </div>
          </div>
        ))}

        {turn.failure && <FailureNotice failure={turn.failure} />}
      </div>
    </section>
  )
}

function TurnStatus({ turn }: { turn: TurnView }) {
  if (turn.status === 'running') {
    return (
      <Badge tone="running">
        <LiveDot /> 执行中
      </Badge>
    )
  }
  if (turn.status === 'failed') {
    const code = turn.failure?.code as TurnFailureCode | undefined
    // cancelled 不按错误渲染：那是用户自己按的取消按钮，
    // 用红色报错框吓唬人不合适。
    const tone = code === 'cancelled' ? 'neutral' : 'danger'
    return <Badge tone={tone}>{code ? TURN_FAILURE_CODES[code] ?? code : '失败'}</Badge>
  }
  return (
    <span className="shrink-0 font-mono text-[11px] text-ink-faint">
      {turn.usage ? `${compactNumber(turn.usage.total_tokens)} tok · ${turn.usage.model_calls} 步` : ''}
    </span>
  )
}

function FailureNotice({ failure }: { failure: { code: string; message: string } }) {
  const cancelled = failure.code === 'cancelled'
  return (
    <div
      className={`rounded border px-3 py-2 text-[12px] ${
        cancelled ? 'border-line bg-surface text-ink-muted' : 'border-danger/30 bg-danger/5 text-danger'
      }`}
    >
      <div className="font-medium">
        {TURN_FAILURE_CODES[failure.code as TurnFailureCode] ?? failure.code}
      </div>
      {/* 原始 message 只作为次要信息展示，前端的分支判断一律依据 code。
          后端注释明确说了错误文本随时会为排查方便而改写，原因码不会。 */}
      {!cancelled && failure.message && (
        <div className="mt-1 font-mono text-[11px] break-all opacity-70">{failure.message}</div>
      )}
    </div>
  )
}
