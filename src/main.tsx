import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'
import { AppProviders } from './app/providers'
import { router } from './app/routes'
import './index.css'

const container = document.getElementById('root')
if (!container) throw new Error('找不到 #root 挂载点')

createRoot(container).render(
  // StrictMode 在开发模式下会故意把每个组件挂载两次（mount → unmount → mount），
  // 用来暴露没写清理函数的副作用。SSE 订阅正是典型案例：不清理就会留下
  // 两条连接。保留它是因为这类 bug 在生产里极难复现，让它在开发时就炸出来。
  <StrictMode>
    <AppProviders>
      <RouterProvider router={router} />
    </AppProviders>
  </StrictMode>,
)
