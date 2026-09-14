import type { ApiClient } from './client'
import type { Meta, ServerConfig, Snapshot } from '@/types/contract'

/**
 * 会话相关的端点。
 *
 * 每个函数都显式接收 ApiClient 而不是 import 全局实例，这样调用方
 * （store/queries.ts）可以把从 Context 拿到的实例传进来，测试则传假的。
 */

export function getServerConfig(client: ApiClient) {
  return client.request<ServerConfig>('/api/config')
}

export interface CreateThreadInput {
  workspace: string
  title?: string
}

/**
 * 请求体类型必须**精确**。
 *
 * 后端 decodeJSON 开了 DisallowUnknownFields：多带一个字段就是 400。
 * 后端这么做是为了让前端的拼写错误立刻暴露（一个被静默忽略的 "workSpace"
 * 会让人对着跑在错误目录里的 Agent 排查半天），代价是前端不能顺手多传字段。
 */
export function createThread(client: ApiClient, input: CreateThreadInput) {
  const body: CreateThreadInput = { workspace: input.workspace }
  if (input.title) body.title = input.title
  return client.request<{ thread_id: string; meta: Meta }>('/api/threads', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export function listThreads(client: ApiClient, workspace?: string) {
  const query = workspace ? `?workspace=${encodeURIComponent(workspace)}` : ''
  return client.request<{ threads: Meta[] }>(`/api/threads${query}`)
}

export function getSnapshot(client: ApiClient, threadId: string) {
  return client.request<Snapshot>(`/api/threads/${encodeURIComponent(threadId)}`)
}

export function deleteThread(client: ApiClient, threadId: string) {
  return client.request<void>(`/api/threads/${encodeURIComponent(threadId)}`, { method: 'DELETE' })
}

/**
 * 提交一次输入。
 *
 * 返回 202 Accepted 而不是 200：响应发出时 Turn 根本还没开始跑，返回体里
 * 只有 turn_id。**这次调用成功不代表任务成功**——任务的成败只能通过事件流里的
 * turn.completed / turn.failed 得知。前端因此有两条独立的错误通道，不能合并：
 *   - 这里 throw 的 ApiError：任务没能启动（409 已有任务、400 输入为空…）
 *   - 事件流里的 turn.failed：任务启动了但跑挂了（max_steps、provider_error…）
 */
export function startTurn(client: ApiClient, threadId: string, input: string) {
  return client.request<{ turn_id: string }>(
    `/api/threads/${encodeURIComponent(threadId)}/turns`,
    { method: 'POST', body: JSON.stringify({ input }) },
  )
}

export function cancelTurn(client: ApiClient, threadId: string) {
  return client.request<void>(`/api/threads/${encodeURIComponent(threadId)}/cancel`, {
    method: 'POST',
  })
}
