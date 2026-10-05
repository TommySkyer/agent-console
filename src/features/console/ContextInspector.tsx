import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useApiClient } from '@/app/ApiClientContext'
import { getContextRevision } from '@/api/threads'
import { useLiveSelector } from '@/store/liveThread/LiveThreadContext'
import { selectStatus, selectTurnCount } from '@/store/liveThread/selectors'
import { Badge, Disclosure, EmptyState } from '@/components/primitives'
import type { Message } from '@/types/contract'
import { useModelContext } from '@/store/queries'
import { compactNumber, percent } from '@/lib/format'

/**
 * 服务端按 Agent 真正的请求组装路径返回下一次请求的基础内容。
 * 下一条用户消息要到提交时才能追加，所以在这里明确排除它。
 */
export function ContextInspector({ threadId }: { threadId: string }) {
  const status = useLiveSelector(selectStatus)
  const turnCount = useLiveSelector(selectTurnCount)
  const context = useModelContext(threadId, turnCount, status)
  const messages = context.data?.messages ?? []

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

  if (context.isPending) {
    return <EmptyState title="正在读取模型上下文" />
  }
  if (context.isError || !context.data) {
    return <EmptyState title="模型上下文读取失败" hint={<div className="flex flex-col items-center gap-2"><span>{context.error instanceof Error ? context.error.message : '请检查后端服务'}</span><button type="button" onClick={() => void context.refetch()} className="text-accent">重试</button></div>} />
  }

  const preview = context.data
  const inputTokens = preview.last_model_input_tokens
  const ratio = inputTokens === null ? null : percent(inputTokens, preview.context_window)

  return (
    <div className="flex flex-col">
      <div className="border-b border-line px-4 py-3 text-[11px] text-ink-muted">
        <div className="flex items-center justify-between gap-3">
          <strong className="text-[12px] font-medium text-ink">当前模型窗口</strong>
          <button type="button" onClick={() => void context.refetch()} className="text-accent hover:underline">刷新</button>
        </div>
        <p className="mt-1">
          {preview.status === 'running'
            ? '任务执行中，消息历史还会变化。下方是刚读取到的服务端状态。'
            : '下一条用户输入会在提交时追加到这些消息之后。'}
        </p>
        <div className="mt-2 font-mono text-[10px] text-ink-faint">
          {preview.model} · 思考强度 {preview.reasoning_effort} · 输出上限 {preview.max_tokens || '模型默认'} · 事件 #{preview.last_seq}
        </div>
        <div className="mt-3">
          <span>上次调用实际占窗：</span>
          <span className="font-mono text-ink">{inputTokens === null ? '尚无记录' : `${compactNumber(inputTokens)} tokens`}</span>
          {preview.context_window > 0 && inputTokens !== null && (
            <span> / {compactNumber(preview.context_window)} tokens（{ratio?.toFixed(1)}%）</span>
          )}
          {preview.last_cache_read_tokens != null && inputTokens !== null && (
            <p className="mt-0.5">其中缓存命中：{compactNumber(preview.last_cache_read_tokens)} tokens（占本次输入 {percent(preview.last_cache_read_tokens, inputTokens).toFixed(1)}%，仍占窗口）</p>
          )}
          <p className="mt-0.5 text-[10px] text-ink-faint">这是上次调用收到请求时的实测输入；最终回答和下一条用户输入会进入下一次请求。</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-4 py-2.5">
        <span className="mr-1 text-[11px] text-ink-muted">{messages.length} 条消息</span>
        {stats.byRole.user > 0 && <Badge tone="accent">user ×{stats.byRole.user}</Badge>}
        {stats.byRole.assistant > 0 && <Badge tone="neutral">assistant ×{stats.byRole.assistant}</Badge>}
        {stats.byRole.tool > 0 && <Badge tone="success">tool ×{stats.byRole.tool}</Badge>}
        {stats.toolCalls > 0 && <Badge tone="running">{stats.toolCalls} 次调用</Badge>}
        <Badge tone="neutral">{preview.tools.length} 个可用工具</Badge>
      </div>
      <div className="flex flex-col gap-1.5 px-4 py-3">
        {messages.map((message, index) => (
          <MessageRow key={index} message={message} index={index} />
        ))}
      </div>
      {preview.tools.length > 0 && (
        <div className="border-t border-line px-4 py-3">
          <div className="mb-2 text-[11px] text-ink-muted">每次请求还会携带这些工具定义</div>
          {preview.tools.map((tool) => (
            <ToolRow key={tool.name} tool={tool} />
          ))}
        </div>
      )}
      {preview.wire_request !== undefined && (
        <WireRequest data={preview.wire_request} />
      )}
      {(preview.history ?? []).length > 0 && (
        <section className="border-t border-line px-4 py-4">
          <h2 className="mb-2 text-xs font-medium text-ink">此前的窗口（按发生顺序）</h2>
          {preview.history!.map((revision, index) => (
            <HistoryWindow key={`${revision.at}-${index}`} threadId={threadId} revision={revision} index={index} />
          ))}
        </section>
      )}
    </div>
  )
}

