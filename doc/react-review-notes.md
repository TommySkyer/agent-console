# React 应答手册：可能被追问的点

Entry Task 明确说了：不评价代码是不是 AI 生成的，评价的是**能不能理解、调试、修改、维护**；Code Review 会随机挑一段代码，问实现原理、设计原因、涉及的语言特性。

这份文档就是按那个标准写的。它不是 React 教程，是**这个项目里每一处非平凡决策的理由**，外加"如果我是面试官，我会追问什么"。

读法建议：先通读一遍建立地图，然后对着代码逐个验证。凡是这里说"在某某文件"的地方，都去把那个文件打开看一眼——**能指着代码讲，和能背出概念，是两回事**。

---

## 零、先回答一个总问题：这个项目的架构是什么

如果只允许讲三句话：

1. **分层是单向的，判据是"换掉 React 要不要重写"。** 要重写的（`features/`、`hooks/`、`app/`）在上层；不用重写的（`types/`、`api/`、`realtime/`、`store/liveThread/apply.ts`）在下层。上层依赖下层，反过来不行。
2. **状态分三类，用三套机制。** 服务端资源用 TanStack Query，实时事件投影用自建 store + `useSyncExternalStore`，纯 UI 状态用 `useState`。Context 只用来注入依赖，不装状态。
3. **"事件如何改变状态"只写在一个地方**（`store/liveThread/apply.ts` 的 `applyEvent`），它是纯函数，用一份真实的 463 条事件日志测。

第 1 条是从后端抄的：后端 `internal/transport/http/server.go` 的包注释写着"如果一段逻辑在 CLI 里也需要，那它就不该写在这里"。前端把"CLI"换成"Vue"，就是同一条判据。

---

## 一、组件通信

React 里组件之间传数据一共就那么几种方式。**关键不是知道有哪几种，而是知道每种的代价，以及这个项目里为什么在某处选了某一种。**

| 方式 | 代价 | 本项目用在哪 |
|---|---|---|
| props 向下传 | 层级深了要一路透传（prop drilling） | 展示组件：`ItemCard` → `CommandExecutionCard` 传 `item` |
| 回调向上传 | 父组件被迫持有本不属于它的状态 | `Disclosure` 的 `onToggle` |
| Context | **value 一变，所有 consumer 无差别重渲染** | 注入 `ApiClient`、`LiveThreadStore`、Toast 派发 |
| 外部 store + 订阅 | 需要自己管订阅生命周期 | 实时投影（`useLiveSelector`） |
| URL | 只能放字符串 | 当前会话 ID、workspace 筛选 |

### 最可能被问：为什么 `ItemCard` 接 `itemId` 而不是 `item` 对象？

这是整个项目里性能架构的落点，在 `src/features/console/ItemCard.tsx`。

```tsx
export const ItemCard = memo(function ItemCard({ itemId }: { itemId: string }) {
  const item = useLiveSelector(selectItem(itemId))
```

如果改成父组件传 `item` 对象：

- 某个 item 的文本一变 → 父组件必须重渲染才能把新 prop 传下来
- 父组件一重渲染 → 它下面**所有**卡片跟着重渲染
- 流式输出实测 **139 条 delta/秒**，页面上几十张卡片 → 每秒几千次组件渲染

传 `itemId` 之后：父组件订阅的是 `turns` 结构，而 reducer 保证 delta **不改动那棵树的引用**（步骤里存的是 id 字符串，不是 Item 对象），所以父组件一次都不重渲染，只有目标卡片重渲染。

**这条有测试守着**：`src/features/console/console.test.tsx` 里的「流式 delta 只让目标卡片重渲染」，灌 100 条 delta，断言时间线的重渲染次数是 **0**。

> 追问："这不就是把数据获取下沉到叶子组件吗？不是说容器组件才该取数据？"
>
> 答：那条经验法则针对的是**网络请求**——请求下沉会导致瀑布流和重复请求。这里下沉的是**同步的内存读取**（一次 `Map.get`），没有网络、没有瀑布。真正的数据获取（`GET /threads/{id}`）仍然在容器组件 `ThreadConsolePage` 里。区分标准是"这次读取有没有副作用和延迟"。

