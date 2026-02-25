# CyberGroupmate — 项目实施方案

> **文档版本**: 0.1.0
> **最后更新**: 2026-02-25
> **状态**: 初始规划

---

## 工程进度追踪

> **指示（给负责实施的 Coding Agent）**：每完成一个 Task，请更新下方表格的状态，并在「实施笔记」列补充你做出的关键决策、遇到的问题、以及与原计划的偏差。如果实施过程中发现原计划有设计缺陷或需要调整，请直接修改对应章节并在变更处标注 `[REVISED @Phase-X]`。

| Phase | Task | 状态 | 实施笔记 |
|-------|------|------|----------|
| 1.1 | NotificationCenter | ⬜ 未开始 | |
| 1.2 | Sandbox + Worker | ⬜ 未开始 | |
| 1.3 | BackgroundManager | ⬜ 未开始 | |
| 1.4 | Memory Store | ⬜ 未开始 | |
| 1.5 | SceneManager + 类型定义文件 | ⬜ 未开始 | |
| 2.1 | LLM 调用封装 | ⬜ 未开始 | |
| 2.2 | CodeAct Session Runner | ⬜ 未开始 | |
| 2.3 | Bootstrap 流程 | ⬜ 未开始 | |
| 2.4 | Main Event Loop | ⬜ 未开始 | |
| 3.1 | Session Compaction | ⬜ 未开始 | |
| 3.2 | Agent State 管理 | ⬜ 未开始 | |
| 3.3 | System Prompt 调优 | ⬜ 未开始 | |
| 3.4 | 安全限制（rate limit、禁止破坏性操作） | ⬜ 未开始 | |
| 4.1 | 错误恢复（sandbox 重启 + bootstrap 重放） | ⬜ 未开始 | |
| 4.2 | CLI 工具 | ⬜ 未开始 | |
| 4.3 | 配置化 | ⬜ 未开始 | |

---

## 0. 项目概述

### 0.1 愿景

CyberGroupmate（赛博群友）是一个基于 LLM 的 Telegram 社交智能体。终极目标：**让新来的群友一点都看不出这是赛博群友。**

它具备以下能力：对每个群友的记忆、图像识别、发表情包、读空气（智能的对话管理和响应机制）、消息历史搜索、联网搜索，以及更多可扩展的能力。

### 0.2 核心架构理念

本项目借鉴 CodeAct 论文（Wang et al., 2024, "Executable Code Actions Elicit Better LLM Agents"）的核心理念，但不使用其代码库。我们提取的关键思想是：

1. **代码即统一动作空间**：让 LLM 直接写可执行代码来执行所有动作（读消息、发消息、搜索记忆等），而非通过预定义的 JSON/Text tool calling。代码天然支持控制流（for/if）和数据流（变量复用），一次动作可以组合多个操作。
2. **多轮交互与自我调试**：Agent 写代码 → 执行 → 看到结果（或错误信息）→ 修正 → 继续。错误信息是天然的自动反馈机制。
3. **直接使用现有软件包**：Agent 直接 `import` 并操作 mtcute、Playwright 等库，不需要人为封装 tool。

### 0.3 与传统聊天机器人架构的根本区别

传统做法是：收到消息 → 调用 LLM → 拿到回复文本 → 发送。每个会话独立处理。

本项目的做法是：Agent 运行在一个**持续的事件循环**中。外部信息（@消息、私聊、cron 提醒等）汇入一个 Notification Center。Agent 的 main loop 只看这个事件流，然后**自己写代码**决定调用哪些能力去读消息、搜索记忆、生成并发送回复。Agent 甚至自己写代码来 setup 要监听哪些消息——订阅逻辑本身也是 agent 的代码产出。

### 0.4 技术选型

| 组件 | 选型 | 理由 |
|------|------|------|
| 语言 | **TypeScript** | mtcute 是原生 TS 库，零桥接；TS 类型系统提供额外的自动错误反馈；现代 LLM 写 TS 能力已很强 |
| Runtime | **Bun** | 直接运行 TypeScript 无需编译；内置 SQLite（`bun:sqlite`）；启动快；兼容 Node.js API |
| Telegram 客户端 | **@mtcute/node** | 已有配置好的 env 和 session |
| LLM | Claude Sonnet 4 / GPT-4o 等（可配置） | 需要强代码生成 + 长 context + 中文能力 |
| 记忆存储 | SQLite + FTS5 | 零外部依赖，Bun 内置，够用 |
| 事件日志 | Append-only JSONL | 零依赖，可 grep，未来可接日志系统 |

### 0.5 MVP 边界

**MVP 做的事**：
- Agent 通过自己写 TypeScript 代码连接 Telegram、设置消息订阅、读取消息、回复消息
- 场景化的类型上下文系统（Telegram / Memory / Home）
- 基础记忆系统（SQLite FTS5）
- Session compaction 和 agent state 持久化
- 错误恢复（sandbox 崩溃后自动重启 + bootstrap 重放）
- CLI 查看工具
- 结构化事件日志（可观测性基础）

