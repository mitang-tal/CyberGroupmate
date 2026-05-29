# Background Agent 实施计划

> 基于 RFC `docs/background-agent.md`，结合现有代码基础设施制定。

---

## 现有基础设施

实施前先摸清楚我们已经有什么，避免重复造轮子：

| 组件 | 现状 | 位置 |
|---|---|---|
| Meta API（dispatch/todo/memory/agents/cron） | ✅ 已有完整实现 | `src/meta-sandbox/meta-api/` |
| BackgroundManager（进程生命周期） | ✅ 已有，支持 spawn/kill/persist | `src/sandbox/background-manager.ts` |
| Proactive Idle 触发逻辑 | ✅ 已有，可 hook | `src/main-agent/main-agent-loop.ts:249-264` |
| Reflection 执行 + 输出 | ✅ 已有，可在输出阶段追加逻辑 | `src/memory-v2/reflection.ts:586-614` |
| GlobalState 持久化 | ✅ 已有 | `src/main-agent/global-state.ts` |
| MCP Client（连接外部 MCP server） | ✅ 已有 | `src/sandbox/modules/mcp-bridge/` |
| **MCP Server（暴露内部 API）** | ❌ 不存在，需要新建 | — |
| **HarnessManager（外部 harness 管理）** | ❌ 不存在，需要新建 | — |
| **notify 工具** | ❌ 不存在，需要扩展 dispatch | — |

---

## Phase 0: notify 工具

**目标**：将现有 dispatch 语义扩展为 notify，支持双向通信。

**改动点**：
- `src/meta-sandbox/meta-api/dispatch.ts` — 扩展 `taskToGroup` 或新增 `notify` 方法
  - 支持 `to: "meta" | bindingId`
  - 当 `to: "meta"` 时，写入 GlobalState 的一个新字段（如 `backgroundNotifications`）供 Meta 下次 turn 读取
- 更新 Meta Agent 的 tool definitions，将 dispatch 重命名/别名为 notify
- Subagent 侧兼容（现有 dispatch 调用方式不变，只是多了一个入口名）

**预计工作量**：1-2 天

**验证**：Meta Agent 能通过 notify 给某个 bindingId 塞任务，subagent 收到并执行。

---

## Phase 1: MCP Server

**目标**：将 Meta API 包装成 MCP Server，让外部 harness 通过 MCP 协议访问 Core 能力。

**这是整个实施的关键路径。** Background Agent 的所有能力都依赖于此。

### 新建 `src/mcp-server/`

```
src/mcp-server/
├─ index.ts           — MCP server 入口，注册所有 tools
├─ transport.ts       — Streamable HTTP transport（外部 harness 通过 HTTP 连接）
├─ tools/
│   ├─ conversation.ts  — getDigest, getHistory
│   ├─ memory.ts        — query, write, update, delete
│   ├─ agents.ts        — list, getState
│   ├─ notify.ts        — notify(to, content, artifacts)
│   ├─ skills.ts        — list, reload
│   ├─ todo.ts          — list, create, update, delete
│   ├─ cron.ts          — list, create, update, delete
│   └─ platform.ts      — 改头像/bio/发动态等平台操作
└─ auth.ts            — 简单的 token 认证（防止未授权访问）
```

### 实现策略

- 每个 tool 文件是一个薄包装层，内部直接调用已有的 Meta API（`createDispatchApi`、`createTodoApi` 等）
- 不需要重新实现业务逻辑，只做 MCP tool schema 定义 + 参数转换
- 安全边界在这里实现：不暴露发消息、删消息、踢人等 API

### 安全边界实现

在 MCP server 注册 tools 时，直接**不注册**被屏蔽的操作：
- 不注册：sendMessage、deleteMessage、kickUser、banUser、changeGroupSettings
- 不注册：editFile（限定路径：SOUL.md、system-prompts/、src/、.env）
- 注册但做路径校验：file write 只允许 workspace/ 下

### Transport

- 使用 Streamable HTTP（Claude Code 和 Copilot CLI 都支持）
- 监听本地端口（如 `localhost:3100/mcp`）
- Token 认证：启动时生成随机 token，传给 harness 启动参数

### 启动方式

MCP server 随 CyberGroupmate 主进程启动，作为内嵌服务：

```typescript
// src/main.ts 中追加
import { startMcpServer } from './mcp-server';
const mcpServer = await startMcpServer({
  port: config.backgroundAgent?.mcpPort ?? 3100,
  metaApi: buildMetaApiContext(deps),
  authToken: generateToken()
});
```

**预计工作量**：3-5 天

**验证**：用 Claude Code 手动连接 MCP server，调通 getDigest、notify、skills.list。

---

## Phase 2: HarnessManager

**目标**：管理 Background Agent 外部进程的生命周期。

### 新建 `src/harness/`

```
src/harness/
├─ manager.ts         — HarnessManager 类
├─ launchers/
│   ├─ claude-code.ts — Claude Code 启动逻辑
│   └─ copilot-cli.ts — Copilot CLI 启动逻辑（Phase 4）
├─ types.ts           — 接口定义
└─ prompt.ts          — 固定层 prompt 生成
```

### HarnessManager 核心

```typescript
class HarnessManager {
  private state: { running: boolean; pid?: number; pendingQueue: Notify[] };

  enqueue(notify: Notify): void {
    if (!this.state.running) this.launch();
    else this.state.pendingQueue.push(notify);
  }

  private async launch(): Promise<void> {
    const prompt = buildFixedLayerPrompt(this.config);
    const pending = this.drainQueue();
    const process = await this.launcher.start({ prompt, pending, mcpUrl, authToken });
    this.state = { running: true, pid: process.pid, pendingQueue: [] };
    process.on('exit', () => this.onComplete());
  }

  private onComplete(): void {
    this.state.running = false;
    if (this.state.pendingQueue.length > 0) this.launch();
  }
}
```