### 最可能被问：`memo` 在这里是必需的还是锦上添花？

必需的。父组件会因为**别的**原因重渲染——比如新增一个 Step、Turn 结束。那时如果没有 `memo`，所有 `ItemCard` 都要重跑一遍 `useLiveSelector`（虽然选择器返回同一个引用、不会真的重渲染子树，但函数调用和 hook 开销还在）。`memo` 比较 `itemId` 这个字符串 prop，没变就整个跳过。

> 追问："`memo` 不是一般不推荐用吗？"
>
> 答：不推荐的是**无差别地到处加**——多数组件重渲染很便宜，加 `memo` 反而多了一次 props 比较。这里的判据是具体的：这个组件会在一个高频更新的列表里出现几十次，且它的 prop 是一个字符串（比较成本极低）。有明确理由时才加。

---

## 二、Hooks

### 这个项目用到的 Hook 及其理由

| Hook | 用在哪 | 为什么是它 |
|---|---|---|
| `useState` | 折叠状态、输入框文本、当前 tab | 纯 UI 状态，不跨组件、不需持久化 |
| `useRef` | store 实例、滚动容器、贴底标志 | 变化不需要触发重渲染 |
| `useEffect` | 订阅 SSE、监听 scroll | 需要清理函数的副作用 |
| `useLayoutEffect` | 自动滚到底 | 必须在浏览器绘制**之前**完成 |
| `useMemo` | `ContextInspector` 里的统计 | 派生计算，且不能写进 selector |
| `useCallback` | Toast 的 `show` | 锁住引用，让 dispatch Context 的 value 永不变 |
| `useSyncExternalStore` | 订阅实时 store | 并发渲染下唯一不会撕裂的方式 |
| `useContext` | 取 ApiClient / store / toast | 依赖注入 |
| `useParams` / `useNavigate` / `useSearchParams` / `NavLink` | 路由 | 见第五节 |
| 自定义 Hook | `useThreadLive`、`useStickToBottom`、`useLiveSelector` | 把"有状态的逻辑"抽出来复用 |

### 最可能被问：`useEffect` 的清理函数为什么必须写？

看 `src/hooks/useThreadLive.ts`：

```ts
useEffect(() => {
  if (!data) return
  store.reset(seedFromSnapshot(data))
  return subscribeThreadEvents(url, {...})   // 返回值就是清理函数，内部 source.close()
}, [store, data, client, threadId, eventSourceFactory])
```

不写清理的后果**不是**"多一条连接"这么轻描淡写。React 18 的 `StrictMode` 在开发模式下会故意 mount → unmount → mount。不清理的话：

1. 留下两条 SSE 连接
2. **两条都在往同一个 store 灌事件**
3. 第二条的事件因为 `seq` 重复被 reducer 判定为重复而丢弃

所以症状不是明显报错，而是"偶尔丢字"——极难查。这条有测试守着：`useThreadLive.test.tsx` 的「卸载时关闭连接（StrictMode 下不留双份）」，用 `StrictMode` 包着渲染，断言 `openCount === 1`，卸载后 `=== 0`。

> 追问："那把 StrictMode 关掉不就行了？"
>
> 答：反了。StrictMode 不制造 bug，它**暴露**本来就存在的 bug。这个组件在生产里也会因为路由切换而卸载重挂，不清理照样泄漏，只是你要等到用户反馈"页面开久了变卡"才发现。关掉 StrictMode 等于把体检报告撕了。

### 最可能被问：为什么 store 实例用 `useRef` 而不是 `useMemo`？

```ts
const storeRef = useRef<{ id: string; store: LiveThreadStore } | null>(null)
if (!storeRef.current || storeRef.current.id !== threadId) {
  storeRef.current = { id: threadId, store: new LiveThreadStore(threadId) }
}
```

因为 **`useMemo` 在 React 的契约里是"性能提示"，允许被丢弃重算**。丢一个缓存的计算结果无所谓；丢一个正在被订阅的 store，会让已经收到的事件凭空消失。

`useRef` 是"这个盒子我自己管，React 不许动"。在渲染期间写 ref 通常要避免（会破坏并发渲染的可重入性），但这里写的是**幂等的初始化**——同样的 `threadId` 进来，结果完全一样，重入多少次都安全。