**MVP 不做但架构预留的事**：
- 多平台支持（架构上只需新增场景即可）
- 向量语义搜索（Memory 接口预留 `vectorSearch` 方法）
- 图像/表情包生成
- 自主安装新工具（sandbox 支持动态 install 但 MVP 不主动引导）
- 精细的可观测性 dashboard
- 多 agent 协作
- Human-in-the-loop 审批

---

## 1. 系统架构

### 1.1 总体架构

```
┌──────────────────────────────────────────────────────────────┐
│                    Host Process (Bun)                         │
│                                                              │
│  ┌─────────────┐    ┌──────────────┐    ┌────────────────┐   │
│  │ Agent Loop   │◄──│ Notification │◄───│ Background     │   │
│  │ (orchestrator│    │ Center       │    │ Task Manager   │   │
│  │  + LLM call) │    │ (event queue)│    │ (agent-spawned)│   │
│  └──────┬───────┘    └──────────────┘    └───────▲────────┘   │
│         │                                        │            │
│         │ 提交代码                     stdout / notify()      │
│         ▼                                        │            │
│  ┌──────────────────────────────────────────────────────┐    │
│  │              Code Execution Sandbox                   │    │
│  │  Bun subprocess（持久化命名空间，跨代码块保留变量）      │    │
│  │  预装: @mtcute/node 等                                │    │
│  │  注入: runtime (notify/spawn/cron), memory, scene     │    │
│  └──────────────────────────────────────────────────────┘    │
│         │                                                     │
│         ▼                                                     │
│  ┌──────────────┐    ┌──────────────┐                        │
│  │ Memory Store  │    │ Event Log    │                        │
│  │ (SQLite+FTS5) │    │ (JSONL)      │                        │
│  └──────────────┘    └──────────────┘                        │
└──────────────────────────────────────────────────────────────┘
```

整个系统是**一个 Bun 进程**（或一个 container）。不引入消息队列、不引入微服务。

### 1.2 数据流

1. Agent 在 bootstrap 阶段写代码连接 Telegram，通过 `runtime.spawn()` 创建后台监听任务
2. 后台任务通过 `runtime.notify()` 将筛选后的消息事件推入 Notification Center
3. Main loop 用 `nc.drain()` 批量取出事件，组装 context 后调用 LLM
4. LLM 输出思考 + TypeScript 代码块
5. 代码在 Sandbox 中执行，结果作为 observation 返回给 LLM
6. 多轮交互直到 agent 完成处理（不再输出代码块）
7. Session 结束后做 compaction，更新 agent state 和长期记忆

### 1.3 场景（Scene）系统

这是本项目的一个关键设计。Agent 的 context window 是有限资源，应像人类注意力一样管理。

**核心概念**：Agent 在任一时刻只处于一个「场景」中。每个场景提供该场景专属的 TypeScript 类型定义（`.d.ts`）。Agent 通过 `scene.enter("telegram")` 切换场景，此时新场景的类型定义作为 observation 返回，替代之前的类型信息。

这类似于 AVG 游戏中进入不同房间——进入不同场景，能施展的动作不同。但 agent 始终拥有自己的意识流（连贯的 LLM 对话历史），知道自己要干什么。

**场景切换的运行时行为**：
- `scene.enter(name)` 被调用时，sandbox worker 返回新场景的类型定义和上下文说明作为 stdout 输出
- 这个输出成为 CodeAct 交互中的 observation，进入下一轮 LLM 输入
- Agent 看到新的类型定义后，就知道在这个场景中可以做什么

**类型定义的展开粒度**：
- **L0（场景列表）**：只有场景名 + 一句话描述。在 home 场景中通过 `scene.list()` 获得。
- **L1（核心类型）**：进入场景后默认展示。手写的精简版类型定义，只包含常用方法和核心数据结构。这不是库的完整 `.d.ts`，而是我们人工裁剪的子集，控制 token 消耗。
- **L2（完整类型）**：Agent 遇到困难时可以调用 `scene.showFullTypes()` 主动请求更详细的类型定义。

**MVP 包含的场景**：
- `home`：通知中心。查看通知、决定下一步、切换场景。只有 `scene`、`runtime`、`ctx` 的类型。
- `telegram`：Telegram 操作。类型定义包含精简版的 `TelegramClient`、`Message`、`Chat`、`User` 等接口。
- `memory`：记忆系统。类型定义包含 `MemoryStore`、`PersonProfile`、`ConversationSummary` 等接口。

**扩展预留**：
- 未来新增 `browser` 场景（Playwright）只需新增一个 `.d.ts` 文件和场景注册条目
- Agent 可以自己注册新场景（`scene.register(name, typeDefs)`）

### 1.4 通知积累与批量呈现

