import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

/**
 * 轻量 Toast。
 *
 * ## 为什么拆成两个 Context
 *
 * Context 的 value 引用一变，**所有** useContext 的组件都会重渲染。
 * 如果 { toasts, show } 放在一个 Context 里，那么每弹一个 toast，
 * 所有"只想调用 show"的组件（输入框、删除按钮…）都会跟着重渲染——
 * 它们根本不关心当前有哪些 toast。
 *
 * 拆开之后：
 *   ToastStateContext     value 随 toasts 变 → 只有渲染列表的 ToastViewport 订阅
 *   ToastDispatchContext  value 被 useCallback 锁死，引用**永不改变**
 *                         → 订阅它的组件一次都不会因为 toast 变化而重渲染
 *
 * 这是 Context 的经典优化手法，也是"Context 没有选择性订阅"这条规则的
 * 直接推论。能讲清这一点，基本就说明理解了 Context 的代价在哪。
 */

type ToastKind = 'error' | 'info'
interface Toast {
  id: number
  message: string
  kind: ToastKind
}

interface ToastDispatch {
  show: (message: string, kind?: ToastKind) => void
}

const ToastStateContext = createContext<Toast[]>([])
const ToastDispatchContext = createContext<ToastDispatch>({ show: () => {} })

let nextId = 1

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])

  const show = useCallback((message: string, kind: ToastKind = 'info') => {
    const id = nextId++
    setToasts((current) => [...current, { id, message, kind }])
    setTimeout(() => setToasts((current) => current.filter((t) => t.id !== id)), 5000)
  }, [])

  // useMemo 锁住这个对象的引用。少了它，每次 ToastProvider 重渲染都会产生
  // 一个新的 { show }，dispatch Context 的"引用永不变"就白设计了。
  const dispatch = useMemo(() => ({ show }), [show])

  return (
    <ToastDispatchContext value={dispatch}>
      <ToastStateContext value={toasts}>
        {children}
        <ToastViewport />
      </ToastStateContext>
    </ToastDispatchContext>
  )
}

export function useToast(): ToastDispatch {
  return useContext(ToastDispatchContext)
}

function ToastViewport() {
  const toasts = useContext(ToastStateContext)
  if (toasts.length === 0) return null
  return (
    // role=status + aria-live 让读屏软件会朗读新出现的提示，
    // 否则纯视觉的 toast 对读屏用户等于不存在。
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 flex-col gap-2"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`pointer-events-auto rounded border px-3 py-2 text-[12px] shadow-lg ${
            toast.kind === 'error'
              ? 'border-danger/40 bg-danger/10 text-danger'
              : 'border-line-strong bg-surface-raised text-ink'
          }`}
        >
          {toast.message}
        </div>
      ))}
    </div>
  )
}
