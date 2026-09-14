import { describe, expect, it } from 'vitest'
import { applyEvent } from './apply'
import { initialState, seedFromSnapshot } from './state'
import type { LiveThreadState } from './state'
import { loadRealSession } from '@/test/fixtures'
import type { SessionEvent } from '@/types/contract'

function runAll(events: SessionEvent[], from?: LiveThreadState): LiveThreadState {
  return events.reduce(applyEvent, from ?? initialState('th_38f99fc73eca648b'))
}

describe('applyEvent — 真实会话日志', () => {
  const events = loadRealSession()

  it('日志本身符合预期形状（fixture 自检）', () => {
    // 这条测的是 fixture 而不是被测代码：fixture 哪天被换掉而下面的断言
    // 还"通过"，那些断言就失去意义了。
    expect(events).toHaveLength(463)
    expect(events[0]?.type).toBe('thread.started')
    expect(events.at(-1)?.type).toBe('turn.completed')
  })

  it('还原出 2 个 Turn，第二个有 4 个 Step', () => {
    const state = runAll(events)
    expect(state.turns).toHaveLength(2)
    expect(state.turns[0]?.steps).toHaveLength(1)
    expect(state.turns[1]?.steps).toHaveLength(4)
    expect(state.status).toBe('idle')
    expect(state.lastSeq).toBe(463)
    expect(state.desynced).toBe(false)
  })

  it('3 次命令执行都归到正确的 Step 下，且退出码为 0', () => {
    const state = runAll(events)
    const turn = state.turns[1]!

    // 前 3 步各有一次命令执行，第 4 步是最终回答。
    for (const stepIndex of [0, 1, 2]) {
      const step = turn.steps[stepIndex]!
      expect(step.index).toBe(stepIndex + 1)
      const items = step.itemIds.map((id) => state.items.get(id)!)
      expect(items).toHaveLength(1)
      expect(items[0]!.type).toBe('command_execution')
      expect(items[0]!.status).toBe('completed')
      // exit_code 必须是 0 而不是 null——null 意味着 item.completed 的
      // 整体替换没生效，只改了 status。
      expect(items[0]!.command?.exit_code).toBe(0)
      expect(items[0]!.command?.aggregated_output.length).toBeGreaterThan(0)
    }
  })

  it('带工具调用的 Step 里没有 agent_message Item', () => {
    // 模型那几轮只吐了 tool_call 分片、没吐文本分片，而文本 Item 是懒创建的
    // （aggregate.go：第一个 TextDelta 才建）。前端不能假设每个 Step 都有正文。
    const state = runAll(events)
    const step1Items = state.turns[1]!.steps[0]!.itemIds.map((id) => state.items.get(id)!)
    expect(step1Items.some((item) => item.type === 'agent_message')).toBe(false)
  })

  it('421 条 delta 拼出的全文等于 turn.completed 里的 final_text', () => {
    // 这是整套测试里最有价值的一条断言：它同时验证了增量拼接、
    // item.completed 的整体替换、以及前端对"最终回答"的理解和后端一致。
    // 而且它是从真实数据里**免费**得到的——不需要我手写任何期望值。
    const state = runAll(events)
    const turn = state.turns[1]!
    const lastStep = turn.steps[3]!
    const messageItem = lastStep.itemIds
      .map((id) => state.items.get(id)!)
      .find((item) => item.type === 'agent_message')

    expect(messageItem?.text).toBe(turn.finalText)
    expect(messageItem!.text!.length).toBeGreaterThan(400)
  })

  it('跨轮 token 总量是两轮之和', () => {
    const state = runAll(events)
    // 真实日志：第一轮 505，第二轮 7116。
    expect(state.turns[0]?.usage?.total_tokens).toBe(505)
    expect(state.turns[1]?.usage?.total_tokens).toBe(7116)
    expect(state.sessionTokens).toBe(505 + 7116)
    // 这正是后端 Snapshot.usage 在重放态给不出的那个数（契约缺口三），
    // 所以前端自己累加。
  })

  it('模型消息历史被完整重建', () => {
    const state = runAll(events)
    // 日志里 message.appended 一共 10 条。
    expect(state.messages).toHaveLength(10)
    expect(state.messages[0]?.role).toBe('user')
    // 第二轮前三步各是 assistant(带 tool_calls) + tool 一对。
    expect(state.messages.filter((m) => m.role === 'tool')).toHaveLength(3)
  })

  it('context_window 从 usage.updated 里取到', () => {
    const state = runAll(events)
    expect(state.contextWindow).toBe(128000)
  })
})

