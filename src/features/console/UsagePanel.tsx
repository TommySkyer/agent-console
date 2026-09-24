import { useLiveSelector } from '@/store/liveThread/LiveThreadContext'
import {
  selectContextWindow,
  selectSessionTokens,
  selectTurnUsage,
} from '@/store/liveThread/selectors'
import { compactNumber } from '@/lib/format'

/** 本轮累计用量；单次模型请求的上下文占用在「模型上下文」页展示。 */
export function UsagePanel() {
  const usage = useLiveSelector(selectTurnUsage)
  const contextWindow = useLiveSelector(selectContextWindow)
  const sessionTokens = useLiveSelector(selectSessionTokens)

  const inputTokens = usage ? usage.uncached_input_tokens + usage.cache_read_tokens : 0
  return (
    <div className="border-t border-line px-4 py-3">
      <div className="mb-2 flex items-baseline justify-between">
        <span className="text-[11px] text-ink-muted">本轮累计输入</span>
        <span className="font-mono text-[11px] text-ink">
          {usage ? compactNumber(inputTokens) : '—'}
        </span>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11px]">
        <Stat label="未命中缓存" value={usage?.uncached_input_tokens} mono />
        <Stat label="命中缓存" value={usage?.cache_read_tokens} mono />
        <Stat label="输出" value={usage?.output_tokens} mono />
        <Stat label="思考" value={usage?.reasoning_tokens} mono />
        <Stat label="本轮模型调用" value={usage?.model_calls} />
        <Stat label="窗口上限" value={contextWindow || undefined} mono />
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
