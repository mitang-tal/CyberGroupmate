# CyberGroupmate — 项目实施方案（NC 边界重写版）

> **版本**: 2026-03-08 重写
>
> **状态**: Phase 1-5 已完成。Phase 6A 已完成，但其设计解释已更新为“框架接管消息消费侧，Agent 掌握消息生产侧与扩展侧”。Phase 6B 起正式引入 `PlatformAdapter -> NotificationCenter -> Cognition Pipeline` 的边界模型，并彻底替换旧的 bootstrap-listener 路线。

---

## 0. 执行摘要

这次重写不是局部优化，而是一次**架构边界澄清**。

旧方案里，系统在 Phase 1-5 默认由 Agent 在 bootstrap 时自己连接 Telegram、自己监听消息、再通过 `runtime.notify()` 推入 `NotificationCenter`。这在项目早期是合理的，因为它最大化了 CodeAct 的自由度，也让原型能快速跑起来。

但从 Phase 6A 开始，系统已经在事实上走向另一条路线：

- `Fast Router` 在宿主侧消费消息流
- `Recording Pipeline` 在宿主侧做批量观察和话题提取
- `TopicRegistry` 在宿主侧维护话题状态机
- `Memory V2` 在宿主侧统一落盘、检索、反思、压缩
- `Dry-Run` 在宿主侧回放历史消息验证行为

也就是说，**框架实际上已经接管了消息消费侧**。问题只在于，这个边界一直没有被明确写入实施方案，导致文档仍然保留“Agent 自己监听平台”作为默认主路径，进而造成后续设计上的模糊和冲突。

本版方案的核心结论是：

1. **`NotificationCenter` 是平台无关的正式消息入口边界。**
2. **框架默认拥有 canonical ingress。**
3. **平台接入通过官方 `PlatformAdapter` 实现，而不是把监听逻辑长期托付给 bootstrap 代码。**
4. **Agent 继续拥有发送能力、CodeAct 自主性、Memory API、Scene API，以及扩展新平台的实验能力。**
5. **`NotificationCenter` 的心智模型应接近手机通知中心；`scene` 的心智模型应接近手机 app。**
6. **整个项目坚持 CodeAct 路线：不用 JSON/Text tool use，所有能力、Action API、Skill 都必须以代码形态提供。**

一句话概括新的职责划分：

> **平台连接与事件标准化属于基础设施；消息理解、回复、记忆利用属于智能体。**

进一步说：

> **scene 像 app，NotificationCenter 像手机通知中心。不同 scene 产生的通知统一进入 NC，Agent 在 NC 中看到“哪个 app 发来了什么通知”，再决定是否点开、切换过去、阅读、回复。**

同时：

> **所有能力暴露给 Agent 的方式，都应是 TypeScript 代码接口，而不是额外的 tool-calling 协议。Skill 也不是神秘外部工具，而是可被导入、调用、组合、调试的代码能力包。**

---

## 1. 工程进度追踪

### 1.1 已完成 / 规划中

| Task | 内容 | 状态 | 备注 |
|------|------|------|------|
| 1.1 | NotificationCenter | ✅ 完成 | monotonic ULID；JSONL append-only；drain/waiter 机制 |
| 1.2 | Sandbox + Worker | ✅ 完成 | `new Function()` + async wrapper；JSON-line IPC；持久 `ctx` |
| 1.3 | BackgroundManager | ✅ 完成 | 后台任务生命周期管理；异常上报 |
| 1.4 | Memory Store（旧版） | ✅ 完成 | Phase 6 后已被 Memory V2 取代 |
| 1.5 | SceneManager + 类型定义文件 | ✅ 完成 | `home / telegram / memory` 场景；L1/L2 类型系统 |
| 1.6 | 项目脚手架 | ✅ 完成 | ESM、Node 22、strict TS、测试基线 |
| 2.1 | LLM 调用封装 | ✅ 完成 | 多 Provider；重试；配置化 |
| 2.2 | CodeAct Session Runner | ✅ 完成 | 多轮交互；代码块解析；中途检查通知 |
| 2.3 | Bootstrap 流程 | ✅ 完成 | 代码保存+重放；失败回退完整 bootstrap |
| 2.4 | Main Event Loop | ✅ 完成 | drain + context 组装 + session 执行 |
| 3.1 | Session Compaction | ✅ 完成 | 自动摘要/事实/待办提取 |
| 3.2 | Agent State 管理 | ✅ 完成 | `agent-state.md` 自动维护 |
| 3.3 | System Prompt 调优 | ✅ 完成 | 人格与运行环境说明 |
| 3.4 | 安全限制 | ✅ 完成 | 速率限制；危险方法禁止；审计日志 |
| 4.1 | 错误恢复 | ✅ 完成 | sandbox 崩溃后自动重启 + bootstrap 重放 |
| 4.2 | CLI 工具 | ✅ 完成 | sandbox / notify / drain / memory / config / status |
| 4.3 | 配置化 | ✅ 完成 | `config.ts`；env > yaml > defaults |
| 4.4 | Agent Docs 系统 | ✅ 完成 | 本地文档注入；避免联网搜索 |
| 4.5 | 结构化日志 | ✅ 完成 | logger 统一化 |
| 4.6 | Bootstrap 改进 | ✅ 完成 | 提供 mtcute 示例与登录说明 |
| 4.7 | 跨进程通讯补丁 | ✅ 完成 | NC cross-process 修复 |
| 4.8 | API Docs 与配置补丁 | ✅ 完成 | mtcute 文档修补；温度配置修补 |
| 5.1 | Scene-Bound Sessions | ✅ 完成 | 单一长 Session + scope 过滤 |
| 6.0 | Memory V2 Stub 迁移 | ✅ 完成 | 模块替换与调用面迁移已完成 |
| 6.1 | Air-Reading Engine | ✅ 完成 | Fast Router + TopicRegistry 状态机 |
| 6.1.1 | Engaged Topic Handler | ✅ 完成 | 已介入话题的快速对话路径 |
| 6.2 | Recording Pipeline | ✅ 完成 | 50 条 / 2 分钟缓冲；强信号加速 |
| 6.6 | Dry-Run System | ✅ 完成 | 历史回放验证 |
| 6.7 | Model Router | ✅ 完成 | 规则驱动模型与模式路由 |
| 6B.0 | Ingress Boundary Refactor | 🚧 进行中 | `nc.message` 标准化 schema、`PlatformAdapter` 抽象、全链路 string ID 迁移、官方 `TelegramAdapter`、bootstrap 降责已落地；仍需继续扩展更多 adapter / ingress 测试 |
| 6.3 | Reply Pipeline Framework | ✅ 完成 | `ReplyPipeline` + `ReplyTask` 已接入主循环，覆盖 FAST_PATH / topic triage / engaged 三类任务；`ContextAssembler` 已把 `Scene Focus / Latent Memory` 自动注入首轮上下文 |
| 6.4 | Code-First Action Surface | ✅ 完成 | sandbox 已注入 `actions.*`，host-call 已桥接 memory/topic/action 上下文 |
| 6.5 | Agent-Skill Runtime | ✅ 完成 | sandbox 已注入代码型 `skills.memory` / `skills.social`，并由测试覆盖实际调用链 |
| 6.6 | Feedback Loop | ✅ 完成 | `system.agent_message_sent` → `FeedbackLoop` → `system.feedback_evaluated` 闭环已接入主循环并有集成测试 |
| 7.1 | Playbook System | 📝 规划中 | SOTA 行为知识下沉 |
| 7.2 | Skill Auto-Generation | 📝 规划中 | 失败场景沉淀为可复用 skill |
| 7.3 | CoT Template Distillation | 📝 规划中 | 典型推理模板下沉 |
| 7.4 | Cost Control | 📝 规划中 | 预算与模型分层 |
| 7.5 | Degradation Strategy | 📝 规划中 | 多级降级 |

