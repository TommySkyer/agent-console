import { useMemo, useState } from 'react'
import { useLiveSelector } from '@/store/liveThread/LiveThreadContext'
import { selectMessages } from '@/store/liveThread/selectors'
import { Badge, Disclosure, EmptyState } from '@/components/primitives'
import type { Message } from '@/types/contract'

/**
 * 模型上下文检查器：把**模型真正看到的东西**画出来。
 *
 * ## 它和时间线是两套投影，不是同一份数据的两种样子
 *
 *   时间线（Item）    给人看的展示单元。一次 bash 调用是**一张卡片**。
 *   这里（Message）   给模型看的历史。同一次 bash 调用是**两条消息**——
 *                     一条带 tool_calls 的 assistant，加一条 tool 结果。
 *
 * 后端为此发两套事件（item.* 和 message.appended），理由是
 * "Model-visible means logged"：凡是能进模型请求的东西都必须能从日志重建，
 * 否则会话跨重启就会失忆。前端把这两套都画出来，是这个面板区别于
 * 普通聊天界面的地方——能看见 Agent 的输入，而不只是它的输出。
 *
 * 排查时最有用：模型行为诡异，十次里有九次是上下文里混进了不该有的东西，
 * 而这个视图是唯一能直接看到的地方。
 */
export function ContextInspector() {
  const messages = useLiveSelector(selectMessages)

  // 派生统计放在组件里用 useMemo 算，**不能**写进 selector——
  // selector 返回新对象会让 useSyncExternalStore 无限重渲染。
  const stats = useMemo(() => {
    const byRole = { system: 0, user: 0, assistant: 0, tool: 0 }
    let toolCalls = 0
    for (const message of messages) {
      byRole[message.role] += 1
      toolCalls += message.tool_calls?.length ?? 0
    }
    return { byRole, toolCalls }
  }, [messages])

  if (messages.length === 0) {
    return <EmptyState title="暂无模型消息" hint="发起一轮任务后，模型看到的完整上下文会显示在这里。" />
  }

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-4 py-2.5">
        <span className="mr-1 text-[11px] text-ink-muted">{messages.length} 条消息</span>
        {stats.byRole.user > 0 && <Badge tone="accent">user ×{stats.byRole.user}</Badge>}
        {stats.byRole.assistant > 0 && <Badge tone="neutral">assistant ×{stats.byRole.assistant}</Badge>}
        {stats.byRole.tool > 0 && <Badge tone="success">tool ×{stats.byRole.tool}</Badge>}
        {stats.toolCalls > 0 && <Badge tone="running">{stats.toolCalls} 次调用</Badge>}
      </div>
      <div className="flex flex-col gap-1.5 px-4 py-3">
        {messages.map((message, index) => (
          <MessageRow key={index} message={message} index={index} />
        ))}
      </div>
    </div>
  )
}

const ROLE_TONE = {
  system: 'neutral',
  user: 'accent',
  assistant: 'neutral',
  tool: 'success',
} as const

function MessageRow({ message, index }: { message: Message; index: number }) {
  const [open, setOpen] = useState(false)
  const preview = message.content.replace(/\s+/g, ' ').slice(0, 80)

  return (
    <div className="rounded border border-line bg-surface px-2.5 py-1.5">
      <Disclosure
        open={open}
        onToggle={() => setOpen(!open)}
        summary={
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <span className="font-mono text-[10px] text-ink-faint">{index}</span>
            <Badge tone={ROLE_TONE[message.role]} mono>
              {message.role}
            </Badge>
            <span className="min-w-0 flex-1 truncate text-[11px] text-ink-faint">
              {preview || <span className="italic">（无正文）</span>}
            </span>
            {message.tool_calls?.length ? (
              <Badge tone="running">{message.tool_calls.length} call</Badge>
            ) : null}
          </span>
        }
      >
        <div className="flex flex-col gap-2 pl-4">
          {message.content && (
            <pre className="max-h-48 overflow-auto rounded bg-canvas px-2 py-1.5 font-mono text-[11px] whitespace-pre-wrap break-all text-ink-muted">
              {message.content}
            </pre>
          )}
          {message.reasoning_content && (
            <div>
              <div className="mb-1 text-[10px] text-reasoning">reasoning_content</div>
              {/* 思考过程不是可选的展示数据，而是协议状态：请求带 tools 时
                  DeepSeek 会校验历史里的思考过程是否完整，缺失可能直接 400。
                  所以它必须出现在这个"模型看到了什么"的视图里。 */}
              <pre className="max-h-32 overflow-auto rounded bg-canvas px-2 py-1.5 font-mono text-[11px] whitespace-pre-wrap break-all text-ink-faint">
                {message.reasoning_content}
              </pre>
            </div>
          )}
          {message.tool_calls?.map((call) => (
            <div key={call.id} className="rounded border border-line bg-canvas px-2 py-1.5">
              <div className="flex items-center gap-2 text-[11px]">
                <span className="font-mono text-running">{call.name}</span>
                <span className="font-mono text-[10px] text-ink-faint">{call.id}</span>
              </div>
              {/* arguments 是 JSON 原文字符串，后端刻意不解析它（参数模式由
                  各工具自己定义，Model 层不该认识）。这里 try-parse 只为了
                  美化显示，解析失败就原样展示——模型吐出半截 JSON 是
                  真实会发生的情况（输出被 max_tokens 截断时）。 */}
              <pre className="mt-1 font-mono text-[10px] whitespace-pre-wrap break-all text-ink-muted">
                {prettyJson(call.arguments)}
              </pre>
            </div>
          ))}
          {message.tool_call_id && (
            <div className="font-mono text-[10px] text-ink-faint">
              回指调用 {message.tool_call_id}
            </div>
          )}
        </div>
      </Disclosure>
    </div>
  )
}

function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}