function HistoryWindow({ threadId, revision, index }: { threadId: string; revision: NonNullable<import('@/types/contract').ModelContext['history']>[number]; index: number }) {
  const [open, setOpen] = useState(false)
  const client = useApiClient()
  const archive = useQuery({
    queryKey: ['threads', threadId, 'model-context', 'revision', index],
    queryFn: () => getContextRevision(client, threadId, index),
    enabled: open,
    staleTime: Infinity,
  })
  return <div className="mb-2 rounded border border-line bg-surface px-3 py-2">
    <Disclosure open={open} onToggle={() => setOpen(!open)} summary={<span className="text-[11px] text-ink-muted">窗口 {index + 1} · {revision.kind === 'summary' ? '摘要压缩前' : '旧工具结果清理前'} · {revision.message_count} 条消息 · {new Date(revision.at).toLocaleString()}</span>}>
      <p className="my-2 text-[10px] text-ink-faint">治理前预估 {compactNumber(revision.estimated_before)} → 治理后 {compactNumber(revision.estimated_after)} tokens</p>
      {archive.isPending && <p className="text-[11px] text-ink-faint">正在读取原始窗口…</p>}
      {archive.isError && <p className="text-[11px] text-danger">读取原始窗口失败</p>}
      {archive.data && <div className="flex flex-col gap-1.5">{archive.data.before.map((message, messageIndex) => <MessageRow key={messageIndex} message={message} index={messageIndex} />)}</div>}
    </Disclosure>
  </div>
}

function WireRequest({ data }: { data: unknown }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="border-t border-line px-4 py-3">
      <Disclosure open={open} onToggle={() => setOpen(!open)} summary={<span className="text-[11px] text-ink-muted">查看供应商请求 JSON（不含鉴权和下一条用户输入）</span>}>
        <pre className="max-h-96 overflow-auto rounded bg-canvas p-2 font-mono text-[10px] whitespace-pre-wrap break-all text-ink-muted">{JSON.stringify(data, null, 2)}</pre>
      </Disclosure>
    </div>
  )
}

function ToolRow({ tool }: { tool: { name: string; description: string; parameters: unknown } }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="mb-1.5 rounded border border-line bg-surface px-2.5 py-1.5">
      <Disclosure open={open} onToggle={() => setOpen(!open)} summary={<span className="font-mono text-[11px] text-ink">{tool.name}</span>}>
        <p className="mb-2 text-[11px] text-ink-muted">{tool.description}</p>
        <pre className="max-h-48 overflow-auto font-mono text-[10px] whitespace-pre-wrap break-all text-ink-faint">{JSON.stringify(tool.parameters, null, 2)}</pre>
      </Disclosure>
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
          {message.source_path && (
            <div className="font-mono text-[10px] break-all text-ink-faint">
              完整工具输出归档：{message.source_path}
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
