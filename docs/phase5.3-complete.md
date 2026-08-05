# Phase 5.3 — Execution Trace v1

## 完成时间

2026-07-30

## Commit

```
d0d1750d60961445b59300e260f88621c04e0126
```

## 目标

将 Execution 从生命周期记录升级为可追踪调用链，回答：

1. 一个 Agent 做了哪些动作？
2. 一个 Tool Call 来自哪个 Agent Turn？
3. 一个失败发生在哪一层？
4. 一个执行耗时在哪里？
5. 整条执行链是什么？

## 架构

```
Execution Tree (runtime-accurate):

Agent Turn  (source=agent, method=agent.turn)
  │
  ├── Sandbox Execution  (source=sandbox, method=sandbox.execute)
  │     └── Host Call    (source=host_call, method=<method>)
  │
  └── Sandbox Execution  (source=sandbox, method=sandbox.execute)
```

## 修改文件

| 文件 | 变更 |
|------|------|
| `src/execution/execution-record.types.ts` | 新增 `ExecutionTreeNode`、`ExecutionTimelineEvent`、`ExecutionTimeline` 类型 |
| `src/execution/execution-record-store.ts` | 接口新增 `getChildren()`、`getExecutionTree()` |
| `src/execution/sqlite-execution-record-store.ts` | 实现 `getChildren()`（按 parent_id 查询）、`getExecutionTree()`（递归构建树，最大深度 10） |
| `src/execution/execution-record-service.ts` | 新增 `getTrace()`（返回根节点完整树）、`getTimeline()`（计算 queueTime/runTime/totalTime）；`complete()` 增加 completeOnce 保护（仅 running/pending 可完成） |
| `src/execution/execution-context.ts` | 新增 `executionId?: string` 字段，用于子执行链式设置 parentId |
| `src/subagent/code-act-executor.ts` | `executeWithSandbox()` 接受 `agentTurnExecutionId`，设置到 sandbox context.executionId |
| `src/sandbox/sandbox.ts` | `execute()` 读取 `executionContext.executionId` 作为 parentId；创建后更新 context.executionId |
| `src/sandbox/host-call-handler.ts` | `start()` 传入 `parentId`（从 `executionContext.executionId`） |
| `src/dashboard/api-routes.ts` | 新增 `GET .../:id/trace` 和 `GET .../:id/timeline` 路由 |
| `src/dashboard/public/execution-records.html` | 新增 Detail Panel：执行信息、Trace Tree（递归树渲染）、Timeline（事件列表 + 可视化时间条 + 耗时统计） |

## 关键实现细节

### 父子链传递

```
CodeActExecutor
  └── setExecutionContext({ executionId: agentTurnExecutionId })
        │
        ├── sandbox.execute()
        │     └── start({ parentId: context.executionId })
        │     └── 更新 context.executionId = sandbox execution ID
        │
        └── host-call-handler
              └── start({ parentId: context.executionId })
```

### completeOnce 保护

`complete()` 仅在 `record.status === "running" || record.status === "pending"` 时执行。如果重复调用（如超时后又收到 worker 回复），第二次调用静默跳过。

### Timeline 计算

- Queue Time: `startedAtMs - createdAtMs`
- Run Time: `completedAtMs - startedAtMs`
- Total Time: `completedAtMs - createdAtMs`

### Trace 树查询

- `getTrace(id)`：如果记录有 parentId，从根节点（root）返回整棵树；否则从自身开始构建
- 最大递归深度 10，防止循环引用

## 完成标准

| 问题 | 可回答 |
|------|--------|
| 一个 Agent 做了哪些动作？ | ✅ 展开 trace tree 可见所有子执行 |
| 一个 Tool Call 来自哪个 Agent Turn？ | ✅ parentId 链可追溯到根 |
| 一个失败发生在哪一层？ | ✅ trace tree 中可见失败位置 |
| 一个执行耗时在哪里？ | ✅ timeline 显示 queue/run/total 各阶段 |
| 整条执行链是什么？ | ✅ trace API 返回完整树 |

## 未实现（留给 Phase 6+）

- statusHistory（状态变更历史）
- retry workflow（重试机制）
- cascade cancel（级联取消）
- workflow engine（工作流引擎）
- 多 Agent 调度追踪
- 自动恢复

## 已知问题

1. **sandbox.ts 时序**：`markRunning()` 和 `complete()` 在 worker 回复时几乎同时调用，中间无实际间隔。trace tree 正确但 `startedAtMs` 接近 `completedAtMs`。
2. **host-call-handler 先 start 后 policy guard**：快速拒绝场景也会创建一条短生命周期记录。保证了生命周期完整性但会产生少量无意义记录。
3. **旧兼容方法仍存在**：`record()`、`recordHostCall()` 等旧 API 未设置 parentId，使用这些方法的记录不在 trace tree 中。

## 回滚指南

```bash
git revert d0d1750d60961445b59300e260f88621c04e0126
```
