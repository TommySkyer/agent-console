# 后端契约实录

这份文档记录前端依赖的后端契约。它不是从设计稿抄的，而是**逐条对照后端源码和一份真实会话日志核对过的**：

- 源码：`../../code-agent/internal/session/{event,item,thread,turn,subscribe}.go`、`internal/transport/http/{server,sse,threads,middleware}.go`、`internal/agent/agent.go`
- 真实日志：`../../code-agent/.tmp/code-agent/sessions/th_38f99fc73eca648b.jsonl`（463 条事件、2 个 Turn、其中一个 4 步带 3 次命令执行）

凡是设计文档和代码有出入的地方，**以代码为准**，并在本文末尾"契约缺口"一节里单独列出。前端所有的兜底逻辑都源自那一节，不要在别处凭感觉加兜底。

> **状态**：写前端过程中发现的七处缺口**已经全部在后端修掉**（每处都配了 Go 回归测试，`go vet` + `go test -race ./...` 全绿）。下面保留完整的发现与修复记录，因为"怎么发现的"比"改了什么"更有参考价值。前端同时保留了对老版本后端的兼容降级，两边可以独立部署。

## REST 表面

Base URL 开发期是 `http://localhost:8080`，通过 `VITE_API_BASE` 注入。

| 方法与路径 | 请求体 | 成功响应 | 前端用途 |
|---|---|---|---|
| `GET /api/health` | — | 200 `{status:"ok"}` | 连接自检 |
| `GET /api/config` | — | 200 `{workspace_root, allow_any_workspace}` | 新建会话时提示可选目录范围 |
| `POST /api/threads` | `{workspace, title?}` | 201 `{thread_id, meta}` | 新建会话 |
| `GET /api/threads?workspace=` | — | 200 `{threads: Meta[]}` | 侧栏列表 |
| `GET /api/threads/{id}` | — | 200 `Snapshot` | 首屏快照 |
| `DELETE /api/threads/{id}` | — | 204 无体 | 删除 |
| `POST /api/threads/{id}/turns` | `{input}` | **202** `{turn_id}` | 提交输入 |
| `POST /api/threads/{id}/cancel` | — | 204 无体 | 取消 |
| `GET /api/threads/{id}/events?from_seq=` | — | 200 `text/event-stream` | 实时流 |

两个容易踩的点：

**`POST /turns` 返回 202，不是 200。** 响应发出时 Turn 还没开始跑。它的成败**不可能**体现在这个状态码上，只能通过事件流里的 `turn.completed` / `turn.failed` 得知。所以前端有两条完全独立的错误通道，不能合并（详见下面"错误语义"）。

**`DELETE` 和 `cancel` 返回 204 无响应体。** `fetch` 之后不能无条件 `res.json()`，会抛 `Unexpected end of JSON input`。`api/client.ts` 里按状态码判空。

## 错误响应

统一形状，前端只解析 `code`，**绝不解析 `message`**（后端注释明确说了错误文本随时会为排查方便而改写，原因码不会）：

```json
{ "error": { "code": "turn_in_progress", "message": "..." } }
```

实际能收到的 `code`（核对自 `middleware.go: writeDomainError` 与 `threads.go` 的直接调用）：

| code | 状态码 | 触发 | 前端处理 |
|---|---|---|---|
| `bad_request` | 400 | 请求体格式错、`input` 为空 | Toast |
| `invalid_workspace` | 400 | `workspace` 为空 | 表单内联报错 |
| `thread_not_found` | 404 | Thread ID 不存在 | 跳回列表页 + Toast |
| `turn_in_progress` | 409 | 已有 Turn 在跑 | **不 Toast**，UI 本该已禁用提交 |
| `provider_error` | 502 | 模型供应商侧失败 | Toast，可重试 |
| `internal` | 500 | 其它 | Toast，可重试 |

注意设计文档 `modules/http-api.md` 里写的 `provider_unauthorized` 在代码里实际是 `provider_error`，以代码为准。

`decodeJSON` 开了 `DisallowUnknownFields`，所以请求体**多一个字段就会 400**。前端的请求体类型必须精确，不能顺手带上多余字段。

## SSE 协议

每条事件三行加一个空行：

```
id: 42
event: item.delta
data: {"seq":42,"thread_id":"th_...","turn_id":"turn_...","at":"...","type":"item.delta","payload":{...}}

```

