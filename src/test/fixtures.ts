import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { SessionEvent } from '@/types/contract'

/**
 * 一次**真实**运行的完整事件日志。
 *
 * 来源：code-agent 后端跑 DeepSeek 真实联调时落盘的 JSONL
 * （.tmp/code-agent/sessions/th_38f99fc73eca648b.jsonl，原样复制）。
 * 463 条事件、2 个 Turn、3 次命令执行、一条 421 个 delta 的长回答。
 *
 * 用真实日志而不是手写 fixture 的价值：手写的 fixture 只覆盖我**以为**会发生的
 * 情况，而这份日志覆盖的是真正发生过的情况——包括那些我没想到的时序
 * （比如带工具调用的 Step 里根本没有 agent_message Item，因为模型那轮只吐了
 * tool_call 分片、没吐文本分片，而文本 Item 是懒创建的）。
 *
 * 注意用 process.cwd() 而不是 import.meta.url：测试跑在 jsdom 环境下，
 * import.meta.url 是 http:// 而不是 file://，fileURLToPath 会直接抛错。
 * Vitest 的工作目录是项目根，所以相对根解析是稳的。
 */
export function loadRealSession(): SessionEvent[] {
  const path = resolve(process.cwd(), 'src/test/fixtures/real-session.jsonl')
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as SessionEvent)
}
