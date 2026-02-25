# CyberGroupmate — 项目实施方案

> **文档版本**: 0.2.0
> **最后更新**: 2026-02-25
> **状态**: 初始规划

---

## 工程进度追踪

> **指示（给 Claude Code）**：每完成一个 Task，请更新下方表格的状态，并在「实施笔记」列补充你做出的关键决策、遇到的问题、以及与原计划的偏差。如果实施过程中发现原计划有设计缺陷或需要调整，请直接修改对应章节并在变更处标注 `[REVISED @Phase-X.Y]`。每个 Phase 完成后，在末尾「实施日志」章节追加一段总结。

| Phase | Task | 状态 | 实施笔记 |
|-------|------|------|----------|
| 1.1 | NotificationCenter | ⬜ 未开始 | |
| 1.2 | Sandbox + Worker | ⬜ 未开始 | |
| 1.3 | BackgroundManager | ⬜ 未开始 | |
| 1.4 | Memory Store | ⬜ 未开始 | |
| 1.5 | SceneManager + 类型定义文件 | ⬜ 未开始 | |
| 1.6 | 项目脚手架（package.json, tsconfig, git 初始化） | ⬜ 未开始 | |
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

本项目借鉴 CodeAct 论文（Wang et al., 2024, "Executable Code Actions Elicit Better LLM Agents"）的核心理念，但不使用其代码库或框架。我们提取的关键思想是：

1. **代码即统一动作空间**：让 LLM 直接写可执行代码来执行所有动作（读消息、发消息、搜索记忆等），而非通过预定义的 JSON/Text tool calling。代码天然支持控制流（for/if）和数据流（变量复用），一次动作可以组合多个操作 [[11]]。
2. **多轮交互与自我调试**：Agent 写代码 → 执行 → 看到结果（或错误信息）→ 修正 → 继续。错误信息是天然的自动反馈机制 [[11]]。
3. **直接使用现有软件包**：Agent 直接 `import` 并操作 mtcute、Playwright 等库，不需要人为封装 tool [[11]]。

### 0.3 与传统聊天机器人架构的根本区别

传统做法是：收到消息 → 调用 LLM → 拿到回复文本 → 发送。每个会话独立处理。

本项目的做法是：Agent 运行在一个**持续的事件循环**中。外部信息（@消息、私聊、cron 提醒等）汇入一个 Notification Center。Agent 的 main loop 只看这个事件流，然后**自己写 TypeScript 代码**决定调用哪些能力去读消息、搜索记忆、生成并发送回复。Agent 甚至自己写代码来 setup 要监听哪些消息——订阅逻辑本身也是 agent 的代码产出。

### 0.4 技术选型

| 组件 | 选型 | 理由 |
|------|------|------|
| 语言 | **TypeScript** | mtcute 是原生 TS 库，零桥接；TS 类型系统提供额外的自动错误反馈；现代 LLM 写 TS 能力已很强 |
| Runtime | **Node.js (≥22) + tsx** | `@mtcute/node` 显式针对 Node.js，涉及 TCP 长连接 + MTProto 协议 + 原生 crypto，在 Node.js 上是保证工作的；tsx 零配置直接运行 TypeScript；Node.js 在生产环境中的长时间运行稳定性最成熟；LLM 训练数据中 Node.js 代码量最大，对 API 最熟悉 |
| Telegram 客户端 | **@mtcute/node** | 已有配置好的 env 和 session |
| LLM | Claude Sonnet 4 / GPT-4o 等（可配置） | 需要强代码生成 + 长 context + 中文能力 |
| 记忆存储 | **SQLite（better-sqlite3）+ FTS5** | 成熟同步 API，性能好；零外部服务依赖 |
| 事件日志 | Append-only JSONL | 零依赖，可 grep，未来可接日志系统 |
| 测试 | Node.js 内置 test runner 或 vitest | 零额外配置 |

**为什么不用 Bun**：`@mtcute/node` 底层涉及 MTProto 长连接和自定义加密，这类底层网络库恰恰是 Bun 的 Node.js 兼容层最容易出问题的地方。Agent 在 Bun 上遇到兼容性 bug 时无法区分"我代码写错了"和"runtime 不支持"，会破坏 CodeAct 的自我调试循环。待 mtcute 官方明确支持 Bun 后可考虑迁移。

**为什么不用 Deno**：Deno 的权限模型（`--allow-net`、`--allow-read` 等）会给 agent 动态执行代码制造障碍——要么全开权限（失去安全模型意义），要么逐个配置（极其繁琐）。且 npm 兼容性风险最高。

### 0.5 MVP 边界

**MVP 做的事**：
- Agent 通过自己写 TypeScript 代码连接 Telegram、设置消息订阅、读取消息、回复消息
- 场景化的类型上下文系统（Home / Telegram / Memory）
- 基础记忆系统（SQLite FTS5）
- Session compaction 和 agent state 持久化
- 错误恢复（sandbox 崩溃后自动重启 + bootstrap 重放）
- CLI 查看工具
- 结构化事件日志（可观测性基础）