Agent 在处理当前事件批次期间（一个 CodeAct session 内），新到达的通知在 Notification Center 队列中静默积累，不打断当前工作流。通知的呈现时机：

1. **Session 之间**：每个 session 结束后，main loop 回到 `nc.drain()` 等待，此时积累的通知和新通知一起被取出，组成下一个 session 的输入。
2. **Session 内定期追加**：每隔 N 轮代码执行（建议 5 轮），检查是否有新通知。如果有，以 `[新通知到达]` 的形式追加到对话中，agent 可以选择立即处理或继续当前任务。

---

## 2. 组件详细设计

### 2.1 Notification Center

**职责**：线程安全的内存事件队列 + append-only JSONL 持久化日志。

**接口**：
- `push(event)`: 写入队列并 append 到 JSONL 文件。自动添加 `_id`（ULID）和 `_ts`（时间戳）。
- `drain(timeout, maxBatch)`: 异步等待并批量取出事件。至少等到一个事件或超时。最多返回 `maxBatch` 条。

**设计要点**：
- 使用 ULID 作为事件 ID，单调递增，便于排序和去重。
- JSONL 文件是 append-only 的，所有事件（包括系统内部事件如代码执行记录）都写入，形成完整的审计日志。
- `drain` 的超时机制：如果超时无事件，返回空数组。Main loop 据此决定是否执行 idle 行为。

**扩展预留**：JSONL 格式可直接被 Grafana Loki / Elasticsearch 导入。`_id` 可用于未来的 exactly-once 处理。

### 2.2 Code Execution Sandbox

**职责**：在隔离的 Bun 子进程中执行 agent 写的 TypeScript 代码，维护跨代码块的持久化命名空间。

**架构**：Host 进程通过 stdin/stdout JSON 行协议与 sandbox worker 子进程通信。

**Host 侧（sandbox.ts）**：
- 管理子进程生命周期
- `execute(code, timeout)`: 发送代码到 worker，等待执行结果，支持超时
- `isAlive()`: 检查子进程是否存活
- 崩溃检测和重启能力

**Worker 侧（sandbox-worker.ts）**：
- 维护一个持久化的 `ctx` 对象挂在 `globalThis` 上，agent 代码中 `ctx.xxx = ...` 的赋值会跨代码块保留
- 预注入 `runtime`（notify/spawn/kill/ps/cron）、`memory`、`scene` 到 `globalThis`
- 每段代码通过 `new Function()` + async wrapper 执行，支持 top-level `await`
- 劫持 `console.log`：输出被捕获并作为执行结果返回（这是 agent 获取信息的主要手段）
- 错误被 catch 并将 stack trace 作为输出返回（自动错误反馈）

**关键设计**：
- 使用 `new Function("ctx", "runtime", "memory", "scene", "return (async () => { <code> })()")` 来执行代码。这让 agent 的代码可以直接访问注入的 API，同时支持 `await`。
- `ctx` 对象是跨代码块共享状态的唯一机制。Agent 在第一个代码块中 `ctx.client = new TelegramClient(...)` 后，后续代码块可以直接用 `ctx.client`。
- 后台任务（`runtime.spawn` 创建的）运行在 worker 进程内的 asyncio 任务中。它们通过 `runtime.notify()` 与 Notification Center 通信。注意 Notification Center 的实例需要在 host 和 worker 之间共享——实现方式是 worker 中的 `runtime.notify()` 通过 IPC（例如 stdout 上的特殊 JSON 消息类型）将事件传递给 host 进程中的 NotificationCenter。

### 2.3 Background Task Manager

**职责**：管理 agent 通过 `runtime.spawn()` 创建的后台长驻任务。

**接口**：
- `spawn(name, asyncFn)`: 启动一个命名的后台协程。同名不可重复，需先 kill。
- `kill(name)`: 通过 AbortController 取消任务。
- `ps()`: 列出所有任务及其状态。

**关键设计**：
- 每个后台任务被 `guardedRun` 包裹。如果任务抛出异常（非正常取消），自动向 Notification Center 推送一个 `system.background_error` 事件，包含任务名、错误信息和 stack trace。Agent 在下次 poll 到这个事件时可以自己决定是否重启任务。这是 CodeAct "自动错误反馈 → 自我调试" 理念的延伸。
- 使用 AbortController/AbortSignal 实现任务取消。

### 2.4 Memory Store

**职责**：提供记忆的存储、搜索和管理。MVP 基于 SQLite + FTS5 全文搜索。

**数据表**：
- `memories`（FTS5 虚拟表）：通用记忆条目。字段：`content`（文本）、`metadata`（JSON 字符串）、`timestamp`。
- `person_profiles`：群友画像。字段：`user_id`（主键）、`data`（JSON）、`updated_at`。
- `conversation_log`：对话摘要日志。字段：`id`、`chat_id`、`chat_title`、`summary`、`key_points`（JSON 数组）、`timestamp`。

