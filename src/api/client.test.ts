import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiClient } from './client'
import { ApiError } from './errors'

describe('ApiClient 404', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('裸 404 识别为旧服务缺少路由', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('404 page not found', { status: 404 })))
    await expect(new ApiClient().request('/api/threads/th_1/model-context')).rejects.toMatchObject({
      code: 'endpoint_not_found', status: 404,
    } satisfies Partial<ApiError>)
  })

  it('结构化 404 保留会话不存在错误码', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { code: 'thread_not_found', message: 'thread not found' },
    }), { status: 404, headers: { 'Content-Type': 'application/json' } })))
    await expect(new ApiClient().request('/api/threads/th_1/model-context')).rejects.toMatchObject({
      code: 'thread_not_found', status: 404,
    } satisfies Partial<ApiError>)
  })
})