**MVP 不做但架构预留的事**：
- 多平台支持（架构上只需新增场景即可）
- 向量语义搜索（Memory 接口预留 `vectorSearch` 方法）
- 图像/表情包生成
- 自主安装新工具（sandbox 支持动态 `npm install` 但 MVP 不主动引导）
- 精细的可观测性 dashboard
- 多 agent 协作
- Human-in-the-loop 审批

---

## 1. 系统架构

### 1.1 总体架构

```
┌──────────────────────────────────────────────────────────────┐
│                    Host Process (Node.js + tsx)               │
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
│  │  Node.js subprocess via tsx（持久化命名空间）           │    │
│  │  预装: @mtcute/node, better-sqlite3 等                │    │
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

整个系统是**一个 Node.js 进程**（或一个 container）。不引入消息队列、不引入微服务。

### 1.2 数据流

1. Agent 在 bootstrap 阶段写代码连接 Telegram，通过 `runtime.spawn()` 创建后台监听任务
2. 后台任务通过 `runtime.notify()` 将筛选后的消息事件推入 Notification Center
3. Main loop 用 `nc.drain()` 批量取出事件，组装 context 后调用 LLM
4. LLM 输出思考 + TypeScript 代码块
5. 代码在 Sandbox 中执行，结果作为 observation 返回给 LLM
6. 多轮交互直到 agent 完成处理（不再输出代码块）
7. Session 结束后做 compaction，更新 agent state 和长期记忆

### 1.3 场景（Scene）系统

Agent 的 context window 是有限资源，应像人类注意力一样管理。

**核心概念**：Agent 在任一时刻只处于一个「场景」中。每个场景提供该场景专属的 TypeScript 类型定义（`.d.ts`）。Agent 通过 `scene.enter("telegram")` 切换场景，此时新场景的类型定义作为 observation 返回，替代之前的类型信息。

这类似于 AVG 游戏中进入不同房间——进入不同场景，能施展的动作不同。但 agent 始终拥有自己的意识流（连贯的 LLM 对话历史），知道自己要干什么。最顶部的 system prompt 定义了它的行为模式和人格。

**场景切换的运行时行为**：
- `scene.enter(name)` 被调用时，sandbox worker 返回新场景的类型定义和上下文说明作为 stdout 输出
- 这个输出成为 CodeAct 交互中的 observation，进入下一轮 LLM 输入
- Agent 看到新的类型定义后，就知道在这个场景中可以做什么

**类型定义的展开粒度**：
- **L0（场景列表）**：只有场景名 + 一句话描述。在 home 场景中通过 `scene.list()` 获得。
- **L1（核心类型）**：进入场景后默认展示。手写的精简版类型定义，只包含常用方法和核心数据结构。不是库的完整 `.d.ts`，而是人工裁剪的子集，控制在 100-200 行以内。
- **L2（完整类型）**：Agent 遇到困难时可以调用 `scene.showFullTypes()` 主动请求更详细的类型定义。

类型定义本身就是最好的文档——Agent 看到的是 TypeScript 接口签名，比自然语言描述的 tool specification 更精确、更紧凑，而且 LLM 天然理解这种格式。

**MVP 包含的场景**：
- `home`：通知中心。查看通知、决定下一步、切换场景。只有 `scene`、`runtime`、`ctx` 的类型。
- `telegram`：Telegram 操作。精简版的 `TelegramClient`、`Message`、`Chat`、`User` 等接口。
- `memory`：记忆系统。`MemoryStore`、`PersonProfile`、`ConversationSummary` 等接口。

**扩展预留**：
- 新增平台/工具 = 新增一个场景目录 + `.d.ts` 文件，不改框架代码
- Agent 未来可以自己注册新场景（`scene.register(name, typeDefs)`）

### 1.4 通知积累与批量呈现

Agent 在处理当前事件批次期间（一个 CodeAct session 内），新到达的通知在 Notification Center 队列中静默积累，不打断当前工作流。通知的呈现时机：

1. **Session 之间**：每个 session 结束后，main loop 回到 `nc.drain()` 等待，积累的通知和新通知一起被取出，组成下一个 session 的输入。
2. **Session 内定期追加**：每隔 N 轮代码执行（建议 5 轮），检查是否有新通知。如果有，以 `[新通知到达]` 的形式追加到对话中，agent 可以选择立即处理或继续当前任务。

---

## 2. 组件详细设计

### 2.1 Notification Center

**职责**：线程安全的内存事件队列 + append-only JSONL 持久化日志。

**接口**：
- `push(event)`: 写入队列并 append 到 JSONL 文件。自动添加 `_id`（ULID）和 `_ts`（时间戳）。
- `drain(timeout, maxBatch)`: 异步等待并批量取出事件。至少等到一个事件或超时返回空数组。最多返回 `maxBatch` 条。

**设计要点**：
- 使用 ULID 作为事件 ID，单调递增，便于排序和去重。
- JSONL 文件是 append-only 的，所有事件（包括系统内部事件如代码执行记录）都写入，形成完整的审计日志。
- `drain` 的超时机制：如果超时无事件，返回空数组。Main loop 据此决定是否执行 idle 行为。

**扩展预留**：JSONL 格式可直接被 Grafana Loki / Elasticsearch 导入。`_id` 可用于未来的 exactly-once 处理。

### 2.2 Code Execution Sandbox

**职责**：在隔离的 Node.js 子进程中执行 agent 写的 TypeScript 代码，维护跨代码块的持久化命名空间。

**架构**：Host 进程通过 `child_process.spawn` 启动 worker 子进程（`tsx src/sandbox-worker.ts`），通过 stdin/stdout JSON 行协议通信。

**Host 侧（sandbox.ts）**：
- 管理子进程生命周期
- `execute(code, timeout)`: 发送代码到 worker，等待执行结果，支持超时
- `isAlive()`: 检查子进程是否存活
- 崩溃检测和重启能力

**Worker 侧（sandbox-worker.ts）**：
- 维护一个持久化的 `ctx` 对象挂在 `globalThis` 上，agent 代码中 `ctx.xxx = ...` 的赋值会跨代码块保留
- 预注入 `runtime`（notify/spawn/kill/ps/cron）、`memory`、`scene` 到 `globalThis`
- 每段代码通过 `new Function()` + async wrapper 执行，支持 top-level `await`
- 劫持 `console.log`：输出被捕获并作为执行结果返回（这是 agent 获取信息的主要手段——和 CodeAct 论文中 print 作为获取信息手段一致 [[11]]）
- 错误被 catch 并将 stack trace 作为输出返回（自动错误反馈 [[11]]）

**代码执行机制**：
```
new Function("ctx", "runtime", "memory", "scene",
  `return (async () => { ${code} })()`
)
```
这让 agent 的代码可以直接访问注入的 API，同时支持 top-level `await`。`ctx` 对象是跨代码块共享状态的唯一机制。Agent 在第一个代码块中 `ctx.client = new TelegramClient(...)` 后，后续代码块可以直接用 `ctx.client`。

**IPC 消息协议**：

Host → Worker：
- `{ type: "execute", id: string, code: string }` — 执行代码

Worker → Host：
- `{ type: "result", id: string, output: string, error: boolean }` — 代码执行结果
- `{ type: "notify", event: object }` — 后台任务推送事件（转发给 NC）

### 2.3 Background Task Manager

**职责**：管理 agent 通过 `runtime.spawn()` 创建的后台长驻任务。运行在 sandbox worker 进程内的 async 任务中。

**接口**：
- `spawn(name, asyncFn)`: 启动一个命名的后台协程。同名不可重复，需先 kill。
- `kill(name)`: 通过 AbortController 取消任务。
- `ps()`: 列出所有任务及其状态。

**关键设计**：
- 每个后台任务被 `guardedRun` 包裹。如果任务抛出异常（非正常取消），自动向 Notification Center 推送 `system.background_error` 事件（包含任务名、错误信息和 stack trace），agent 在下次 poll 到时自己决定是否重启。这是 CodeAct "自动错误反馈 → 自我调试"理念的延伸 [[11]]。

### 2.4 Memory Store

**职责**：提供记忆的存储、搜索和管理。MVP 基于 better-sqlite3 + FTS5 全文搜索。

**数据表**：
- `memories`（FTS5 虚拟表）：通用记忆条目。字段：`content`（文本）、`metadata`（JSON 字符串）、`timestamp`。
- `person_profiles`：群友画像。字段：`user_id`（主键）、`data`（JSON）、`updated_at`。
- `conversation_log`：对话摘要日志。字段：`id`、`chat_id`、`chat_title`、`summary`、`key_points`（JSON 数组）、`timestamp`。

**接口**：
- `search(query, limit)`: FTS5 全文搜索记忆
- `store(content, metadata)`: 存入一条记忆
- `getPerson(userId)` / `updatePerson(userId, data)`: 群友画像 CRUD（update 是 merge 模式）
- `getRecentConversations(chatId?, limit)`: 获取对话摘要
- `rawQuery(sql, ...params)`: 直接执行 SQL（agent 高级用法——CodeAct "直接使用现有软件包"的体现 [[11]]）

**扩展预留**：`Memory` 是一个清晰的接口，后续换 Postgres + pgvector 只需改实现。加向量搜索只需新增 `vectorSearch` 方法。

### 2.5 Scene Manager

**职责**：管理场景注册表和场景切换。

**数据结构（每个场景）**：
- `name`: 场景标识符
- `description`: 一句话描述
- `typeDefs`: L1 精简类型定义字符串（`.d.ts` 文件内容）
- `fullTypeDefs`（可选）: L2 完整类型定义
- `contextSetup`（可选）: 进入场景时的额外说明文本
- `prelude`（可选）: 进入场景时在 sandbox 中自动执行的代码

**注入到 sandbox 的接口**：
- `scene.enter(name)`: 切换场景。将场景说明 + 类型定义通过 `console.log` 输出，作为下一轮 observation 返回给 LLM。
- `scene.current`: 当前场景名
- `scene.list()`: 列出所有可用场景及简介
- `scene.showFullTypes()`: 展示当前场景的 L2 完整类型定义

### 2.6 LLM 调用封装

**接口**：
- `callLLM(messages): Promise<string>`: 接受 OpenAI 格式的消息数组，返回 assistant 回复文本。

**设计要点**：
- 支持 Anthropic Claude API 和 OpenAI 兼容 API（通过 `config.yaml` 切换）
- 处理 rate limiting 和重试
- 可配置 model name、temperature、max tokens

### 2.7 Agent Main Loop（Orchestrator）

**Phase 1 — Bootstrap**：
1. 创建 NotificationCenter、Sandbox、Memory、SceneManager 实例
2. 向 LLM 发送 bootstrap prompt，告知 agent 身份、可用 runtime API、以及需要设置 Telegram 订阅
3. 运行一个 CodeAct session（多轮），agent 自己写代码完成连接和订阅设置
4. Agent 表示 READY 后保存 bootstrap 代码到 `data/bootstrap-code.json`，进入主循环

**Phase 2 — Main Event Loop**：
1. `nc.drain(timeout)` 等待事件
2. 有事件时：
   a. 读取当前 agent state（`data/agent-state.md`）
   b. 格式化事件为文本
   c. 组装 context：system prompt + agent state + home 场景类型定义 + 事件文本
   d. 运行 CodeAct session（agent 可能切换多个场景来处理事件）
   e. Session 结束后执行 compaction
3. 超时无事件：可选执行 idle 行为（MVP 中跳过）
4. 检查 sandbox 是否存活，不存活则重启并重放 bootstrap

**CodeAct Session Runner**：
1. 调用 LLM 获取 response
2. 解析 response：分离自然语言思考和 TypeScript 代码块（匹配 ` ```typescript ` / ` ```ts ` / ` ```js ` 围栏）
3. 没有代码块 → session 结束
4. 有代码块 → 在 sandbox 中依次执行，收集输出
5. 执行输出作为 `[Execution Output]` 追加到消息历史（截断到 4000 字符）
6. 每隔 5 轮检查 NC 中是否有新通知，有则追加 `[新通知到达]` 到对话
7. 重复直到无代码块或达到最大轮次（15 轮）