**接口**：
- `search(query, limit)`: FTS5 全文搜索记忆
- `store(content, metadata)`: 存入一条记忆
- `getPerson(userId)` / `updatePerson(userId, data)`: 群友画像 CRUD（update 是 merge 模式）
- `getRecentConversations(chatId?, limit)`: 获取对话摘要
- `rawQuery(sql, ...params)`: 直接执行 SQL（agent 高级用法）

**扩展预留**：`Memory` 是一个清晰的接口，后续加向量搜索只需新增 `vectorSearch` 方法，底层接 pgvector / Qdrant。Agent 也可以直接通过 `rawQuery` 做任意 SQL 查询。

### 2.5 Scene Manager

**职责**：管理场景注册表和场景切换。

**数据结构（每个场景）**：
- `name`: 场景标识符
- `description`: 一句话描述（在 `scene.list()` 中展示）
- `typeDefs`: L1 级别的精简类型定义字符串（`.d.ts` 文件内容）
- `fullTypeDefs`（可选）: L2 级别的完整类型定义
- `contextSetup`（可选）: 进入场景时的额外说明文本（如 "ctx.tg 已连接"）
- `prelude`（可选）: 进入场景时在 sandbox 中自动执行的代码

**注入到 sandbox 的接口**：
- `scene.enter(name)`: 切换场景。返回值包含场景说明和类型定义，agent 通过 `console.log` 或直接的 return 看到这些信息。
- `scene.current`: 当前场景名
- `scene.list()`: 列出所有可用场景
- `scene.showFullTypes()`: 展示当前场景的 L2 完整类型定义

**在 sandbox worker 中的实现**：`scene.enter()` 被调用时，它做三件事：(1) 更新内部状态；(2) 如果有 prelude 代码则执行；(3) 将场景说明 + 类型定义通过 `console.log` 输出。由于 `console.log` 的输出会作为代码执行的 observation 返回给 LLM，agent 自然就看到了新场景的能力说明。

### 2.6 LLM 调用封装

**职责**：封装对 LLM API 的调用，支持多 provider。

**接口**：
- `callLLM(messages): Promise<string>`: 接受 OpenAI 格式的消息数组，返回 assistant 回复文本。

**设计要点**：
- 支持 Anthropic Claude API 和 OpenAI 兼容 API（通过配置切换）
- 处理 rate limiting 和重试
- 可配置 model name、temperature、max tokens 等

### 2.7 Agent Main Loop（Orchestrator）

这是系统的心脏。它编排整个生命周期：

**Phase 1 — Bootstrap**：
1. 创建 NotificationCenter、Sandbox、Memory、SceneManager 实例
2. 向 LLM 发送 bootstrap prompt，告知 agent 它的身份、可用的 runtime API、以及需要设置 Telegram 订阅
3. 运行一个 CodeAct session（多轮），agent 自己写代码完成连接和订阅设置
4. Agent 表示 READY 后进入主循环

**Phase 2 — Main Event Loop**：
1. `nc.drain(timeout)` 等待事件
2. 如果有事件：
   a. 读取当前 agent state
   b. 格式化事件为文本
   c. 组装 context：system prompt + agent state + home 场景类型定义 + 事件文本
   d. 运行 CodeAct session（agent 可能切换多个场景来处理事件）
   e. Session 结束后执行 compaction
3. 如果超时无事件：可选执行 idle 行为（MVP 中跳过）
4. 检查 sandbox 是否存活，不存活则重启并重放 bootstrap

**CodeAct Session Runner** 的逻辑：
1. 调用 LLM 获取 response
2. 解析 response：分离自然语言思考和 TypeScript 代码块（匹配 ` ```typescript ` / ` ```ts ` 围栏）
3. 如果没有代码块 → session 结束
4. 如果有代码块 → 在 sandbox 中依次执行，收集输出
5. 将执行输出作为 `[Execution Output]` 追加到消息历史
6. 每隔 N 轮（建议 5 轮）检查 NC 中是否有新通知，如有则追加到消息历史
7. 重复直到无代码块或达到最大轮次（建议 15 轮）

### 2.8 Session Compaction

**职责**：每个 CodeAct session 结束后，压缩会话内容并归档到记忆系统。

**流程**：
1. 提取 session 中的关键信息（最近若干条消息）
2. 调用 LLM 生成结构化摘要（JSON 格式），包含：
   - 和谁聊了什么（对话摘要）
   - 学到的新事实
   - 需要更新的人物信息
   - 待办事项
   - 需要追加到 agent state 的内容
3. 将摘要写入 `conversation_log` 表
4. 将新事实写入 `memories` 表
5. 更新 `person_profiles` 表
6. 更新 `data/agent-state.md`

**关键设计**：Compaction 使用独立的 LLM 调用（不是 agent 自己做的），用一个专门的 prompt 模板来提取结构化信息。这保证了即使 agent 忘记存记忆，系统也会自动归档。

