import { useLiveSelector } from '@/store/liveThread/LiveThreadContext'
import {
  selectContextWindow,
  selectSessionTokens,
  selectTurnUsage,
} from '@/store/liveThread/selectors'
import { compactNumber, percent } from '@/lib/format'

/**
 * 「上下文窗口监控」。
 *
 * ## 分子用什么
 *
 * 上下文占用的分子是**这一次请求实际发给模型的 token 数**，也就是输入侧的
 * uncached + cache_read。不能用 total_tokens——那里面含 output，而输出不占
 * 下一次请求的输入上下文（它会作为历史的一部分在下一轮重新计入输入，
 * 但那是下一轮的事）。
 *
 * 后端把输入侧拆成 uncached / cache_read 两项而不是给一个总数，是为了能算出
 * 真实成本（命中缓存的 token 计价更低）。这里把两项都显示出来，顺带让
 * "Agent Loop 每轮重放全部历史，所以缓存命中率随对话变长而升高"这件事
 * 变得可观察。
 *
 * ## 分母可能是未知的
 *
 * context_window 在老版本后端只随 usage.updated 事件下发，快照里没有。
 * 那种情况下打开一个 idle 的历史会话，分母就是 0——此时不画进度条，
 * 只显示绝对值，而不是画一个分母是 0 的假进度条。
 */
export function UsagePanel() {
  const usage = useLiveSelector(selectTurnUsage)
  const contextWindow = useLiveSelector(selectContextWindow)
  const sessionTokens = useLiveSelector(selectSessionTokens)

  const inputTokens = usage ? usage.uncached_input_tokens + usage.cache_read_tokens : 0
  const known = contextWindow > 0
  const ratio = percent(inputTokens, contextWindow)

  return (
    <div className="border-t border-line px-4 py-3">
      <div className="mb-2 flex items-baseline justify-between">
        <span className="text-[11px] text-ink-muted">上下文占用</span>
        <span className="font-mono text-[11px] text-ink">
          {known ? (
            <>
              {compactNumber(inputTokens)}
              <span className="text-ink-faint"> / {compactNumber(contextWindow)}</span>
              <span className="ml-1.5 text-ink-muted">{ratio.toFixed(1)}%</span>
            </>
          ) : (
            <>
              {compactNumber(inputTokens)}
              <span className="ml-1.5 text-ink-faint">上限未知</span>
            </>
          )}
        </span>
      </div>

      {known ? (
        <div
          className="h-1.5 overflow-hidden rounded-full bg-line"
          role="progressbar"
          aria-valuenow={Math.round(ratio)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="上下文窗口占用"
        >
          <div
            // 超过 75% 转黄、90% 转红：上下文快满时 Agent 会开始失忆，
            // 这是一个需要用户注意的信号，而不只是一个数字。
            className={`h-full transition-[width] duration-300 ${
              ratio > 90 ? 'bg-danger' : ratio > 75 ? 'bg-running' : 'bg-accent'
            }`}
            style={{ width: `${ratio}%` }}
          />
        </div>
      ) : (
        <p className="text-[10px] text-ink-faint">发起一轮任务后可知（由 usage 事件下发）</p>
      )}

      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11px]">
        <Stat label="未命中缓存" value={usage?.uncached_input_tokens} mono />
        <Stat label="命中缓存" value={usage?.cache_read_tokens} mono />
        <Stat label="输出" value={usage?.output_tokens} mono />
        <Stat label="思考" value={usage?.reasoning_tokens} mono />
        <Stat label="本轮模型调用" value={usage?.model_calls} />
        {/* 跨轮总量由前端自己累加（后端 Snapshot.usage 在实时态和重放态
            语义不同，见 doc/backend-contract.md 缺口三），所以必须诚实标注
            它只统计本次会话期间，刷新就归零。 */}
        <Stat label="本次会话累计" value={sessionTokens} mono title="刷新页面后重新计数" />
      </dl>
    </div>
  )
}

function Stat({
  label,
  value,
  mono,
  title,
}: {
  label: string
  value: number | undefined
  mono?: boolean
  title?: string
}) {
  return (
    <div className="flex items-baseline justify-between gap-2" title={title}>
      <dt className="truncate text-ink-faint">{label}</dt>
      <dd className={`shrink-0 text-ink-muted ${mono ? 'font-mono' : ''}`}>
        {value === undefined ? '—' : compactNumber(value)}
      </dd>
    </div>
  )
}
