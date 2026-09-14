import { Outlet } from 'react-router-dom'
import { ThreadSidebar } from '@/features/threads/ThreadSidebar'

/**
 * 布局路由：侧栏常驻，右侧由子路由填充。
 *
 * 用嵌套路由而不是在每个页面各自渲染一遍侧栏，好处是切换会话时侧栏组件
 * **不会卸载重建**——它的 Query 缓存、滚动位置、展开状态都保留着。
 * react-router 的 <Outlet /> 就是子路由的插槽。
 */
export function AppLayout() {
  return (
    <div className="flex h-full">
      <ThreadSidebar />
      <main className="min-w-0 flex-1">
        <Outlet />
      </main>
    </div>
  )
}