### 2.8 Session Compaction

每个 CodeAct session 结束后，压缩会话内容并归档。

1. 提取 session 关键信息（最近若干条消息）
2. 调用 LLM 生成结构化 JSON 摘要：对话摘要、新事实、人物信息更新、待办事项、agent state 更新建议
3. 写入 `conversation_log`、`memories`、`person_profiles` 表
4. 更新 `data/agent-state.md`

Compaction 使用独立的 LLM 调用（不是 agent 自己做的），保证即使 agent 忘记存记忆，系统也会自动归档。同时 agent 在 session 内也可以主动调用 `memory.store()` 来存储信息。

---

## 3. 类型定义文件规范

### 3.1 编写原则

1. **精简但完备**：只包含 agent 常用的方法和数据结构，不是库的完整类型。控制在 100-200 行以内。
2. **注释即文档**：每个方法和字段都有 JSDoc 注释。Agent 读注释来理解用法。
3. **类型即约束**：精确的参数和返回值类型帮助 agent 写出正确代码。类型错误是额外的自动反馈。
4. **跨场景共用类型**：`scene`、`runtime`、`ctx` 在所有场景中都可用，每个场景的 `.d.ts` 中都要声明。

### 3.2 home.d.ts

定义场景切换、runtime 管理、ctx。这是 agent 启动时和回到通知中心时看到的类型。