四个实现细节，前端都必须知道：

**`id:` 行就是 `Seq`。** 浏览器 `EventSource` 会把它存进 `MessageEvent.lastEventId`，断线自动重连时放进 `Last-Event-ID` 请求头。前端不用写任何重连代码。

**`data` 里是完整的 Event 信封**，包含 `seq`、`type`，和 `id:`/`event:` 行重复。所以前端可以只解析 `data`，不必依赖 `lastEventId`——两者一致。我们仍然以 `data.seq` 为准，因为它类型明确（`lastEventId` 是字符串）。

**`from_seq` 与 `Last-Event-ID` 语义不同。** 核对 `sse.go: resolveFromSeq`：

```go
// Last-Event-ID: N  →  从 N+1 开始（「我已经收到了 N」）
// ?from_seq=N       →  从 N   开始（「我想要的第一个是 N」）
```

所以前端首次订阅要传 `from_seq = snapshot.last_seq + 1`，**这个 +1 在前端做**。这不是可有可无的兜底路径——原生 `EventSource` 建连时无法自定义任何请求头，首连拿不到 `Last-Event-ID`，`from_seq` 就是专门留给首连的入口。

**心跳是注释行 `: keepalive\n\n`，每 15 秒一次。** 它不符合事件格式，`EventSource` 直接忽略，前端什么都不用做。反过来说：**不能因为长时间没收到业务事件就判定连接已死**，判断连接状态只看 `readyState` 和 `onerror`。

## 事件流的真实形状

下面是从真实日志里提取的完整序列（`item.delta` 已折叠），这是前端 reducer 必须正确处理的唯一权威样本：

```
   1  thread.started
   2  turn.started
   3  message.appended     role=user
── Turn 1：模型直接回答，无工具 ──
   4  step.started         step=1
   5  item.started         agent_message  in_progress
   6-12 item.delta ×7      field=text
  13  item.completed       agent_message  completed（带完整 text）
  14  message.appended     role=assistant
  15  usage.updated        turn_total=505  context_window=128000
  16  turn.completed       final_text=...

── Turn 2：4 步，前 3 步各一次命令执行 ──
  19  step.started         step=1
  20  message.appended     role=assistant  tool_calls=1
  21  usage.updated        turn_total=581
  22  item.started         command_execution  in_progress  command="pwd && ls -la && ..."
  23  message.appended     role=tool
  24  item.completed       command_execution  completed  exit_code=0
  25  step.started         step=2
  ...（step 2、3 同形）
  37  step.started         step=4
  38  item.started         agent_message
  39-459 item.delta ×421   field=text
 460  item.completed       agent_message
 461  message.appended     role=assistant
 462  usage.updated        turn_total=7116
 463  turn.completed
```

从这段序列能读出五条对前端有约束力的事实：

**一、`item.started` 一定在它所属的 `step.started` 之后、下一个 `step.started` 之前。** 这是前端能把 Item 归到 Step 下的唯一依据（Item 自己不带 step 字段，见"契约缺口"）。事件在 Thread 的写锁内顺序 emit、Seq 单调，所以这个顺序是有保证的，可以放心依赖。

**二、有工具调用的 Step 里没有 `agent_message` Item。** 模型那一轮只吐了 tool_call 分片、没有文本分片，而文本 Item 是懒创建的（`aggregate.go`：第一个 `TextDelta` 才建）。所以前端不能假设"每个 Step 都有一条正文"。

**三、`usage.updated` 在 Assistant Message 之后、工具执行之前。** 意味着 Step N 的 token 数在该步的命令跑完之前就已知了。

**四、`item.delta` 的 `field` 目前只可能是 `"text"`。** 命令输出**不是流式的**——`FieldOutput` 这个取值在当前后端从未被发出，命令的全部输出一次性出现在 `item.completed` 的载荷里。前端仍然要实现 `field: "output"` 的分支（协议留了这个口子），但界面不能设计成"依赖命令输出边跑边滚"，因为现在做不到。

**五、`item.completed` 的载荷是完整 Item 快照，含之前所有事件里都没有的字段**（`exit_code`、`duration_ms`、`truncated`、`timed_out`、以及 agent_message 的全文 `text`）。所以 reducer 对 `item.completed` 必须**整体替换**，不能只改 status——这一条直接抄后端 `thread.go: apply` 的同名分支。