但同时，agent 在 session 内也可以主动调用 `memory.store()` 等方法来存储信息——这给了 agent 额外的主动记忆能力。

---

## 3. 类型定义文件规范

每个场景的 `.d.ts` 文件是 agent 理解其能力的核心。以下是编写规范和 MVP 所需文件。

### 3.1 编写原则

1. **精简但完备**：只包含 agent 常用的方法和数据结构，不是库的完整类型。目标是控制在 100-200 行以内。
2. **注释即文档**：每个方法和字段都有 JSDoc 注释。Agent 读注释来理解用法。
3. **类型即约束**：精确的参数和返回值类型帮助 agent 写出正确代码。类型错误是额外的自动反馈。
4. **跨场景共用类型**：`scene`、`runtime`、`ctx` 在所有场景中都可用，但每个场景的 `.d.ts` 中都要声明它们（因为每次场景切换只展示当前场景的类型定义）。

### 3.2 home.d.ts

定义场景切换、runtime 管理、ctx 这三个在任何场景都可用的基础 API。这是 agent 启动时和回到"通知中心"时看到的类型。

关键接口：
- `scene.enter(name)` / `scene.current` / `scene.list()` / `scene.showFullTypes()`
- `runtime.notify(event)` / `runtime.spawn(name, fn)` / `runtime.kill(name)` / `runtime.ps()` / `runtime.cron(expr, name, fn)`
- `ctx: Record<string, any>` — 跨场景、跨代码块的持久化变量容器

### 3.3 telegram.d.ts

精简版的 mtcute 操作接口。这不是 mtcute 的真实类型——是我们根据 agent 需要手工编写的子集。

关键接口：
- `TelegramClient`：`sendText`, `getMessages`, `getDialogs`, `forwardMessages`, `sendSticker`, `searchMessages`, `onNewMessage`（AsyncIterable，用于后台监听）, `getMe`
- `Message`：`id`, `text`, `date`, `chat`, `sender`, `mentioned`, `replyToMessageId`, `media`, `sticker`
- `Chat`：`id`, `type`, `title`, `username`
- `User`：`id`, `firstName`, `lastName`, `username`
- `Dialog`：`chat`, `lastMessage`, `unreadCount`

声明 `ctx.tg` 的类型为 `TelegramClient`。同时也声明 `scene`、`runtime`。

### 3.4 memory.d.ts

记忆系统操作接口。

关键接口：
- `MemoryStore`：`search`, `store`, `getPerson`, `updatePerson`, `getRecentConversations`, `getPendingTasks`, `addTodo`, `rawQuery`
- `PersonProfile`：`userId`, `displayName`, `notes`, `traits`, `lastInteraction`
- `ConversationSummary`：`chatId`, `chatTitle`, `summary`, `keyPoints`, `timestamp`
- `TodoItem`：`id`, `description`, `createdAt`, `dueDate`, `done`

声明 `memory` 为 `MemoryStore` 类型。同时也声明 `scene`、`runtime`、`ctx`。

---

## 4. System Prompt 设计

System prompt 定义了 agent 的行为模式和人格，是整个系统的"灵魂"。

### 4.1 结构

```
# 你是谁
[人格定义、说话风格、兴趣爱好]

# 你的运行环境
[解释 CodeAct 模式：你通过写 TypeScript 代码来行动]
[解释 ctx 对象、场景系统、runtime API]

# 你的工作方式
[解释事件循环：收到通知 → 进入对应场景 → 写代码处理 → 存记忆]

# 重要行为原则
- 不要每条消息都回复。真人不会这样做。读空气。
- 回复要自然，用群里的语气风格。
- 如果不确定上下文，先查记忆或拉历史消息。
- 如果代码执行出错，看错误信息自己 debug。
- 你可以随时修改自己的订阅规则。

# 可用 API 概览
[极简概述——详细类型在进入场景后可见]
- scene.enter("telegram") — 进入 Telegram 操作场景
- scene.enter("memory") — 进入记忆系统场景
- runtime.spawn/kill/ps — 后台任务管理
- ctx — 跨场景持久化变量
```

### 4.2 人格可配置

人格部分从 `config.yaml` 中读取，注入 system prompt。这样可以通过修改配置文件来改变 agent 的性格，不用改代码。

---

## 5. 错误恢复与安全

### 5.1 分层错误处理

| 级别 | 场景 | 处理方式 |
|------|------|---------|
| L1 | Agent 代码执行出错（语法错误、运行时异常） | 错误 stack trace 作为 observation 返回给 LLM，agent 自己 debug 并重试 |
| L2 | 后台任务崩溃（Telegram 断连、网络错误） | `guardedRun` 捕获异常 → 推 `system.background_error` 事件到 NC → agent 下次 poll 到后自己决定是否重启 |
| L3 | Sandbox worker 进程崩溃（OOM、段错误） | Orchestrator 检测 `isAlive() === false` → 创建新 sandbox → 重放 bootstrap 代码 |
| L4 | Host 进程崩溃（程序 bug、机器重启） | 从 events.jsonl 恢复。重新启动全流程。 |

