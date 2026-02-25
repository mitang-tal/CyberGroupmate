# CyberGroupmate 赛博群友

基于 LLM 的 Telegram 社交智能体。终极目标：**让新来的群友一点都看不出这是赛博群友。**

## 架构概览

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
│  ┌──────────────────────────────────────────────────────────┐│
│  │              Code Execution Sandbox                       ││
│  │  Node.js subprocess via tsx（持久化命名空间）               ││
│  │  注入: runtime (notify/spawn/cron), memory, scene         ││
│  └──────────────────────────────────────────────────────────┘│
│         │                                                     │
│         ▼                                                     │
│  ┌──────────────┐    ┌──────────────┐                        │
│  │ Memory Store  │    │ Event Log    │                        │
│  │ (SQLite+FTS5) │    │ (JSONL)      │                        │
│  └──────────────┘    └──────────────┘                        │
└──────────────────────────────────────────────────────────────┘
```

## 快速开始

### 1. 安装

```bash
git clone git@github.com:Archeb/CyberGroupmate.git
cd CyberGroupmate
git checkout agentic
npm install
```

要求 **Node.js ≥ 22**。

### 2. 配置

复制示例配置并填入你的凭据：

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
```

也可以通过**环境变量**配置（优先级高于 config.yaml）：

```bash
# LLM
export LLM_PROVIDER=openai
export LLM_BASE_URL=https://api.openai.com/v1
export LLM_API_KEY=sk-xxxx
export LLM_MODEL=gpt-4o

# Telegram
export TG_API_ID=12345678
export TG_API_HASH=abcdef1234567890
export TG_BOT_TOKEN=123456:ABC-DEF...

# 日志
export LOG_LEVEL=debug       # debug | info | warn | error (默认 info)
export LOG_FORMAT=text       # text | json (默认 text)
```

### 3. 检查配置

```bash
npx tsx src/cli.ts config
```

这会显示：
- LLM 配置（provider、model、API key 是否设置）
- Telegram 环境变量状态
- 数据文件是否存在

### 4. 运行

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

### 5. 运行测试

```bash
npm test                     # 运行全部 73 个测试
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
| `memory todos` | 查看待办事项 |
| `memory sql <SQL>` | 执行原始 SQL 查询 |
| `config` | 检查配置加载结果 |
| `status` | 查看 agent 运行状态和统计 |

**Sandbox REPL 示例：**

```
$ npx tsx src/cli.ts sandbox
sandbox> console.log("hello from sandbox")
hello from sandbox
✔ (15ms)
sandbox> ctx.x = 42
✔ (3ms)
sandbox> console.log(ctx.x)
42
✔ (2ms)
sandbox> .exit
```

## 日志

使用结构化日志，支持两种格式：

**Text 格式**（默认，人类可读）：
```
15:30:45.123 INFO  [main] 🤖 CyberGroupmate starting...
15:30:45.456 INFO  [main] LLM 配置加载完成 provider=openai model=gpt-4o
15:30:46.789 INFO  [main] Sandbox 就绪
15:30:47.012 WARN  [main] 重放失败，回退到 LLM bootstrap error=...
```

**JSON 格式**（机器可解析，适合 `jq`）：
```json
{"ts":"2026-02-25T15:30:45.123Z","level":"info","module":"main","msg":"🤖 CyberGroupmate starting..."}
```

通过环境变量控制：`LOG_LEVEL=debug LOG_FORMAT=json`

## 项目结构

```
src/
├── main.ts                 # Orchestrator（入口）
├── cli.ts                  # CLI 调试工具
├── logger.ts               # 结构化日志
├── notification-center.ts  # 事件队列 + JSONL
├── sandbox.ts              # Sandbox host
├── sandbox-worker.ts       # Sandbox worker（子进程）
├── background-manager.ts   # 后台任务管理
├── memory.ts               # SQLite + FTS5 记忆
├── scene-manager.ts        # 场景管理
├── llm.ts                  # LLM API 封装
├── compaction.ts           # Session 压缩归档
├── safety.ts               # 速率限制 + 安全检查
└── scenes/
    ├── index.ts            # 场景注册表
    ├── home.d.ts           # Home 场景类型
    ├── telegram.d.ts       # Telegram 场景类型
    └── memory.d.ts         # Memory 场景类型

data/                       # 运行时数据（自动创建）
├── memory.db               # SQLite 数据库
├── events.jsonl            # 事件日志
├── agent-state.md          # Agent 状态
├── bootstrap-code.json     # Bootstrap 快照
├── sent-messages.jsonl     # 发送消息审计日志
├── sessions/               # Session transcripts
└── tg-session/             # Telegram session
```

## 开发状态

- [x] Phase 1：基础 Runtime (v0.1.0)
- [x] Phase 2：Agent Loop + LLM 集成 (v0.2.0)
- [x] Phase 3：记忆与人格 (v0.3.0)
- [x] Phase 4：稳定性与工具 (v0.3.0)

## License

Private
