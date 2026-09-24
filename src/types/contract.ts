/**
 * 后端契约的 TypeScript 镜像。
 *
 * 这个文件里的每一个类型都与 Go 结构体逐字段对应，**不做任何重命名或转换**：
 *   Item / CommandExecution / Usage / Meta / Snapshot  ← internal/session/item.go
 *   Event / Payload 各变体                              ← internal/session/event.go
 *   Message / ToolCall                                  ← internal/model/message.go
 *
 * 保持字段名一致（含 snake_case）是刻意的。前端不做驼峰转换，因为那需要一层映射
 * 代码，而映射代码是纯粹的负担：它会漂移、要测试、出错时还难定位。字段名不一致
 * 带来的唯一成本是看起来不像"前端风格"，这个成本远小于维护一层转换。
 *
 * 详细的契约说明（含实测数据与四处缺口）见 doc/backend-contract.md。
 */

// ── 展示单元 ────────────────────────────────────────────────────────────

/** 对齐 session.ItemType。将来后端加 file_change / todo_list 时这里跟着加。 */
export type ItemType = 'agent_message' | 'reasoning' | 'command_execution'

/** 对齐 session.ItemStatus。 */
export type ItemStatus = 'in_progress' | 'completed' | 'failed'

/** 对齐 session.CommandExecution。 */
export interface CommandExecution {
  command: string
  aggregated_output: string
  /**
   * null 表示「命令还没结束」，不是「结束了且返回 0」。
   *
   * 后端在 Go 侧用的是 *int 指针正是为了表达这个区别：用值类型的话，
   * 前端无法区分成功和未完成。渲染时必须先判 null 再判 0。
   */
  exit_code: number | null
  duration_ms?: number
  /** 输出超长被截断。后端 bash 工具上报。 */
  truncated?: boolean
  /** 命令超时被杀。 */
  timed_out?: boolean
}

/**
 * 对齐 session.Item。
 *
 * 注意这是「带可选字段的结构体」而不是可辨识联合：后端 Go 侧就是这个形状
 * （Text 和 Command 都是 omitempty），前端如果强行收窄成联合类型，
 * 反而要写额外的窄化代码。按 type 分支时用 item.command 判空即可。
 */
export interface Item {
  id: string
  type: ItemType
  status: ItemStatus
  /** 用于 agent_message 与 reasoning。 */
  text?: string
  /** 只在 command_execution 上出现。 */
  command?: CommandExecution
  /**
   * 以下两个字段是后端补充的（见 doc/backend-contract.md 缺口一）。
   * 老版本后端的快照里没有它们，所以标成可选并在前端做兜底。
   */
  turn_id?: string
  step?: number
}

/** 对齐 session.Usage。输入侧拆成两项是为了能算出真实成本（命中缓存计价更低）。 */
export interface Usage {
  uncached_input_tokens: number
  cache_read_tokens: number
  output_tokens: number
  reasoning_tokens: number
  total_tokens: number
  /** 本 Turn 发起的模型调用次数，等于 Step 数。 */
  model_calls: number
}

/** 对齐 session.Meta。 */
export interface Meta {
  id: string
  workspace: string
  title?: string
  created_at: string
}

/** 对齐 session.Status。回答「现在能不能接受新输入」。 */
export type ThreadStatus = 'idle' | 'running'

/** 对齐 session.TurnStatus。回答「这一轮的结局是什么」，是历史的一部分。 */
export type TurnStatus = 'running' | 'completed' | 'failed'

/**
 * 对齐 session.TurnMeta。
 *
 * 有了它，快照才能还原出「第几轮、问了什么、结局如何」，而不只是一串
 * 没有上下文的 Item。刷新页面和一直开着看到的东西因此是同一份。
 */
export interface TurnMeta {
  id: string
  input: string
  status: TurnStatus
  started_at: string
  usage: Usage
  final_text?: string
  /** 稳定的机器可读原因码，客户端据此分支，不解析 failure_message。 */
  failure_code?: string
  failure_message?: string
}

/**
 * 对齐 session.Snapshot。
 *
 * last_seq 是这份快照的核心：客户端拿它作为订阅起点。
 * 先订阅再拉快照会重复，拉了快照但订阅不带起点会丢事件。
 */
export interface Snapshot {
  meta: Meta
  status: ThreadStatus
  /**
   * 可能是 null：Go 的 encoding/json 把 nil 切片编码成 null，
   * 刚创建、还没跑过任务的会话就是这种情况。seedFromSnapshot 里有兜底。
   */
  items: Item[] | null
  /** 老版本后端没有这个字段；新后端在空会话时可能是 null。 */
  turns?: TurnMeta[] | null
  last_seq: number
  usage: Usage
  /** 非空表示事件日志有缺口，这份历史不完整。 */
  persist_error?: string
  /** 后端补充字段（缺口二）。0 或缺失表示未知。 */
  context_window?: number
}

