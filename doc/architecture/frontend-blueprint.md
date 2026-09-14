# 前端架构总纲

## 一、技术选型

| 关注点 | 选型 | 版本 | 不选什么，为什么 |
|---|---|---|---|
| 构建 | Vite + React + TypeScript | 8 / 19 / 7 | 不用 Next.js：不需要 SSR 和文件路由，这是内网观测面板不是内容站点 |
| 路由 | react-router-dom | 7 | 不用"单页 tab 切换"：会话要能被 URL 直接分享和刷新恢复 |
| 服务端资源 | TanStack Query | 5 | 不手写 `useEffect` + `useState`：会重复造 loading / error / 缓存 / 失效 |
| 实时投影 | 自建 store + `useSyncExternalStore` | — | 不用 Query（语义不符）、不用 Context（性能）、不用 Redux（仪式过重）。详见 [状态模型与实时层](state-and-realtime.md) |
| 样式 | Tailwind | 4 | 不用 CSS Modules：组件多但样式简单（卡片、徽章、进度条），原子类比维护几十个 `.module.css` 快 |
| 测试 | Vitest + Testing Library | 5 / 16 | Vite 项目用 Vitest 配置成本最低；不引 MSW，因为 `ApiClient` 本身就可注入，不需要在网络层做 mock |

关于 Tailwind v4：它用 CSS 变量做配置（`@theme`），不再需要 `tailwind.config.js`。设计令牌全在 `src/index.css` 里，按**状态语义**组织（running / success / danger / reasoning）而不是按色板，因为这是个观测面板，一眼要能分出"正在跑""成功""失败""模型在想"。

## 二、分层与依赖方向

```
app/          路由、Provider 装配           ← 只有这层知道"页面"长什么样
  ↓
features/     页面与业务组件                ← 只有这层知道"产品"长什么样
  ↓
hooks/        编排（useThreadLive）         ← 把下面三层缝起来
  ↓
store/        状态（queries + liveThread）  ← 只有这层知道"事件如何改变状态"
  ↓
api/  realtime/   协议翻译                  ← 只有这两层知道 HTTP / SSE
  ↓
types/        契约类型                      ← 谁都能依赖，它不依赖任何人
```

**箭头永远不向上。** `api/` 不许 import `store/`，`store/` 不许 import React 组件。

判据是一句话：**"把 React 换成别的框架，这段代码要不要重写？"**

- 不用重写 → `types/`、`api/`、`realtime/`、`store/liveThread/apply.ts`
- 要重写 → `features/`、`hooks/`、`app/`

这条判据是从后端抄的。后端 `internal/transport/http/server.go` 的包注释写着：

> 判断标准很简单：如果一段逻辑在 CLI 里也需要，那它就不该写在这里。

把"CLI"换成"Vue"就是前端版本。同一条思路在两端得到同一种分层，不是巧合——它们面对的是同一个问题：**把"业务是什么"和"用什么壳子呈现"分开。**

## 三、目录结构

```
src/
  app/                     组合根
    providers.tsx            QueryClient + ApiClient + Toast 的装配点
    routes.tsx               路由表
    AppLayout.tsx            侧栏 + <Outlet />
    ApiClientContext.tsx     依赖注入
    ToastContext.tsx         拆成 state / dispatch 两个 Context
  types/
    contract.ts              与 Go 结构体逐字段对齐的协议类型
  api/                     协议翻译（不含业务判断）
    client.ts                fetch 封装、错误映射、204 处理
    threads.ts               七个端点
    errors.ts                ApiError + 错误码 → 中文文案
  realtime/
    eventStream.ts           EventSource 封装，工厂可注入
  store/
    queries.ts               TanStack Query hooks
    liveThread/
      state.ts                 状态形状 + seedFromSnapshot
      apply.ts                 纯 reducer（本项目的核心）
      apply.test.ts            用真实 463 条事件日志测
      store.ts                 外部 store + rAF 合并
      selectors.ts             稳定选择器（含使用约束说明）
      useLiveThread.ts         useSyncExternalStore 绑定
      LiveThreadContext.tsx    store 引用注入
  hooks/
    useThreadLive.ts         编排：快照 → 订阅 → 事件 → 缺口恢复
    useStickToBottom.ts      自动滚到底，但不抢用户的滚动条
  features/
    threads/ThreadSidebar.tsx      列表 + 新建弹窗
    console/
      ThreadConsolePage.tsx        容器
      StepTimeline.tsx             执行步骤可视化
      ItemCard.tsx                 分发 + 选择性订阅的落点
      AgentMessageCard.tsx         流式正文
      ReasoningCard.tsx            思考过程（默认折叠）
      CommandExecutionCard.tsx     工具调用详情
      ContextInspector.tsx         模型上下文检查器
      UsagePanel.tsx               上下文窗口监控
      TurnComposer.tsx             输入 / 取消
      ConnectionBadge.tsx          连接状态
      console.test.tsx             组件测试 + 架构回归
  components/primitives.tsx   无业务语义的展示原件
  lib/format.ts               展示格式化
  test/                       fixtures、FakeEventSource、setup
mock-server/server.mjs        协议级 mock，回放真实日志
```

