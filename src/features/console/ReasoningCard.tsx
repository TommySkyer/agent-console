import { useState } from 'react'
import type { Item } from '@/types/contract'
import { Disclosure, LiveDot } from '@/components/primitives'

/**
 * 模型的思考过程。
 *
 * 默认折叠：它通常比正文长好几倍，展开会把真正的答案挤到屏幕外。
 * 但流式期间自动展开——正在思考时把过程显示出来，正是这个面板的意义
 * （"展示 Agent 内部状态"而不只是最终输出）。
 *
 * 折叠状态是纯 UI 状态：不跨组件、不需要持久化、刷新后回到默认值就行。
 * 所以用 useState 而不是往全局 store 里塞。这是第三类状态的典型例子。
 */
export function ReasoningCard({ item }: { item: Item }) {
  const streaming = item.status === 'in_progress'
  const [manuallyOpened, setManuallyOpened] = useState<boolean | null>(null)
  // 用户没手动操作过就跟随流式状态；一旦手动点过就尊重用户的选择。
  const open = manuallyOpened ?? streaming

  return (
    <div className="rounded border border-reasoning/25 bg-reasoning/5 px-3 py-2">
      <Disclosure
        open={open}
        onToggle={() => setManuallyOpened(!open)}
        summary={
          <span className="flex items-center gap-1.5 text-[11px] text-reasoning">
            {streaming ? <LiveDot tone="reasoning" /> : null}
            思考过程
            <span className="text-ink-faint">{item.text?.length ?? 0} 字</span>
          </span>
        }
      >
        <div className="text-[12px] leading-relaxed whitespace-pre-wrap text-ink-muted">
          {item.text}
        </div>
      </Disclosure>
    </div>
  )
}