### 1.2 这次重写对“已完成工作”的影响

本次重写**不否定** Phase 1-6A 已完成的工程成果。相反，它做的是：

- 保留所有已经可用的组件
- 重解释这些组件在新边界下的职责
- 调整未来 Phase 6B-7 的实施顺序
- 彻底移除原本含糊的“Agent 自己监听平台”主路线

换言之，这不是推翻重来，而是**重新定义主干架构**。

---

## 2. 产品目标与边界

### 2.1 愿景

CyberGroupmate（赛博群友）是一个长期在线、具备社会感、记忆连续性和上下文理解能力的社交智能体。终极目标不是“像一个机器人能答题”，而是：

> **让新来的群友很难意识到这不是一个真实群友。**

### 2.2 核心设计目标

系统必须同时满足以下目标：

1. **自然性**：行为节奏、发言内容、介入时机接近真实群友。
2. **可控性**：即使模型能力波动，系统也要维持基本稳定。
3. **可演进性**：可以从 Telegram 扩展到 Discord 等其他 IM。
4. **可观测性**：任何一次误行为都能回溯到事件流、路由决策和模型调用。
5. **可维护性**：平台接入、消息处理、记忆系统、回复策略要分层清晰。
6. **统一动作空间**：所有能力必须能以 TypeScript 代码接口被调用、组合和调试。

### 2.3 明确不再追求的目标

以下目标不再作为核心架构目标：

1. **不再把“Agent 能自己写出完整平台监听逻辑”视为系统主路径。**
2. **不再把 Scene 当作平台接入机制。**
3. **不再让 bootstrap 代码承担 canonical ingress 的责任。**
4. **不再为旧 bootstrap-listener 路线保留兼容设计。**
5. **不引入额外的 JSON / 文本 tool use 体系。**

Agent 仍然可以探索平台接入，但那属于**实验扩展能力**，不是系统主干。

---

## 3. 新的总体架构

### 3.1 架构总览

```
┌──────────────────────────────────────────────────────────────┐
│                   Platform Adapter Layer                     │
│                                                              │
│  TelegramAdapter   DiscordAdapter   FutureAdapter...         │
│  - connect         - connect        - connect                │
│  - receive         - receive        - receive                │
│  - normalize       - normalize      - normalize              │
│  - dedupe key      - dedupe key     - dedupe key             │
└──────────────────────────────┬───────────────────────────────┘
                               │ NCEvent
┌──────────────────────────────▼───────────────────────────────┐
│                    NotificationCenter                        │
│                                                              │
│  inbox / append-only log / drain / replay / ack / inspect    │
└──────────────────────────────┬───────────────────────────────┘
                               │
┌──────────────────────────────▼───────────────────────────────┐
│                    Cognition Pipeline                        │
│                                                              │
│  Fast Router                                                 │
│  Recording Pipeline                                          │
│  TopicRegistry                                               │
│  Memory V2                                                   │
│  Reply Pipeline                                              │
│  Feedback Loop                                               │
└──────────────────────────────┬───────────────────────────────┘
                               │
┌──────────────────────────────▼───────────────────────────────┐
│                    Agent Runtime / Sandbox                   │
│                                                              │
│  CodeAct / Scenes / Memory API / Docs / Code Actions / Skills│
│  Outbound send / recalls / optional experimental adapters    │
└──────────────────────────────────────────────────────────────┘
```

### 3.2 职责边界

| 领域 | 框架负责 | Agent 负责 |
|------|----------|------------|
| 平台连接 | 官方 adapter 的实现、重连、限流、日志、标准化 | 可选地编写实验 adapter，但非主路径 |
| 消息接收 | 接收原始平台事件并转成 `NCEvent` | 不拥有 canonical ingress |
| 消息消费 | Fast Router / Recording / Memory / Reply / Feedback 全部由框架掌控 | 不直接操纵消息流转规则 |
| 消息发送 | 提供代码形式的发送 API、审计与限流 | 决定何时发、发什么、调用哪个 API |
| 记忆 | 落盘、检索、压缩、反思、核心事实 | 调用 recall / browse / store 等接口 |
| 场景 | 提供类型上下文和动作边界 | 切换场景、按场景写代码 |
| 扩展 | 定义 adapter、event schema、代码接口、skill 模块 | 在此基础上发明策略、流程和实验能力 |