关键接口：
- `scene.enter(name)` / `scene.current` / `scene.list()` / `scene.showFullTypes()`
- `runtime.notify(event)` / `runtime.spawn(name, fn)` / `runtime.kill(name)` / `runtime.ps()` / `runtime.cron(expr, name, fn)`
- `ctx: Record<string, any>` — 跨场景、跨代码块的持久化变量容器

### 3.3 telegram.d.ts

精简版 mtcute 操作接口，手工编写的子集。

关键接口：
- `TelegramClient`：`sendText`, `getMessages`, `getDialogs`, `forwardMessages`, `sendSticker`, `searchMessages`, `onNewMessage`（AsyncIterable，用于后台监听）, `getMe`
- `Message`：`id`, `text`, `date`, `chat`, `sender`, `mentioned`, `replyToMessageId`, `media`, `sticker`
- `Chat`：`id`, `type`, `title`, `username`
- `User`：`id`, `firstName`, `lastName`, `username`
- `Dialog`：`chat`, `lastMessage`, `unreadCount`

声明 `ctx.tg: TelegramClient`。

### 3.4 memory.d.ts

关键接口：
- `MemoryStore`：`search`, `store`, `getPerson`, `updatePerson`, `getRecentConversations`, `getPendingTasks`, `addTodo`, `rawQuery`
- `PersonProfile`：`userId`, `displayName`, `notes`, `traits`, `lastInteraction`
- `ConversationSummary`：`chatId`, `chatTitle`, `summary`, `keyPoints`, `timestamp`
- `TodoItem`：`id`, `description`, `createdAt`, `dueDate`, `done`

