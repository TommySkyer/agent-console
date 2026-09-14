import { FIELD_OUTPUT, FIELD_TEXT, type Item, type SessionEvent } from '@/types/contract'
import type { LiveThreadState, StepView, TurnView } from './state'

/**
 * 事件 → 状态的**唯一**转换点。
 *
 * 纯函数：不依赖 React、不依赖网络、不依赖时间。给它一串事件，它产出状态。
 * 这是整个前端唯一知道"事件如何改变状态"的地方，也是唯一需要认真测的地方。
 *
 * 这个形状是刻意照抄后端 internal/session/thread.go 的 Thread.apply：
 * 后端也把"事件如何折叠进投影"收在一个方法里，Agent、Tool、HTTP 三层都不认识
 * Event 的内部结构。前端照搬这条边界，好处一样——换渲染框架不用重写，
 * 换传输方式（比如将来改 WebSocket）也不用重写。
 */
export function applyEvent(state: LiveThreadState, event: SessionEvent): LiveThreadState {
  // ── 不变量一：幂等与缺口检测 ──
  //
  // 重复投递直接返回**同一个引用**。返回新对象会让 useSyncExternalStore
  // 判定"变了"，触发一次毫无意义的全量重渲染。
  if (event.seq <= state.lastSeq) return state

  // 中间有窟窿。追不回来（见 state.ts 对 desynced 的说明），标记后等编排层
  // 重新拉快照。标记之后仍然继续处理本条事件是错的——状态已经不自洽了，
  // 再往上叠只会把错误固化，所以这里直接返回。
  if (event.seq !== state.lastSeq + 1) {
    return state.desynced ? state : { ...state, desynced: true }
  }

  const next = reduce(state, event)
  // lastSeq 统一在这里推进，各分支不用各写一遍，也就不会漏。
  return next === state ? { ...state, lastSeq: event.seq } : { ...next, lastSeq: event.seq }
}

function reduce(state: LiveThreadState, event: SessionEvent): LiveThreadState {
  switch (event.type) {
    case 'thread.started':
      // 会话身份由快照提供，这条事件对投影没有增量信息。
      return state

    case 'turn.started': {
      const turn: TurnView = {
        id: event.turn_id ?? '',
        input: event.payload.input,
        status: 'running',
        steps: [],
      }
      return { ...state, status: 'running', turns: [...state.turns, turn], turnUsage: null }
    }

    case 'step.started': {
      const step: StepView = { index: event.payload.step, itemIds: [] }
      return updateLastTurn(state, (turn) => ({ ...turn, steps: [...turn.steps, step] }))
    }

    case 'item.started': {
      const items = new Map(state.items).set(event.payload.item.id, event.payload.item)
      const withItem = { ...state, items }

      // ── Step 归组 ──
      //
      // 优先用 Item 自带的 step（后端在 addItem 里打的显式标签），
      // 没有才退回"挂到当前最后一个 Step"的顺序推断。
      //
      // 两者的区别不只是代码长短：顺序推断依赖一条**没有被类型系统表达**的
      // 隐式契约——"item.started 一定落在它所属的 step.started 和下一个
      // step.started 之间"。这条在当前后端成立（事件在 Thread 写锁内顺序
      // emit、Seq 单调），但哪天改成并行执行工具，它会**静默出错**而不是报错。
      // 用显式字段就没有这个风险，顺序推断只作为老版本后端的兼容路径。
      return placeItem(withItem, event.payload.item)
    }

    case 'item.delta': {
      const { item_id, field, text } = event.payload
      const item = state.items.get(item_id)
      // 收到未知 item 的 delta 说明状态不自洽（正常情况下 item.started 一定先到）。
      // 静默忽略，让缺口检测去处理真正的问题。
      if (!item) return state

      let updated: Item
      if (field === FIELD_TEXT) {
        updated = { ...item, text: (item.text ?? '') + text }
      } else if (field === FIELD_OUTPUT && item.command) {
        // 当前后端从不发这个分支——命令输出不是流式的，全部内容一次性出现在
        // item.completed 里。实现它是因为协议留了这个口子（session.FieldOutput），
        // 将来后端支持命令输出流式推送时前端不用改。
        updated = {
          ...item,
          command: { ...item.command, aggregated_output: item.command.aggregated_output + text },
        }
      } else {
        return state
      }
      return { ...state, items: new Map(state.items).set(item_id, updated) }
    }

    case 'item.completed': {
      // ── 不变量二：整体替换，不是只改 status ──
      //
      // completed 的载荷里带着之前所有事件里**都不存在**的字段：命令的
      // exit_code、duration_ms、truncated、timed_out，以及正文的完整 text。
      // 只改 status 会把这些全丢掉。这一条抄自后端 apply 里的同名分支。
      return { ...state, items: new Map(state.items).set(event.payload.item.id, event.payload.item) }
    }

    case 'usage.updated': {
      return {
        ...state,
        turnUsage: event.payload.turn,
        // context_window 可能缺失（老后端、或未配置）。已经拿到过就不要被 0 覆盖。
        contextWindow: event.payload.context_window || state.contextWindow,
      }
    }

    case 'turn.completed': {
      const finished = updateLastTurn(state, (turn) => ({
        ...turn,
        status: 'completed' as const,
        finalText: event.payload.final_text,
        usage: event.payload.usage,
      }))
      return {
        ...finished,
        status: 'idle',
        turnUsage: event.payload.usage,
        sessionTokens: state.sessionTokens + event.payload.usage.total_tokens,
      }
    }

    case 'turn.failed': {
      const finished = updateLastTurn(state, (turn) => ({
        ...turn,
        status: 'failed' as const,
        usage: event.payload.usage,
        failure: { code: event.payload.code, message: event.payload.message },
      }))
      return {
        ...finished,
        status: 'idle',
        turnUsage: event.payload.usage,
        // 失败的轮次一样烧了 token，必须计入总量。
        sessionTokens: state.sessionTokens + event.payload.usage.total_tokens,
      }
    }

    case 'message.appended':
      return { ...state, messages: [...state.messages, event.payload.message] }

    default: {
      // 穷尽性检查：新增事件类型而这里漏了 case 时，TS 会报 never 不可赋值。
      // 编译期发现漏改，而不是等运行时界面少块东西。
      const never: never = event
      void never
      return state
    }
  }
}

