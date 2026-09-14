import { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/**
 * 渲染模型输出的 Markdown。
 *
 * ## 安全：为什么这样是安全的
 *
 * 模型输出是**不可信输入**，绝不能走 dangerouslySetInnerHTML。react-markdown
 * 不碰 innerHTML —— 它把 Markdown 解析成 AST 再构造 React 元素树，
 * 所以 `<img onerror=...>` 这类东西只会变成字面文本，不会变成 DOM。
 *
 * 默认也不开 rehype-raw（那个插件才会允许内联 HTML），这里刻意不加。
 *
 * ## 为什么用库而不是自己写
 *
 * Markdown 的边界情况多得离谱（嵌套列表、表格对齐、代码块里的反引号、
 * 链接里的括号……）。自己写一个「够用」的解析器，最后要么漏渲染要么渲染错，
 * 而且每个 bug 都得自己查。这是典型的「标准库比手写强」的场景。
 *
 * remark-gfm 补上表格、删除线、任务列表 —— 模型很爱用这三样。
 *
 * ## 为什么只在消息结束后渲染
 *
 * 见 AgentMessageCard：流式期间半截语法每帧都在变，渲染器会反复重排整棵树，
 * 既闪烁又慢。所以流式期间走纯文本，item.completed 之后才切成 Markdown。
 */
export const Markdown = memo(function Markdown({ children }: { children: string }) {
  return (
    <div className="md text-[13px] leading-relaxed text-ink">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // 标题在卡片里不需要很大，统一压到接近正文的尺寸，只用字重和颜色区分层级。
          h1: ({ children }) => <h3 className="mt-3 mb-1.5 text-[14px] font-semibold first:mt-0">{children}</h3>,
          h2: ({ children }) => <h4 className="mt-3 mb-1.5 text-[13px] font-semibold first:mt-0">{children}</h4>,
          h3: ({ children }) => <h5 className="mt-2.5 mb-1 text-[13px] font-medium first:mt-0">{children}</h5>,
          p: ({ children }) => <p className="my-1.5 first:mt-0 last:mb-0">{children}</p>,
          ul: ({ children }) => <ul className="my-1.5 list-disc space-y-0.5 pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="my-1.5 list-decimal space-y-0.5 pl-5">{children}</ol>,
          li: ({ children }) => <li className="marker:text-ink-faint">{children}</li>,
          strong: ({ children }) => <strong className="font-semibold text-ink">{children}</strong>,
          em: ({ children }) => <em className="text-ink-muted italic">{children}</em>,
          blockquote: ({ children }) => (
            <blockquote className="my-2 border-l-2 border-line-strong pl-3 text-ink-muted">{children}</blockquote>
          ),
          hr: () => <hr className="my-3 border-line" />,
          a: ({ children, href }) => (
            // noopener/noreferrer 是必须的：模型给的链接同样不可信，
            // 少了它，目标页面能通过 window.opener 操纵我们这一页。
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent underline underline-offset-2 hover:text-accent/80"
            >
              {children}
            </a>
          ),
          code: ({ className, children }) => {
            // react-markdown 用 className 上有没有 language-* 来区分行内代码和代码块。
            const isBlock = /language-/.test(className ?? '')
            if (!isBlock) {
              return (
                <code className="rounded bg-surface-raised px-1 py-0.5 font-mono text-[12px] text-running">
                  {children}
                </code>
              )
            }
            return <code className="font-mono text-[12px] leading-relaxed">{children}</code>
          },
          pre: ({ children }) => (
            <pre className="my-2 overflow-x-auto rounded border border-line bg-canvas px-3 py-2 text-ink-muted">
              {children}
            </pre>
          ),
          table: ({ children }) => (
            <div className="my-2 overflow-x-auto">
              <table className="w-full border-collapse text-[12px]">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-line bg-surface-raised px-2 py-1 text-left font-medium">{children}</th>
          ),
          td: ({ children }) => <td className="border border-line px-2 py-1">{children}</td>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
})
