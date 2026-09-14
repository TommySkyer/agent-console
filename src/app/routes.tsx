import { createBrowserRouter, Navigate } from 'react-router-dom'
import { AppLayout } from './AppLayout'
import { ThreadConsolePage } from '@/features/console/ThreadConsolePage'
import { EmptyState } from '@/components/primitives'

/**
 * 路由表。
 *
 * ## 为什么会话 ID 在 URL 里
 *
 * /threads/:threadId 而不是用组件 state 记住"当前打开哪个会话"。
 * 判据是：这个状态刷新之后应该还在吗？应该能被分享给同事吗？
 * 两个都是"是"，那它就属于 URL。
 *
 * ## key={threadId} 的作用
 *
 * 从会话 A 切到会话 B 时，React 默认会**复用**同一个组件实例（类型和位置都没变），
 * 只是 props 变了。那样 useState/useRef 里的东西会被带到新会话去。
 * 加上 key 之后 React 会卸载重建，新会话从干净状态开始。
 *
 * useThreadLive 内部其实已经用 ref 比较处理了 store 的重建，这里的 key
 * 是第二道保险，也让"切换会话 = 全新开始"这件事在路由表上一眼可见。
 */
export const router = createBrowserRouter([
  {
    path: '/',
    element: <AppLayout />,
    children: [
      {
        index: true,
        element: (
          <EmptyState
            title="选择左侧的会话，或新建一个"
            hint="每个会话绑定一个工作目录，Agent 的所有命令都在其中执行。"
          />
        ),
      },
      {
        path: 'threads/:threadId',
        element: <ThreadConsolePage />,
      },
      {
        path: '*',
        element: <Navigate to="/" replace />,
      },
    ],
  },
])
