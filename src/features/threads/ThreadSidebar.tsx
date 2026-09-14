import { useState } from 'react'
import { NavLink, useNavigate, useSearchParams } from 'react-router-dom'
import { useCreateThread, useDeleteThread, useThreadList } from '@/store/queries'
import { Button, EmptyState, Spinner } from '@/components/primitives'
import { basename, relativeTime } from '@/lib/format'
import { ApiError } from '@/api/errors'
import { useToast } from '@/app/ToastContext'

/**
 * 会话列表侧栏。
 *
 * 这里的数据全部是**服务端资源状态**，交给 TanStack Query：它有明确的
 * 请求-响应语义，重新取一次就能得到完整的当前值。实时投影不满足这个前提，
 * 所以走另一套机制（见 store/liveThread）。
 */
export function ThreadSidebar() {
  // workspace 过滤放在 URL 上而不是组件 state 里：这样筛选结果可以被分享、
  // 被收藏、刷新后还在。凡是"应该能被链接指向"的状态都属于 URL。
  const [searchParams, setSearchParams] = useSearchParams()
  const workspace = searchParams.get('workspace') ?? undefined
  const threads = useThreadList(workspace)

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-line bg-surface/30">
      <div className="flex items-center justify-between px-4 py-3">
        <span className="text-[11px] tracking-wide text-ink-muted uppercase">会话</span>
        <CreateThreadButton />
      </div>

      {workspace && (
        <button
          type="button"
          onClick={() => setSearchParams({})}
          className="mx-3 mb-2 truncate rounded border border-line bg-surface px-2 py-1 text-left font-mono text-[10px] text-ink-faint hover:text-ink"
          title={`当前筛选：${workspace}（点击清除）`}
        >
          筛选：{basename(workspace)} ✕
        </button>
      )}

      <div className="min-h-0 flex-1 overflow-auto px-2 pb-3">
        {threads.isLoading && (
          <div className="flex justify-center py-6">
            <Spinner className="text-ink-faint" />
          </div>
        )}
        {threads.error && (
          <p className="px-2 py-4 text-[11px] text-danger">
            {threads.error instanceof ApiError ? threads.error.message : '加载失败'}
          </p>
        )}
        {threads.data?.length === 0 && (
          <EmptyState title="还没有会话" hint="点击右上角 + 新建一个。" />
        )}
        {threads.data?.map((meta) => (
          <ThreadRow key={meta.id} id={meta.id} title={meta.title} workspace={meta.workspace} createdAt={meta.created_at} />
        ))}
      </div>
    </aside>
  )
}

function ThreadRow({
  id,
  title,
  workspace,
  createdAt,
}: {
  id: string
  title?: string
  workspace: string
  createdAt: string
}) {
  const navigate = useNavigate()
  const remove = useDeleteThread()

  return (
    // NavLink 相比 Link 多了 isActive：当前路由匹配时能拿到激活态，
    // 不用自己比较 useLocation().pathname。这是 react-router 为
    // "导航项高亮" 这个高频需求提供的专门 API。
    <NavLink
      to={`/threads/${id}`}
      className={({ isActive }) =>
        `group flex items-start gap-2 rounded px-2 py-2 transition-colors ${
          isActive ? 'bg-surface-raised text-ink' : 'text-ink-muted hover:bg-surface-raised/60'
        }`
      }
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px]">{title || `会话 ${id.slice(3, 11)}`}</div>
        <div className="truncate font-mono text-[10px] text-ink-faint" title={workspace}>
          {basename(workspace)} · {relativeTime(createdAt)}
        </div>
      </div>
      <button
        type="button"
        aria-label="删除会话"
        onClick={(event) => {
          // NavLink 包着删除按钮，不阻止冒泡的话点删除会顺带导航过去。
          event.preventDefault()
          event.stopPropagation()
          if (!confirm('删除这个会话？事件日志也会一并删除。')) return
          remove.mutate(id, { onSuccess: () => navigate('/') })
        }}
        className="shrink-0 rounded px-1 text-ink-faint opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
      >
        ✕
      </button>
    </NavLink>
  )
}

function CreateThreadButton() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="新建会话"
        className="rounded px-1.5 text-ink-muted hover:bg-surface-raised hover:text-ink"
      >
        +
      </button>
      {open && <CreateThreadDialog onClose={() => setOpen(false)} />}
    </>
  )
}

function CreateThreadDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate()
  const create = useCreateThread()
  const toast = useToast()
  const [workspace, setWorkspace] = useState('')
  const [title, setTitle] = useState('')
  const [fieldError, setFieldError] = useState('')

  function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!workspace.trim()) {
      setFieldError('工作目录不能为空')
      return
    }
    create.mutate(
      { workspace: workspace.trim(), title: title.trim() || undefined },
      {
        onSuccess: (data) => {
          onClose()
          navigate(`/threads/${data.thread_id}`)
        },
        onError: (error) => {
          if (!(error instanceof ApiError)) return
          // invalid_workspace 是字段级错误，显示在输入框下面比弹 toast 更合适——
          // 用户需要知道是**哪个字段**错了。
          if (error.code === 'invalid_workspace') setFieldError(error.message)
          else if (error.shouldToast) toast.show(error.message, 'error')
        },
      },
    )
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-canvas/80 p-4"
      onClick={onClose}
      role="presentation"
    >
      <form
        onSubmit={submit}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="新建会话"
        className="w-full max-w-md rounded-lg border border-line-strong bg-surface p-5"
      >
        <h2 className="mb-4 text-sm text-ink">新建会话</h2>

        <label className="mb-1 block text-[11px] text-ink-muted" htmlFor="workspace">
          工作目录（绝对路径）
        </label>
        <input
          id="workspace"
          value={workspace}
          onChange={(event) => {
            setWorkspace(event.target.value)
            setFieldError('')
          }}
          autoFocus
          placeholder="/Users/you/project"
          className="mb-1 w-full rounded border border-line-strong bg-canvas px-2.5 py-1.5 font-mono text-[12px] text-ink focus:border-accent/60 focus:outline-none"
        />
        <p className="mb-3 text-[10px] text-ink-faint">
          {fieldError ? (
            <span className="text-danger">{fieldError}</span>
          ) : (
            'Agent 的所有命令都在这个目录里执行，后端启动时已固定可访问范围。'
          )}
        </p>

        <label className="mb-1 block text-[11px] text-ink-muted" htmlFor="title">
          标题（可选）
        </label>
        <input
          id="title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="重构会话层"
          className="mb-5 w-full rounded border border-line-strong bg-canvas px-2.5 py-1.5 text-[12px] text-ink focus:border-accent/60 focus:outline-none"
        />

        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            取消
          </Button>
          <Button type="submit" variant="primary" disabled={create.isPending}>
            {create.isPending ? <Spinner /> : null}
            创建
          </Button>
        </div>
      </form>
    </div>
  )
}
