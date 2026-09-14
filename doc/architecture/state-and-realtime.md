# 状态模型与实时层

这是整个前端唯一有难度的地方。读完这篇应当能回答三个问题：为什么这个项目里有**三套**状态机制而不是一套、为什么实时那一套没有用 Context 也没有用 Redux、以及一条 SSE 事件到底怎么变成界面上会动的卡片。

前置阅读：[后端契约实录](../backend-contract.md)。这篇里所有的数字和约束都来自那一篇，不重复论证。

## 一、为什么是三套机制

新手最容易犯的错是"引一个状态库，所有状态都塞进去"。这个项目里那样做一定会出问题，因为这里的状态有三种性质完全不同的东西：

| 类别 | 例子 | 变化频率 | 谁是权威 | 机制 |
|---|---|---|---|---|
| **服务端资源** | 会话列表、快照 | 低，用户操作驱动 | 服务器 | TanStack Query |
| **实时事件投影** | items / steps / usage | **139 次/秒** | 服务器的事件流 | 自建 store + `useSyncExternalStore` |
| **纯 UI 状态** | 输入框文本、卡片折叠 | 中，用户交互驱动 | 浏览器 | `useState` / `useReducer` |

另有第四类，它不是"状态"而是"依赖"：`ApiClient` 实例、Toast 派发函数。这类用 **Context**。

判断一条状态属于哪一类，问一个问题：**"刷新页面之后，这个值应该从哪来？"**

- 从服务器重新请求 → 服务端资源，交给 Query。
- 从服务器的事件流重放 → 实时投影，交给 live store。
- 回到默认值就行 → UI 状态，`useState`。
- 它根本不是值，是一个对象/函数 → 依赖，Context。

这个判据的好处是它不依赖直觉。下面逐个说为什么不能合并。

### 为什么实时投影不能交给 TanStack Query

Query 的心智模型是「一个 key 对应一次请求的结果，可以缓存、失效、重试、去重」。它假设**同一个 key 重新取一次能得到完整的当前值**。

事件流不满足这个假设。`item.delta` 只带增量，单独一条毫无意义；它们的值依赖于此前所有事件。"重新请求一次"对一条 SSE 流来说也不成立——重连要带 `from_seq`，语义是"接着上次"，不是"重来"。

硬塞进 Query 的话，得在 `queryFn` 外面用 `setQueryData` 手动打补丁，等于把 Query 当成一个全局变量用，它的缓存、失效、重试全部失效甚至碍事。

**但快照本身是标准的请求-响应**，所以 `GET /threads/{id}` 归 Query 管，它取回来的结果用来给 live store 播种。两者的接缝在 `useThreadLive` 里，见第四节。

### 为什么实时投影不能用 Context

这是本项目最重要的一条性能判断，它有实测数据支撑。

React Context 的语义是：**Provider 的 `value` 引用一变，所有 `useContext` 的组件无差别重渲染**，没有选择性订阅，`memo` 也挡不住（`memo` 比较的是 props，而 Context 是绕过 props 传进去的）。

而实测下来流式输出是 **139 条 delta/秒**（真实日志里 421 条 delta 用了 3.02 秒，平均每条 1.98 个字符）。一个跑了几步的面板上有几十张卡片。把投影放进 Context 意味着：

```
139 次/秒 × 全部卡片重渲染 = 掉帧、输入框卡顿、风扇起飞
```

而实际上每条 delta 只改**一张**卡片的文本。

Context 不是不能用，是**不能用来装高频变化的值**。它在本项目里的正确用途见第五节。

### 为什么不用 Redux / Zustand

Redux 的核心价值是 action 日志 + devtools 时间旅行 + 中间件生态。这里的 reducer 不是被用户 dispatch 驱动的，是被服务器事件流驱动的；而"事件序列 → 状态"的可回放性后端已经用 JSONL 做掉了，前端再复制一份收益很小，却要引入 action creator、slice、middleware 一整套仪式。

Zustand 是合适的，本来就是这个场景的标准答案。这里没用它只有一个原因：**这个 store 加上 rAF 合并逻辑总共约 90 行，而 `useSyncExternalStore` 正是 Zustand 内部用的那个 React 官方原语。** 自己写一遍能完全讲清楚每一行，也能把合并逻辑直接写进 store 而不是包一层 middleware。

什么情况下应该换成 Zustand：需要多个互相引用的 store、需要 devtools、需要持久化中间件。目前一个都不需要。这是个可以随时反悔的决定——`useLiveThread` 这个 hook 的签名和 Zustand 的 `useStore(selector)` 一模一样，换实现不影响任何组件。

## 二、状态形状：结构与内容分离

这是让"139 次/秒"变得无所谓的关键一招。

