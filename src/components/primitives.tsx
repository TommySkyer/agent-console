import type { ButtonHTMLAttributes, ReactNode } from 'react'

/**
 * 无业务语义的展示原件。
 *
 * 放在 components/ 而不是 features/ 的判据：**它认不认识"会话""轮次"这些词**。
 * Badge 只知道自己有个颜色和一段文字，所以它在这里；StatusBadge 知道
 * in_progress 意味着什么，所以它在 features/console/。
 *
 * 这条边界的实际好处是这些组件可以随便复用、随便测，不用先造一个假的会话。
 */

type Tone = 'neutral' | 'running' | 'success' | 'danger' | 'reasoning' | 'accent'

const TONE_CLASS: Record<Tone, string> = {
  neutral: 'bg-line/60 text-ink-muted border-line-strong',
  running: 'bg-running/10 text-running border-running/30',
  success: 'bg-success/10 text-success border-success/30',
  danger: 'bg-danger/10 text-danger border-danger/30',
  reasoning: 'bg-reasoning/10 text-reasoning border-reasoning/30',
  accent: 'bg-accent/10 text-accent border-accent/30',
}

export function Badge({
  tone = 'neutral',
  children,
  mono = false,
}: {
  tone?: Tone
  children: ReactNode
  mono?: boolean
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] leading-none ${
        TONE_CLASS[tone]
      } ${mono ? 'font-mono' : ''}`}
    >
      {children}
    </span>
  )
}

/** 会脉动的小圆点，表示"正在进行"。 */
export function LiveDot({ tone = 'running' }: { tone?: Tone }) {
  const color = {
    neutral: 'bg-ink-faint', running: 'bg-running', success: 'bg-success',
    danger: 'bg-danger', reasoning: 'bg-reasoning', accent: 'bg-accent',
  }[tone]
  return <span className={`inline-block size-1.5 rounded-full ${color} animate-pulse-dot`} />
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'ghost' | 'danger'
}

export function Button({ variant = 'ghost', className = '', ...props }: ButtonProps) {
  const base =
    'inline-flex items-center justify-center gap-1.5 rounded px-3 py-1.5 text-sm ' +
    'transition-colors disabled:cursor-not-allowed disabled:opacity-40'
  const variants = {
    primary: 'bg-accent text-canvas font-medium hover:bg-accent/85',
    ghost: 'border border-line-strong text-ink-muted hover:bg-surface-raised hover:text-ink',
    danger: 'border border-danger/40 text-danger hover:bg-danger/10',
  }
  return <button className={`${base} ${variants[variant]} ${className}`} {...props} />
}

export function Spinner({ className = '' }: { className?: string }) {
  return (
    <svg className={`size-3.5 animate-spin ${className}`} viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path d="M14.5 8A6.5 6.5 0 0 0 8 1.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

export function EmptyState({ title, hint }: { title: string; hint?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <p className="text-sm text-ink-muted">{title}</p>
      {hint && <p className="max-w-sm text-xs text-ink-faint">{hint}</p>}
    </div>
  )
}

/** 可折叠区块。用在 reasoning 卡片和命令输出上，默认收起以免刷屏。 */
export function Disclosure({
  open,
  onToggle,
  summary,
  children,
}: {
  open: boolean
  onToggle: () => void
  summary: ReactNode
  children: ReactNode
}) {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        // aria-expanded 让读屏软件知道这是可展开的，以及当前展开没有。
        // 自己用 div 拼折叠面板时最容易漏的就是这个。
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 text-left"
      >
        <svg
          className={`size-3 shrink-0 text-ink-faint transition-transform ${open ? 'rotate-90' : ''}`}
          viewBox="0 0 12 12"
          fill="currentColor"
        >
          <path d="M4 2.5 8 6l-4 3.5z" />
        </svg>
        {summary}
      </button>
      {open && <div className="mt-2">{children}</div>}
    </div>
  )
}