> 追问："`useState(() => new Store())` 的惰性初始化不行吗？"
>
> 答：可以，但 `threadId` 变了要靠 `setState` 重建，那是在渲染期间 setState，React 会警告。要么配合 `key` 强制重新挂载。我在路由表里**也**加了 `key`（见 `routes.tsx` 的注释），两道保险，但 ref 这道让这个 Hook 自己就是正确的，不依赖调用方记得加 key。

### 最可能被问：`useLayoutEffect` 和 `useEffect` 的区别

在 `src/hooks/useStickToBottom.ts`：

- `useEffect` 在浏览器**绘制之后**异步跑
- `useLayoutEffect` 在 DOM 变更之后、浏览器**绘制之前**同步跑

自动滚到底必须用后者。用 `useEffect` 的话，用户会看到"新内容先出现在下面、下一帧才滚下去"的闪动——因为浏览器已经画了一帧了。

代价是 `useLayoutEffect` 阻塞绘制，里面不能做重活。这里只读写 `scrollTop`，可以接受。

### 最可能被问：为什么 `useStickToBottom` 里"是否贴底"存在 ref 而不是 state？

因为它**不影响渲染输出**。每次滚动都改一次 state 会触发一连串重渲染，而渲染结果完全一样。

判据：**这个值变了，界面需要重画吗？** 需要 → state；不需要 → ref。

---

## 三、Context

### 核心认知：Context 的语义是广播，不是订阅

`Provider` 的 `value` 引用一变，**所有** `useContext` 的组件无差别重渲染。没有选择性订阅，`memo` 也挡不住——`memo` 比较的是 props，而 Context 是绕过 props 传进去的。

这条规则推出这个项目里所有关于 Context 的决策。

### 最可能被问：为什么实时状态不放 Context？

139 次/秒 × 全部 consumer 重渲染。这是唯一的理由，而且它有实测数据（`doc/backend-contract.md` 的"流式速率"一节，测自真实日志）。

### 最可能被问：那 Context 在这个项目里用来干什么？

**装依赖，不装状态。** 三处：

1. `src/app/ApiClientContext.tsx` —— `ApiClient` 实例，整个生命周期不变
2. `src/store/liveThread/LiveThreadContext.tsx` —— store 的**引用**（注意是引用，不是里面的状态）
3. `src/app/ToastContext.tsx` —— toast 派发函数

第 2 条是最值得讲的一处区分：

```
放进 Context 的是 store 的引用  → 一个 Thread 的生命周期内不变 → Context 的完美用例
store 里的状态                  → 139 次/秒                    → 绝不能放
```

于是既拿到了 Context 的好处（不用把 store 一层层 props 传到每张卡片），又完全避开了它的代价。组件订阅状态走的是 `useSyncExternalStore` 的选择性订阅路径，和 Context 的广播机制没有关系。

> 这也是 Zustand、Redux 这类库的实际做法——它们也是把 store 引用放 Context，状态靠订阅。理解了这一点，就理解了这类库为什么长这样。

### 最可能被问：Toast 为什么拆成两个 Context？

```tsx
<ToastDispatchContext value={dispatch}>     // value 被 useCallback + useMemo 锁死，引用永不变
  <ToastStateContext value={toasts}>        // 随 toasts 变
```

不拆的话，每弹一个 toast，所有"只想调用 `showToast`"的组件（输入框、删除按钮……）都会跟着重渲染——它们根本不关心当前有哪些 toast。

拆开之后，订阅 dispatch 的组件因为 value 引用永不变，一次都不会因 toast 变化而重渲染。

注意 `useMemo` 那一行不是可有可无的：

```ts
const dispatch = useMemo(() => ({ show }), [show])
```

少了它，每次 `ToastProvider` 重渲染都会产生一个新的 `{ show }` 对象，"引用永不变"的设计就白做了。

### 最可能被问：为什么 `useLiveSelector` 要抛错而不是返回 null？

```ts
if (!store) throw new Error('useLiveSelector 必须在 <LiveThreadProvider> 内使用')
```

漏包 Provider 是**结构性错误**，不是运行时的偶发情况。让它在第一次渲染就炸掉，比让每个调用点都写一遍 `if (!store) return null` 好——后者会把一个明确的配置错误变成"页面上少了一块，但不知道为什么"。