/**
 * 对齐 httpapi.configResponse（GET /api/config）。
 *
 * 需要这个端点是因为「工作目录可以填哪些」是**服务端的策略**，客户端猜不出来。
 * 没有它的话前端只能让用户盲填一个路径，填错了才收到 400。
 */
export interface ServerConfig {
  /** 服务启动时声明的根目录。会话的工作目录必须是它或它的子目录。 */
  workspace_root: string
  /** 为 true 时服务端放弃了边界检查，任意已存在的目录都可以。 */
  allow_any_workspace: boolean
}

// ── 模型消息 ────────────────────────────────────────────────────────────

export type Role = 'system' | 'user' | 'assistant' | 'tool'

export interface ToolCall {
  id: string
  name: string
  /** 工具参数的 JSON 原文。Model 层不解析它，前端展示时才 try-parse。 */
  arguments: string
}

export interface Message {
  role: Role
  content: string
  reasoning_content?: string
  tool_calls?: ToolCall[]
  tool_call_id?: string
}

/** 服务端按实际 Agent 请求组装逻辑生成；messages 尚未包含下一条用户输入。 */
export interface ModelContext {
  model: string
  messages: Message[]
  tools: { name: string; description: string; parameters: unknown }[]
  max_tokens: number
  reasoning_effort: string
  context_window: number
  last_model_input_tokens: number | null
  status: ThreadStatus
  last_seq: number
  wire_request?: unknown
}

// ── 事件协议 ────────────────────────────────────────────────────────────

export type EventType =
  | 'thread.started'
  | 'turn.started'
  | 'turn.completed'
  | 'turn.failed'
  | 'step.started'
  | 'item.started'
  | 'item.delta'
  | 'item.completed'
  | 'usage.updated'
  | 'message.appended'

/** item.delta 的 field 取值。对齐 session.FieldText / FieldOutput。 */
export const FIELD_TEXT = 'text'
export const FIELD_OUTPUT = 'output'

/**
 * 事件信封的公共部分。
 *
 * seq 在一个 Thread 内单调递增，从 1 开始。它是断线重连的**全部**依据：
 * SSE 把它写进 id 行，浏览器 EventSource 重连时自动带 Last-Event-ID。
 */
interface EventBase {
  seq: number
  thread_id: string
  /** Thread 级事件（thread.started）为空。 */
  turn_id?: string
  at: string
}

/**
 * 可辨识联合（discriminated union），判别字段是 `type`。
 *
 * 这是 TypeScript 里最接近 Go sealed interface 的表达：后端用未导出的
 * isPayload() 方法把外部类型挡在 Payload 之外，前端用联合类型达到同样效果——
 * switch (event.type) 时 TS 会把 payload 自动收窄到对应的具体形状，
 * 漏写一个 case 且函数有返回值类型时编译期就能发现。
 */
export type SessionEvent =
  | (EventBase & { type: 'thread.started'; payload: { meta: Meta } })
  | (EventBase & { type: 'turn.started'; payload: { input: string } })
  | (EventBase & { type: 'turn.completed'; payload: { usage: Usage; final_text: string } })
  | (EventBase & { type: 'turn.failed'; payload: { code: string; message: string; usage: Usage } })
  | (EventBase & { type: 'step.started'; payload: { step: number } })
  | (EventBase & { type: 'item.started'; payload: { item: Item } })
  | (EventBase & { type: 'item.delta'; payload: { item_id: string; field: string; text: string } })
  | (EventBase & { type: 'item.completed'; payload: { item: Item } })
  | (EventBase & {
      type: 'usage.updated'
      payload: { turn: Usage; delta: Usage; context_window?: number }
    })
  | (EventBase & { type: 'message.appended'; payload: { message: Message } })

/** 供 realtime 层逐个 addEventListener 用。顺序无关紧要，但必须与后端完全一致。 */
export const EVENT_TYPES: EventType[] = [
  'thread.started',
  'turn.started',
  'turn.completed',
  'turn.failed',
  'step.started',
  'item.started',
  'item.delta',
  'item.completed',
  'usage.updated',
  'message.appended',
]

// ── Turn 失败原因码（对齐 agent/errors.go） ────────────────────────────

export const TURN_FAILURE_CODES = {
  max_steps: '达到步数上限',
  /** 不是 Agent 报的，是重放时发现「这一轮没有终态事件」补上的。 */
  interrupted: '服务重启中断',
  wall_clock: '执行超时',
  max_tokens: '模型输出被截断',
  provider_error: '模型服务异常',
  tool_failure: '工具执行失败',
  cancelled: '已取消',
} as const

export type TurnFailureCode = keyof typeof TURN_FAILURE_CODES
