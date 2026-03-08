# CyberGroupmate

一个基于 CodeAct 的社交 Agent。目标不是做“会回消息的 bot”，而是做一个真正能在群聊里长期观察、记忆、决策、行动的赛博群友。

当前主线架构已经切换为：

`PlatformAdapter -> NotificationCenter -> FastRouter / RecordingPipeline / Memory -> ReplyPipeline -> CodeAct Agent`

重点变化：

- Telegram 连接和消息监听现在由宿主侧官方 `TelegramAdapter` 接管
- Agent 不再在 bootstrap 里自己连接 Telegram、自己挂 listener
- bootstrap 只负责理解系统、加载文档、做幂等初始化
- 所有能力继续坚持 code-first：不用 tool calling，Agent 通过代码接口、`actions.*`、`skills.*` 行动

## 当前状态

- `Phase 1-5`：已完成
- `Phase 6A`：已完成
- `Phase 6B`：主运行链已接通
- Telegram ingress：已从 bootstrap 迁出，走官方 adapter
- Reply / Memory / Feedback 闭环：已接通并有测试覆盖

如果你想看详细设计，读 [Implementation_Plan.md](/mnt/g/Projects/CyberGroupmate/Implementation_Plan.md)。

## 核心心智模型

- `scene` 像手机里的 app
- `NotificationCenter` 像手机通知中心
- Telegram/未来的 Discord 都应该先进入 NC，再由框架统一消费
- Agent 主要掌握“怎么理解、怎么检索、怎么回复、怎么写代码扩展自己”

## 架构概览

```text
Telegram / Future IM
        │
        ▼
PlatformAdapter
  - connect/login
  - receive messages
  - normalize to nc.message
  - expose host-backed ctx APIs
        │
        ▼
NotificationCenter
  - append-only events.jsonl
  - queue / drain / urgency
        │
        ▼
FastRouter
  - FAST_PATH
  - ENGAGED
  - RECORDING
        │
        ├── EngagedTopicHandler
        ├── RecordingPipeline
        │     - topic clustering
        │     - summary + triage
        │     - TopicRegistry
        │     - Memory V2 writes
        │
        ▼
ReplyPipeline
  - build ReplyTask
  - inject topic / recall / route context
        │
        ▼
CodeAct Session
  - sandbox
  - actions.*
  - memory.*
  - skills.*
  - ctx.tg host proxy
        │
        ▼
FeedbackLoop
```

## 环境要求

- Node.js `>= 22`
- npm
- Telegram 凭据
- 一个可用的 LLM API 配置

## 安装

```bash
git clone git@github.com:Archeb/CyberGroupmate.git
cd CyberGroupmate
npm install
```

## 配置

先复制配置：

```bash
cp config.example.yaml config.yaml
```

然后至少准备这些值：

```bash
export TG_MODE=bot
export TG_API_ID=12345678
export TG_API_HASH=abcdef1234567890
export TG_BOT_TOKEN=123456:ABCDEF

# 或 userbot 模式
# export TG_MODE=userbot
# export TG_PHONE=+8613xxxxxxxxx
```

LLM 也可以写进 `config.yaml`，或者用环境变量覆盖。当前配置读取优先级是：

`env > config.yaml > defaults`

检查配置：

```bash
npx tsx src/cli.ts config
```

## 启动

```bash
npm start
```

或者：

```bash
npx tsx src/main.ts
```

推荐调试方式：

```bash
LOG_LEVEL=debug npm start
```

你应该看到这些关键现象：

1. `TelegramAdapter` 启动成功
2. sandbox 启动成功
3. bootstrap 运行，但不会要求 Agent 自己连接 Telegram
4. 后续 Telegram 消息会直接进入 `NotificationCenter`

## 人工验证

下面这套流程是当前最重要的手动验收路径。

### A. 验证 Telegram ingress 不依赖 bootstrap

1. 启动进程：`LOG_LEVEL=debug npm start`
2. 观察日志里是否出现 `TelegramAdapter` 启动成功
3. 让另一个 Telegram 账号向 bot / userbot 所在会话发一条消息
4. 观察日志和 `workspace/events.jsonl`

预期：

- 即使 Agent bootstrap 还没做任何平台连接代码，消息也会被记录进 [events.jsonl](/mnt/g/Projects/CyberGroupmate/workspace/events.jsonl)
- 事件类型应该是 `nc.message`
- Agent 不需要 `runtime.spawn("tg-listener", ...)`

可辅助执行：

```bash
npx tsx src/cli.ts drain
```

### B. 验证 ReplyPipeline -> Agent -> Telegram 发送链

1. 用另一个账号发一条明确需要回应的消息
2. 观察日志中是否出现：
   - `FAST_PATH`
   - 或 `话题通过 Triage`
   - 或 `对话模式就绪`
3. 观察 Agent 是否进入 session 并调用 `ctx.tg` / `skills.social.replyInTelegram`
4. 观察新事件：
   - `system.agent_message_sent`
   - 之后的 `system.feedback_evaluated`

预期：

- Agent 发送消息时，不需要自己创建 Telegram client
- 发送通过宿主侧 `ctx.tg` host proxy 完成
- 发言后反馈会进入 `FeedbackLoop`