> 追问："那有没有踩过这个坑？"
>
> 踩过，而且很典型：`useStickToBottom` 一开始是直接写在 `ThreadConsolePage` 里的，但那个组件**自己**就是渲染 `<LiveThreadProvider>` 的地方。Provider 和 consumer 写在同一个组件里是不行的——组件函数体在它返回的 JSX 之前执行，那时 Provider 还不存在。解法是隔一层组件边界，于是抽出了 `ScrollArea`（见 `ThreadConsolePage.tsx` 里的注释）。

---

## 四、状态管理

### 三类状态与三套机制

| 类别 | 例子 | 机制 | 判据 |
|---|---|---|---|
| 服务端资源 | 会话列表、快照 | TanStack Query | 刷新后从服务器重新请求 |
| 实时事件投影 | items / steps / usage | 自建 store + `useSyncExternalStore` | 刷新后从事件流重放 |
| 纯 UI 状态 | 折叠、输入框、tab | `useState` | 刷新后回到默认值就行 |

判据统一是一句话：**"刷新页面之后，这个值应该从哪来？"**

### 最可能被问：为什么实时数据不能也用 TanStack Query？

Query 的心智模型是"一个 key 对应一次请求的结果，可以缓存、失效、重试、去重"，它假设**同一个 key 重新取一次能得到完整的当前值**。

事件流不满足这个假设：

- `item.delta` 只带增量，单独一条毫无意义，值依赖于此前所有事件
- "重新请求一次"对 SSE 不成立——重连要带 `from_seq`，语义是"接着上次"，不是"重来"

硬塞进去的话，得在 `queryFn` 外面用 `setQueryData` 手动打补丁，等于把 Query 当全局变量用，它的缓存、失效、重试全部失效甚至碍事。

**但快照本身是标准的请求-响应**，所以 `GET /threads/{id}` 归 Query 管。两者的接缝在 `useThreadLive`。

### 最可能被问：为什么不用 Redux / Zustand，自己写 store？

先说不是因为"造轮子好玩"。

**Redux**：核心价值是 action 日志 + devtools 时间旅行 + 中间件。但这里的 reducer 不是被用户 dispatch 驱动的，是被服务器事件流驱动的；而"事件序列 → 状态"的可回放性**后端已经用 JSONL 做掉了**（`internal/session/jsonl.go`），前端再复制一份收益很小，却要引入一整套仪式。

**Zustand**：本来就是这个场景的标准答案，选择不用只有一个理由——这个 store 加上 rAF 合并逻辑一共不到 90 行，而 `useSyncExternalStore` 正是 Zustand 内部用的那个 React 官方原语。自己写一遍能完全讲清每一行，合并逻辑也能直接写进 `dispatch` 而不是包一层 middleware。

**什么时候该换**：需要多个互相引用的 store、需要 devtools、需要持久化中间件。目前一个都不需要。而且这是个可以随时反悔的决定——`useLiveSelector(selector)` 的签名和 Zustand 的 `useStore(selector)` 一模一样，换实现不影响任何组件。

> 这个回答的关键不是"我选了 A 不选 B"，而是"我知道 B 好在哪、什么条件下该换成 B"。

### 最可能被问：`useSyncExternalStore` 到底解决什么问题？

解决 **tearing（撕裂）**。

朴素写法：

```tsx
const [state, setState] = useState(store.getState())
useEffect(() => store.subscribe(() => setState(store.getState())), [])
```

React 18 的并发渲染允许渲染到一半让出主线程。外部 store 恰好在这个间隙变了的话，**已渲染完的组件用旧值、还没渲染的用新值，同一帧里画出两个不一致的状态**。

`useSyncExternalStore` 在渲染期间检查 store 是否变过，变了就丢弃这次渲染重来，保证一帧内所有组件读到同一个版本。

它的三个参数：

```ts
useSyncExternalStore(
  store.subscribe,                        // 订阅函数，返回取消订阅
  () => selector(store.getState()),       // 客户端快照
  () => selector(store.getState()),       // SSR 快照
)
```

### 最可能被问：selector 有什么约束？（这是最容易踩的坑）

