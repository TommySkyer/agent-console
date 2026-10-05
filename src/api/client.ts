import { ApiError } from './errors'

/**
 * HTTP 客户端。
 *
 * 职责边界：**只做协议翻译**——拼 URL、编解码 JSON、把非 2xx 变成 ApiError。
 * 它不认识「会话」「轮次」这些概念，也不含任何重试/缓存策略（那是 TanStack Query
 * 的事）。判断一段逻辑该不该写在这里，问：把 React 换成别的框架，这段要不要改？
 * 要改就不属于这一层。
 *
 * 写成 class 而不是一堆导出函数，是为了能通过 Context 注入：
 * 测试和 Storybook 可以塞一个假实现进去，不必 mock 掉整个模块。
 * 这和后端把 Model、Store 作为接口注入 Agent 是同一个思路。
 */
export class ApiClient {
  constructor(private readonly baseUrl: string = '') {}

  /** SSE 端点的完整 URL。EventSource 自己发请求，不走本类的 fetch。 */
  eventsUrl(threadId: string, fromSeq: number): string {
    return `${this.baseUrl}/api/threads/${encodeURIComponent(threadId)}/events?from_seq=${fromSeq}`
  }

  async request<T>(path: string, init?: RequestInit): Promise<T> {
    let response: Response
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
          ...init?.headers,
        },
      })
    } catch (cause) {
      // fetch 只在网络层失败时 reject；HTTP 错误状态码是正常 resolve 的。
      // 这个区别是 fetch 最常见的坑，也是这里必须显式分开处理的原因。
      throw new ApiError('network', 0, String(cause))
    }

    if (!response.ok) {
      throw await this.toApiError(response)
    }

    // 204 No Content 没有响应体（DELETE 和 cancel 都是）。
    // 无条件 res.json() 会抛 "Unexpected end of JSON input"。
    if (response.status === 204 || response.headers.get('Content-Length') === '0') {
      return undefined as T
    }
    return (await response.json()) as T
  }

  /**
   * 把错误响应解析成 ApiError。
   *
   * 后端保证错误体统一是 { error: { code, message } }，但这里仍然做了兜底：
   * 反向代理返回的 502/504 是 HTML 而不是 JSON，网关超时也一样。
   * 解析失败时按状态码猜一个 code，至少不让前端崩在错误处理里。
   */
  private async toApiError(response: Response): Promise<ApiError> {
    try {
      const body = (await response.json()) as { error?: { code?: string; message?: string } }
      if (body?.error?.code) {
        return new ApiError(body.error.code, response.status, body.error.message ?? '')
      }
    } catch {
      // 落到下面按状态码兜底
    }
    // 后端的“会话不存在”有结构化错误码。裸 404 说明当前服务没有这个路由，
    // 常见原因是前端已热更新而 GoLand 仍在运行旧版后端。
    const fallback = response.status === 404 ? 'endpoint_not_found' : 'internal'
    return new ApiError(fallback, response.status, response.statusText)
  }
}

/**
 * 默认实例。baseUrl 为空串意味着所有请求都是**同源相对路径**。
 *
 * 开发期由 Vite 的 /api 代理转发到 Go 后端（见 vite.config.ts），
 * 生产期由 nginx 做同样的事。前端因此永远不需要知道后端的真实地址，
 * 也不需要后端开 CORS——EventSource 跨域时的凭据和预检行为比同源复杂得多，
 * 同源可以完全绕开这类问题。
 */
export const apiClient = new ApiClient('')
