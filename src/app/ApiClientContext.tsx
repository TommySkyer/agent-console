import { createContext, useContext, type ReactNode } from 'react'
import { ApiClient, apiClient } from '@/api/client'

/**
 * 通过 Context 注入 ApiClient。
 *
 * ## 这是 Context 的正确用途：注入依赖，不是存放状态
 *
 * Context 的语义是「Provider 的 value 引用一变，所有 useContext 的组件
 * 无差别重渲染」，没有选择性订阅，memo 也挡不住（memo 比的是 props，
 * 而 Context 是绕过 props 传进去的）。所以它只适合放**引用稳定**的东西。
 *
 * 这里的 value 是一个整个生命周期都不变的实例，重渲染问题根本不存在。
 * 高频变化的实时投影为什么不能这么放，见 store/liveThread/store.ts。
 *
 * ## 为什么不直接 import 全局单例
 *
 * 组件从 Context 拿而不是 import，测试时就能注入一个假 client，
 * 不必 mock 掉整个模块。这和后端把 Model、Store 作为接口注入 Agent、
 * 而不是在 Agent 里直接构造，是同一个思路。
 */
const ApiClientContext = createContext<ApiClient>(apiClient)

export function ApiClientProvider({
  client = apiClient,
  children,
}: {
  client?: ApiClient
  children: ReactNode
}) {
  return <ApiClientContext value={client}>{children}</ApiClientContext>
}

export function useApiClient(): ApiClient {
  return useContext(ApiClientContext)
}