声明 `memory: MemoryStore`。

---

## 4. System Prompt 设计

### 4.1 结构

```
# 你是谁
[人格定义、说话风格、兴趣爱好——从 config.yaml 注入]

# 你的运行环境
[解释 CodeAct 模式：你通过写 TypeScript 代码来行动]
[解释 ctx 对象、场景系统、runtime API]

# 你的工作方式
[解释事件循环：收到通知 → 进入对应场景 → 写代码处理 → 存记忆]
[解释场景切换：scene.enter() 会展示新场景的可用 API]

# 重要行为原则
- 不要每条消息都回复。真人不会这样做。读空气。
- 回复要自然，用群里的语气风格。
- 如果不确定上下文，先查记忆或拉历史消息。
- 如果代码执行出错，看错误信息自己 debug。
- 你可以随时修改自己的订阅规则。

# 可用 API 概览
[极简概述——详细类型在进入场景后可见]
```

### 4.2 人格可配置

人格描述从 `config.yaml` 中读取并注入 system prompt。修改配置文件即可改变 agent 性格，不改代码。

---

## 5. 错误恢复与安全

### 5.1 分层错误处理

| 级别 | 场景 | 处理方式 |
|------|------|---------|
| L1 | Agent 代码执行出错 | 错误 stack trace 作为 observation 返回给 LLM，agent 自己 debug 并重试  |
| L2 | 后台任务崩溃（断连、网络错误） | `guardedRun` 捕获异常 → 推 `system.background_error` 到 NC → agent 自己修 |
| L3 | Sandbox worker 进程崩溃 | Orchestrator 检测 `isAlive() === false` → 创建新 sandbox → 重放 bootstrap 代码 |
| L4 | Host 进程崩溃 | 从 events.jsonl 恢复。重新启动全流程。 |

### 5.2 Bootstrap 重放

- Bootstrap session 中 agent 每段成功执行的代码保存到 `data/bootstrap-code.json`
- Sandbox 重启后，依次自动执行这些代码（不经过 LLM），快速恢复
- 重放中某段代码失败则回退到完整 LLM bootstrap 流程

### 5.3 安全限制

- **Rate limiting**：每个 session 内发送消息计数器，超过阈值（如 10 条/session）抛出 `RateLimitError`
- **禁止破坏性操作**：`deleteMessages`、`banUser` 等在 sandbox 中直接抛出 `PermissionError`
- **发出消息记录**：每条发出消息的 ID 记录在 event log 中，出事可批量撤回

**扩展预留**：future human-in-the-loop（暂停执行 → 推通知给管理员审批）；回滚机制（根据消息 ID 批量删除）。

---

## 6. 可观测性

MVP 不做 dashboard，但所有关键数据以结构化方式记录。

### 6.1 Event Log

`data/events.jsonl`，所有事件的 append-only 日志：外部事件、代码执行事件（`system.code_execution`，含代码和输出）、系统事件（后台任务启停、sandbox 重启、场景切换）、agent 发出的消息（含消息 ID）。

### 6.2 Session Transcripts

`data/sessions/` 目录，每个 session 一个 JSONL 文件。记录完整 LLM 对话历史、触发事件、compaction 结果。

### 6.3 CLI 工具

```bash
npx tsx src/cli.ts events --tail 20        # 查看最近事件
npx tsx src/cli.ts sessions --last 5       # 查看最近 session
npx tsx src/cli.ts state                   # 查看 agent 当前状态
npx tsx src/cli.ts ps                      # 查看后台任务
npx tsx src/cli.ts person @username        # 查看某人画像
npx tsx src/cli.ts memory search "关键词"  # 搜索记忆
```

---

## 7. 目录结构

```
cybergroupmate/
├── src/
│   ├── main.ts                     # Orchestrator / Agent Main Loop
│   ├── notification-center.ts      # 事件队列
│   ├── sandbox.ts                  # Sandbox host 侧管理
│   ├── sandbox-worker.ts           # Sandbox worker 进程（子进程运行）
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
│       ├── telegram.full.d.ts      # L2 完整类型（agent 请求时展开）
│       └── memory.d.ts
├── system-prompt.md
├── config.yaml                     # 配置文件
├── package.json
├── tsconfig.json
├── .gitignore
├── data/                           # 运行时数据（gitignore）
│   ├── tg-session/
│   ├── memory.db
│   ├── events.jsonl
│   ├── agent-state.md
│   ├── bootstrap-code.json
│   └── sessions/
├── docs/                           # 项目文档
│   ├── architecture.md             # 本文档（或本文档的精简版）
│   ├── scene-authoring.md          # 如何编写新场景
│   └── CHANGELOG.md
├── README.md
└── tests/
    ├── notification-center.test.ts
    ├── sandbox.test.ts
    ├── memory.test.ts
    └── scene-manager.test.ts
```

