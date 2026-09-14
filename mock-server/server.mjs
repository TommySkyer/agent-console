/**
 * 协议级 Mock 后端。
 *
 * 它把一份**真实**的会话日志（src/test/fixtures/real-session.jsonl）按原始时间
 * 间隔通过 SSE 回放出来，接口形状与 Go 后端完全一致。
 *
 * 为什么值得写：
 *   1. 不烧 API 额度，也不需要配 DEEPSEEK_API_KEY 就能开发前端。
 *   2. 能**按需制造**真实后端很难复现的情况：丢事件（验证 seq 缺口自检）、
 *      中途断流（验证 EventSource 自动重连 + Last-Event-ID 续传）。
 *      指望真实模型恰好在你想要的时刻出错是不现实的。
 *   3. 回放速度可调，1 倍速看流式效果，20 倍速跑回归。
 *
 * 用法：
 *   node mock-server/server.mjs            # 默认 8080，1 倍速
 *   MOCK_SPEED=10 node mock-server/server.mjs
 *   MOCK_DROP=1 node mock-server/server.mjs   # 随机丢事件，逼出重新同步
 */
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.MOCK_PORT ?? 8080)
const SPEED = Number(process.env.MOCK_SPEED ?? 1)
const DROP = process.env.MOCK_DROP === '1'

const events = readFileSync(resolve(here, '../src/test/fixtures/real-session.jsonl'), 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line))

const THREAD_ID = events[0].payload.meta.id
const META = events[0].payload.meta

/** 把事件折叠成快照。逻辑与后端 Thread.apply 等价——mock 也不能凭空编状态。 */
function snapshotAt(upTo) {
  const items = new Map()
  const turns = []
  let usage = null
  let step = 0
  for (const event of events.slice(0, upTo)) {
    const p = event.payload
    switch (event.type) {
      case 'turn.started':
        step = 0
        turns.push({ id: event.turn_id, input: p.input, status: 'running', started_at: event.at, usage: {} })
        break
      case 'turn.completed':
        Object.assign(turns.at(-1), { status: 'completed', final_text: p.final_text, usage: p.usage })
        break
      case 'turn.failed':
        Object.assign(turns.at(-1), { status: 'failed', failure_code: p.code, usage: p.usage })
        break
      case 'step.started':
        step = p.step
        break
      case 'item.started':
        items.set(p.item.id, { ...p.item, turn_id: event.turn_id, step })
        break
      case 'item.delta': {
        const item = items.get(p.item_id)
        if (item) item.text = (item.text ?? '') + p.text
        break
      }
      case 'item.completed':
        items.set(p.item.id, { ...items.get(p.item.id), ...p.item })
        break
      case 'usage.updated':
        usage = p.turn
        break
    }
  }
  return {
    meta: META,
    status: 'idle',
    items: [...items.values()],
    turns,
    last_seq: upTo === 0 ? 0 : events[upTo - 1].seq,
    usage: usage ?? { uncached_input_tokens: 0, cache_read_tokens: 0, output_tokens: 0, reasoning_tokens: 0, total_tokens: 0, model_calls: 0 },
    context_window: 128000,
  }
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
  res.end(JSON.stringify(body))
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const path = url.pathname

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Last-Event-ID',
    })
    return res.end()
  }

  if (path === '/api/health') return json(res, 200, { status: 'ok' })
  if (path === '/api/threads' && req.method === 'GET') return json(res, 200, { threads: [META] })
  if (path === `/api/threads/${THREAD_ID}`) return json(res, 200, snapshotAt(0))

  if (path === `/api/threads/${THREAD_ID}/events`) {
    // 与后端 resolveFromSeq 同构：Last-Event-ID 是「已收到 N」，from_seq 是「想要 N」。
    const header = req.headers['last-event-id']
    const fromSeq = header ? Number(header) + 1 : Number(url.searchParams.get('from_seq') ?? 1)

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
    })
    // 立刻写一行注释：很多代理拿到第一个响应体字节之前不转发响应头，
    // 不写的话浏览器会一直停在 CONNECTING。后端也是这么做的。
    res.write(': connected\n\n')

    let closed = false
    req.on('close', () => { closed = true })

    const pending = events.filter((e) => e.seq >= fromSeq)
    let previous = pending.length ? new Date(pending[0].at).getTime() : 0

    for (const event of pending) {
      if (closed) return
      const gap = new Date(event.at).getTime() - previous
      previous = new Date(event.at).getTime()
      if (gap > 0) await new Promise((r) => setTimeout(r, Math.min(gap, 2000) / SPEED))

      // 故意丢事件，用来验证前端的 seq 缺口自检与重新同步。
      if (DROP && event.type === 'item.delta' && Math.random() < 0.01) {
        console.log(`  dropped seq ${event.seq}（前端应当检测到缺口并重新拉快照）`)
        continue
      }
      res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    }
    return // 放完就结束，浏览器会自动重连并带上 Last-Event-ID
  }

  json(res, 404, { error: { code: 'thread_not_found', message: 'mock 只提供固定会话' } })
}).listen(PORT, () => {
  console.log(`mock 后端已启动  http://localhost:${PORT}`)
  console.log(`  会话 ${THREAD_ID} · ${events.length} 条事件 · ${SPEED}x 速度${DROP ? ' · 随机丢包' : ''}`)
})