### 3.3 设计原则

1. **Ingress 是基础设施，不是行为智能。**
2. **NC 之后的一切由框架接管。**
3. **Agent 拥有主动性，但不拥有系统真相的唯一来源。**
4. **平台无关依赖的是标准化事件契约，不是把平台监听权下放给 Agent。**
5. **未来扩展到 Discord 依赖“新增 adapter + scene + action surface”，而不是只新增一个 scene。**
6. **代码即统一动作空间**：不引入独立 tool use；所有系统能力都通过代码 API 暴露。
7. **Skill 也是代码，不是工具**：skill 应表现为可导入、可调用、可测试、可审计的代码模块。

### 3.4 核心心智模型

新的认知模型必须非常明确：

1. **`scene` 像手机里的 app。**
2. **`NotificationCenter` 像手机通知中心。**
3. **平台 adapter 像操作系统里的 push / system integration 层。**

因此：

1. Telegram、Discord 这类平台可以各自对应一个 scene
2. 它们发来的消息通知统一进入 `NotificationCenter`
3. Agent 在 `home` scene 看到通知列表时，本质上是在看“有哪些 app 发来了什么通知”
4. Agent 可以根据通知来源决定是否切换到对应 scene 进一步行动

这比“scene = 平台接入点”要准确得多。

---

## 4. 正式数据流

### 4.1 Canonical Ingress Flow

1. `PlatformAdapter` 连接平台并接收原始事件
2. Adapter 将原始事件标准化为 `NCEvent`
3. `NotificationCenter` 负责持久化、排队、drain、重放
4. `Fast Router` 消费 `NCEvent`，决定进入：
   - 直接快速路径
   - Engaged Topic Handler
   - Recording Pipeline 缓冲
5. `Recording Pipeline` 批量提取话题、摘要、Triage、写入记忆
6. `Reply Pipeline` / `ContextAssembler` 将话题级判断和潜意识记忆转换为可执行的 Agent 输入
7. Agent 在 sandbox 中通过 CodeAct 消费这些输入，调用代码接口与 skill 模块完成感知、检索、思考与行动
8. `Feedback Loop` 追踪发言后的后效

### 4.2 Agent Loop 的新角色

Agent 不再负责“先把 Telegram 连上再说”。它的新职责是：

1. 理解通知和上下文
2. 调用 `memory.recall()`、`browseHistory()`、`actions.*`
3. 决定回复内容与回复节奏
4. 通过 `ctx.tg`、未来的 `ctx.dc` 等发送接口执行外发
5. 在需要时编写辅助工具或实验扩展

这使得 bootstrap 从“建立生命支持系统”变成“初始化人格与行为环境”。

### 4.3 Phase 6B 的真正目标：接上 Agent 侧与 Memory 侧

从工程现实看，当前项目里两块最重、最真实的资产是：

1. **Phase 1-5 的 Agent 侧执行引擎**
   - CodeAct Session Runner
   - Sandbox / Worker
   - Scene System
   - `ctx` / `runtime` / docs
   - 长 session 与 scope 隔离
2. **Phase 6A 的 Memory / Pipeline 侧**
   - Fast Router
   - Recording Pipeline
   - TopicRegistry
   - Memory V2
   - Dry-Run / Model Router

因此，Phase 6B 的本质不是“再加几个新模块”，而是：

> **把 Agent 侧的代码执行能力，和 Memory 侧已经形成的话题判断、记忆检索、上下文预处理能力，接成一条完整闭环。**

在新架构下，这条闭环应当是：

1. NC 收到某个 scene 的通知
2. Pipeline 将消息提炼成话题、摘要、triage、memory context
3. Reply Pipeline 把这些结构化结果变成 Agent 可消费的输入
4. Agent 仍然通过 CodeAct 写代码决策，而不是切到 tool use
5. Agent 通过代码 API / skill 模块执行动作
6. 行动结果再回流到 Memory / Feedback

---

## 5. NotificationCenter 作为正式边界

### 5.1 边界定义

`NotificationCenter` 是整个系统的**平台无关入口总线**，同时也是 Agent 的**统一通知收件箱**。

最贴切的类比不是“事件队列”，而是**手机通知中心**：

- Telegram scene 发来一条消息，NC 里出现一条 Telegram 通知
- Discord scene 发来一条消息，NC 里出现一条 Discord 通知
- system 自己产生错误、提醒、定时任务，也可以进入 NC

它的职责不是“帮 Agent 暂存通知”这么简单，而是：

1. 承接各个平台 adapter 的标准化事件
2. 形成 append-only 的可审计事件流
3. 作为 Routing / Recording / Replay / Dry-Run 的共同输入层
4. 将平台差异约束在 adapter 边界之外

### 5.1.1 NotificationCenter 对 Agent 可见的形态

对 Agent 来说，NC 里的每条通知都应至少带有：

1. `scene`
2. `kind`
3. `summary`
4. `observedAt`
5. 必要时的 `traceId` / `eventId`

这样 Agent 在 `home` scene 中看到的是：

- 哪个 scene 发来了通知
- 这是什么类型的通知
- 是否值得切过去处理

这正是“通知中心”模型的关键。

### 5.2 设计要求

`NotificationCenter` 必须具备：

1. append-only 持久化
2. monotonic event id
3. drain 批量消费
4. replay / inspect 能力
5. event 去重支持
6. 与平台无关的 schema 校验

### 5.3 不做什么

`NotificationCenter` 不负责：

1. 直接理解消息语义
2. 决定是否该回复
3. 维护话题状态机
4. 直接调用 LLM

这些职责留给上层 cognition pipeline。

---

## 6. 标准化事件模型

### 6.1 为什么必须先做标准化

