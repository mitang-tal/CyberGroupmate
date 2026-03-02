# CyberGroupmate 赛博群友

基于 LLM 的 Telegram 社交智能体。终极目标：**让新来的群友一点都看不出这是赛博群友。**

架构灵感来源于 [CodeAct](https://github.com/xingyaoww/code-act)：Agent 通过写代码与环境交互，而非固定的 tool-call 接口。

## 架构概览

```
  Telegram 消息
       │
       ▼
┌─ NotificationCenter (event/) ──────────────────────────┐
│  JSONL 持久化事件队列 + 跨进程 fs.watch                   │
└───────────────┬────────────────────────────────────────┘
                │ drain()
                ▼
┌─ FastRouter (pipeline/) ───────────────────────────────┐
│  @ / 回复 / 私聊 → FAST_PATH (直接进 CodeAct Session)    │
│  属于 ENGAGED 话题 → EngagedTopicHandler                │
│  其他群消息 → RecordingPipeline 缓冲                     │
└──┬─────────────┬──────────────────────────┬────────────┘
   │             │                          │
   ▼             ▼                          ▼
 CodeAct     Engaged Topic           Recording Pipeline
 Session     Handler                 (50条/2min flush)
 (sandbox/)  (对话模式)               ├── LLM 话题聚类
                                     ├── LLM 摘要+Triage
                                     └── TopicRegistry 更新
```

## 快速开始

### 1. 环境要求

- **Node.js ≥ 22**
- **npm**（随 Node.js 附带）
- Git

### 2. 安装

```bash
git clone git@github.com:Archeb/CyberGroupmate.git
cd CyberGroupmate
git checkout agentic
npm install
```

### 3. 配置

复制示例配置并填入凭据：

```bash
cp config.example.yaml config.yaml
```

编辑 `config.yaml`，至少需要设置：

```yaml
llm:
  provider: openai           # 或 "anthropic"
  base_url: https://api.openai.com/v1
  api_key: sk-xxxx           # 你的 API Key
  model: gpt-4o              # 模型名称

persona:
  name: 赛博群友
  description: 一个混在群里的 AI     # Agent 的人设描述

telegram:
  mode: bot                  # "bot" 或 "userbot"
  bot_token: 123456:ABC-DEF  # Bot Token（bot 模式）
  api_id: "12345678"         # API ID（userbot 模式）
  api_hash: abcdef123456     # API Hash（userbot 模式）
```

也可以通过**环境变量**覆盖（优先级：环境变量 > config.yaml > 默认值）：

```bash
# LLM
export LLM_PROVIDER=openai
export LLM_BASE_URL=https://api.openai.com/v1
export LLM_API_KEY=sk-xxxx
export LLM_MODEL=gpt-4o

# Telegram
export TG_BOT_TOKEN=123456:ABC-DEF...
export TG_API_ID=12345678
export TG_API_HASH=abcdef1234567890

# 日志
export LOG_LEVEL=debug       # debug | info | warn | error (默认 info)
export LOG_FORMAT=text       # text | json (默认 text)
```

### 4. 检查配置

```bash
npx tsx src/cli.ts config
```

输出会显示 LLM 配置、Telegram 状态、数据文件等信息。

### 5. 运行

```bash
# 启动 agent（完整流程：bootstrap → 事件循环）
npm start

# 或直接：
npx tsx src/main.ts

# 开发模式（debug 日志）
LOG_LEVEL=debug npm start

# JSON 格式日志（方便 grep/jq）
LOG_FORMAT=json npm start
```

### 6. 运行测试

```bash
npm test                               # 运行全部测试
npx tsx --test tests/sandbox.test.ts   # 只运行某个测试文件
```

## CLI 调试工具

`npx tsx src/cli.ts <command>` 提供以下子命令：

| 命令 | 说明 |
|------|------|
| `sandbox` | 交互式 Sandbox REPL，直接执行 TypeScript 代码 |
| `notify [type] [text]` | 手动推送一条通知到事件队列 |
| `drain` | 查看并清空当前通知队列 |
| `memory search <关键词>` | 搜索记忆 |
| `memory person <userId>` | 查看群友画像 |
| `memory conversations` | 查看对话摘要 |
| `config` | 检查配置加载结果 |
| `status` | 查看 agent 运行状态和统计 |
| `dry-run <history.jsonl>` | 在历史聊天记录上回放评估 agent 行为 |

### Dry-Run 历史回放

Dry-Run 系统可以在历史消息上模拟 agent 的决策流程，用于评估和调优。

```bash
# 基本用法
npx tsx src/cli.ts dry-run chat_history.jsonl

# 指定群组和天数
npx tsx src/cli.ts dry-run chat_history.jsonl --chat-id -10012345 --days 7
```

输入文件格式（JSONL，每行一个 JSON）：

```json
{"id": 1, "chat_id": -10012345, "user_id": 100, "user_name": "Alice", "text": "有人知道怎么...", "date": "2026-03-01T10:00:00Z"}
```

## 日志

使用结构化日志，支持两种格式：

**Text 格式**（默认，人类可读）：
```
15:30:45.123 INFO  [main] 🤖 CyberGroupmate starting...
15:30:46.789 INFO  [main] 组件初始化完成（含 Phase 6 管线）
15:30:47.012 INFO  [fast-router] FAST_PATH msgId=123 reason=direct_mention
```

**JSON 格式**（机器可解析）：
```json
{"ts":"2026-03-02T15:30:45.123Z","level":"info","module":"main","msg":"🤖 CyberGroupmate starting..."}
```

通过环境变量控制：`LOG_LEVEL=debug LOG_FORMAT=json`

## 项目结构

```
src/
├── main.ts                      # 主入口（Orchestrator）
├── cli.ts                       # CLI 调试工具入口
│
├── core/                        # 核心基础设施（无业务逻辑）
│   ├── config.ts                # 配置管理 (config.yaml + env)
│   ├── logger.ts                # 结构化日志
│   ├── llm.ts                   # LLM API 调用 (OpenAI + Anthropic)
│   └── safety.ts                # 速率限制 + 安全检查
│
├── sandbox/                     # 代码执行沙箱
│   ├── sandbox.ts               # Sandbox 主控（进程管理）
│   ├── sandbox-worker.ts        # Worker 子进程（代码执行环境）
│   ├── background-manager.ts    # Agent 后台任务管理
│   └── session-runner.ts        # CodeAct Session Runner
│
├── event/                       # 事件系统
│   ├── notification-center.ts   # 事件队列 + JSONL 持久化
│   └── compaction.ts            # Session 压缩归档
│
├── pipeline/                    # 消息处理管线 (Phase 6)
│   ├── types.ts                 # 共享类型定义
│   ├── topic-registry.ts        # 话题注册表 + 状态机
│   ├── recording-pipeline.ts    # 后台话题提取 + Triage
│   ├── fast-router.ts           # 消息快速路由
│   ├── engaged-topic-handler.ts # 对话模式处理器
│   ├── model-router.ts          # 模型 + Pipeline 模式路由
│   ├── dry-run.ts               # 历史回放评估
│   └── index.ts                 # 统一导出
│
├── memory-v2/                   # 记忆系统 V2
│   ├── types.ts                 # V2 类型定义
│   ├── memory-v2.ts             # V2 Stub 实现
│   └── index.ts                 # 统一导出
│
├── scenes/                      # 场景系统
│   ├── scene-manager.ts         # 场景管理器
│   ├── index.ts                 # 内置场景注册
│   ├── home.d.ts                # Home 场景类型
│   ├── telegram.d.ts            # Telegram 场景类型
│   └── memory.d.ts              # Memory 场景类型
│
└── agent/                       # Agent 辅助工具
    └── docs.ts                  # Agent 文档系统

tests/                           # 测试
workspace/                       # 运行时数据（自动创建）
├── memory.db                    # SQLite 数据库
├── events.jsonl                 # 事件日志
├── agent-state.md               # Agent 状态
├── bootstrap-code.json          # Bootstrap 快照
├── sent-messages.jsonl          # 发送消息审计日志
├── sessions/                    # Session transcripts
└── tg-session/                  # Telegram session
```

## 开发状态

- [x] Phase 1：基础 Runtime (v0.1.0)
- [x] Phase 2：Agent Loop + LLM 集成 (v0.2.0)
- [x] Phase 3：记忆与人格 (v0.3.0)
- [x] Phase 4：稳定性与工具 (v0.4.0)
- [x] Phase 5：场景系统 (v0.5.0)
- [x] Phase 6A：消息处理管线 + Memory V2 Stub (v0.6.0)
  - Memory V2 Stub 迁移（read-empty / write-discard）
  - Air-Reading Engine（TopicRegistry 状态机 + FastRouter）
  - Engaged Topic Handler（对话模式 + 退出机制）
  - Recording Pipeline（话题提取 + Triage）
  - Model Router + Dry-Run System
- [ ] Phase 6B：Reply Pipeline + Feedback Loop
- [ ] Phase 7：知识蒸馏 + 成本控制

## License

Private