## 流式速率：决定渲染架构的那个数字

对真实日志里那条 421 个 delta 的消息做过测量：

| 指标 | 值 |
|---|---|
| delta 总数 | 421 |
| 耗时 | 3.02 s |
| **速率** | **139.5 条/秒** |
| 单条平均长度 | 1.98 字符 |
| delta 间隔 p50 | 0.0 ms（成串爆发） |
| delta 间隔 p90 | 0.6 ms |

这两个数字（139/s、2 字符）是前端状态管理选型的**直接证据**，不是拍脑袋的性能担忧：

- 每条 delta 都触发一次全树重渲染是不可接受的。
- 用 Context 装这份状态更不可接受——Context 的 value 一变，**所有** consumer 无差别重渲染，而这个面板里可能有几十张卡片。

具体怎么应对见 [状态模型与实时层](architecture/state-and-realtime.md)。

## Turn 失败原因码

`turn.failed` 的 `code` 取自 `agent/errors.go`，是封闭集合：

| code | 含义 | 前端文案方向 |
|---|---|---|
| `max_steps` | 反复调工具不给答案，撞上步数上限（默认 20） | 「达到步数上限」，可重新提问 |
| `wall_clock` | 超过墙钟上限（默认 10m） | 「执行超时」 |
| `max_tokens` | 输出被截断，半截工具调用不予执行 | 「输出被截断」 |
| `provider_error` | 模型流失败 | 「模型服务异常」，可重试 |
| `tool_failure` | 工具基础设施故障 | 「工具执行失败」 |
| `cancelled` | 用户主动取消或进程退出 | 「已取消」，不按错误渲染 |

`cancelled` 要和其它五个区别对待：它是用户自己按的按钮，用红色报错框吓唬人不合适。

## 契约缺口与修复

以下七条是核对源码和真机联调时发现的、后端确实给不了前端想要的东西的地方。**全部已修复**，每条都记录了症状、改法和验证方式。

前端对每条都保留了降级路径（字段标为可选、缺失时走兜底），所以前后端可以独立发布。

### 一、Item 不带 Turn / Step 归属 ✅ 已修

**症状**：`Snapshot.Items` 是一个跨所有 Turn 的扁平数组，`Item` 结构体既没有 `turn_id` 也没有 `step`。而事件信封 `Event` 是**有** `TurnID` 的——也就是说，实时流有完整的层次信息，快照投影把它丢掉了。刷新页面后前端拿到一堆没有边界的卡片，画不出"第几轮、第几步"。

**改法**：`Item` 加 `TurnID` 和 `Step` 两个字段，在 `addItem` 里统一填写（而不是让每个 `StartXxxItem` 各填一遍——少一处就会产生一批归不了组的 Item，而且这种缺失只在前端才看得出来）。`Step` 的值来自新加的 `Thread.currentStep`，由 `StartStep` 在锁内更新。

**验证**：`TestItemsCarryTurnAndStep`，以及真机上跑了一轮带工具调用的任务后查快照。

### 二、Snapshot 不带 context_window ✅ 已修

**症状**：`context_window` 只出现在 `usage.updated` 事件里，`Snapshot` 没有这个字段，也没有任何配置端点能拿到。于是打开一个 idle 的历史会话时，前端知道"用了多少 token"但不知道分母，进度条画不出来——要等用户发起下一轮才知道。

**改法**：`Snapshot` 加 `ContextWindow` 字段，值取 `t.contextWindow`。两行。

**前端降级**（保留）：分母未知时不画进度条，只显示绝对值并标注"上限未知"。

### 三、usage 在实时态和重放态语义不同 ✅ 已修

五条里最需要注意的一条，因为它**不是"少给了什么"，而是同一个字段在两种情况下含义不同**。

实时路径（`turn.go: RecordUsage`）：

```go
thread.turnUsage.Add(delta)
thread.usage.Add(delta)      // 跨 Turn 累加
```

重放路径（`thread.go: apply`，进程重启后从 JSONL 恢复时走这里）：

```go
case UsageUpdated:
    t.usage = payload.Turn    // 直接赋值，不是累加
```

于是同一个会话，进程没重启过时 `Snapshot.usage` 是跨 Turn 累计，重启重放后变成最后一个 Turn 的累计。字段注释写的是"跨 Turn 累加"，所以重放那一支更像是笔误而非设计。