**返回值必须引用稳定。** React 每次渲染都会调 `getSnapshot` 并比较引用，返回新对象就永远不等于上一个，判定"又变了"，**无限重渲染**。

```ts
useLiveSelector(s => s.turns.map(t => t.id))   // ✗ 每次都是新数组 → 死循环
useLiveSelector(s => ({ a: s.status }))         // ✗ 每次都是新对象 → 死循环
useLiveSelector(s => s.turns)                   // ✓ reducer 保证结构共享
useLiveSelector(s => s.items.get(id))           // ✓ 同上
useLiveSelector(s => s.lastSeq)                 // ✓ 原始值
```

所以项目里定了规矩，写在 `src/store/liveThread/selectors.ts` 的文件头：**selector 只允许返回原始值，或 reducer 保证结构共享的现成引用。需要派生数组时在组件里用 `useMemo` 算。**

`ContextInspector` 里就是这么做的——统计各 role 的消息条数用 `useMemo`，不写进 selector。

### 最可能被问：reducer 为什么是纯函数？不可变复制不会慢吗？

纯函数的好处是它**不依赖 React、不依赖网络、不依赖时间**，于是可以用一份真实的 463 条事件日志直接测（`apply.test.ts`）。这是整个前端测试覆盖里性价比最高的一块。

关于性能，这笔账算过：每条 delta 要 `new Map(state.items)`，50 个条目的 Map 复制约 2µs，139 次/秒约合 **0.3ms/秒** 的 CPU。可以忽略。

**这是一个知情的取舍，不是没想到。** 真到了瓶颈（items 上千），做法是把 Map 改成可变容器、只保证 Item 对象本身不可变——因为选择器只用 `.get(id)`，从不整体读 Map。那时再改，不需要动任何组件。

### 最可能被问：rAF 合并是干什么的？会不会读到旧数据？

在 `src/store/liveThread/store.ts`：

```ts
dispatch = (event) => {
  const next = applyEvent(this.state, event)
  if (next === this.state) return
  this.state = next                                        // 同步更新
  if (event.type === 'item.delta') this.scheduleNotify()   // 通知合并到下一帧
  else this.notifyNow()                                     // 其它事件立刻通知
}
```

**写入同步、通知合并。** 139 次/秒而屏幕只有 60Hz，多出来的唤醒全是白干。

- **会不会读到旧值？** 不会。`state` 是同步更新的，`getSnapshot()` 读的永远是最新值。合并影响的只是"什么时候叫 React 来读"，不影响"读到什么"。
- **后台标签页怎么办？** `requestAnimationFrame` 在后台不触发，所以不通知 React。但事件照收、状态照更新，切回来时一次性追上。这正是想要的行为。
- **为什么只合并 delta？** 规则越简单越不会记错。其它事件都是低频的状态跃迁（`step.started`、`item.completed`、`turn.completed`），立刻通知，响应不打折。

调度器是可注入的（`Scheduler` 类型），测试里换成 `syncScheduler` 同步执行，断言就不用 await 帧。

---

## 五、Router

### 路由表

```
/                       AppLayout（侧栏常驻）
├── index               空状态提示
├── threads/:threadId   ThreadConsolePage
└── *                   重定向回 /
```

### 最可能被问：为什么用嵌套路由？

`src/app/AppLayout.tsx` 渲染侧栏 + `<Outlet />`。

好处是切换会话时**侧栏组件不会卸载重建**——它的 Query 缓存、滚动位置、展开状态都保留着。如果在每个页面各自渲染一遍侧栏，每次切换都是一次完整的卸载/挂载。

`<Outlet />` 就是子路由的插槽，等价于 Vue 的 `<router-view>`。

### 最可能被问：为什么会话 ID 在 URL 里而不是组件 state？

判据：**这个状态刷新之后应该还在吗？应该能分享给同事吗？** 两个都是"是"，那它就属于 URL。

同样的判据让 workspace 筛选也进了 URL（用 `useSearchParams`），见 `ThreadSidebar.tsx`。

### 最可能被问：`routes.tsx` 里的 `key={threadId}` 是干什么的？

从会话 A 切到会话 B 时，React 默认会**复用**同一个组件实例（类型和位置都没变），只是 props 变了。那样 `useState`/`useRef` 里的东西会被带到新会话去。