**预计核心代码量：1000-1500 行 TypeScript。**

---

## 8. 文档要求

### 8.1 代码内文档

- **每个源文件顶部**须有一段注释说明该模块的职责和在整体架构中的位置。
- **所有对外接口**（class 的 public 方法、导出的函数）须有 JSDoc 注释，包含参数说明、返回值说明和简要使用示例。
- **复杂逻辑段落**须有行内注释说明意图（"为什么"而非"做什么"）。
- **类型定义文件**（`scenes/*.d.ts`）中的每个 interface 和每个方法都须有 JSDoc 注释——这些注释是 agent 理解 API 的唯一途径。

### 8.2 项目文档

| 文档 | 位置 | 内容 | 维护时机 |
|------|------|------|---------|
| **README.md** | 项目根目录 | 项目简介、快速开始（安装依赖、配置环境变量、启动）、架构概览图、CLI 用法 | 每个 Phase 结束后更新 |
| **architecture.md** | `docs/` | 本文档的精简版：架构图、组件交互、数据流、场景系统说明 | 架构变更时更新 |
| **scene-authoring.md** | `docs/` | 如何编写新场景：文件结构、类型定义编写规范、注册流程、示例 | Phase 1.5 完成时创建 |
| **CHANGELOG.md** | `docs/` | 按版本/Phase 记录变更，格式遵循 [Keep a Changelog](https://keepachangelog.com/) | 每个 Phase 结束时追加 |
| **config.yaml 注释** | 项目根目录 | 配置文件本身须有详细的行内注释说明每个配置项的含义、类型和默认值 | Phase 4.3 完成时 |

### 8.3 给 Claude Code 的文档指示

- 每完成一个 Task，检查是否需要更新 README.md。
- 每个新建的 `.ts` 文件必须有文件头注释。
- 每个 Phase 结束时更新 `docs/CHANGELOG.md`。
- 本文档（项目实施方案）本身也是持续维护的文档——如果实施过程中发现任何与实际不符之处，直接修改并标注 `[REVISED @Phase-X.Y]`。

---

## 9. Git 工作流要求

### 9.1 仓库信息

仓库已经初始化在了 git@github.com:Archeb/CyberGroupmate.git 

需要在 agentic 这个分支上操作。

### 9.2 Commit 规范

遵循 [Conventional Commits](https://www.conventionalcommits.org/)：

```
<type>(<scope>): <subject>

<body>（可选）
```

**type 枚举**：
- `feat`: 新功能
- `fix`: 修复 bug
- `refactor`: 重构（不改变行为）
- `docs`: 文档变更
- `test`: 测试相关
- `chore`: 构建/配置/依赖等杂项

**scope**：对应组件名，如 `sandbox`、`memory`、`scene`、`llm`、`cli`、`prompt` 等。

**示例**：
```
feat(sandbox): implement persistent namespace via new Function()
fix(notification-center): fix drain timeout not resolving on empty queue
docs(readme): add quick start section
test(memory): add FTS5 search tests
chore: add better-sqlite3 dependency
```

### 9.3 Commit 粒度

- **一个 Task 对应若干个 commit**，而非一个巨大 commit。
- 每个 commit 应该是**原子性的**：能独立编译/运行，或至少不破坏现有功能。
- 测试和实现代码可以在同一个 commit 中（`feat(xxx): implement xxx with tests`），也可以分开。

### 9.4 .gitignore

```gitignore
# Runtime data
data/
*.db
*.db-wal
*.db-shm

# Dependencies
node_modules/

# Build artifacts
dist/

# Environment
.env
.env.*

# OS
.DS_Store
Thumbs.db

# Editor
.vscode/
.idea/
*.swp
```

**注意**：`data/` 目录整体 gitignore。运行时数据（session 文件、SQLite 数据库、events.jsonl、agent-state.md 等）不进入版本控制。但 `data/` 目录结构应在 README 中说明，且启动时程序应自动创建所需子目录。

### 9.5 Tag 与 Release

每个 Phase 完成后在 `main` 上打 tag：

```
v0.1.0 — Phase 1 完成（基础 Runtime）
v0.2.0 — Phase 2 完成（Agent Loop + LLM 集成）
v0.3.0 — Phase 3 完成（记忆与人格）
v0.4.0 — Phase 4 完成（稳定性与工具）= MVP
```

### 9.6 给 Claude Code 的 Git 指示

- 每完成一个逻辑单元（一个函数、一个测试文件、一个配置），就 commit。不要攒到 Task 结束才一次性 commit。
- Commit message 必须遵循 Conventional Commits 格式。
- 每个 Phase 结束后，确保所有变更已 commit，然后在 `main` 上打 tag。
- 如果需要回滚某个实验性改动，使用 `git revert` 而非 `git reset --hard`，保留历史记录。

---

## 10. 项目脚手架

### 10.1 package.json

```json
{
  "name": "cybergroupmate",
  "version": "0.1.0",
  "type": "module",
  "engines": {
    "node": ">=22"
  },
  "scripts": {
    "start": "tsx src/main.ts",
    "dev": "tsx watch src/main.ts",
    "test": "tsx --test tests/**/*.test.ts",
    "cli": "tsx src/cli.ts"
  },
  "dependencies": {
    "@mtcute/node": "latest",
    "better-sqlite3": "^11.0.0",
    "ulid": "^2.3.0"
  },
  "devDependencies": {
    "tsx": "^4.0.0",
    "@types/better-sqlite3": "^7.0.0",
    "@types/node": "^22.0.0",
    "typescript": "^5.5.0"
  }
}
```

### 10.2 tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "resolveJsonModule": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

---

## 11. 分阶段实施计划

### Phase 1：基础 Runtime（目标：~1 周）

**目标**：所有基础组件可用，能手动在 sandbox 中执行 TS 代码连接 Telegram 并收发消息。

**Task 1.1 — NotificationCenter**
- 实现 `push` 和 `drain`
- JSONL 持久化
- 单元测试

**Task 1.2 — Sandbox + Worker**
- Host 侧 Sandbox 类（`child_process.spawn` 启动 `tsx src/sandbox-worker.ts`）
- Worker 侧 REPL loop（`new Function()` 执行、`console.log` 劫持、错误捕获）
- `ctx` 持久化命名空间
- Worker → Host IPC（`runtime.notify()` 事件传回 host NC）
- 单元测试

**Task 1.3 — BackgroundManager**
- `spawn`、`kill`、`ps`、`guardedRun`
- 单元测试

**Task 1.4 — Memory Store**
- SQLite 表创建（FTS5 + person_profiles + conversation_log）
- 所有接口方法实现
- 单元测试

**Task 1.5 — SceneManager + 类型定义文件**
- SceneManager 实现（场景注册、enter、list、showFullTypes）
- 编写 `home.d.ts`、`telegram.d.ts`、`memory.d.ts`
- 注入 sandbox worker
- 单元测试
- 创建 `docs/scene-authoring.md`

**Task 1.6 — 项目脚手架**
- `git init`，创建 `.gitignore`
- `package.json`、`tsconfig.json`
- 目录结构创建
- `README.md` 初始版本
- 首个 commit + `v0.1.0-scaffold` tag

**Phase 1 验收标准**：集成测试——在 sandbox 中执行 `scene.enter("telegram")` → 连接 mtcute → `runtime.spawn` 启动监听 → 从另一个账号发消息 → 后台任务 `runtime.notify()` → host 侧 `nc.drain()` 取到事件。全链路跑通。

完成后打 tag `v0.1.0`，更新 README 和 CHANGELOG。

### Phase 2：Agent Loop + LLM 集成（目标：~1 周）

**目标**：Agent 能自主 bootstrap 并响应 @ 消息。

**Task 2.1 — LLM 调用封装**
- `callLLM(messages)` 函数
- 支持 Anthropic Claude API 和 OpenAI 兼容 API
- Rate limiting 和重试
- 通过 `config.yaml` 配置

**Task 2.2 — CodeAct Session Runner**
- `runCodeActSession` 函数
- Response 解析（分离思考和代码块）
- 代码执行结果反馈
- Session 内定期追加新通知
- Session transcript 记录到 `data/sessions/`

**Task 2.3 — Bootstrap 流程**
- Bootstrap prompt 编写
- Bootstrap session 运行
- 保存成功执行的代码到 `data/bootstrap-code.json`

**Task 2.4 — Main Event Loop**
- 完整 main loop（bootstrap → event loop）
- Context 组装
- Sandbox 崩溃检测

**Phase 2 验收标准**：启动 agent → 自主连接 Telegram 并设置监听 → 有人 @ agent → agent 读取消息上下文并回复。端到端跑通。

完成后打 tag `v0.2.0`，更新 README 和 CHANGELOG。

### Phase 3：记忆与人格（目标：~1 周）

**Task 3.1 — Session Compaction**
- Compaction prompt 模板
- Compaction 流程（LLM → 解析 → 写入 memory）

**Task 3.2 — Agent State 管理**
- `data/agent-state.md` 初始内容和格式
- 读取和更新逻辑

**Task 3.3 — System Prompt 调优**
- 完整 `system-prompt.md`
- 人格描述格式（从 config.yaml 注入）
- 迭代测试

**Task 3.4 — 安全限制**
- 消息发送 rate limiter
- 破坏性操作拦截
- 发出消息 ID 记录

**Phase 3 验收标准**：Agent 在真实群运行 24h，能记住群友信息，回复自然不刷屏。

完成后打 tag `v0.3.0`，更新 README 和 CHANGELOG。

### Phase 4：稳定性与工具（目标：~3-5 天）

**Task 4.1 — 错误恢复**
- Sandbox 崩溃检测 + 自动重启
- Bootstrap 代码重放
- 测试：手动 kill sandbox 后系统自动恢复

**Task 4.2 — CLI 工具**
- `cli.ts` 各子命令

**Task 4.3 — 配置化**
- `config.yaml` schema 定义（含详细行内注释）
- 配置加载和验证

**Phase 4 验收标准**：连续运行 48h 无不可恢复崩溃。CLI 可用。配置修改后重启生效。

完成后打 tag `v0.4.0`（= MVP），更新 README 和 CHANGELOG，整理 `docs/architecture.md`。

---

## 12. Context Window 管理

为避免超出 context window：
- 每个代码执行输出截断到 4000 字符
- Session 最多 15 轮
- Agent state 截断到 4000 字符
- 事件文本中每个事件预览截断到 300 字符

---

## 13. Agent 的 Telegram 连接方式

Agent 在 bootstrap 时自己写代码创建 mtcute client。环境变量预配置：
- `TG_API_ID`
- `TG_API_HASH`
- `TG_BOT_TOKEN`（bot 模式）或 session 文件路径（userbot 模式）

Agent 在 bootstrap 时从 `process.env` 读取这些值。

---

## 附录 A：Agent 行为示例

以下展示完整交互流程，帮助理解组件协作。

**触发**：NC 收到事件 `{ type: "telegram.message", priority: "high", chatTitle: "二次元研究所", fromUser: "alice", preview: "@CyberGroupmate 你觉得东京有什么好玩的", chatId: -100123456, messageId: 42 }`

**Turn 0 — Home 场景**：Orchestrator 将事件 + agent state + home 类型定义组装成 context 发给 LLM。

**Turn 1**：Agent 输出思考 + `scene.enter("telegram")`。Observation 返回 telegram 类型定义。

**Turn 2**：Agent 写 `const msgs = await ctx.tg.getMessages(-100123456, { limit: 15 })`，console.log 打印最近消息。

**Turn 3**：`scene.enter("memory")`，然后 `memory.search("alice 东京")`。

**Turn 4**：`scene.enter("telegram")`，然后 `await ctx.tg.sendText(-100123456, "...")`。

**Turn 5**：`scene.enter("memory")`，调用 `memory.store(...)` 和 `memory.updatePerson(...)`。Agent 表示处理完毕。

**Session 结束** → Compaction 自动执行 → Agent state 更新。

---

## 附录 B：未来扩展路径

| 方向 | MVP 中的预留点 | 后续做法 |
|------|-------------|---------|
| 多平台 | 场景系统可扩展 | 新增 `discord.d.ts` 场景 |
| 向量记忆 | Memory 接口清晰 | 加 `vectorSearch` 方法 |
| 自主学新工具 | Sandbox 支持 `npm install` | Agent 自己装包并注册新场景 |
| 可观测性 Dashboard | 全量结构化日志 | 接 Grafana |
| Human-in-the-loop | 安全拦截点已有 | 改为暂停 + 审批 |
| Fine-tuning | Session transcript 全保存 | 筛选高质量 session 做 SFT |

---

## 附录 C：给 Claude Code 的完整操作指示

1. **按 Phase 和 Task 顺序实施**。每完成一个 Task，更新本文档顶部的进度追踪表。
2. **每个组件先写单元测试，再写实现**（或同步进行）。使用 `tsx --test` 或 vitest 运行测试。
3. **如果实施中发现设计需要调整，直接修改本文档对应章节**，标注 `[REVISED @Phase-X.Y]` 及修改原因。
4. **代码风格**：TypeScript strict mode、ESM（`"type": "module"`）、async/await。不使用 class 继承。核心组件（NC、Sandbox、Memory 等）使用 class，工具函数使用纯函数。
5. **依赖极简**：仅 `@mtcute/node`、`better-sqlite3`、`ulid`。其他手写。
6. **Git 操作**：每完成一个逻辑单元就 commit（Conventional Commits 格式）。每个 Phase 结束后打 tag。详见第 9 节。
7. **文档**：每个源文件有文件头注释。所有 public 接口有 JSDoc。每个 Phase 结束后更新 README 和 CHANGELOG。详见第 8 节。
8. **Phase 1 结束时运行集成测试**确认全链路可用。
9. **Phase 2 结束时做端到端测试**：启动 → bootstrap → @ agent → 确认回复。
10. **每个 Phase 结束后在「实施日志」追加总结**，记录关键决策、问题、对后续影响。

---

## 实施日志

> Claude Code 在完成每个 Phase 后在此追加总结。

（待填写）