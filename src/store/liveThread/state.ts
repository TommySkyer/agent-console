import type { Item, Message, Snapshot, ThreadStatus, TurnMeta, TurnStatus, Usage } from '@/types/contract'

/**
 * 一个 Thread 的实时状态投影。
 *
 * 形状上最重要的一条：**结构与内容分离**。
 *
 *   turns → steps → itemIds(string[])        ← 结构，变化很少
 *   items: Map<string, Item>                  ← 内容，139 次/秒
 *
 * steps 里存的是 itemId 字符串而不是 Item 对象。于是一条 item.delta 只替换
 * items 这个 Map 里的一个条目，turns 这棵树的引用完全不变——渲染时间线的
 * 组件订阅 turns，整段流式输出期间一次都不重渲染；每张卡片订阅
 * items.get(myId)，只有正在流的那一张重渲染。
 *
 * 这就是"选择性订阅"的全部实现，不需要任何库，只需要把状态形状设计对。
 * 完整论证见 doc/architecture/state-and-realtime.md。
 */
export interface LiveThreadState {
  readonly threadId: string
  readonly status: ThreadStatus
  /** 已经消费到的最大序号。缺口检测与订阅起点都依赖它。 */
  readonly lastSeq: number
  /**
   * 检测到 seq 缺口。置位后编排层会重新拉快照 + 重新订阅。
   *
   * 缺口有两个真实来源：后端 subscriber.push 在队列满时丢弃事件（慢消费者
   * 不能拖死 Agent Loop）；断线太久超出了 2048 条的环形补发缓冲。
   * 两种情况前端都追不回来，唯一正确的反应就是重新同步。
   */
  readonly desynced: boolean

  // ── 结构 ──
  readonly turns: readonly TurnView[]
  /**
   * 快照带来的、无法归组的历史 Item。
   *
   * 老版本后端的 Item 不带 turn_id/step，快照是一个跨所有 Turn 的扁平数组，
   * 画不出层次（doc/backend-contract.md 缺口一）。这些 Item 单独放这里，
   * 渲染成一个折叠区块。新版后端带了归属信息，seedFromSnapshot 会正常归组，
   * 这个数组就是空的。
   */
  readonly historyItems: readonly Item[]

  // ── 内容 ──
  readonly items: ReadonlyMap<string, Item>

  // ── 度量 ──
  /** 当前（或最近一次）Turn 的累计用量。 */
  readonly turnUsage: Usage | null
  /**
   * 跨轮 token 总量，由前端在每次 turn.completed / turn.failed 时自己累加。
   *
   * 不用 Snapshot.usage 是因为那个字段在实时态和重放态语义不同
   * （doc/backend-contract.md 缺口三）。自己累加的代价是刷新页面会归零，
   * 所以 UI 上标注为"本次会话期间"。
   */
  readonly sessionTokens: number
  /** 上下文窗口上限。0 表示未知——此时不画进度条，只显示绝对值。 */
  readonly contextWindow: number

  /**
   * 模型可见的消息历史，供"Agent 内部状态"检查器展示。
   *
   * 它和 items 是两套东西：items 是给人看的展示单元，messages 是给模型看的
   * 上下文。把它显式画出来正是这个面板的意义——能看见 Agent 真正"想"的是什么，
   * 而不只是它说了什么。
   */
  readonly messages: readonly Message[]
}

export interface TurnView {
  readonly id: string
  readonly input: string
  readonly status: TurnStatus
  readonly steps: readonly StepView[]
  readonly finalText?: string
  readonly usage?: Usage
  readonly failure?: { code: string; message: string }
}

export interface StepView {
  /** 后端 step.started 给的步号，从 1 开始。 */
  readonly index: number
  readonly itemIds: readonly string[]
}

export function initialState(threadId: string): LiveThreadState {
  return {
    threadId,
    status: 'idle',
    lastSeq: 0,
    desynced: false,
    turns: [],
    historyItems: [],
    items: new Map(),
    turnUsage: null,
    sessionTokens: 0,
    contextWindow: 0,
    messages: [],
  }
}