加上 `key` 之后 React 会卸载重建，新会话从干净状态开始。

> 追问："`useThreadLive` 里不是已经用 ref 比较处理了吗？"
>
> 答：是，那是第一道。`key` 是第二道，而且它让"切换会话 = 全新开始"这件事在路由表上一眼可见。两道的区别在于责任归属：ref 那道让 Hook 自己是正确的（不依赖调用方），`key` 这道是声明式的意图表达。

### 最可能被问：`NavLink` 和 `Link` 的区别？

`NavLink` 的 `className` 可以接收一个函数，拿到 `{ isActive }`：

```tsx
<NavLink className={({ isActive }) => isActive ? '...' : '...'}>
```

不用自己比较 `useLocation().pathname`。这是 react-router 为"导航项高亮"这个高频需求提供的专门 API。

### 一个实际踩到的坑：`NavLink` 里嵌按钮

侧栏每一项是 `NavLink`，里面有个删除按钮。不阻止冒泡的话，点删除会顺带导航过去：

```tsx
onClick={(event) => {
  event.preventDefault()    // 阻止 NavLink 的默认导航
  event.stopPropagation()   // 阻止冒泡
  ...
}}
```

两个都要。`preventDefault` 管的是 `<a>` 的默认跳转，`stopPropagation` 管的是事件继续往上冒。

---

## 六、TypeScript

### 最可能被问：`SessionEvent` 这个联合类型是什么写法？

在 `src/types/contract.ts`：

```ts
export type SessionEvent =
  | (EventBase & { type: 'item.delta'; payload: { item_id: string; field: string; text: string } })
  | (EventBase & { type: 'step.started'; payload: { step: number } })
  | ...
```

这叫**可辨识联合**（discriminated union），判别字段是 `type`。`switch (event.type)` 时 TS 会把 `payload` 自动收窄到对应的具体形状。

这是 TS 里最接近 Go sealed interface 的表达。后端用未导出的 `isPayload()` 方法把外部类型挡在 `Payload` 之外：

```go
type Payload interface { isPayload() }
```

两边达到的效果一样：载荷类型是一个**封闭集合**，编译器拒绝没被系统认可的类型。

### 最可能被问：reducer 里那个 `const never: never = event` 是干什么的？

穷尽性检查。如果后端新增了一个事件类型、`SessionEvent` 加了一个成员而 `switch` 里漏了 `case`，那么走到 `default` 时 `event` 的类型就不是 `never` 了，赋值给 `never` 会编译报错。

**编译期发现漏改，而不是等运行时界面少块东西。** 这和后端 `codec.go` 里那句注释是同一个思路：

> 写成 `map[EventType]func() Payload` 会更短，但 switch 让编译器在新增事件类型时更容易被发现漏改。

### 最可能被问：为什么不做 camelCase 转换？

前端类型直接用 `snake_case`（`exit_code`、`last_seq`、`aggregated_output`），和 Go 的 json tag 完全一致。

因为转换需要一层映射代码，而映射代码是纯粹的负担：它会漂移、要测试、出错时还难定位。字段名不一致带来的唯一成本是"看起来不像前端风格"，这个成本远小于维护一层转换。

### 最可能被问：`exit_code: number | null` 为什么不能是 `number`？

`null` 表示"命令还没结束"，不是"结束了且返回 0"。后端在 Go 侧用的是 `*int` 指针，注释写得很明确：

> 用值类型的话前端无法区分「成功了」和「还没结束」。

渲染时必须先判 `null` 再判 `0`。这条有测试守着（`console.test.tsx` 的「exit_code 为 null 时不显示成 exit 0」）。

---

## 七、这个项目特有的、最可能被深挖的三处

### 1. 快照 + 订阅的顺序为什么不能反？

```
① GET /threads/{id}  → 拿到 items 和 last_seq
② SSE ?from_seq=last_seq+1
```

- **先订阅后拉快照**：两次请求之间产生的事件会被快照包含、又被流重发一次 → 重复
- **拉了快照但订阅不带起点**：中间产生的事件直接丢

后端文档把这两条列为"这套设计能自洽的前提"。