/** 只复制"最后一个 Turn"这条路径，其余引用保持不变（结构共享）。 */
function updateLastTurn(
  state: LiveThreadState,
  update: (turn: TurnView) => TurnView,
): LiveThreadState {
  const last = state.turns[state.turns.length - 1]
  if (!last) return state
  const turns = state.turns.slice(0, -1)
  turns.push(update(last))
  return { ...state, turns }
}

/**
 * 把 Item 放进它所属的 Step。
 *
 * 兜底几种反常情况，一律不抛异常——前端因为一条意外事件白屏是最糟的失败方式：
 *   没有任何 Turn    → 塞进 historyItems，至少能看见
 *   Step 还不存在    → 按 index 插到正确的位置（保持有序）
 *   Item 没带 step   → 退回"挂到最后一个 Step"的顺序推断
 */
function placeItem(state: LiveThreadState, item: Item): LiveThreadState {
  const lastTurn = state.turns[state.turns.length - 1]
  if (!lastTurn) {
    return { ...state, historyItems: [...state.historyItems, item] }
  }

  const steps = lastTurn.steps.slice()
  // step 为 0 或缺失都当作"没带"：后端用 omitempty，0 值不会出现在 JSON 里。
  const target = item.step && item.step > 0 ? item.step : steps[steps.length - 1]?.index

  if (target === undefined) {
    // 连一个 Step 都还没有（理论上 step.started 总是先到，这里纯属防御）。
    steps.push({ index: 1, itemIds: [item.id] })
  } else {
    const position = steps.findIndex((step) => step.index === target)
    if (position >= 0) {
      steps[position] = { ...steps[position]!, itemIds: [...steps[position]!.itemIds, item.id] }
    } else {
      // 目标 Step 还没建。按 index 插到正确位置，而不是 push 到末尾 ——
      // 乱序到达时 push 会让时间线上的步骤顺序是错的。
      const insertAt = steps.findIndex((step) => step.index > target)
      const created = { index: target, itemIds: [item.id] }
      if (insertAt >= 0) steps.splice(insertAt, 0, created)
      else steps.push(created)
    }
  }

  const turns = state.turns.slice(0, -1)
  turns.push({ ...lastTurn, steps })
  return { ...state, turns }
}