### 5.2 Bootstrap 重放

为支持 L3 级恢复，需要保存 bootstrap 阶段 agent 写的所有代码。具体方案：
- Bootstrap session 中 agent 每段成功执行的代码都保存到 `data/bootstrap-code.json`
- Sandbox 重启后，依次自动执行这些代码（不经过 LLM），快速恢复到 bootstrap 完成后的状态
- 如果重放中某段代码失败，则回退到完整的 LLM bootstrap 流程

### 5.3 安全限制

**MVP 的简单方案**：
- **Rate limiting**：每个 CodeAct session 内，发送消息计数器。超过阈值（如 10 条/session）时抛出 `RateLimitError`，agent 看到后可以选择停止或显式提升限制。
- **禁止破坏性操作**：在注入 sandbox 的 Telegram client wrapper 中，`deleteMessages`、`banUser` 等操作直接抛出 `PermissionError`。
- **所有发出的消息记录**：agent 发送的每条消息的 ID 记录在 event log 中，出事时可以批量撤回。

**扩展预留**：
- 未来可加 human-in-the-loop：敏感操作暂停执行 → 推通知给管理员 → 等待审批
- 可加回滚机制：根据 event log 中记录的消息 ID 批量删除

---

## 6. 可观测性

MVP 不做 dashboard，但所有关键数据以结构化方式记录。

### 6.1 Event Log

`data/events.jsonl`，Notification Center 的 append-only 日志。记录所有事件：
- 外部事件：Telegram 消息、cron 触发
- 代码执行事件：`system.code_execution`，包含 agent 写的代码和执行输出
- 系统事件：后台任务启动/崩溃、sandbox 重启、场景切换
- Agent 动作：发出的消息（带消息 ID）

### 6.2 Session Transcripts

`data/sessions/` 目录，每个 session 一个 JSONL 文件。记录完整的 LLM 对话历史（所有轮次的 messages）、触发事件、compaction 结果。

### 6.3 CLI 工具

`src/cli.ts`，提供基本的查看能力：

```bash
bun run cli events --tail 20        # 查看最近事件
bun run cli sessions --last 5       # 查看最近 session
bun run cli state                   # 查看 agent 当前状态
bun run cli ps                      # 查看后台任务
bun run cli person @username        # 查看某人画像
bun run cli memory search "关键词"  # 搜索记忆
```

---

## 7. 目录结构

```
cybergroupmate/
├── src/
│   ├── main.ts                     # Orchestrator / Agent Main Loop
│   ├── notification-center.ts      # 事件队列
│   ├── sandbox.ts                  # Sandbox host 侧管理
│   ├── sandbox-worker.ts           # Sandbox worker 进程
│   ├── background-manager.ts       # 后台任务管理
│   ├── memory.ts                   # SQLite 记忆存储
│   ├── scene-manager.ts            # 场景管理
│   ├── llm.ts                      # LLM API 封装
│   ├── compaction.ts               # Session 压缩
│   ├── cli.ts                      # CLI 工具
│   └── scenes/                     # 场景定义
│       ├── index.ts                # 场景注册表
│       ├── home.d.ts
│       ├── telegram.d.ts
│       ├── telegram.full.d.ts      # L2 完整类型（可选，agent 请求时展开）
│       └── memory.d.ts
├── system-prompt.md
├── config.yaml                     # 配置文件（LLM、人格、rate limit 等）
├── data/                           # 运行时数据（gitignore）
│   ├── tg-session/
│   ├── memory.db
│   ├── events.jsonl
│   ├── agent-state.md
│   ├── bootstrap-code.json
│   └── sessions/
├── package.json
├── tsconfig.json
└── tests/
    ├── notification-center.test.ts
    ├── sandbox.test.ts
    ├── memory.test.ts
    └── scene-manager.test.ts
```

**预计核心代码量：1000-1500 行 TypeScript。**

---

## 8. 分阶段实施计划

### Phase 1：基础 Runtime（目标：~1 周）

**目标**：所有基础组件可用，能手动在 sandbox 中执行 TS 代码连接 Telegram 并收发消息。

**Task 1.1 — NotificationCenter**
- 实现 `push` 和 `drain`
- JSONL 持久化
- 单元测试：push/drain 正确性、JSONL 写入正确性、drain 超时行为

**Task 1.2 — Sandbox + Worker**
- 实现 host 侧的 `Sandbox` 类（进程管理、stdin/stdout JSON 通信、execute 方法）
- 实现 worker 侧的 REPL loop（`new Function()` 执行、`console.log` 劫持、错误捕获）
- 实现 `ctx` 持久化命名空间
- worker 到 host 的 IPC 机制（worker 中 `runtime.notify()` 的事件如何传回 host 的 NC）
- 单元测试：代码执行、变量跨块保留、错误捕获、超时处理