describe('applyEvent — 不变量', () => {
  const events = loadRealSession()

  it('重复事件返回同一个引用（不触发重渲染）', () => {
    const state = runAll(events.slice(0, 10))
    const again = applyEvent(state, events[5]!) // seq 6，早就消费过
    expect(again).toBe(state) // 注意是 toBe：引用相等，不是内容相等
  })

  it('seq 跳号时置 desynced，且不再改变投影', () => {
    const state = runAll(events.slice(0, 10))
    const gapped = { ...events[20]! } // 跳过 seq 11..20
    const after = applyEvent(state, gapped)

    expect(after.desynced).toBe(true)
    expect(after.lastSeq).toBe(state.lastSeq) // 没有前进
    expect(after.turns).toBe(state.turns) // 结构未被污染
    expect(after.items).toBe(state.items)
  })

  it('流式过程中 turns 引用保持不变（选择性订阅的前提）', () => {
    // 这条守的是性能架构而不是功能：turns 一变，整条时间线就要重渲染。
    // 找到那段 421 条 delta，确认它们一条都没有动过 turns 的引用。
    const upToStream = events.findIndex((e) => e.seq === 39)
    let state = runAll(events.slice(0, upToStream))
    const turnsBefore = state.turns

    let deltaCount = 0
    for (const event of events.slice(upToStream)) {
      if (event.type !== 'item.delta') break
      state = applyEvent(state, event)
      deltaCount++
    }

    expect(deltaCount).toBeGreaterThan(400)
    expect(state.turns).toBe(turnsBefore) // 引用完全没变
  })

  it('每条 delta 只替换一个 item 条目', () => {
    const upToStream = events.findIndex((e) => e.seq === 39)
    const state = runAll(events.slice(0, upToStream))
    const delta = events[upToStream]!
    const after = applyEvent(state, delta)

    expect(after.items).not.toBe(state.items) // Map 本身是新的（不可变）
    // 但除了正在流的那个，其余条目的对象引用完全没变。
    for (const [id, item] of state.items) {
      if (delta.type === 'item.delta' && id === delta.payload.item_id) continue
      expect(after.items.get(id)).toBe(item)
    }
  })
})

describe('applyEvent — Step 归组', () => {
  const base = (seq: number, type: string, payload: unknown) =>
    ({ seq, thread_id: 'th_1', turn_id: 't1', at: '2026-01-01T00:00:00Z', type, payload }) as SessionEvent

  function turnWithSteps() {
    let state = initialState('th_1')
    state = applyEvent(state, base(1, 'turn.started', { input: '任务' }))
    state = applyEvent(state, base(2, 'step.started', { step: 1 }))
    state = applyEvent(state, base(3, 'step.started', { step: 2 }))
    return state
  }

  it('优先用 Item 自带的 step，而不是"挂到最后一个"', () => {
    // 老的顺序推断会把它挂到 step 2（当前最后一个），显式字段说的是 step 1。
    const state = applyEvent(
      turnWithSteps(),
      base(4, 'item.started', {
        item: { id: 'i1', type: 'agent_message', status: 'in_progress', step: 1 },
      }),
    )
    expect(state.turns[0]?.steps[0]?.itemIds).toEqual(['i1'])
    expect(state.turns[0]?.steps[1]?.itemIds).toEqual([])
  })

  it('Item 不带 step 时退回顺序推断（老后端兼容）', () => {
    const state = applyEvent(
      turnWithSteps(),
      base(4, 'item.started', {
        item: { id: 'i1', type: 'agent_message', status: 'in_progress' },
      }),
    )
    expect(state.turns[0]?.steps[1]?.itemIds).toEqual(['i1'])
  })

  it('目标 Step 还没建时按 index 插到正确位置', () => {
    // 乱序到达时 push 到末尾会让时间线上的步骤顺序是错的。
    let state = initialState('th_1')
    state = applyEvent(state, base(1, 'turn.started', { input: '任务' }))
    state = applyEvent(state, base(2, 'step.started', { step: 3 }))
    state = applyEvent(
      state,
      base(3, 'item.started', {
        item: { id: 'i1', type: 'agent_message', status: 'in_progress', step: 1 },
      }),
    )
    expect(state.turns[0]?.steps.map((s) => s.index)).toEqual([1, 3])
  })
})