```ts
interface LiveThreadState {
  status: 'idle' | 'running'
  lastSeq: number
  desynced: boolean              // 检测到 seq 缺口，需要重新同步

  // ── 结构：变化很少 ──
  turns: TurnView[]              // 每个 turn 内是 steps，每个 step 内只存 itemId
  historyItems: Item[]           // 快照带来的、无法归组的历史（契约缺口一）

  // ── 内容：变化极频繁 ──
  items: ReadonlyMap<string, Item>

  // ── 度量 ──
  turnUsage: Usage | null        // 当前/最近一轮累计
  sessionTokens: number          // 前端自己累加的跨轮总量（契约缺口三）
  contextWindow: number          // 0 表示未知（契约缺口二）
  lastFailure: { code: string; message: string } | null
}

interface TurnView {
  id: string
  input: string
  status: 'running' | 'completed' | 'failed'
  steps: { index: number; itemIds: string[] }[]
  finalText?: string
}
```

要点是 **`steps` 里存的是 `itemId` 字符串，不是 Item 对象**。于是：

- 一条 `item.delta` 只替换 `items` 这个 Map 里的**一个**条目，`turns` 这棵树的引用**完全不变**。
- 渲染时间线的组件订阅 `state.turns`，它在整段流式输出期间引用稳定，**一次都不重渲染**。
- 每张卡片订阅 `state.items.get(myId)`，只有正在流的那一张引用变了，**只有它重渲染**。

这就是"选择性订阅"的全部内容。它不需要任何库，只需要把状态形状设计对。

## 三、reducer：一个纯函数

```ts
// store/liveThread/apply.ts
export function applyEvent(state: LiveThreadState, event: SessionEvent): LiveThreadState
```

不依赖 React、不依赖网络、不依赖时间。给它一串事件，它产出状态。这是整个前端**唯一**知道"事件如何改变状态"的地方，也是唯一需要认真测的地方。

这个形状是刻意照抄后端的 `Thread.apply`（`internal/session/thread.go`）。后端也是把"事件如何折叠进投影"收在一个方法里，Agent、Tool、HTTP 三层都不认识 `Event` 的内部结构。前端照搬这条边界，带来的好处一模一样：**换渲染框架不用重写，换传输方式不用重写。**

### 两条不变量

**幂等与缺口检测。** 每条事件进来先过这一关：

```ts
if (event.seq <= state.lastSeq) return state            // 重复投递，原样返回
if (event.seq !== state.lastSeq + 1) {                   // 中间有缺口
  return { ...state, desynced: true }                    // 标记，等待重新同步
}
```

`return state`（同一个引用）很重要：`useSyncExternalStore` 靠引用比较决定要不要重渲染，返回新对象会造成一次无意义的全量重渲染。

缺口为什么会发生，有两个真实来源，都在契约文档里有据可查：后端 `subscriber.push` 在队列满时会**丢弃事件并计数**（慢消费者不能拖死 Agent Loop）；以及断线太久超出了 2048 条的环形缓冲。两种情况前端都追不回来，唯一正确的反应是重新拉快照，见第四节。

**`item.completed` 整体替换。** 不能只改 status：

```ts
case 'item.completed':
  next.items = new Map(state.items).set(p.item.id, p.item)   // 整体替换
```

因为 completed 的载荷里带着之前所有事件里**都不存在**的字段——命令的 `exit_code`、`duration_ms`、`truncated`、`timed_out`，以及正文的完整 `text`。这条同样是抄后端 `apply` 里的同名分支，后端注释写得很清楚。

### Step 归组：从隐式契约改成显式字段

这一处值得完整讲，因为它展示了"发现隐式假设 → 消除它"的过程。

**最初的做法**：后端的 `step.started` 只带 `{step: N}`，`item.started` 只带完整 Item，两者互相不带对方的 ID，Item 结构体上也没有 `step` 字段。所以归组只能靠顺序——收到 `step.started` 时记住当前步号，之后每个 `item.started` 都归到这一步下。

这成立的前提是"`item.started` 一定落在它所属的 `step.started` 和下一个 `step.started` 之间"。这条在真实日志里逐条验证过，也有后端机制保证（事件在 Thread 的写锁内顺序 emit、Seq 单调）。

**但它是一条被依赖、却没有被类型系统表达的隐式契约。** 哪天后端改成并行执行工具，这里会**静默出错**而不是报错——界面上步骤归错了组，没有任何报错，也没有任何测试会失败。这类地方正是 Code Review 该追问的。

**现在的做法**：后端在 `addItem` 里给每个 Item 打上 `TurnID` 和 `Step`（见[后端契约实录](../backend-contract.md)缺口一），reducer 优先用这个显式字段：