如果 `Recording Pipeline`、`TopicRegistry`、`Memory V2` 仍然依赖 Telegram 原始字段，就不可能真正平台无关。

因此，平台无关化不是“让 Agent 自己研究 Discord 文档”，而是：

> **让平台差异在 adapter 层被吃掉，框架内部只看统一事件。**

### 6.2 `NCEvent` 总体结构

```ts
interface NCEventEnvelope<TPayload> {
  eventId: string;
  kind: string;
  source: "platform_adapter" | "agent_runtime" | "system";
  observedAt: string;
  scene: string;
  payload: TPayload;
  dedupeKey?: string;
  traceId?: string;
}
```

说明：

- `eventId` 是 NC 内部单调 ID
- `kind` 决定 payload 类型
- `scene` 表示这条通知来自哪个 scene / app，例如 `telegram`、`discord`
- `dedupeKey` 由 adapter 生成，用于去重

### 6.3 `message` 事件规范

```ts
interface NCMessageEventPayload {
  type: "message";

  // 平台无关核心字段
  scene: string;
  chatId: string;
  userId: string;
  displayName: string;
  text: string;
  timestamp: string; // ISO 8601

  // 可选结构化字段
  messageId?: string;
  replyToMessageId?: string;
  threadId?: string;
  chatTitle?: string;
  chatType?: string;
  isDirectMessage?: boolean;
  mentionsAgent?: boolean;

  source?: {
    scene: string;
    platform: string;
    chatId: string;
    userId: string;
    chatType?: string;
    messageId?: string;
    replyToMessageId?: string;
    threadId?: string;
  };

  // 富媒体和扩展字段
  attachments?: Array<{
    kind: "image" | "video" | "audio" | "file" | "link" | "other";
    url?: string;
    mimeType?: string;
    name?: string;
  }>;

  platformData?: Record<string, unknown>;
}
```

关键约束：

1. **所有 ID 一律是 `string`**
2. 时间统一为 ISO 8601
3. 平台专有信息只能进入 `platformData`
4. 框架内部组件不得依赖平台原始对象
5. **每条消息通知都必须能让 Agent 明确知道“这是哪个 scene 发来的”**
6. **每条消息通知都必须显式携带来源身份，而不是要求后续模块再猜它属于哪个 chat / user / chatType**

### 6.4 其他事件类型

后续可逐步加入：

```ts
type NCEvent =
  | NCEventEnvelope<NCMessageEventPayload>
  | NCEventEnvelope<NCSystemEventPayload>
  | NCEventEnvelope<NCDeliveryEventPayload>
  | NCEventEnvelope<NCTimerEventPayload>;
```

初期必须先完成 `message`，其他事件可延后。

---

## 7. PlatformAdapter 层

### 7.1 平台接入的新主路径

平台接入从现在开始统一抽象为 `PlatformAdapter`。

```ts
interface PlatformAdapter {
  readonly platform: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  getSendContext(): Record<string, unknown>;
}
```

更完整地说，每个 adapter 必须提供四类能力：

1. **连接**：鉴权、会话恢复、断线重连
2. **接收**：监听平台原始事件
3. **标准化**：转为 `NCEvent`
4. **发送上下文**：把可用于发消息的对象暴露给 Agent

### 7.2 Telegram 作为 first-party adapter

Telegram 不再只是一个 bootstrap 里的“示例代码”。

它是系统的第一个**官方 adapter**，需要由框架正式维护：

1. 连接 mtcute
2. 监听新消息
3. 标准化为 `NCMessageEventPayload`
4. 生成 dedupe key
5. 把消息送入 NC
6. 为 sandbox 暴露发送能力，如 `ctx.tg.sendText()`

### 7.3 Discord 的正确接入方式

未来接 Discord 时，理想流程不再是：

> “只新建一个 scene，让 Agent 自己去研究并长期托管监听代码”

而是：

1. 新增 `DiscordAdapter`
2. 定义 `discord.d.ts` 和发送 API
3. 保持相同的 `NCMessageEventPayload`
4. 让上层 `Fast Router / Recording / Memory / Reply` 零修改复用

### 7.4 Agent 编写 adapter 的允许范围

Agent 仍然可以：

1. 生成一个新平台 adapter 的原型代码
2. 通过 docs 和类型定义探索如何接平台
3. 在实验环境中启动非官方 adapter

但规则是：

1. **实验 adapter 不是系统默认入口**
2. **只有通过人工审阅并升格后，才能成为官方 adapter**
3. **框架对消息流的管理权不能依赖 Agent 一次 bootstrap 的成功与否**

---

## 8. Cognition Pipeline

### 8.1 总则

从 `NC` 往上的所有组件只面向标准化事件工作。

这包括：

- `Fast Router`
- `Engaged Topic Handler`
- `Recording Pipeline`
- `TopicRegistry`
- `Memory V2`
- `Reply Pipeline`
- `Feedback Loop`

它们不关心 Telegram、Discord 的 SDK 细节。

### 8.2 Fast Router

职责：

1. 对进入 NC 的消息做第一层路由
2. 把明确的高优先级事件送往快速路径
3. 把其他消息交给 Recording Pipeline 做观察模式处理

初期规则：

1. `@agent`
2. 回复 agent 的消息
3. 私聊
4. 属于已 ENGAGED 话题的消息

全部直接走快速路径。

其他群聊消息进入 Recording 缓冲。

### 8.3 TopicRegistry

TopicRegistry 是框架内部的实时话题注册表。

要求：

1. `chatId`、`userId`、`messageId` 全部使用 `string`
2. 只存标准化消息引用，不存平台原始对象
3. 明确区分观察态、预热态、对话态、退出态

建议结构：

```ts
interface Topic {
  id: string;
  scene: string;
  chatId: string;
  label: string;
  keywords: string[];
  participantIds: Set<string>;
  messageIds: string[];
  state: TopicState;
  parentTopicId?: string;
  createdAt: number;
  lastActivityAt: number;
  lastTriagedAt?: number;
  messageCount: number;
}
```

