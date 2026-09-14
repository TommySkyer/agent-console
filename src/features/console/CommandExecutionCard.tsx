import { useEffect, useRef, useState } from 'react'
import type { Item } from '@/types/contract'
import { Badge, Disclosure, Spinner } from '@/components/primitives'
import { duration } from '@/lib/format'

/**
 * 一次命令执行。「工具调用详情」这条验收要求主要落在这张卡上。
 *
 * 它的生命周期被三类事件依次触碰：
 *   item.started              → 卡片出现，in_progress，exit_code 为 null
 *   item.delta(field=output)  → 往 aggregated_output 追加（**当前后端不发**，见下）
 *   item.completed            → 整体替换，此时才有 exit_code / duration / truncated
 *
 * 关于 delta：后端当前的 Environment 是一次性返回全部输出的，命令输出**不是
 * 流式的**，全部内容随 item.completed 一次到达。协议里留了 field=output 这个
 * 口子（session.FieldOutput），reducer 也实现了，但界面不能设计成"依赖输出
 * 边跑边滚"——现在做不到。所以 in_progress 期间显示的是命令行 + 转圈，
 * 而不是一个空的输出框。
 */
export function CommandExecutionCard({ item }: { item: Item }) {
  const command = item.command
  const [open, setOpen] = useState(false)
  if (!command) return null

  const running = item.status === 'in_progress'
  const hasOutput = command.aggregated_output.length > 0
  const lineCount = hasOutput ? command.aggregated_output.split('\n').length : 0

  return (
    <div className="rounded border border-line bg-surface">
      {/* 命令行：执行前就有了，所以用户立刻知道 Agent 在干什么，
          而不是等命令跑完才看到。后端为此专门设计了 Previewer 接口。 */}
      <div className="flex items-start gap-2 px-3 py-2">
        <span className="mt-0.5 shrink-0 font-mono text-xs text-ink-faint">$</span>
        <code className="min-w-0 flex-1 font-mono text-xs leading-relaxed break-all text-ink">
          {command.command}
        </code>
        <div className="flex shrink-0 items-center gap-1.5">
          <StatusBadge item={item} />
        </div>
      </div>

      {(hasOutput || running) && (
        <div className="border-t border-line px-3 py-2">
          {running && !hasOutput ? (
            <span className="flex items-center gap-1.5 text-[11px] text-ink-faint">
              <Spinner /> 执行中…
            </span>
          ) : (
            <Disclosure
              open={open}
              onToggle={() => setOpen(!open)}
              summary={
                <span className="text-[11px] text-ink-faint">
                  输出 {lineCount} 行
                  {command.truncated && <span className="ml-1.5 text-running">已截断</span>}
                </span>
              }
            >
              <OutputPane text={command.aggregated_output} live={running} />
            </Disclosure>
          )}
        </div>
      )}
    </div>
  )
}

function StatusBadge({ item }: { item: Item }) {
  const command = item.command!

  if (item.status === 'in_progress') {
    return <Badge tone="running">执行中</Badge>
  }
  // failed 是**工具基础设施故障**（进程起不来、超时被杀），不是"命令返回非零"。
  // 后端 CommandItem.Complete 的注释写得很明确：命令返回非零退出码是正常的
  // 观察结果，不算 failed。两者必须分开展示，否则会把"grep 没匹配到"
  // 这种正常情况渲染成系统错误。
  if (item.status === 'failed') {
    return (
      <Badge tone="danger">
        {command.timed_out ? '超时' : '执行失败'}
      </Badge>
    )
  }

  const code = command.exit_code
  return (
    <>
      {command.duration_ms ? (
        <span className="font-mono text-[11px] text-ink-faint">{duration(command.duration_ms)}</span>
      ) : null}
      {/* exit_code 为 null 表示"结束了但没拿到退出码"，和 0 是两回事，
          必须先判 null。用值类型的话前端根本区分不了，后端为此在 Go 侧
          用的是 *int 指针。 */}
      {code === null ? (
        <Badge tone="neutral">无退出码</Badge>
      ) : code === 0 ? (
        <Badge tone="success" mono>
          exit 0
        </Badge>
      ) : (
        <Badge tone="danger" mono>
          exit {code}
        </Badge>
      )}
    </>
  )
}

/**
 * 输出面板。
 *
 * 限高 + 自动滚到底：命令输出动辄上千行，全量展开会把页面撑爆，
 * 而用户真正关心的几乎总是最后几行（错误信息、结果）。
 */
function OutputPane({ text, live }: { text: string; live: boolean }) {
  const ref = useRef<HTMLPreElement>(null)

  useEffect(() => {
    // 只在流式期间自动贴底。命令结束后用户可能正在往回翻，
    // 这时再强行滚到底会把他刚找到的位置弄丢。
    if (live && ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [text, live])

  return (
    <pre
      ref={ref}
      className="max-h-64 overflow-auto rounded bg-canvas px-2.5 py-2 font-mono text-[11px]
                 leading-relaxed whitespace-pre-wrap break-all text-ink-muted"
    >
      {text}
    </pre>
  )
}