**Task 1.3 — BackgroundManager**
- 实现 `spawn`、`kill`、`ps`
- 实现 `guardedRun`（崩溃事件推送）
- 单元测试：任务启动/停止、崩溃捕获

**Task 1.4 — Memory Store**
- 创建 SQLite 表（FTS5 + person_profiles + conversation_log）
- 实现所有接口方法
- 单元测试：CRUD、FTS5 搜索

**Task 1.5 — SceneManager + 类型定义文件**
- 实现 SceneManager（场景注册、enter、list、showFullTypes）
- 编写 `home.d.ts`、`telegram.d.ts`、`memory.d.ts`
- 将 SceneManager 注入 sandbox worker
- 单元测试：场景切换返回正确的类型定义

**Phase 1 验收标准**：写一个集成测试脚本，在 sandbox 中依次执行以下操作：
1. `scene.enter("telegram")` → 看到 telegram 类型定义
2. 写代码连接 mtcute 并 `getMe()`
3. `runtime.spawn("listener", ...)` 启动后台监听
4. 从另一个 Telegram 账号发消息
5. 后台任务通过 `runtime.notify()` 推送事件
6. 在 host 侧 `nc.drain()` 取到事件

### Phase 2：Agent Loop + LLM 集成（目标：~1 周）

**目标**：Agent 能自主 bootstrap 并响应 @ 消息。

**Task 2.1 — LLM 调用封装**
- 实现 `callLLM(messages)` 函数
- 支持 Anthropic Claude API 和 OpenAI 兼容 API
- 处理 rate limiting 和重试
- 通过 `config.yaml` 配置 model、temperature 等

**Task 2.2 — CodeAct Session Runner**
- 实现 `runCodeActSession` 函数
- Response 解析（分离思考和代码块）
- 代码执行结果反馈
- Session 内定期追加新通知（每 5 轮检查 NC）
- 最大轮次限制
- Session 过程记录到 `data/sessions/`

**Task 2.3 — Bootstrap 流程**
- 编写 bootstrap prompt
- 实现 bootstrap session 运行
- 保存成功执行的代码到 `data/bootstrap-code.json`

**Task 2.4 — Main Event Loop**
- 实现完整的 main loop（bootstrap → event loop）
- Context 组装（system prompt + agent state + home 类型定义 + 事件文本）
- Sandbox 崩溃检测与重启

**Phase 2 验收标准**：启动 agent → agent 自主连接 Telegram 并设置监听 → 有人 @ agent → agent 读取消息上下文并回复。完整链路跑通。

### Phase 3：记忆与人格（目标：~1 周）

**目标**：Agent 能跨 session 记住群友信息，回复风格自然。

**Task 3.1 — Session Compaction**
- 实现 compaction prompt 模板
- 实现 compaction 流程（调用 LLM → 解析结果 → 写入 memory 各表）
- 在每个 session 结束后自动执行

**Task 3.2 — Agent State 管理**
- 定义 `data/agent-state.md` 的初始内容和格式
- 实现 state 的读取和更新逻辑
- Compaction 结果自动 merge 到 agent state

**Task 3.3 — System Prompt 调优**
- 编写完整的 `system-prompt.md`
- 定义人格描述格式（从 config.yaml 读取）
- 迭代测试：观察 agent 的回复风格、是否读空气、是否合理使用记忆

**Task 3.4 — 安全限制**
- 实现消息发送 rate limiter
- 实现破坏性操作拦截
- 实现发出消息 ID 的记录

**Phase 3 验收标准**：Agent 在真实 Telegram 群里运行 24 小时。能记住群友提到的信息，在后续对话中引用；回复风格自然，不刷屏；对话有来有回。

### Phase 4：稳定性与工具（目标：~3-5 天）

**目标**：系统可靠运行，出问题时可排查。

**Task 4.1 — 错误恢复**
- 实现 sandbox 崩溃检测 + 自动重启
- 实现 bootstrap 代码重放
- 测试：手动 kill sandbox 进程后系统自动恢复

**Task 4.2 — CLI 工具**
- 实现 `cli.ts` 的各子命令

**Task 4.3 — 配置化**
- 定义 `config.yaml` 的 schema
- 人格、模型选择、rate limit、drain timeout 等可配置
- 实现配置加载和验证

**Phase 4 验收标准**：连续运行 48h 无不可恢复的崩溃。CLI 工具可用。配置修改后重启即生效。

---

## 9. 关键实现细节备忘

### 9.1 Sandbox Worker 的 IPC 设计

Worker 进程和 Host 进程之间通过 stdin/stdout 的 JSON 行协议通信。需要区分以下几种消息类型：

