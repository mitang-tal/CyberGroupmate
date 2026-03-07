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

然后编辑 `config.yaml`

也可以通过**环境变量**覆盖部分设置（优先级：环境变量 > config.yaml > 默认值）：

```bash、

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
| `memory recall <关键词>` | 搜索记忆（话题 + 事实，支持向量语义检索） |
| `memory browse <意图描述>` | 浏览历史消息（LLM 意图解析 + 深度阅读） |
| `memory reflect --chat <id>` | 手动触发 Reflection（反思总结） |
| `memory status` | 查看 Memory V2 统计（话题/事实/消息/用户数） |
| `config` | 检查配置加载结果 |
| `status` | 查看 agent 运行状态和统计 |
| `dry-run <history.jsonl>` | 在历史聊天记录上回放评估 agent 行为 |

### Dry-Run 历史回放

Dry-Run 系统可以在历史消息上模拟 agent 的决策流程，同时将消息写入 Memory V2 数据库，用于评估和调优。

```bash
# 基本用法（含 Memory 写入）
npx tsx src/cli.ts dry-run chat_history.jsonl

# 指定群组和天数
npx tsx src/cli.ts dry-run chat_history.jsonl --chat-id -10012345 --days 7

# 处理完后触发 Reflection（反思总结）
npx tsx src/cli.ts dry-run chat_history.jsonl --days 0 --reflect

# 自定义 Memory 数据库路径
npx tsx src/cli.ts dry-run chat_history.jsonl --memory-db workspace/test-memory.db
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
│   ├── types.ts                 # V2 类型定义（三层记忆模型）
│   ├── memory-v2.ts             # SQLite CRUD + recall + browseHistory
│   ├── reflection.ts            # Reflection Skill 引擎（反思 + 情感合并）
│   ├── context-manager.ts       # 智能上下文 Compaction
│   ├── embedding.ts             # 向量嵌入（纯 JS hash + OpenAI API）
│   ├── query-builder.ts         # SafeUpdateBuilder / SafeSelectBuilder
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

system-prompts/                  # 外部化 LLM Prompt 模板
├── reflection-system.md         # Reflection 系统提示
├── compaction-system.md         # Compaction 系统提示
├── context-compaction.md        # Context Briefing 生成提示
├── merge-episodes-system.md     # 情感合并系统提示
├── browse-intent-parse.md       # 历史检索意图解析
├── browse-deep-read.md          # 深度阅读提示
├── recall-deep-summary.md       # recall 深度总结提示
└── ...                          # 其他模板

scripts/                         # 工具脚本
└── bootstrap-memory-db.ts       # 预填充 memory.db（测试用）

tests/                           # 测试（node:test + assert/strict）
├── memory-v2.test.ts            # Memory V2 CRUD 测试 (34 cases)
├── context-manager.test.ts      # Context Compaction 测试 (31 cases)
├── reflection.test.ts           # Reflection 引擎测试
├── embedding.test.ts            # 向量嵌入测试
├── vector-search.test.ts        # 向量搜索测试
├── query-builder.test.ts        # SQL Builder 测试
├── sandbox.test.ts              # Sandbox 测试
├── notification-center.test.ts  # NC 测试
├── ...                          # 其他测试
└── helpers/test-db.ts           # 共享测试基础设施

workspace/                       # 运行时数据（自动创建，gitignore）
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
- [x] Memory V2 M1-M4：完整记忆系统
  - M1: SQLite 数据层（7 表 + FTS5）
  - M2: Reflection Skill + 情感合并 + 审计修复
  - M3: 智能 Context Compaction（token budget + 话题感知压缩）
  - M4: 向量搜索 + Deep Recall + browseHistory 深度阅读
- [ ] Phase 6B：Reply Pipeline + Feedback Loop
- [ ] Phase 7：知识蒸馏 + 成本控制

## License

Private

