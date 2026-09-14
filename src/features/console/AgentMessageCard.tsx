import type { Item } from '@/types/contract'
import { LiveDot } from '@/components/primitives'

/**
 * 模型正文。流式输出时文本会持续增长。
 *
 * ## 为什么不渲染 Markdown
 *
 * 模型输出是**不可信输入**，绝不能走 dangerouslySetInnerHTML。上 Markdown
 * 需要引入渲染库并配一层 sanitize，而且流式场景还有个额外难题：半截语法
 * （`**加粗还没闭合`、代码块只开了三个反引号）每一帧都在变，渲染器会
 * 反复重排整棵树，既闪烁又慢。
 *
 * 所以这里用 whitespace-pre-wrap 保留换行和空格，安全、零依赖、
 * 流式下稳定。等确实需要富文本时，正确做法是"流式期间纯文本、
 * item.completed 之后再渲染 Markdown"，那是个独立的设计。
 */
export function AgentMessageCard({ item }: { item: Item }) {
  const streaming = item.status === 'in_progress'
  return (
    <div className="rounded border border-line bg-surface px-3 py-2.5">
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] text-ink-faint">
        {streaming ? <LiveDot tone="accent" /> : <span className="size-1.5 rounded-full bg-accent/40" />}
        回答
      </div>
      <div className="text-[13px] leading-relaxed whitespace-pre-wrap text-ink">
        {item.text}
        {/* 光标只在流式期间出现，让"还在打字"这件事不言自明 */}
        {streaming && <span className="ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 bg-accent animate-pulse-dot" />}
      </div>
    </div>
  )
}