**改法**：`t.usage.Add(payload.Delta)`。

注意**不能**写成 `Add(payload.Turn)`——`Turn` 是轮内累计值，直接 Add 会重复计算（同一轮的第 2 次 usage 事件会把第 1 次的量再加一遍）。`Delta` 正是实时路径累加的那个量，用它重放能逐字节复现实时态。

**验证**：`TestReplayReproducesLiveState` 直接对比两条路径的产物；真机上跑两轮（1391 + 834 = 2225 tokens）后重启进程，重放后仍是 2225（旧代码会变成 834）。

### 四、Snapshot 没有轮次元信息 ✅ 已修

**症状**：修完缺口一之后 Item 能归组了，但**归属不等于内容**——轮次的输入文本、最终回答、用量、失败原因都只存在于事件流里。界面上每一轮的标题只能显示"历史轮次（快照未保留输入）"。

**改法**：新增 `TurnMeta` 投影（id / input / status / started_at / usage / final_text / failure_code），`Thread` 加 `turns []TurnMeta` 字段，实时路径在 `BeginTurn` / `Complete` / `Fail` 维护，重放路径在 `apply` 的三个分支维护，`Snapshot` 带出去。

顺带处理了一个边界：进程在 Turn 执行期间挂掉时，日志里那一轮没有终态事件，重放出来会永远停在 `running`。`ReplayThread` 把它标成 `failure_code: "interrupted"`——界面上显示"执行中"是谎言，那个 Turn 的进程早就没了。

**验证**：`TestReplayReproducesLiveState` 逐字段对比 turns；`TestReplayMarksInterruptedTurn` 守中断路径。

有意思的是：改完之后，**一份写于改动之前的 JSONL 也能重放出完整的 turns**——因为 `turn.started` 事件里本来就有 `input`，`Event` 信封里本来就有 `turn_id`。这正是"事件日志是磁盘上的唯一真相"这条设计的兑现：只要事实进了日志，后来新增的投影就能从历史里长出来。

### 五、SSE 空闲流的响应头不被代理转发 ✅ 已修

**这条只有真机联调才会暴露，单元测试测不出来**（测试用 `httptest` 直连，中间没有代理）。

**症状**：订阅一个当前空闲的 Thread 时（`from_seq` 已追平 `last_seq`），后端只写响应头、不写 body，要等下一条事件产生才有数据。而 Vite 的 dev proxy（以及部分 nginx 配置）**在拿到第一个响应体字节之前不会把响应头转发给客户端**。于是浏览器的 `EventSource` 一直停在 `CONNECTING`、`onopen` 不触发，界面一直显示"连接中"——而连接其实早就建好了。

用 curl 直连后端能立刻看到响应头，经过 Vite 代理则什么都收不到，这个对比是定位的关键。

**改法**：写完响应头之后立刻发一行注释 `: connected\n\n` 再 Flush。注释行以 `:` 开头，`EventSource` 会忽略它，不会被当成事件。这同时也成了一次连接健康探测——写失败就说明客户端根本没连上。

### 六、空切片序列化成 null ✅ 已修

**这条是测试盲区的典型**，也是六条里唯一一个会导致**白屏**的。

**症状**：Go 的 `encoding/json` 把 nil 切片编码成 `null` 而不是 `[]`。于是一个刚创建、还没跑过任何任务的会话，快照是：

```json
{ "meta": {...}, "status": "idle", "items": null, "turns": null, "last_seq": 0, ... }
```

前端 `for (const item of snapshot.items)` 直接抛 `TypeError: snapshot.items is not iterable`，React 的 ErrorBoundary 接住，整页白屏。

**为什么所有测试都没发现**：症状只在"一个 item 都没有"时出现，而测试 fixture 总是有数据的——真实会话日志有 463 条事件，手写的 fixture 也都塞了几个 item。前端 33 个测试、后端全套测试，全绿。

是在浏览器里点"新建会话"时才发现的。

**改法**：`append(make([]Item, 0, len(t.items)), t.items...)` 代替 `append([]Item(nil), t.items...)`。后端 `listThreads` 里对 metas 本来就做过同样的处理（"没有会话时返回空数组而不是 null：前端可以直接 .map"），只是 `Snapshot` 这两处漏了。