describe('seedFromSnapshot', () => {
  it('items 和 turns 是 null 时不崩（刚创建的空会话）', () => {
    // Go 把 nil 切片编码成 null。新建会话的快照就是 {items: null, turns: null}。
    // 这条是真机上新建会话白屏之后补的——有数据的 fixture 永远测不出来。
    const state = seedFromSnapshot({
      meta: { id: 'th_new', workspace: '/tmp', created_at: '2026-01-01T00:00:00Z' },
      status: 'idle',
      last_seq: 0,
      items: null,
      turns: null,
      usage: {
        uncached_input_tokens: 0, cache_read_tokens: 0, output_tokens: 0,
        reasoning_tokens: 0, total_tokens: 0, model_calls: 0,
      },
    })
    expect(state.turns).toHaveLength(0)
    expect(state.historyItems).toHaveLength(0)
    expect(state.items.size).toBe(0)
    expect(state.sessionTokens).toBe(0)
  })

  it('老后端（无 turns、Item 不带 turn_id）时全部落到 historyItems', () => {
    const state = seedFromSnapshot({
      meta: { id: 'th_1', workspace: '/tmp', created_at: '2026-01-01T00:00:00Z' },
      status: 'idle',
      last_seq: 42,
      items: [
        { id: 'i1', type: 'agent_message', status: 'completed', text: 'hi' },
        { id: 'i2', type: 'command_execution', status: 'completed' },
      ],
      usage: {
        uncached_input_tokens: 1, cache_read_tokens: 0, output_tokens: 2,
        reasoning_tokens: 0, total_tokens: 3, model_calls: 1,
      },
    })
    expect(state.turns).toHaveLength(0)
    expect(state.historyItems).toHaveLength(2)
    expect(state.lastSeq).toBe(42)
    expect(state.contextWindow).toBe(0) // 缺口二：快照不带上限时未知
  })

  it('新后端带 turns 时还原出完整层次与输入文本', () => {
    const usage = (total: number) => ({
      uncached_input_tokens: 1, cache_read_tokens: 0, output_tokens: 2,
      reasoning_tokens: 0, total_tokens: total, model_calls: 1,
    })
    const state = seedFromSnapshot({
      meta: { id: 'th_1', workspace: '/tmp', created_at: '2026-01-01T00:00:00Z' },
      status: 'idle',
      last_seq: 9,
      context_window: 128000,
      turns: [
        { id: 't1', input: '看看目录', status: 'completed', started_at: '2026-01-01T00:00:00Z',
          usage: usage(100), final_text: 'ok' },
        { id: 't2', input: '再说一遍', status: 'failed', started_at: '2026-01-01T00:01:00Z',
          usage: usage(50), failure_code: 'cancelled', failure_message: 'ctx canceled' },
      ],
      items: [
        { id: 'i1', type: 'command_execution', status: 'completed', turn_id: 't1', step: 1 },
        { id: 'i2', type: 'agent_message', status: 'completed', turn_id: 't1', step: 2, text: 'ok' },
        { id: 'i3', type: 'agent_message', status: 'completed', turn_id: 't2', step: 1, text: 'yo' },
      ],
      usage: usage(150),
    })
    expect(state.historyItems).toHaveLength(0)
    expect(state.turns).toHaveLength(2)
    // 输入文本现在能从快照还原，不再显示"历史轮次"。
    expect(state.turns[0]?.input).toBe('看看目录')
    expect(state.turns[0]?.steps).toHaveLength(2)
    expect(state.turns[1]?.status).toBe('failed')
    expect(state.turns[1]?.failure?.code).toBe('cancelled')
    // 跨轮总量由每轮用量加出来，不读 snapshot.usage。
    expect(state.sessionTokens).toBe(150)
    expect(state.contextWindow).toBe(128000)
  })

  it('有轮次但一个 Item 都没有时，轮次本身不会消失', () => {
    // 刚开始就被取消的轮次不产生任何 Item。用 Item 的出现顺序推断轮次
    // 会让它整个消失，所以顺序必须以 turns 为准。
    const state = seedFromSnapshot({
      meta: { id: 'th_1', workspace: '/tmp', created_at: '2026-01-01T00:00:00Z' },
      status: 'idle',
      last_seq: 3,
      turns: [
        { id: 't1', input: '立刻取消', status: 'failed', started_at: '2026-01-01T00:00:00Z',
          usage: { uncached_input_tokens: 0, cache_read_tokens: 0, output_tokens: 0,
                   reasoning_tokens: 0, total_tokens: 0, model_calls: 0 },
          failure_code: 'cancelled' },
      ],
      items: [],
      usage: { uncached_input_tokens: 0, cache_read_tokens: 0, output_tokens: 0,
               reasoning_tokens: 0, total_tokens: 0, model_calls: 0 },
    })
    expect(state.turns).toHaveLength(1)
    expect(state.turns[0]?.steps).toHaveLength(0)
  })
})