### 8.4 Recording Pipeline

职责不变，但输入定义改变为统一事件：

1. 从 NC 中接收标准化消息
2. 批量做话题聚类
3. 生成话题摘要与 triage 结果
4. 更新 TopicRegistry
5. 写入 Memory V2

`Recording Pipeline` 不应知道消息来自 Telegram 还是 Discord。

### 8.5 Memory V2

Memory V2 继续作为统一记忆系统，职责包括：

1. `message_log` 标准化存档
2. `topics` / `topic_nodes`
3. `person_profiles`
4. `core_facts`
5. `browseHistory()`
6. `recall()`
7. compaction / reflection

关键约束：

1. `message_log` 存的是标准化消息，而非 Telegram 原始格式
2. scene 是一级索引维度
3. `chat_id` / `user_id` / `message_id` 一律为 `TEXT`

### 8.6 Reply Pipeline + ContextAssembler

Reply Pipeline 仍然负责三种模式：

1. `Advisory`
2. `Guided`
3. `Enforced`

但在本版架构中，它明确位于 **NC 之后**，因此不参与平台接入，也不拥有消息监听逻辑。

它的真正职责是把 Memory / Pipeline 侧的结构化输出，桥接成 Agent 侧可执行的输入：

1. 接收 topic、summary、triage、memory_context、scene 信息
2. 通过 `ContextAssembler` 自动读取与当前目标 chat 相关的潜意识记忆
3. 决定这次交给 Agent 的自由度等级
4. 以 prompt + typed API + 代码能力表面的形式，把任务交给 CodeAct
5. 保证即使在 `Guided` / `Enforced` 模式下，也仍然是“生成并执行代码”，而不是切换到外部 tool use

`ContextAssembler` 是桥接层组件，不属于 adapter，也不属于 Agent。它负责把下列 Memory V2 信息自动注入：

- `person_identities`
- `person_group_profiles`
- `group_models`
- 近 7 天相关 `topics`
- 当前 task 的 recent context / incoming messages

其输出应至少分成两块：

1. `Scene Focus`
2. `Latent Memory`

例如：

```text
[Scene Focus]
scene=telegram chat=682932098 type=private target=莫思奇多
recent:
- [telegram/private] 莫思奇多: 在吗在吗

[Latent Memory]
identities=莫思奇多 (user:682932098, aliases:mozzie)
profiles=tier=2; relation=熟人; style=简洁直接
group=title=莫思奇多私聊; engagement=high; agentRole=技术搭子
recentTopics=Phase 6 / TelegramAdapter
```

这里的“潜意识”不是把 `memory.md` 或原始数据库原样塞给 Agent，而是把框架已经整理好的、与当前 chat 强相关的摘要自动注入。

### 8.7 Feedback Loop

Feedback Loop 也只消费标准化事件与系统动作结果：

1. Agent 发言后 3 分钟观察反应
2. 判断是否被忽略、被接纳、引发新互动、造成异常
3. 更新 engagement 指标

---

## 9. Scene 系统的重新定位

### 9.1 Scene 不再承担 ingress 职责

此前“Telegram Scene”在认知上容易被误解为：

> 进入 telegram scene = 获得 Telegram 的监听与控制权

这是不准确的。

从现在开始：

1. `scene` 既是 Agent 的类型上下文，也是一个接近“app”的操作空间
2. scene 决定“你现在能调用哪些 API”
3. 平台消息先进入 NC，再以“来自某个 scene 的通知”形式呈现给 Agent
4. 平台接收在 adapter 层；scene 不负责监听接入

### 9.2 Scene 的角色

保留三类 scene：

1. `home`
2. `telegram`
3. `memory`

未来可增加：

1. `discord`
2. `moderation`
3. `analytics`

但新增 scene 只代表：

- 增加一套类型定义
- 增加一组动作能力

不代表平台接入已经完成。

同时，不应把 scene 膨胀成：

- `telegram/-100123`
- `telegram/-100456`
- `telegram/682932098`

正确做法是：

- scene 仍然是 `telegram`
- 目标 chat 通过 `Scene Focus` 表达
- 当 Agent 进入 scene 时，框架继续自动注入该目标 chat 的最近上下文和潜意识记忆

也就是说，真正需要按 chat 变化的不是 scene 名，而是 scene 的 focus / target context。

### 9.3 `ctx` 的角色

`ctx` 继续作为跨代码块共享状态，但其主要用途转为：

1. 保存发送客户端或发送工具
2. 保存临时缓存
3. 保存一些 Agent 自写的 helper

不再建议把“长期存活的平台监听器”作为主系统能力塞进 `ctx`。

---

## 10. Bootstrap 的重新定义

### 10.1 旧 bootstrap 的问题

旧设计中 bootstrap 同时承担：

1. 连平台
2. 建监听器
3. 初始化 Agent
4. 建立长期后台任务

这让 bootstrap 成为一个过重的责任中心，并带来三个问题：

1. bootstrap 失败会直接影响 ingress
2. 回放逻辑要负责恢复平台监听副作用
3. 难以区分“平台接入失败”和“Agent 初始化失败”

### 10.2 新 bootstrap 的职责

bootstrap 从现在开始只负责：

1. 初始化 Agent 运行时
2. 设定人格与默认场景
3. 初始化可选 helper
4. 加载 docs / skills / action surface 的认知准备

### 10.3 bootstrap 不再默认做什么

1. 不再默认连接 Telegram
2. 不再默认建立消息监听器
3. 不再负责向 NC 推送生产消息

如果 Agent 在实验模式下自己写 adapter，必须显式标记为实验，不进入主干计划。

### 10.4 Skill 与 Action 的提供方式

本项目保留旧版方案里的核心立场：

1. **不使用独立 tool use 协议**
2. **不向 Agent 暴露一套 JSON tool schema**
3. **所有能力都以代码接口提供**

因此：