**`+1` 为什么在前端做？** 因为后端 `resolveFromSeq` 里两个入口语义不同：

```go
// Last-Event-ID: N  →  从 N+1 开始（「我已经收到了 N」）
// ?from_seq=N       →  从 N   开始（「我想要的第一个是 N」）
```

快照的 `last_seq` 是"已经收到了"，所以传 `last_seq + 1`。有测试守着（`useThreadLive.test.tsx` 的「订阅起点是 last_seq + 1」，断言 URL 含 `from_seq=8`）。

**为什么首连非得用 query 参数？** 原生 `EventSource` 建连时**无法自定义任何请求头**，这是它相比 `fetch` 最大的限制。`Last-Event-ID` 是浏览器在自动重连时才加的。所以 `?from_seq=` 不是可有可无的兜底，它是首连唯一的入口。

### 2. 断线重连为什么一行代码都没写？

浏览器原生 `EventSource` 自带指数退避重连，且重连时自动带 `Last-Event-ID`（值来自服务端写的 `id:` 行），后端读到就从断点之后补发。

自己写重连不仅多余，还会和浏览器的重连打架，产生两条连接。

前端只需要做两件事：

- 首连带对起点（上一条）
- 区分"正在重连"和"彻底失败"：`onerror` 有两种含义，只能靠 `readyState` 区分。把前者当错误展示，会让用户在每次网络抖动时看到红框。

```ts
handlers.onStatus(source.readyState === READY_STATE_CLOSED ? 'closed' : 'connecting')
```

> 这里有个实际踩到的坑：原本写的是 `EventSource.CLOSED`，但那个全局在 jsdom（单测）和 Node（SSR）里根本不存在，一引用就是 `ReferenceError`。是单元测试先炸出来的。改成本地常量 `READY_STATE_CLOSED = 2`。

### 3. seq 缺口检测是干什么的？

reducer 的第一道关：

```ts
if (event.seq <= state.lastSeq) return state             // 重复投递
if (event.seq !== state.lastSeq + 1) return { ...state, desynced: true }   // 缺口
```

缺口有两个真实来源，都在后端代码里有据可查：

1. 后端 `subscriber.push` 在队列满时**丢弃事件并计数**（"慢消费者不能拖死 Agent Loop"）
2. 断线太久，超出了 2048 条的环形补发缓冲

两种情况前端都追不回来，唯一正确的反应是**重新拉快照 + 重新订阅**。

注意第一行 `return state` 返回的是**同一个引用**——返回新对象会让 `useSyncExternalStore` 判定"变了"，触发一次毫无意义的全量重渲染。这个细节有测试（`apply.test.ts` 的「重复事件返回同一个引用」，用 `toBe` 断言引用相等）。

---

## 八、如果被问"你在这个项目里改了后端，改了什么、为什么"

写前端的过程中发现了四处后端契约缺口，都改了，每处都配了回归测试。**这部分比前端代码更值得讲**，因为它体现的是"能发现问题"而不只是"能实现需求"。

| 缺口 | 症状 | 改法 | 测试 |
|---|---|---|---|
| Item 不带 `turn_id` / `step` | 快照画不出"第几轮第几步"，实时流有层次、快照丢了 | `Item` 加两个字段，在 `addItem` 里统一填 | `TestItemsCarryTurnAndStep` |
| Snapshot 不带 `context_window` | 打开历史会话时"上下文占用"没有分母，进度条画不出来 | `Snapshot` 加字段 | 同上文件 |
| `usage` 重放语义与实时不一致 | 进程重启后跨轮累计变成"最后一轮的量" | `t.usage = payload.Turn` → `t.usage.Add(payload.Delta)` | `TestReplayReproducesLiveState` |
| Snapshot 没有轮次元信息 | 刷新后看不到"用户这一轮问了什么" | 新增 `TurnMeta` 投影 | 同上 |

另外还修了一个**只有真机联调才会暴露**的问题：

**SSE 空闲流的响应头不被代理转发。** 订阅一个当前空闲的 Thread 时（`from_seq` 已追平 `last_seq`），后端只写响应头不写 body。而 Vite 的 dev proxy（以及部分 nginx 配置）**在拿到第一个响应体字节之前不转发响应头**，于是浏览器的 `EventSource` 一直停在 `CONNECTING`、`onopen` 不触发，界面一直显示"连接中"——连接其实早就建好了。

