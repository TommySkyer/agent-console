/**
 * 展示层格式化。
 *
 * 单独成文件是因为这些规则会被多个组件用到，而且它们是**产品决策**
 * （多长算长、保留几位小数）而不是渲染逻辑，改起来应当只改一处。
 */

/** 1234 → "1.2k"，用在 token 计数这种空间紧张的地方。 */
export function compactNumber(value: number): string {
  if (value < 1000) return String(value)
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`
  return `${(value / 1_000_000).toFixed(1)}M`
}

/** 毫秒 → 人类可读。命令耗时用。 */
export function duration(ms: number | undefined): string {
  if (!ms && ms !== 0) return ''
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  return `${minutes}m${Math.round((ms % 60_000) / 1000)}s`
}

/** ISO 时间戳 → 本地 HH:MM:SS。 */
export function clockTime(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleTimeString('zh-CN', { hour12: false })
}

/** 相对时间，用于会话列表。 */
export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const seconds = Math.floor((Date.now() - then) / 1000)
  if (seconds < 60) return '刚刚'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} 小时前`
  return `${Math.floor(seconds / 86_400)} 天前`
}

/** 取路径最后一段，会话列表里显示工作目录用。 */
export function basename(path: string): string {
  const parts = path.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || path
}

/**
 * 把 Markdown 压成一行纯文本，用作折叠时的摘要。
 *
 * 不是要"渲染 Markdown"，只是把语法噪音去掉 —— 折叠行上出现
 * `## 目录概览 | 项目 | 值 | | --- | --- |` 这种东西，比不给摘要还糟。
 *
 * 刻意只做删除、不做还原：表格和代码块整块丢弃（一行摘要里放不下，
 * 放进去只会把真正有信息量的第一句话挤掉），其余只剥掉标记符号。
 */
export function plainPreview(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ') // 代码块整块丢弃
    .replace(/^\s*\|.*\|\s*$/gm, ' ') // 表格行整行丢弃
    .replace(/^\s{0,3}#{1,6}\s+/gm, '') // 标题标记
    .replace(/^\s{0,3}>\s?/gm, '') // 引用标记
    .replace(/^\s*[-*+]\s+/gm, '') // 无序列表标记
    .replace(/^\s*\d+\.\s+/gm, '') // 有序列表标记
    // 链接与图片保留文字丢掉 URL。括号允许嵌套一层，覆盖
    // https://example.com/a(b) 这类地址；嵌套更深的会留下一个多余的 ')'。
    // 这是知情的取舍：摘要是有损的一行字，为了正确处理深层嵌套而引入一个
    // 真正的括号匹配器，性价比不成立 —— 真要完整解析就该用 remark，
    // 而那正是渲染路径已经在做的事。
    .replace(/!?\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2') // 粗体
    .replace(/(\*|_)(.*?)\1/g, '$2') // 斜体
    .replace(/`([^`]+)`/g, '$1') // 行内代码
    .replace(/~~(.*?)~~/g, '$1') // 删除线
    .replace(/\s+/g, ' ')
    .trim()
}

/** 百分比，钳到 0..100 之间——上下文占用超过 100% 时进度条不能溢出。 */
export function percent(used: number, total: number): number {
  if (!total) return 0
  return Math.min(100, Math.max(0, (used / total) * 100))
}