### Claude Code Launcher

```typescript
// src/harness/launchers/claude-code.ts
async function start({ prompt, pending, mcpUrl, authToken }): Promise<ChildProcess> {
  const pendingJson = JSON.stringify(pending);
  const fullPrompt = `${prompt}\n\n## 待处理任务\n${pendingJson}`;
  return spawn('claude', [
    '-p', fullPrompt,
    '--mcp-config', generateMcpConfig(mcpUrl, authToken)
  ]);
}
```

### 定时触发（做梦模式）

在 `src/main.ts` 的 scheduler 里注册一个内置 cron：

```typescript
// 凌晨 3 点触发做梦
scheduler.registerBuiltinCron('background-dreaming', config.backgroundAgent?.schedule ?? '0 3 * * *', () => {
  harnessManager.enqueue({ to: 'background', content: 'scheduled-dreaming', type: 'scheduled' });
});
```

**预计工作量**：2-3 天

**验证**：手动调用 `harnessManager.enqueue()`，观察 Claude Code 进程启动、连接 MCP、执行任务、退出。

---

## Phase 3: 系统集成

**目标**：把 HarnessManager 接入 Proactive Idle 和 Reflection。

### 3.1 Proactive Idle 集成

**文件**：`src/main-agent/main-agent-loop.ts`

在 idle 触发逻辑（约 line 251）中，除了注入 idle session 给 Meta Agent，还通知 HarnessManager：

```typescript
if (this.shouldTriggerProactiveIdle(now)) {
  // 现有逻辑：注入 idle session 给 Meta
  this.injectProactiveIdle();
  // 新增：如果 Meta 的 idle turn 产生了 background notify，HarnessManager 会在 notify 时自动触发
}
```

实际上不需要改 idle 触发逻辑本身——Meta Agent 在 idle turn 中如果发现重活，会调 notify，notify 的实现会调 `harnessManager.enqueue()`。只需要确保 notify tool 在 Meta Agent 的 tool list 里。

### 3.2 Proactive Idle Prompt 缩限

**文件**：`system-prompts/meta-agent/proactive-idle.md`

按 RFC 修改"自主进化"部分，加入 notify Background Agent 的指引。

### 3.3 Reflection 集成

**文件**：`src/memory-v2/reflection.ts`

在 Step 6（约 line 586-614，写 agent-state.md 之后）追加：

```typescript
// 让 reflection 的 LLM 输出中包含 background-dreaming 更新建议
// 然后写入 workspace/background-dreaming.md
if (reflectionResult.dreamingUpdate) {
  await fs.writeFile(
    join(process.cwd(), 'workspace', 'background-dreaming.md'),
    reflectionResult.dreamingUpdate
  );
}
```

需要在 reflection prompt 中加入指引（见 RFC §6.4）。

### 3.4 Dream Journal 目录

初始化时确保 `workspace/dream-journal/` 存在。Background Agent 的固定层 prompt 里指引它写日记到这个目录。

**预计工作量**：2-3 天

**验证**：
- 触发 proactive idle → Meta 发现重活 → notify → HarnessManager 拉起 Claude Code → 执行 → 结果通过 notify 回传
- 触发 reflection → workspace/background-dreaming.md 被更新

---

## Phase 4: 第二 Harness + 打磨

**目标**：验证 harness 可替换性，打磨体验。

### 4.1 Copilot CLI Launcher

新建 `src/harness/launchers/copilot-cli.ts`，实现同样的接口。验证 MCP 连通和任务执行。

### 4.2 Prompt 迭代

根据实际运行情况调整：
- 固定层 prompt（`src/harness/prompt.ts`）
- Proactive idle prompt
- Reflection prompt 中的 dreaming 指引

### 4.3 监控 & 日志

- HarnessManager 记录每次实例的启动/结束/耗时/token 用量
- Dream journal 自动生成
- 异常处理：harness 进程崩溃时的恢复逻辑

**预计工作量**：2-3 天

---

## 总览

```
Phase 0: notify 工具                    1-2 天
Phase 1: MCP Server                     3-5 天  ← 关键路径
Phase 2: HarnessManager                 2-3 天
Phase 3: 系统集成（idle/reflection）     2-3 天
Phase 4: 第二 Harness + 打磨            2-3 天
─────────────────────────────────────────────
总计                                    ~10-16 天
```

```
依赖关系：

Phase 0 ──→ Phase 1 ──→ Phase 2 ──→ Phase 3 ──→ Phase 4
(notify)    (MCP Server) (Harness)   (集成)      (打磨)
```

Phase 0 和 Phase 1 可以部分并行（notify 的 API 设计先确定，MCP server 按设计包装）。Phase 2 依赖 Phase 1 完成（harness 需要连 MCP）。Phase 3 依赖 Phase 2。Phase 4 随时可以开始 Copilot CLI 部分。

---

## 里程碑

| 里程碑 | 标志 | 预计 |
|---|---|---|
| M0: notify 可用 | Meta Agent 能通过 notify 通信 | Phase 0 完成 |
| M1: MCP 连通 | Claude Code 能连上 MCP server 并读到 digest | Phase 1 完成 |
| M2: 首次做梦 | Background Agent 被手动拉起，执行一个完整任务并通过 notify 回传结果 | Phase 2 完成 |
| M3: 自动做梦 | 凌晨 3 点自动拉起，第二天早上有成果 | Phase 3 完成 |
| M4: 双 Harness | Claude Code 和 Copilot CLI 都能跑 | Phase 4 完成 |