1. `memory.recall()`、`browseHistory()`、`ctx.tg.sendText()` 这类能力是代码 API
2. Reply Pipeline 中的“Action API”也必须表现为代码函数，而不是工具调用
3. Phase 7 引入的 skill 也必须是代码模块，例如 `skills.replyInGroup()`、`skills.recallPersonContext()`

Agent 获得能力的方式应该始终是：

- 看到类型定义
- 写 TypeScript 代码
- 执行
- 观察结果
- 修正

这条链不能被 tool use 破坏。

---

## 11. Memory V2 与 Topic 模型的必要调整

### 11.1 统一 ID 类型

这是这次重写最重要的结构性要求之一：

1. `chatId: string`
2. `userId: string`
3. `messageId: string`
4. `participantIds: Set<string>`
5. `messageIds: string[]`

任何内部类型仍使用 `number`，都说明实现还没有真正平台无关。

### 11.2 标准化存档优先于平台原始存档

`message_log` 要存：

1. scene
2. chatId
3. userId
4. displayName
5. text
6. timestamp
7. replyToMessageId
8. messageId
9. platformData（必要时 JSON 存档）

不存“整个 Telegram Message 对象”。

### 11.3 “外挂大脑”视角

你提到的“NC 就像外挂大脑”这个说法是成立的，但需要更精确：

1. `NotificationCenter` 是**知觉入口**
2. `Memory V2` 是**长期与中期记忆系统**
3. `TopicRegistry` 是**工作记忆中的话题状态**
4. `Reply Pipeline + Agent` 是**行动决策系统**

这样框架的抽象就不再 Telegram-centric，而是 cognition-centric。

---

## 12. 对旧方案的取舍结论

本项目当前有三条候选路径：

### 路线 A：继续让 Agent 自己监听平台

优点：

1. 自由度最高
2. 很符合 CodeAct 的“自己接入新世界”幻想

缺点：

1. ingress 不稳定
2. 很难审计和回放
3. 框架无法对消息完整性负责
4. 未来会持续加重调试负担

结论：

**本次重写后不再为这条路线预留兼容位。**

### 路线 B：框架直接全面接管 Telegram 消息

优点：

1. 工程最稳
2. 调试简单
3. replay / dry-run / dedupe / tracing 最清晰

缺点：

1. 如果写成 Telegram 特化逻辑，会牺牲扩展性

结论：

**如果没有平台抽象，会走向耦合；如果有 `PlatformAdapter` 抽象，则这是正确方向。**

### 路线 C：NC 作为平台无关边界，官方 adapter 接入平台

优点：

1. 兼顾工程稳定性与扩展性
2. 框架拥有 canonical ingress
3. 平台差异被约束在 adapter 边界
4. Agent 仍保留高度自主性
5. 与“scene = app，NC = 通知中心”的模型天然一致

缺点：

1. 需要一次较大的边界重构
2. 要清理现有“Telegram Scene = Telegram 接入”的认知混淆

结论：

**本方案选择路线 C。**

---

## 13. Phase 6B-7 新路线图

### 13.1 总体顺序

从现在开始，Phase 6B 的第一优先级不再是 Reply Pipeline，而是：

> **先把 ingress 边界做对，再继续往上叠回复与反馈。**

但从项目价值上看，Phase 6B 的核心交付不是单个组件，而是：

> **把 Phase 1-5 的 Agent 侧执行能力，与 Phase 6A 的 Memory / Pipeline 侧观察能力，无缝接成一个真正可运行的决策闭环。**

### 13.2 Phase 6A（已完成，但语义更新）

已完成内容继续有效：

1. Air-Reading Engine
2. Engaged Topic Handler
3. Recording Pipeline
4. Dry-Run
5. Model Router
6. Memory V2 M1-M4

但它们现在被重新解释为：

> **这些组件全部属于 NC 之后的 cognition pipeline。**

### 13.3 Phase 6B.0：Ingress Boundary Refactor（新增前置阶段）

**目标**：彻底删除“bootstrap 监听平台”这条主路线，改为“官方 adapter 监听平台，NC 成为唯一入口”。

#### Task 6B.0.1 — 定义正式 `NCEvent` schema

内容：

1. 定义 `NCEventEnvelope`
2. 定义 `NCMessageEventPayload`
3. 明确字段约束与去重语义
4. 为后续类型迁移建立唯一真相来源

验收：

1. 所有新消息都能以 schema 校验通过的格式进入 NC
2. Dry-Run 也能构造同样的 schema

#### Task 6B.0.2 — 引入 `PlatformAdapter` 抽象

内容：

1. 建立 adapter 接口
2. 明确 lifecycle：`start()` / `stop()`
3. 明确发送上下文导出方式

验收：

1. 适配器可独立启动与停止
2. 不依赖 sandbox bootstrap

#### Task 6B.0.3 — TelegramAdapter 正式化

内容：

1. 把当前 Telegram 接入从 bootstrap 主路径迁出
2. 在宿主侧实现 `TelegramAdapter`
3. 将原始 mtcute 消息转成 `NCMessageEventPayload`
4. 暴露发送表面给 sandbox

验收：

1. 不运行 bootstrap 监听代码，框架也能稳定接收 Telegram 消息
2. Agent 仍可正常调用发送 API 回复消息

当前状态：

1. 已完成：宿主侧 `TelegramAdapter` 已负责 mtcute 连接、登录、消息监听与 `nc.message` 标准化入队
2. 已完成：sandbox 中的 `ctx.tg` 改为 host-backed proxy，通过 host-call 调用官方 adapter
3. 已完成：测试已去掉“bootstrap 手动注入 ctx.tg / 手动挂监听”的旧假设

#### Task 6B.0.4 — 全链路 ID 类型迁移

内容：

1. `TopicRegistry` 改为 string IDs
2. `pipeline/types.ts` 改为 string IDs
3. `Memory V2` 持久化 schema 检查
4. dry-run 输入层对齐

验收：

1. pipeline 不再要求 Telegram 风格 number id
2. 至少对 Telegram 和模拟 Discord 数据都能跑通