```ts
const target = item.step && item.step > 0 ? item.step : steps[steps.length - 1]?.index
```

顺序推断降级为**老版本后端的兼容路径**。两条路径都有测试覆盖——真实日志那份 fixture 写于后端改动之前，所以它天然在测兼容路径；显式路径另有专门的用例（含"目标 Step 还没建时按 index 插到正确位置"，防止乱序到达把步骤顺序弄反）。

值得注意的是：**问题是在写前端时发现的，但正确的修法在后端。** 前端能用顺序凑合，但那是把一个本该由数据表达的事实，改成由时序假设推断。

### 关于不可变性的代价

`applyEvent` 是纯函数，每条 delta 都 `new Map(state.items)`。粗看是 O(n)：139 次/秒 × 几十个条目。

实测算过这笔账：50 个条目的 Map 复制约 2µs，139 次/秒约合 0.3ms/秒 的 CPU，可以忽略。换来的是可测试性和 `useSyncExternalStore` 需要的引用语义。

**这是一个知情的取舍，不是没想到。** 真到了瓶颈（比如 items 上千），做法是把 Map 改成可变容器、只保证 Item 对象本身不可变——因为选择器只用 `.get(id)`，从不整体读 Map。那时再改，不需要动组件。

## 四、编排：`useThreadLive`

`api/`、`realtime/`、`store/` 三层都不认识彼此。把它们缝起来的是一个自定义 Hook：

```
useThreadLive(threadId)
  ①  React Query 拉 GET /threads/{id}  →  snapshot
  ②  用 snapshot 给 store 播种（items 进 historyItems，记下 last_seq）
  ③  EventSource 订阅 ?from_seq=last_seq+1
  ④  每条事件 → store.dispatch(event) → applyEvent
  ⑤  desynced 变 true → 回到 ①（invalidate + 重新播种 + 重新订阅）
  ⑥  卸载 → 关闭 EventSource
```

四个细节值得单独说。

**顺序不能反。** 先订阅后拉快照，两次请求之间产生的事件会被快照包含、又被流重发一次；先拉快照但订阅不带起点，中间的事件就直接丢了。后端文档把这两条列为"这套设计能自洽的前提"，前端这里是它的兑现处。

**`+1` 在前端做。** 后端 `resolveFromSeq` 里 `from_seq` 的语义是"我想要的第一个序号"（直接用），而 `Last-Event-ID` 的语义是"我已经收到了 N"（用 N+1）。前端拿到的 `last_seq` 是"已经收到了"，所以传 `last_seq + 1`。

**首连必须用 query 参数，因为拿不到 `Last-Event-ID`。** 原生 `EventSource` 在建连时**无法自定义任何请求头**——这是它相比 `fetch` 最大的限制。`Last-Event-ID` 是浏览器在自动重连时才加上的。所以 `?from_seq=` 不是可有可无的兜底，它是首连唯一的入口。断线重连之后浏览器会自动带头，那条路径前端一行代码都不用写。

**store 实例用 ref 而不是 useMemo。** `useMemo` 在 React 的契约里是性能提示，允许被丢弃重算。丢一个缓存的计算结果无所谓，丢一个正在被订阅的 store 会让已收到的事件凭空消失。用 ref 在渲染期做幂等的初始化（同样的 threadId 进来结果完全一样，重入安全）。

**StrictMode 下 effect 会跑两次。** React 18 开发模式故意 mount → unmount → mount，用来暴露没写清理函数的副作用。这里如果不在 cleanup 里 `source.close()`，开发环境会留下两条 SSE 连接，且两条都在往同一个 store 里灌事件——第二条的事件会因为 seq 重复被 reducer 丢弃，于是表现为"偶尔丢字"而不是明显报错。清理函数不是可选项。

## 五、Context 的正确用途

上面论证了 Context 不能装高频状态。那它装什么？

**装依赖，不装状态。** 本项目里两处：

```tsx
<ApiClientProvider client={apiClient}>   // 实例整个生命周期不变
  <ToastProvider>                         // 只往下传 showToast 函数
```

`ApiClientProvider` 是标准的依赖注入：组件不 `import` 一个全局单例，而是从 Context 拿。好处是测试时可以注入假的 client，不用 mock 模块。这和后端把 `Model`、`Store` 作为接口注入 `Agent`、而不是在 `Agent` 里直接 `new` 是同一个思路。

Toast 这里用了一个值得讲的技巧——**把 value 和 dispatch 拆成两个 Context**：

```tsx
<ToastStateContext.Provider value={toasts}>       // 只有渲染 Toast 列表的组件订阅
  <ToastDispatchContext.Provider value={show}>    // show 用 useCallback 锁住，引用永不变
```

