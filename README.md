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

核心理念来自 CodeAct（Wang et al., 2024）：LLM 直接写 TypeScript 代码来执行所有动作。代码天然支持控制流和数据流，错误信息是自动的反馈机制。

## 技术栈

| 组件 | 选型 |
|------|------|
| 语言 | TypeScript |
| Runtime | Node.js ≥22 + tsx |
| Telegram 客户端 | @mtcute/node |
| LLM | Claude Sonnet 4 / GPT-4o（可配置） |
| 记忆存储 | SQLite (better-sqlite3) + FTS5 |
| 事件日志 | Append-only JSONL |

## 快速开始

### 环境要求

- Node.js ≥ 22
- npm

### 安装

```bash
git clone git@github.com:Archeb/CyberGroupmate.git
cd CyberGroupmate
git checkout agentic
npm install
```

### 运行时数据目录

程序启动时会自动创建 `data/` 目录及子目录：

```
data/
├── tg-session/         # Telegram session 文件
├── memory.db           # SQLite 记忆数据库
├── events.jsonl        # 事件日志
├── agent-state.md      # Agent 当前状态
├── bootstrap-code.json # Bootstrap 代码快照
└── sessions/           # Session transcript 目录
```

### 启动

```bash
npm start        # 启动 agent
npm run dev      # 开发模式（watch）
npm test         # 运行测试
```

### CLI 工具

```bash
npx tsx src/cli.ts events --tail 20        # 查看最近事件
npx tsx src/cli.ts sessions --last 5       # 查看最近 session
npx tsx src/cli.ts state                   # 查看 agent 当前状态
npx tsx src/cli.ts ps                      # 查看后台任务
npx tsx src/cli.ts person @username        # 查看某人画像
npx tsx src/cli.ts memory search "关键词"  # 搜索记忆
```

## 项目结构

```
src/
├── main.ts                     # Orchestrator / Agent Main Loop
├── notification-center.ts      # 事件队列
├── sandbox.ts                  # Sandbox host 侧管理
├── sandbox-worker.ts           # Sandbox worker 进程（子进程运行）
├── background-manager.ts       # 后台任务管理
├── memory.ts                   # SQLite 记忆存储
├── scene-manager.ts            # 场景管理
├── llm.ts                      # LLM API 封装
├── compaction.ts               # Session 压缩
├── cli.ts                      # CLI 工具
└── scenes/                     # 场景定义
    ├── index.ts                # 场景注册表
    ├── home.d.ts
    ├── telegram.d.ts
    ├── telegram.full.d.ts      # L2 完整类型
    └── memory.d.ts
```

## 开发状态

- [x] Phase 1：基础 Runtime (v0.1.0)
- [x] Phase 2：Agent Loop + LLM 集成 (v0.2.0)
- [x] Phase 3：记忆与人格 (v0.3.0)
- [x] Phase 4：稳定性与工具 (v0.3.0, CLI 待实现)

## License

Private