当前状态：

1. 已完成：`pipeline/types.ts`、`TopicRegistry`、`FastRouter`、`RecordingPipeline`、`ReplyPipeline`、`Dry-Run`、`Memory V2` 的 canonical ID 全部迁移为 `string`
2. 已完成：`message_log.message_id` / `reply_to_message_id` SQLite schema 改为 `TEXT`
3. 已完成：相关测试数据、scene 类型定义、history browse 结果全部对齐为 string IDs

#### Task 6B.0.5 — Bootstrap 降责

内容：

1. 更新 bootstrap prompt
2. 从“请你建立 Telegram 订阅”改为“平台消息已由系统接入，你负责理解与行动”
3. 保留实验 adapter 能力，但不再默认启用

验收：

1. bootstrap 不做平台监听也能完成正常运行
2. bootstrap 重放不再影响 canonical ingress

当前状态：

1. 已完成：bootstrap prompt 已改写为“理解系统、初始化自身”，不再负责 Telegram 连接或监听
2. 已完成：`system-prompt` / `telegram` agent docs 已去除“自己连接 Telegram / runtime.spawn listener”主叙事
3. 已完成：bootstrap 持久化格式已版本化，旧的 listener 型 replay 不再被当作有效主线状态加载

### 13.4 Phase 6B.1：Agent-Memory Bridge（6B 主体）

在 ingress 边界稳定后，Phase 6B 的主体工作是把 Agent 侧和 Memory 侧真正接上。

#### Task 6.3 — Reply Pipeline Framework

职责：

1. 接收来自 Recording Pipeline / TopicRegistry / Model Router 的结构化结果
2. 组装出 Agent 本轮应该看到的任务输入
3. 决定 `Advisory / Guided / Enforced` 三种代码执行模式
4. 把话题、记忆、动作建议转成 CodeAct session 的高质量上下文

关键要求：

1. 输出给 Agent 的仍然是 prompt + typed code surface
2. 不引入 tool use
3. SOTA 模型仍保留完全自由写代码的能力

当前状态：

1. 已完成：`ReplyPipeline` 已能为 FAST_PATH、话题 triage、ENGAGED continuation 组装 `ReplyTask`
2. 已完成：`main.ts` 主循环改为消费 `ReplyTask` 而不是直接消费原始事件批
3. 已完成：`tests/phase6-chain.test.ts` 使用本地 fake OpenAI endpoint 跑通 `ReplyTask -> runCodeActSession -> sandbox` 主链

#### Task 6.4 — Code-First Action Surface

旧文档里的 “High-Level Action API” 在新架构下应重命名理解为：

> **Code-First Action Surface**

它不是 tools，而是一组以代码形式提供的辅助函数 / helper 模块。

例如：

```ts
actions.getTopicContext(topicId)
actions.recallPerson(userId)
actions.replyInScene(scene, chatId, content)
actions.markTopicHandled(topicId)
```

这些能力必须满足：

1. 有 `.d.ts` 类型定义
2. 可在 sandbox 中被代码直接调用
3. 可组合、可调试、可测试
4. 底层仍可退回原始 API，如 `ctx.tg.*`、`memory.*`

当前状态：

1. 已完成：sandbox worker 通过 host-call 桥接 `memory.recall()` / `memory.browseHistory()` / `memory.reflect()`
2. 已完成：注入 `actions.getTopicContext()` / `actions.listActiveTopics()` / `actions.recallForTopic()`
3. 已完成：home / memory / telegram scene `.d.ts` 已同步这些代码接口

#### Task 6.5 — Agent-Skill Runtime

为了和你的原始设计一致，Phase 6B 就要把 skill 的运行形态定下来，而不是等到 7.2 再想。

约束：

1. skill 不是 tool
2. skill 不是 prompt 片段
3. skill 是代码模块 / 函数库

推荐形式：

```ts
import { replyInGroup, recallPersonContext } from "skills/social";
```

或者通过预注入命名空间：

```ts
skills.social.replyInGroup(...)
```

验收要求：

1. skill 可被 Agent 通过代码直接调用
2. skill 有类型定义和测试
3. skill 调用结果与普通代码执行一样可观察、可报错、可调试

当前状态：

1. 已完成：sandbox 已注入 `skills.memory.recallAndSummarize()` / `skills.memory.browseForAnswer()`
2. 已完成：sandbox 已注入 `skills.social.replyInTelegram()`，底层走 `ctx.tg.sendText()`
3. 已完成：发送后会自动回写 `system.agent_message_sent`，供 Feedback Loop 消费

#### Task 6.6 — Feedback Loop

Feedback Loop 保持原计划，但它现在依赖的是已经接通的 Agent-Memory 闭环。

当前状态：

1. 已完成：主循环捕获 `system.agent_message_sent`
2. 已完成：`FeedbackLoop` 会写入 interaction、更新 `group_models`，并推送 `system.feedback_evaluated`
3. 已完成：有独立测试与 Phase 6 主链集成测试覆盖

| Task | 内容 | 依赖 | 估时 |
|------|------|------|------|
| 6.3 | Reply Pipeline Framework | 6B.0 | 3天 |
| 6.4 | Code-First Action Surface | 6B.0, sandbox | 2天 |
| 6.5 | Agent-Skill Runtime | 6.4, sandbox | 2天 |
| 6.6 | Feedback Loop | 6.3 | 2天 |

### 13.5 Phase 7：知识下沉与自动化

| Task | 内容 | 依赖 | 估时 |
|------|------|------|------|
| 7.1 | Playbook System | 6.2, 6.3 | 3天 |
| 7.2 | Skill Auto-Generation | sandbox, 6.7 | 4天 |
| 7.3 | CoT Template Distillation | 7.1 | 2天 |
| 7.4 | Cost Control | config | 2天 |
| 7.5 | Degradation Strategy | 7.4 | 2天 |

---

## 14. 迁移策略

### 14.1 迁移目标

迁移的目标不是“重构得很优雅”，而是：

