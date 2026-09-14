import { Suspense, lazy } from 'react'
import type { Item } from '@/types/contract'
import { LiveDot } from '@/components/primitives'

/**
 * Markdown 渲染器按需加载。
 *
 * 它（react-markdown + remark-gfm）压缩后约 48 KB，占整个首屏包的三分之一，
 * 但**首屏根本用不到**：进页面时要么还没有消息，要么消息还在流式输出
 * （流式期间走纯文本，见下）。真正需要它的时刻是第一条消息 completed，
 * 那时再加载完全来得及。
 *
 * fallback 用纯文本版本而不是转圈：内容本来就有，只是还没排版。
 * 给用户看一个 spinner 反而是退步 —— 他会觉得"东西没了"。
 */
const Markdown = lazy(() =>
  import('@/components/Markdown').then((module) => ({ default: module.Markdown })),
)

/**
 * 模型正文。
 *
 * ## 流式期间纯文本，结束之后 Markdown
 *
 * 这不是偷懒，是两种状态确实需要不同的渲染方式：
 *
 *   流式期间：半截语法每帧都在变（`**加粗` 还没闭合、代码块只开了三个反引号），
 *             Markdown 渲染器会反复重排整棵树 —— 既闪烁又慢，而且中间态经常
 *             把后面的正文全部吃进一个未闭合的代码块里，看起来像乱码。
 *   结束之后：语法完整，渲染一次，稳定。
 *
 * 判据就是 item.status —— 后端在 item.completed 时给出完整快照，
 * 那一刻正是可以安全渲染的时刻。切换只发生一次，不会闪。
 */
export function AgentMessageCard({ item }: { item: Item }) {
  const streaming = item.status === 'in_progress'
  const text = item.text ?? ''

  return (
    <div className="rounded-lg border border-line bg-surface px-3.5 py-3">
      <div className="mb-2 flex items-center gap-1.5 text-[11px] text-ink-faint">
        {streaming ? <LiveDot tone="accent" /> : <span className="size-1.5 rounded-full bg-accent/40" />}
        回答
      </div>

      {streaming ? (
        <PlainText text={text} cursor />
      ) : (
        <Suspense fallback={<PlainText text={text} />}>
          <Markdown>{text}</Markdown>
        </Suspense>
      )}
    </div>
  )
}

function PlainText({ text, cursor = false }: { text: string; cursor?: boolean }) {
  return (
    <div className="text-[13px] leading-relaxed whitespace-pre-wrap text-ink">
      {text}
      {/* 光标只在流式期间出现，让「还在打字」这件事不言自明 */}
      {cursor && <span className="ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 bg-accent animate-pulse-dot" />}
    </div>
  )
}
