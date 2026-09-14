import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useApiClient } from '@/app/ApiClientContext'
import * as threads from '@/api/threads'
import { ApiError } from '@/api/errors'

/**
 * 服务端资源状态，交给 TanStack Query。
 *
 * 为什么只有这一类状态用 Query：它的心智模型是「一个 key 对应一次请求的结果，
 * 可以缓存、失效、重试、去重」，前提是**同一个 key 重新取一次能得到完整的当前值**。
 * 会话列表和快照满足这个前提，事件流不满足（见 store/liveThread）。
 *
 * queryKey 用数组分层，这样可以按前缀批量失效：
 *   invalidateQueries({ queryKey: ['threads'] })  会连带失效下面所有的。
 */
export const queryKeys = {
  config: ['config'] as const,
  threads: (workspace?: string) => ['threads', workspace ?? ''] as const,
  snapshot: (threadId: string) => ['threads', threadId, 'snapshot'] as const,
}

/**
 * 服务端能力描述。整个会话期间不会变，所以永不过期、永不重取。
 *
 * 老版本后端没有 /api/config，会返回 404。这里把它当成「没有边界信息」
 * 而不是错误——新建会话的表单少一条提示，但不该因此整块坏掉。
 */
export function useServerConfig() {
  const client = useApiClient()
  return useQuery({
    queryKey: queryKeys.config,
    queryFn: () => threads.getServerConfig(client),
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
  })
}

export function useThreadList(workspace?: string) {
  const client = useApiClient()
  return useQuery({
    queryKey: queryKeys.threads(workspace),
    queryFn: () => threads.listThreads(client, workspace),
    select: (data) => data.threads,
  })
}

export function useSnapshot(threadId: string | undefined) {
  const client = useApiClient()
  return useQuery({
    queryKey: queryKeys.snapshot(threadId ?? ''),
    queryFn: () => threads.getSnapshot(client, threadId!),
    enabled: Boolean(threadId),
    // 快照只用来给 live store 播种，播种之后实时性由 SSE 负责。
    // 让 Query 自己去轮询或在窗口聚焦时重取，只会用一份旧数据覆盖掉
    // 已经通过事件流更新到最新的状态。
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: (count, error) => count < 2 && error instanceof ApiError && error.retryable,
  })
}

export function useCreateThread() {
  const client = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: threads.CreateThreadInput) => threads.createThread(client, input),
    // 新建成功后让列表失效，Query 会自动重取。
    // 手动往缓存里塞一条也可以（乐观更新），但新建是低频操作，
    // 多一次请求换少一处可能与服务端不一致的手写逻辑，划算。
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['threads'] }),
  })
}

export function useDeleteThread() {
  const client = useApiClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (threadId: string) => threads.deleteThread(client, threadId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['threads'] }),
  })
}

export function useStartTurn(threadId: string) {
  const client = useApiClient()
  return useMutation({
    mutationFn: (input: string) => threads.startTurn(client, threadId, input),
    // 刻意**不**在 onSuccess 里动任何状态。
    //
    // 这个 mutation 成功只意味着后端返回了 202 —— Turn 才刚被准入，一步都没跑。
    // 界面上「开始执行了」这件事必须由事件流里的 turn.started 驱动，
    // 否则 UI 会比真实状态早一拍，而失败时（turn.failed）又对不上。
  })
}

export function useCancelTurn(threadId: string) {
  const client = useApiClient()
  return useMutation({
    mutationFn: () => threads.cancelTurn(client, threadId),
  })
}
