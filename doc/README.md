# agent-console 设计文档

Task 2（前端执行可视化面板）的设计与实现文档。`agent-console` 是 `code-agent`（Go 后端）的同级目录，消费它的 HTTP + SSE 契约。

## 按目的选择读哪篇

**要准备 Code Review** → [React 应答手册](react-review-notes.md)

这是最重要的一篇。按"随机抽一段代码问原理"的标准写的：每一处非平凡决策的理由、涉及的 React/TS 语言特性、以及"如果我是面试官会追问什么"。末尾有自测清单。

**要理解整体架构** → [前端架构总纲](architecture/frontend-blueprint.md)

技术选型、分层与依赖方向、目录结构、路由、错误处理的两条通道、测试策略。

**要理解最难的那部分** → [状态模型与实时层](architecture/state-and-realtime.md)

为什么有三套状态机制、为什么实时投影不用 Context 也不用 Redux、一条 SSE 事件怎么变成界面上会动的卡片、rAF 合并、`useSyncExternalStore` 的约束。

**要对接后端 / 排查联调问题** → [后端契约实录](backend-contract.md)

逐条核对源码和真实日志得出的契约，含实测的流式速率，以及写前端过程中发现并修复的六处后端缺口。

## 与后端文档的关系

后端的设计文档在 `../../code-agent/doc/`，其中最相关的两篇：

- `architecture/session-and-event-model.md`：Thread / Turn / Item 分层与事件协议。本项目的数据模型完全来自这里，不重新发明。
- `modules/http-api.md`：API 表面与 SSE 细节。

**以代码为准**：这两篇和实现有少量出入（比如错误码 `provider_unauthorized` 实际是 `provider_error`），[后端契约实录](backend-contract.md) 里逐条标注了。

## 当前状态

前端已实现并与真实后端联调通过（真实 DeepSeek 调用、多轮对话、进程重启后恢复）。33 个前端测试、`tsc --noEmit` 与生产构建全部通过；后端改动配了 Go 回归测试，`go vet` + `go test -race ./...` 全绿。

已知不足列在[架构总纲](architecture/frontend-blueprint.md)末尾和[应答手册](react-review-notes.md)第九节。