**前端也同时加了兜底**（`snapshot.items ?? []`）：不因为上游一个字段是 null 就整页崩掉。两边都改不是重复——后端保证正确输出，前端保证不因上游出错而崩，这是两条不同的底线。

### 七、工作目录是假的：设计说按会话，实现是全局 ✅ 已修

**这是七条里最严重的一条**，因为它不是"少给了什么"，而是**一个功能整体没有生效，界面上却看不出来**。

**症状**：在前端新建会话时填 `/Users/me/project-A`，Agent 却报告自己在 `/tmp/demo-ws`（服务启动时 `-workspace` 指定的目录）。换句话说，前端那个「工作目录」输入框**形同虚设** —— 填什么都一样。

**根因**（`grep -rn "\.Workspace" internal/` 一眼可见）：`Thread.Meta.Workspace` 在整个后端只被读过两次，**都是用来过滤会话列表的**，从来没有参与过命令执行的作用域。真正决定在哪执行的是这条链：

```go
// cmd/code-agent-server/main.go —— 启动时一次性绑定
env, err := local.New(*workspace, local.Options{})   // 一个 Environment
tools := tool.NewRegistry(bash.New(env, 0))          // 一个 Registry
codeAgent := agent.New(llm, tools, ...)              // Agent 持有它，终身不变
```

而设计文档 `doc/modules/http-api.md:35` 明确写着：

> 一个工作目录下可以有任意多个 Thread，互相独立。这是 `workspace` 作为 Thread 属性而不是全局配置的原因。

**设计和实现分了岔，而且岔了之后没有任何东西会报错** —— 任务照常跑完，只是跑错了地方。

**为什么我没早发现**：我写契约文档时逐条核对了事件、字段、状态码，唯独这一条我是**照着设计文档信了**，没去追 `Workspace` 字段的读取点。教训很直接：**核对契约要核对"这个字段被谁读"，而不只是"这个字段存不存在"。**

**改法**（三处）：

1. `agent.ToolsFor` —— Agent 不再持有固定的 Registry，改持有 `func(workspace string) (*tool.Registry, error)`。`RunPrepared` 每轮按 `thread.Meta().Workspace` 解析一次。CLI 用 `agent.StaticTools()` 包一个固定的，行为不变。
2. `local.Root` —— 新增执行边界。`-workspace` 从"唯一的工作目录"变成"允许的根目录"，会话可以用它或它下面的任意子目录。
3. `POST /threads` 建会话时就校验，越界返回 400 `invalid_workspace`，并存规范化后的绝对路径。

**为什么要加边界而不是直接放开**：工作目录由 HTTP 客户端指定是设计如此，但"由客户端指定"和"可以是文件系统任意位置"是两回事 —— 后者意味着任何能访问这个端口的人都能让 Agent 在任意目录跑 bash。需要不受限时用 `-allow-any-workspace` 显式打开：**危险的能力应当是「选进来」的，不该是「忘了关」的**。

边界检查解析符号链接后再比较，不是只比字符串前缀 —— 在允许的目录里放一个指向 `/` 的软链接，字面上它确实以根目录开头。这类检查一旦只比字符串就等于没做，`TestRootResolveFollowsSymlinks` 专门守这条。

**验证**：起一个 `-workspace ~/Demo/.wsdemo` 的服务，建两个会话分别指向 `alpha/` 和 `beta/`，各跑 `cat who.txt` —— 一个答 "I am ALPHA"，一个答 "I am BETA"。改之前两个都会答同一个。

### 还没修：断线补发受内存环形缓冲限制

`Thread.backlog` 是容量 2048 的环形缓冲。`Subscribe(fromSeq)` 只能从这个缓冲里补发，补不到已经被挤出去的事件，即使它们在 JSONL 文件里还在。一条 421 个 delta 的消息就占掉 backlog 的 20%。

没修的理由：前端的 seq 缺口自检**本来就要有**（它同时兜住后端 `subscriber.push` 因队列满而丢弃的情况），检测到缺口就重新拉快照，代价只是多一次请求。真要修的话，`Subscribe` 在 backlog 补不全时可以回读 JSONL——但那会让一个内存操作变成磁盘 IO，还要在锁内做，需要先想清楚。

这是一个**知情的不修**，不是遗漏。