**Host → Worker**：
- `{ type: "execute", id: string, code: string }` — 执行代码

**Worker → Host**：
- `{ type: "result", id: string, output: string, error: boolean }` — 代码执行结果
- `{ type: "notify", event: object }` — 后台任务推送事件（转发给 NC）
- `{ type: "spawn", name: string }` — 后台任务启动通知
- `{ type: "kill", name: string }` — 后台任务停止通知

### 9.2 代码块解析

从 LLM 输出中提取代码块：匹配 ` ```typescript ` / ` ```ts ` / ` ```js ` 围栏内的内容。如果一个 response 中有多个代码块，依次执行，输出合并。

### 9.3 Context Window 管理

每个 CodeAct session 的消息列表会增长。为避免超出 context window：
- 每个代码执行输出截断到 4000 字符
- Session 最多 15 轮
- Agent state 截断到 4000 字符
- 事件文本中每个事件的预览截断到 300 字符

### 9.4 Agent 的 Telegram 连接方式

Agent 在 bootstrap 时自己写代码创建 mtcute client。环境变量中应预配置：
- `TG_API_ID`
- `TG_API_HASH`
- `TG_BOT_TOKEN`（如果用 bot 模式）或 session 文件路径（如果用 userbot 模式）

Agent 在 bootstrap 时从 `process.env` 读取这些值。

---

## 10. 给 Claude Code 的操作指示

1. **按 Phase 和 Task 顺序实施**。每完成一个 Task，更新本文档顶部的进度追踪表。
2. **每个组件先写单元测试，再写实现**。使用 `bun test` 运行测试。
3. **如果实施中发现设计需要调整，直接修改本文档对应章节**，并在改动处标注 `[REVISED @Phase-X.Y]` 及修改原因。
4. **代码风格**：使用 TypeScript strict mode、ESM、async/await。不使用 class 继承。优先使用函数式风格，但核心组件（NotificationCenter、Sandbox、Memory 等）使用 class。
5. **依赖极简**：`package.json` 中只需要 `@mtcute/node`、`ulid`（或类似的 ID 生成库），以及 `@types/bun`。其他一切用 Bun 内置能力或手写。
6. **Phase 1 结束时运行集成测试**，确认全链路（sandbox 执行代码 → mtcute 连接 → 后台监听 → 事件推送 → NC drain）可用。
7. **Phase 2 结束时做一次端到端测试**：启动 agent → 观察 bootstrap 日志 → 从另一个账号 @ agent → 确认 agent 回复。
8. **每个 Phase 结束后，在本文档末尾的「实施日志」章节追加一段总结**，记录该阶段的关键决策、遇到的问题、以及对后续阶段的影响。

---

## 附录 A：Agent 行为示例

以下展示 agent 处理一条 @ 消息的完整交互流程，帮助理解系统各组件如何协作。

**触发**：Notification Center 收到事件 `{ type: "telegram.message", priority: "high", chatTitle: "二次元研究所", fromUser: "alice", preview: "@CyberGroupmate 你觉得东京有什么好玩的", chatId: -100123456, messageId: 42 }`

**Turn 0 — Home 场景**：Orchestrator 将事件 + agent state + home 类型定义组装成 context 发给 LLM。

**Turn 1 — Agent 决定进入 Telegram 场景**：Agent 输出思考 + `scene.enter("telegram")`。Observation 返回 telegram 类型定义。

**Turn 2 — Agent 读取完整消息上下文**：Agent 写代码 `const msgs = await ctx.tg.getMessages(-100123456, { limit: 15 })`，通过 `console.log` 打印最近消息。

**Turn 3 — Agent 切到 Memory 查记忆**：`scene.enter("memory")`，然后 `memory.search("alice 东京")`。

**Turn 4 — Agent 切回 Telegram 回复**：`scene.enter("telegram")`，然后 `await ctx.tg.sendText(-100123456, "...")`。

**Turn 5 — Agent 存记忆**：`scene.enter("memory")`，调用 `memory.store(...)` 和 `memory.updatePerson(...)`。

**Session 结束** → Compaction 自动执行 → Agent state 更新。

---

## 附录 B：未来扩展路径

| 方向 | MVP 中的预留点 | 后续做法 |
|------|-------------|---------|
| 多平台 | 场景系统是可扩展的 | 新增 `discord.d.ts` 场景，agent 学会新 SDK |
| 向量记忆 | Memory 接口清晰 | 加 `vectorSearch` 方法 |
| 自主学新工具 | Sandbox 支持 `bun add` | Agent 自己安装包并注册新场景 |
| 可观测性 Dashboard | 全量结构化日志 | 接 Grafana |
| Human-in-the-loop | 安全拦截点已有 | 改为暂停 + 审批 |
| Fine-tuning | Session transcript 全保存 | 筛选高质量 session 做 SFT |

---

## 实施日志

> Claude Code 在完成每个 Phase 后在此追加总结。

（待填写）