改法是在 `sse.go` 里写完头之后立刻发一行注释 `: connected\n\n` 再 Flush。注释行 `EventSource` 会忽略，不会被当成事件。

> 这个 bug 的价值在于：单元测试测不出来（测试用 `httptest` 直连，没有代理），只有真机联调能发现。**"我跑起来了"和"我在真实链路里验证了"是两回事。**

### 关于 `usage` 那处修复的细节

为什么是 `Add(payload.Delta)` 而不是 `Add(payload.Turn)`？

因为 `payload.Turn` 是**轮内累计值**，直接 Add 会重复计算（同一轮的第 2 次 usage 事件会把第 1 次的量再加一遍）。而 `payload.Delta` 正是实时路径 `RecordUsage` 累加的那个量，用它重放能逐字节复现实时态。

验证方式不是看代码，是真跑：跑两轮（1391 + 834 = 2225 tokens），重启进程，重放后仍是 2225。用旧代码会变成 834。

---

## 九、诚实的部分：已知不足

被问"这个项目还有什么没做好"时，这些是真实答案，不要临场编。

1. **没有渲染 Markdown。** 模型输出是不可信输入，绝不能走 `dangerouslySetInnerHTML`；而流式场景下半截语法（`**` 没闭合、代码块只开了三个反引号）每帧都在变，渲染器会反复重排。正确做法是"流式期间纯文本、`item.completed` 之后再渲染 Markdown"，那是个独立的设计，没做。
2. **命令输出不是流式的。** 协议里留了 `field: "output"` 的口子，reducer 也实现了，但后端当前的 Environment 一次性返回全部输出。所以界面上命令执行期间只能显示"执行中"，不能边跑边滚。这是后端能力的限制，不是前端偷懒。
3. **没有虚拟滚动。** 一个跑了很多轮的会话会有几百张卡片，全部挂在 DOM 上。目前没到瓶颈（卡片本身很轻），但这是下一个会遇到的性能问题，解法是 `@tanstack/virtual`。
4. **没有 E2E 测试。** 有单元测试和组件测试，真机联调是手工 + Playwright 脚本驱动的，没有固化成 CI 里能跑的 E2E。`mock-server/` 已经为此准备好了（协议级 mock，支持随机丢包），差的是把脚本写成测试。
5. **没有鉴权。** 后端目前也没有。加的话只影响 `api/client.ts` 一处。
6. **可访问性只做了基础。** 关键交互加了 `aria-expanded`、`role="tab"`、`aria-selected`、`role="status"`，但没有做完整的键盘导航和焦点管理（比如新建会话弹窗没有 focus trap）。

---

## 十、快速自测清单

能流畅回答下面每一条，就算过关了。答不上来的就去看对应文件。

- [ ] 这个项目的分层判据是什么？为什么这么定？（`doc/architecture/frontend-blueprint.md`）
- [ ] 三类状态分别是什么？判据是哪一句话？
- [ ] 为什么实时投影不能用 Context？数据是多少？
- [ ] `ItemCard` 为什么接 `itemId` 不接 `item`？不这么做会怎样？
- [ ] `useSyncExternalStore` 解决什么问题？selector 有什么约束？为什么？
- [ ] `useEffect` 的清理函数不写会怎样？症状是什么？
- [ ] store 实例为什么用 `useRef` 不用 `useMemo`？
- [ ] `useLayoutEffect` 和 `useEffect` 差在哪？这里为什么用前者？
- [ ] Toast 为什么拆两个 Context？少了 `useMemo` 会怎样？
- [ ] 快照和订阅的顺序为什么不能反？`+1` 为什么在前端做？
- [ ] 断线重连的代码在哪？（答案：没有，浏览器做的）
- [ ] seq 缺口怎么来的？检测到了怎么办？
- [ ] rAF 合并会不会导致读到旧数据？为什么不会？
- [ ] `const never: never = event` 是干什么的？
- [ ] 你改了后端哪几处？分别为什么？怎么验证的？
- [ ] 哪个 bug 是只有真机联调才能发现的？为什么单测测不出来？