### C. 验证 Memory V2 在写入

启动后跑一段真实消息流，或者先做 dry-run：

```bash
npx tsx src/cli.ts memory status
```

预期：

- `topics`
- `messages`
- `persons`
- `profiles`

这些计数会增长。

也可以直接看数据库：

- [memory.db](/mnt/g/Projects/CyberGroupmate/workspace/memory.db)

关键表：

- `topics`
- `message_log`
- `person_identities`
- `person_group_profiles`
- `group_models`

### D. 验证 bootstrap 已经降责

看这些文件：

- [bootstrap-prompt.md](/mnt/g/Projects/CyberGroupmate/workspace/agent-docs/bootstrap-prompt.md)
- [system-prompt.md](/mnt/g/Projects/CyberGroupmate/workspace/agent-docs/system-prompt.md)
- [telegram.md](/mnt/g/Projects/CyberGroupmate/workspace/agent-docs/telegram.md)

预期：

- 不再要求 Agent “连接 Telegram”
- 不再要求 Agent “自己设置监听”
- 文档明确说明 `ctx.tg` 是系统注入的 host proxy

## CLI

```bash
npx tsx src/cli.ts <command>
```

常用命令：

- `config`：检查配置解析结果
- `status`：查看运行状态
- `drain`：读取并清空当前 NC 队列
- `notify [type] [text]`：手动推送通知
- `memory status`：看 Memory V2 统计
- `memory recall <关键词>`：检索记忆
- `memory browse <意图>`：浏览历史消息
- `memory reflect --chat <id>`：手动触发 Reflection
- `dry-run <history.jsonl>`：历史回放
- `sandbox`：进入交互式 sandbox

## Dry-Run

如果你不想直接用真实 Telegram 流量，可以先用历史消息回放。

```bash
npx tsx src/cli.ts dry-run chat_history.jsonl --days 0 --reflect
```

输入格式示例：

```json
{"id":"1","chat_id":"-10012345","user_id":"100","user_name":"Alice","text":"有人知道怎么配吗","date":"2026-03-01T10:00:00Z"}
```

注意：现在系统内部 canonical `chatId/userId/messageId` 都按字符串处理。

## 测试

运行全部测试：

```bash
npm test
```

如果只想跑当前主链相关：

```bash
npx tsx --test \
  tests/sandbox.test.ts \
  tests/scene-manager.test.ts \
  tests/phase6-chain.test.ts \
  tests/reply-pipeline.test.ts \
  tests/feedback-loop.test.ts \
  tests/nc-event.test.ts \
  tests/memory-v2.test.ts \
  tests/notification-center.test.ts
```

其中最重要的是：

- [phase6-chain.test.ts](/mnt/g/Projects/CyberGroupmate/tests/phase6-chain.test.ts)
  - 覆盖 `ReplyTask -> runCodeActSession -> sandbox -> host-call -> Telegram send -> NC 回写`
- [sandbox.test.ts](/mnt/g/Projects/CyberGroupmate/tests/sandbox.test.ts)
  - 覆盖 host-backed `ctx.tg` proxy

## 关键文件

- [main.ts](/mnt/g/Projects/CyberGroupmate/src/main.ts)
  - 系统入口，启动 adapter / sandbox / pipeline / main loop
- [telegram-adapter.ts](/mnt/g/Projects/CyberGroupmate/src/adapter/telegram-adapter.ts)
  - 官方 Telegram ingress adapter
- [notification-center.ts](/mnt/g/Projects/CyberGroupmate/src/event/notification-center.ts)
  - 统一通知中心
- [fast-router.ts](/mnt/g/Projects/CyberGroupmate/src/pipeline/fast-router.ts)
  - FAST_PATH / ENGAGED / RECORDING 路由
- [recording-pipeline.ts](/mnt/g/Projects/CyberGroupmate/src/pipeline/recording-pipeline.ts)
  - 话题聚类、Triage、记忆落盘
- [reply-pipeline.ts](/mnt/g/Projects/CyberGroupmate/src/pipeline/reply-pipeline.ts)
  - Agent-Memory bridge
- [memory-v2.ts](/mnt/g/Projects/CyberGroupmate/src/memory-v2/memory-v2.ts)
  - SQLite 记忆存储
- [sandbox-worker.ts](/mnt/g/Projects/CyberGroupmate/src/sandbox/sandbox-worker.ts)
  - sandbox 里的 code-first 运行面

## 当前限制

- 当前只有 Telegram 官方 adapter，Discord 仍未实现
- Telegram host proxy 目前只暴露了主链需要的常用方法，不是完整 mtcute 全量镜像
- bootstrap 仍然存在，但已经不承担 canonical ingress 责任

## 结论

如果你只关心“现在系统是不是已经从旧 bootstrap listener 方案切走了”，答案是：**是**。

现在正确的验证标准不是“Agent 能不能自己写出 Telegram 监听代码”，而是：

1. 平台消息是否先进入官方 adapter
2. `NotificationCenter` 是否成为统一入口
3. Agent 是否只通过代码接口理解、检索、回复
4. Reply / Memory / Feedback 闭环是否能真实跑通

当前 README 就是按这条验收线组织的。  
