import { memo, useRef } from 'react'
import { useLiveSelector } from '@/store/liveThread/LiveThreadContext'
import { selectItem } from '@/store/liveThread/selectors'
import { AgentMessageCard } from './AgentMessageCard'
import { ReasoningCard } from './ReasoningCard'
import { CommandExecutionCard } from './CommandExecutionCard'
import type { Item } from '@/types/contract'

/**
 * 一张展示卡片。
 *
 * ## 这个组件是整套性能架构的落点
 *
 * 注意它接的是 **itemId 字符串**，然后自己去 store 里订阅，而不是由父组件
 * 把 Item 对象作为 prop 传下来。这个区别决定了流式输出时会重渲染多少组件：
 *
 *   传 Item 对象  →  item 一变，父组件必须重渲染才能传新 prop
 *                    → 父组件重渲染 → 它下面**所有**卡片跟着重渲染
 *                    → 139 次/秒 × N 张卡片
 *
 *   传 itemId     →  父组件订阅的是 turns 结构，delta 不改它，父组件不动
 *                    → 只有 selectItem(id) 返回值变了的那一张重渲染
 *                    → 139 次/秒 × 1 张卡片
 *
 * 这就是"选择性订阅"，代价是每张卡片多一次 useContext + Map.get（纳秒级）。
 *
 * memo 在这里是必需的而不是锦上添花：父组件因为别的原因重渲染时
 * （比如新增了一个 Step），memo 挡住 itemId 没变的卡片，它们连
 * selectItem 都不用重跑。
 */
export const ItemCard = memo(function ItemCard({ itemId }: { itemId: string }) {
  const item = useLiveSelector(selectItem(itemId))
  // 事件乱序或缺口时可能出现引用了但还没到的 Item。不渲染总比崩掉好。
  if (!item) return null
  return (
    <RenderCounter itemId={itemId}>
      <ItemBody item={item} />
    </RenderCounter>
  )
})

function ItemBody({ item }: { item: Item }) {
  switch (item.type) {
    case 'agent_message':
      return <AgentMessageCard item={item} />
    case 'reasoning':
      return <ReasoningCard item={item} />
    case 'command_execution':
      return <CommandExecutionCard item={item} />
    default:
      // 后端将来会加 file_change、todo_list、web_search。
      // 渲染一个诚实的占位而不是什么都不显示——静默丢弃会让人以为是 bug。
      return (
        <div className="rounded border border-line bg-surface px-3 py-2 text-xs text-ink-faint">
          暂不支持的展示单元类型：<span className="font-mono">{(item as Item).type}</span>
        </div>
      )
  }
}

/**
 * 开发模式下在卡片角上显示重渲染次数。
 *
 * 这不是调试残留，是给这套架构留的**可验证性**：跑一次流式输出就能亲眼看到
 * "只有正在流的那张卡片计数在涨，其余全部停在 1"。
 * 没有它，"选择性订阅生效了"就只是一句口头声明。
 *
 * import.meta.env.DEV 在生产构建时是编译期常量 false，
 * 整个分支会被 tree-shaking 掉，不占生产包体积。
 */
function RenderCounter({ itemId, children }: { itemId: string; children: React.ReactNode }) {
  const renders = useRef(0)
  if (!import.meta.env.DEV) return <>{children}</>
  renders.current += 1
  return (
    <div className="group relative">
      {children}
      <span
        title={`${itemId} 重渲染次数`}
        className="pointer-events-none absolute -top-1.5 -right-1.5 rounded bg-canvas px-1
                   font-mono text-[10px] text-ink-faint opacity-0 transition-opacity
                   group-hover:opacity-100"
      >
        ×{renders.current}
      </span>
    </div>
  )
}
