import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { ApiClientProvider } from './ApiClientContext'
import { ToastProvider } from './ToastContext'
import { ApiError } from '@/api/errors'

/**
 * 全局 Provider 的装配点——前端的「组合根」。
 *
 * 和后端 cmd/code-agent-server/main.go 是同一个角色：**唯一**知道具体实现
 * 怎么拼起来的地方。下面的组件只认接口（useApiClient、useToast），
 * 不知道自己拿到的是真实现还是测试替身。
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 默认不自动重试。这套 API 的失败大多是确定性的（404、409、400），
      // 重试只是让用户多等几秒再看到同一个错误。真正值得重试的
      // （provider_error、网络抖动）在各自的 hook 里单独开。
      retry: false,
      // 窗口聚焦就重取对普通 CRUD 是好事，但这里的快照只用来给
      // live store 播种，重取会用一份旧数据覆盖掉已经通过事件流
      // 更新到最新的状态。
      refetchOnWindowFocus: false,
      staleTime: 5_000,
    },
    mutations: {
      retry: (count, error) => count < 1 && error instanceof ApiError && error.retryable,
    },
  },
})

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <ApiClientProvider>
        <ToastProvider>{children}</ToastProvider>
      </ApiClientProvider>
    </QueryClientProvider>
  )
}