1. 不破坏当前已完成的 cognition pipeline
2. 让 ingress 边界尽快变得正确
3. 把对 Telegram 的耦合收缩到 adapter 层

### 14.2 推荐实施顺序

1. 定义 schema
2. 迁移内部 ID 类型
3. 实现 TelegramAdapter
4. 改写 bootstrap prompt 与默认行为
5. 实现 Reply Pipeline，把 topic/memory 输出正式喂给 Agent
6. 实现 Code-First Action Surface 与 skill runtime
7. 跑 dry-run 与真实 Telegram 验证 Agent-Memory 闭环

### 14.3 切换策略

因为项目尚未发布，也没有向前兼容包袱，所以这里不采用长期兼容策略，而采用**直接切换**：

1. 新实现只保留官方 adapter 路线
2. 所有新组件只认标准化消息，不认平台原始消息
3. bootstrap listener 不再属于主线代码路径
4. 若保留旧代码，仅作为临时参考，不作为设计承诺

---

## 15. 验收标准

### 15.1 Ingress Boundary Refactor 验收标准

1. Telegram 消息无需 Agent 建立监听器即可进入 NC
2. Agent bootstrap 不负责平台监听，系统仍可正常运行
3. `Fast Router / Recording Pipeline / TopicRegistry / Memory V2` 只消费标准化消息
4. 内部不再存在对 Telegram 原始 message 类型的硬依赖
5. 所有核心 ID 均为 `string`
6. Dry-Run 和真实消息接入使用同一事件 schema

### 15.2 Phase 6 整体验收标准

1. Recording Pipeline 连续运行 24h 无异常
2. Engaged Topic Handler 在真实对话中回复延迟 < 20 秒
3. Reply Pipeline 能稳定把 topic / triage / memory context 交给 Agent
4. Guided / Enforced 模式下，Agent 仍通过代码接口行动，而不是依赖 tool use
5. 退出机制有效，身份探测或拥挤场景能正确退出
6. 误触发率与迟到率可量化追踪

### 15.3 Phase 7 验收标准

1. Playbook 能反映近期群聊动态
2. Skill Auto-Generation 能产出至少 3 个可复用代码 skill
3. 弱模型在代码 skill + Playbook 下的成功率提升可测
4. 系统连续运行 48h 无不可恢复崩溃

---

## 16. 主要风险与应对

### 16.1 风险：重构过程中出现双入口

风险：

如果重构不彻底，同时存在 bootstrap listener 和官方 adapter，可能造成重复入队。

应对：

1. 引入 `dedupeKey`
2. 显式区分 `source`
3. 尽早删除 bootstrap listener 主路径

### 16.2 风险：内部类型改 string 后引发连锁修改

风险：

`TopicRegistry`、pipeline、memory、dry-run 都可能受影响。

应对：

1. 先统一类型定义
2. 再从 adapter 向上逐层修复
3. dry-run 作为回归测试主工具

### 16.3 风险：Agent 能力被误认为被削弱

风险：

表面上看，Agent 不再自己接平台，似乎自由度下降。

应对：

1. 明确告诉 Agent：它失去的是“基础设施责任”，不是“行动能力”
2. 保留实验 adapter 能力
3. 强调 CodeAct 主体地位不变：Reply Pipeline 只是给它更好的输入
4. 强化代码形式的 Action API、Scene、Docs、Memory 能力
5. 明确 Memory V2 不只是“主动 recall 的数据库”，还承担自动注入潜意识上下文的职责

### 16.4 风险：Discord 等未来平台被低估

风险：

误以为“只要新建一个 scene 就能接新平台”。

应对：

在设计文档中明确：

> 新平台接入 = adapter + scene + action surface + auth/runtime handling

而不是只有 scene。

---

## 17. 对 Agent 的新指令原则

未来 system prompt / bootstrap prompt 应反映以下事实：

1. 平台消息由系统接入，你不负责建立 canonical listener
2. 你在 `home` scene 看到的是类似“手机通知中心”的统一通知流
3. 每条通知都明确标识来自哪个 scene / app
4. 你可以消费通知、回忆记忆、决定是否切换 scene、是否发言
5. 你获得能力的方式始终是写 TypeScript 代码，不使用 tool calling
6. 你可以使用代码形式的 API / actions / skills 与场景能力行动
7. 若你要探索新平台，可先写实验 adapter，但必须显式声明其实验性质

这会显著减少“为了把生命支持搭起来，先写一堆监听脚本”的上下文浪费。

---

## 18. 目录与文档建议

### 18.1 建议新增或调整的模块

```text
src/
  adapter/
    platform-adapter.ts
    telegram-adapter.ts
    types.ts
  event/
    nc/
      types.ts
      notification-center.ts
  pipeline/
    fast-router.ts
    recording-pipeline.ts
    topic-registry.ts
    reply-pipeline.ts
  skills/
    social/
    memory/
    platform/
  scenes/
    home.d.ts
    telegram.d.ts
    discord.d.ts           # 未来
    memory.d.ts
  memory-v2/
    ...
```

### 18.2 文档建议

建议后续补三份文档：

1. `docs/platform-adapter.md`
2. `docs/nc-event-spec.md`
3. `docs/bootstrap-role.md`

目的：

1. 把 adapter、scene、bootstrap 三者彻底区分清楚
2. 防止后续设计再次回到“bootstrap 托管 ingress”的旧路径

---

## 19. 结论

本次重写后的项目主张非常明确：

1. **CyberGroupmate 的核心抽象不再是“Agent 自己连 Telegram”**
2. **而是“平台通过 adapter 进入 NotificationCenter，框架在 NC 之后统一运行 cognition pipeline，Agent 在其上进行行动与扩展”**

这条路径比旧方案更稳，也更适合长期演进。

它不会削弱 Agent 的创造力，只会把原本不该交给 Agent 托管的基础设施责任，从智能层剥离出来。

从 Phase 6B 开始，项目的主线应围绕这条边界继续推进。