/**
 * 用快照给 store 播种。
 *
 * 这是"快照 + 增量"里的快照那一半：拿到它之后，订阅要从 last_seq + 1 开始。
 * 顺序不能反——先订阅再拉快照会重复，拉了快照但订阅不带起点会丢事件。
 *
 * 对 Item 的归组做了版本兼容：后端带了 turn_id/step 就正常归组，
 * 没带就整体塞进 historyItems 渲染成折叠区块。
 */
export function seedFromSnapshot(snapshot: Snapshot): LiveThreadState {
  const base = initialState(snapshot.meta.id)

  // ?? [] 不是多余的防御。Go 的 encoding/json 把 nil 切片编码成 **null** 而不是
  // []，所以一个刚创建、还没跑过任何任务的会话，快照里的 items 和 turns 都是
  // null。直接 for...of 会抛 TypeError，表现为「新建会话必然白屏，但跑过任务的
  // 会话完全正常」——这个 bug 是真机上新建会话时才发现的，用有数据的 fixture
  // 测永远测不出来。
  //
  // 后端也已经改成输出 []（见 Thread.Snapshot），但前端不因为一个字段是 null
  // 就整页崩掉，这条底线要自己守住，不能指望上游永远不出错。
  const snapshotItems = snapshot.items ?? []
  const turnMetas = snapshot.turns ?? []

  const items = new Map<string, Item>()
  for (const item of snapshotItems) items.set(item.id, item)
  const knownTurnIds = new Set(turnMetas.map((turn) => turn.id))
  // 只有既有轮次元信息、又能对上号的 Item 才归得了组。
  // 对不上号的（老后端、或元信息缺失）单独走 historyItems，不硬塞。
  const groupable = snapshotItems.filter(
    (item) => item.turn_id && knownTurnIds.has(item.turn_id),
  )
  const ungrouped = snapshotItems.filter(
    (item) => !item.turn_id || !knownTurnIds.has(item.turn_id),
  )

  return {
    ...base,
    status: snapshot.status,
    lastSeq: snapshot.last_seq,
    items,
    turns: groupTurns(turnMetas, groupable),
    historyItems: ungrouped,
    // 跨轮总量从快照里的每轮用量加出来，而不是读 snapshot.usage ——
    // 后者的语义曾经在实时态和重放态不一致，前端自己加更可控。
    sessionTokens: turnMetas.reduce((sum, turn) => sum + turn.usage.total_tokens, 0),
    turnUsage: turnMetas.at(-1)?.usage ?? null,
    contextWindow: snapshot.context_window ?? 0,
  }
}

/**
 * 把轮次元信息和 Item 拼回 turns → steps → itemIds 的层次。
 *
 * 轮次的顺序以 turnMetas 为准（后端按发生顺序给），Item 只负责填进对应的槽。
 * 反过来用 Item 的出现顺序推断轮次是不可靠的：一个没产生任何 Item 的轮次
 * （比如刚开始就被取消）会整个消失。
 */
function groupTurns(turnMetas: TurnMeta[], items: Item[]): TurnView[] {
  const stepsByTurn = new Map<string, Map<number, string[]>>()

  for (const item of items) {
    let steps = stepsByTurn.get(item.turn_id!)
    if (!steps) stepsByTurn.set(item.turn_id!, (steps = new Map()))
    const step = item.step ?? 1
    const bucket = steps.get(step)
    if (bucket) bucket.push(item.id)
    else steps.set(step, [item.id])
  }

  return turnMetas.map((meta) => ({
    id: meta.id,
    input: meta.input,
    status: meta.status,
    finalText: meta.final_text,
    usage: meta.usage,
    failure: meta.failure_code
      ? { code: meta.failure_code, message: meta.failure_message ?? '' }
      : undefined,
    steps: [...(stepsByTurn.get(meta.id) ?? new Map<number, string[]>()).entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([index, itemIds]) => ({ index, itemIds })),
  }))
}