`components/` 和 `features/` 的分界：**它认不认识"会话""轮次"这些词**。`Badge` 只知道自己有颜色和文字，在 `components/`；`ConnectionBadge` 知道 `desynced` 意味着什么，在 `features/`。

## 四、路由

| 路径 | 页面 |
|---|---|
| `/` | 空状态提示（侧栏常驻） |
| `/threads/:threadId` | 执行可视化面板 |
| `*` | 重定向回 `/` |

嵌套路由 + `<Outlet />`，侧栏在布局路由里，切换会话时**不卸载重建**，Query 缓存和滚动位置都保留。

workspace 筛选用 `useSearchParams` 放在 URL 上。判据统一是：**这个状态刷新之后应该还在吗？应该能分享吗？** 是就进 URL。

## 五、错误处理：两条独立通道

这是这套 API 最需要向前端解释的一点，也是最容易写错的地方。

```
POST /turns → 202 Accepted     响应发出时 Turn 才刚被准入，一步都没跑
                                ↓
                    成败只能通过事件流得知
```

所以有两条**不能合并**的错误通道：

| 通道 | 含义 | 处理位置 |
|---|---|---|
| `ApiError`（HTTP 非 2xx） | 任务没能启动：409 已有任务、400 输入为空、404 会话不存在 | `api/errors.ts` + 各 mutation 的 `onError` |
| `turn.failed` 事件 | 任务启动了但跑挂了：`max_steps`、`provider_error`、`cancelled` | `apply.ts` → `StepTimeline` 里的 `FailureNotice` |

两者都只依据**稳定的原因码**分支，绝不解析 message——后端注释明确说了错误文本随时会为排查方便而改写，原因码不会。

`ApiError` 上挂了两个派生判断，让调用方不用各自写规则：

- `shouldToast`：`turn_in_progress` 不弹（UI 本该已禁用提交，弹了只会让人困惑）
- `retryable`：决定 Query 的 retry 策略

## 六、测试策略

29 个测试，分四层，每层测它最该测的东西。

| 测什么 | 文件 | 关键点 |
|---|---|---|
| reducer | `apply.test.ts` | **用真实的 463 条事件日志**，不是手写 fixture |
| 编排 | `useThreadLive.test.tsx` | 假 `EventSource`，覆盖订阅起点、StrictMode 清理、缺口恢复 |
| 展示组件 | `console.test.tsx` | `CommandExecutionCard` 的六种状态 |
| **架构** | `console.test.tsx` | 灌 100 条 delta，断言时间线重渲染 **0 次** |

最后一条最特别：它守的不是功能而是**设计意图**。如果有人图省事把 Item 对象直接塞进 steps 结构，所有功能测试还会过，但流式输出会从"重渲染 1 个组件"退化成"重渲染 N 个"——只有这条测试能发现。

用真实日志的价值：手写 fixture 只覆盖我**以为**会发生的情况，真实日志覆盖的是真正发生过的情况。比如"带工具调用的 Step 里根本没有 `agent_message` Item"（模型那轮只吐了 tool_call 分片，而文本 Item 是懒创建的）——这个时序我事先没想到，是跑真实日志时发现的。

## 七、开发与联调

```bash
npm run dev      # Vite dev server，:5173，/api 代理到 :8080
npm run mock     # 协议级 mock 后端，回放真实日志，不烧 API 额度
npm test         # 29 个测试
npm run build    # 产物 119 KB gzipped
```

**为什么用代理而不是跨域直连后端**：一是不依赖后端开 CORS（后端的 `-cors` 参数只在开发模式挂载，生产留空）；二是 `EventSource` 跨域时的凭据和预检行为比同源复杂得多，同源可以完全绕开。生产环境由 nginx 做同样的事。

**mock 后端的价值**不只是省钱。它能**按需制造**真实后端很难复现的情况：随机丢事件（验证 seq 缺口自检）、中途断流（验证 `EventSource` 自动重连 + `Last-Event-ID` 续传）。指望真实模型恰好在你想要的时刻出错是不现实的。

```bash
MOCK_SPEED=20 npm run mock    # 20 倍速跑回归
MOCK_DROP=1 npm run mock      # 随机丢包，逼出重新同步
```

## 八、后续

- **虚拟滚动**：跑了很多轮的会话会有几百张卡片全挂在 DOM 上。目前没到瓶颈（卡片本身很轻），但这是下一个会遇到的性能问题。
- **Markdown 渲染**：模型输出是不可信输入，不能走 `dangerouslySetInnerHTML`；流式下半截语法的处理需要单独设计（正确做法是流式期间纯文本、`item.completed` 之后再渲染）。
- **E2E**：`mock-server/` 已经为此准备好了，差的是把 Playwright 驱动脚本固化成 CI 里能跑的测试。
- **生产部署**：前端产物由 nginx serve 并反代 `/api`，还是后端用 `embed.FS` 一起打包，需要和后端一侧确认。