不拆的话，每弹一个 toast，所有"只想调用 `showToast`"的组件都会跟着重渲染——它们根本不关心当前有哪些 toast。拆开之后 dispatch 那个 Context 的 value 引用永远不变，订阅它的组件一次都不会因为 toast 变化而重渲染。

这是 Context 的经典优化手法，也是"Context 的 value 变化会让所有 consumer 重渲染"这条规则的直接推论。

## 六、渲染节流：rAF 合并

即便做到了"只有一张卡片重渲染"，139 次/秒仍然意味着 React 每秒被唤醒 139 次。屏幕只有 60Hz，多出来的都是白干。

store 的做法是**写入同步、通知合并**：

```ts
dispatch(event) {
  this.state = applyEvent(this.state, event)     // 状态立刻更新，永不滞后
  if (event.type === 'item.delta') this.scheduleNotify()  // 通知合并到下一帧
  else this.notifyNow()                           // 其它事件立刻通知
}
```

只对 `item.delta` 合并，规则简单到不会记错。其它事件（`step.started`、`item.completed`、`turn.completed`）都是低频的状态跃迁，立刻通知，界面响应不打折。

两个必须想清楚的点：

**会不会读到旧值？** 不会。`state` 是同步更新的，`getSnapshot()` 读的永远是最新值。合并影响的只是"什么时候叫 React 来读"，不影响"读到什么"。

**标签页切到后台怎么办？** `requestAnimationFrame` 在后台标签页不触发，所以不会通知 React。但事件照收、状态照更新（`dispatch` 里那一行是同步的）。切回来时 rAF 恢复，界面一次性追上。这正是想要的行为——后台标签页本来就不该花 CPU 渲染。

调度器是可注入的，测试里换成同步执行，断言就不用 `await` 帧。

## 七、为什么是 `useSyncExternalStore` 而不是 `useState` + `useEffect`

这是本篇最后一个、也是最容易被追问的点。

朴素写法是这样：

```tsx
const [state, setState] = useState(initial)
useEffect(() => store.subscribe(() => setState(store.getState())), [])
```

它在 React 18 的并发渲染下有一个真实缺陷，叫 **tearing（撕裂）**：并发渲染允许 React 渲染到一半让出主线程。如果外部 store 恰好在这个间隙变了，已经渲染完的组件用的是旧值、还没渲染的用的是新值，**同一帧里画出两个不一致的状态**。

`useSyncExternalStore` 就是 React 18 为这个问题提供的官方原语：它在渲染期间检查 store 是否变过，变了就丢弃这次渲染重来，保证一帧内所有组件读到同一个版本。

它有一个必须记住的使用约束：**`getSnapshot` 返回的值必须引用稳定**。写成这样会无限循环：

```ts
useLiveThread(s => s.turns.map(t => t.id))   // ✗ 每次调用都返回新数组
```

React 每次渲染都会调用 `getSnapshot` 比较引用，新数组永远不等于上一个，于是判定"又变了"，无限重渲染。

所以本项目的选择器只允许两种返回值：**原始值**（number / string / boolean），或者**由 reducer 保证结构共享的对象引用**（`state.turns`、`state.items.get(id)`）。需要派生数组时在组件里用 `useMemo` 算，不在选择器里算。这条规则写进了 `selectors.ts` 的文件头注释。

## 八、测试策略

reducer 是纯函数，这让最有价值的测试变得极其便宜：

**用真实日志喂 reducer。** `../../code-agent/.tmp/code-agent/sessions/th_38f99fc73eca648b.jsonl` 是一次真实运行的完整记录，463 条事件、2 个 Turn、3 次命令执行、一条 421 个 delta 的长回答。把它整个喂进 `applyEvent`，断言最终状态：2 个 turn、第二个 turn 有 4 个 step、3 个 command_execution 且 exit_code 都是 0、最后一条正文拼出来的全文等于 `turn.completed` 里的 `final_text`。

最后那条断言尤其有价值：它同时验证了增量拼接、整体替换、以及前端对"最终回答"的理解和后端一致。这是一个**从真实数据里免费得到的端到端断言**，比任何手写 fixture 都可信。

其余三层各测一条主线：

- **缺口检测**：构造跳号序列，断言 `desynced` 置位、后续事件不再改变状态。
- **`useThreadLive`**：假 `EventSource`（手写替身，可手动派发）+ 假 client，断言订阅 URL 是 `?from_seq=last_seq+1`、卸载时连接被关闭（StrictMode 回归）。
- **展示组件**：给 `CommandExecutionCard` 喂 in_progress / completed(exit 0) / completed(exit 1) / failed / truncated 五种 Item，断言徽章与样式。
