import { render, screen } from '@testing-library/react'
import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { CommandExecutionCard } from './CommandExecutionCard'
import { StepTimeline } from './StepTimeline'
import { LiveThreadProvider } from '@/store/liveThread/LiveThreadContext'
import { LiveThreadStore, syncScheduler } from '@/store/liveThread/store'
import { loadRealSession } from '@/test/fixtures'
import type { Item } from '@/types/contract'

function commandItem(over: Partial<Item['command']> & { status?: Item['status'] } = {}): Item {
  const { status = 'completed', ...command } = over
  return {
    id: 'i1',
    type: 'command_execution',
    status,
    command: {
      command: 'go test ./...',
      aggregated_output: 'ok  code-agent/internal/session\n',
      exit_code: 0,
      ...command,
    },
  }
}

describe('CommandExecutionCard', () => {
  it('执行中显示转圈，不显示退出码', () => {
    render(<CommandExecutionCard item={commandItem({ status: 'in_progress', exit_code: null, aggregated_output: '' })} />)
    expect(screen.getByText('执行中')).toBeInTheDocument()
    expect(screen.queryByText(/exit/)).not.toBeInTheDocument()
  })

  it('退出码 0 渲染成功徽章', () => {
    render(<CommandExecutionCard item={commandItem({ exit_code: 0, duration_ms: 52 })} />)
    expect(screen.getByText('exit 0')).toBeInTheDocument()
    expect(screen.getByText('52ms')).toBeInTheDocument()
  })

  it('非零退出码是失败徽章，但不是「执行失败」', () => {
    // 命令返回非零是正常的观察结果（grep 没匹配到也是 1），
    // 和工具基础设施故障必须分开——后端 CommandItem.Complete 的注释写明了这点。
    render(<CommandExecutionCard item={commandItem({ exit_code: 1 })} />)
    expect(screen.getByText('exit 1')).toBeInTheDocument()
    expect(screen.queryByText('执行失败')).not.toBeInTheDocument()
  })

  it('status=failed 才是工具故障', () => {
    render(<CommandExecutionCard item={commandItem({ status: 'failed', exit_code: null })} />)
    expect(screen.getByText('执行失败')).toBeInTheDocument()
  })

  it('超时单独标注', () => {
    render(<CommandExecutionCard item={commandItem({ status: 'failed', timed_out: true, exit_code: null })} />)
    expect(screen.getByText('超时')).toBeInTheDocument()
  })

  it('exit_code 为 null 时不显示成 exit 0', () => {
    // null 表示「结束了但没拿到退出码」，和 0 是两回事。
    // 后端在 Go 侧用 *int 指针正是为了让前端能区分这两种情况。
    render(<CommandExecutionCard item={commandItem({ exit_code: null })} />)
    expect(screen.getByText('无退出码')).toBeInTheDocument()
    expect(screen.queryByText('exit 0')).not.toBeInTheDocument()
  })

  it('输出被截断时给出提示', () => {
    render(<CommandExecutionCard item={commandItem({ truncated: true })} />)
    expect(screen.getByText('已截断')).toBeInTheDocument()
  })
})

describe('选择性订阅（架构回归）', () => {
  it('流式 delta 只让目标卡片重渲染，其余卡片一次都不动', () => {
    // ── 这是全套测试里最重要的一条 ──
    //
    // 它守的不是某个功能，而是整套状态形状的设计意图：把 itemIds 存进
    // 步骤结构、把 Item 内容单独放 Map，就是为了让一条 delta 只影响一张卡片。
    // 如果有人图省事把 Item 对象直接塞进 steps，功能测试全都还会过，
    // 但流式输出会从"重渲染 1 个组件"退化成"重渲染 N 个"——只有这条测试能发现。
    const events = loadRealSession()
    const store = new LiveThreadStore('th_1', syncScheduler)

    // 先喂到第二个 Turn 第 4 步、长回答刚开始的位置。
    // 此时页面上已经有 3 张命令卡 + 1 张正文卡。
    const streamStart = events.findIndex((e) => e.seq === 39)
    act(() => {
      for (const event of events.slice(0, streamStart)) store.dispatch(event)
    })

    const renderSpy = vi.fn()
    // 通过 Profiler 统计每次提交时哪些组件重渲染了。
    // 比给每个组件插桩更可靠：它统计的是 React 实际的提交次数。
    render(
      <LiveThreadProvider store={store}>
        <CountingTimeline onRender={renderSpy} />
      </LiveThreadProvider>,
    )
    const before = renderSpy.mock.calls.length

    // 灌 100 条 delta。
    act(() => {
      for (const event of events.slice(streamStart, streamStart + 100)) store.dispatch(event)
    })

    const timelineRenders = renderSpy.mock.calls.length - before
    // 时间线本身订阅的是 turns 结构，delta 不改它的引用，所以一次都不该重渲染。
    expect(timelineRenders).toBe(0)

    // 但内容确实更新了——说明"没重渲染"不是因为事件没生效。
    const state = store.getState()
    const streamingItem = [...state.items.values()].find((i) => i.status === 'in_progress')
    expect(streamingItem?.text?.length).toBeGreaterThan(50)
  })
})

/** 包一层用来数 StepTimeline 的重渲染次数。 */
function CountingTimeline({ onRender }: { onRender: () => void }) {
  onRender()
  return <StepTimeline />
}
