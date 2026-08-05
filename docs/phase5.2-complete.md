# Phase 5.2 — Execution Lifecycle v1

## 完成时间

2026-07-30

## Commit

```
6d24826bf0657b9e294b105e89a2fb7b417b6528
```

## 目标

将 Execution Record 从 terminal-only（执行结束后才写入）升级为生命周期记录：

```
pending → running → success / failure / interrupted / timed_out / policy_denied
```

## 修改文件

| 文件 | 变更 |
|------|------|
| `src/execution/execution-record.types.ts` | `ExecutionStatus` 扩展为 7 个状态；`ExecutionRecord` 新增 parentId, sequence, timeoutMs, startedAtMs, completedAtMs |
| `src/execution/execution-record-store.ts` | 接口新增 `update()`, `getById()`, `queryActive()` |
| `src/execution/sqlite-execution-record-store.ts` | 表新增 parent_id, sequence, timeout_ms, started_at_ms, completed_at_ms 列；实现新增方法；提取 `mapRow()` |
| `src/execution/execution-record-service.ts` | 新增 `start()`, `markRunning()`, `complete()`, `transition()`, `getById()`, `getActive()`；保留旧 record/recordHostCall/recordAgentTurn/recordSandboxExecution 兼容方法 |
| `src/sandbox/sandbox.ts` | `execute()` 中调用 `start()` 创建 pending 记录；`handleWorkerMessage()` 中调用 `markRunning()` + `complete()`；超时路径调用 `complete(id, "timed_out")`；修复重复 `pending.resolve()` bug |
| `src/sandbox/host-call-handler.ts` | 每个 host call 先 `start()`，成功后 `markRunning()` + `complete("success")`，异常时 `complete("failure"/"policy_denied")` |
| `src/subagent/code-act-executor.ts` | agent turn 开始时 `start()`，成功后 `markRunning()` + `complete()`，catch 中 `complete()` |
| `src/dashboard/api-routes.ts` | 新增 `GET /api/execution-records/active` 和 `GET /api/execution-records/:id` 路由 |
| `src/dashboard/public/execution-records.html` | 状态筛选新增 pending/running/timed_out；pending/running/timed_out 状态显示图标 |

## State Machine

```
pending
  ├──→ running ──→ success
  │              ├──→ failure
  │              ├──→ interrupted
  │              └──→ timed_out
  └──→ policy_denied
```

非法转换仅在服务端 warn 日志中记录，不抛异常。

## 未实现（留给 Phase 5.3+）

- statusHistory（状态变更历史）
- retry workflow（重试机制）
- cascade cancel（级联取消子执行）
- workflow engine（工作流引擎）
- system prompt 修改
- VPS 配置修改
- status 变更事件通知

## 已知问题

1. **sandbox.ts 时序**：`markRunning()` 和 `complete()` 在 worker 回复时几乎同时调用，中间无实际间隔。如果后续需要 "正在运行中" 的可观察性，需在 worker 端加 heartbeat 或任务开始通知。
2. **host-call-handler 的 `start()` 在 policy guard 之前**：即使快速拒绝（之前已被 deny），也会先创建一条 pending 记录再立即 complete("policy_denied")。这会产生一些无意义的短生命周期记录，但保证了每条执行都有完整生命周期。
3. **code-act-executor agent turn 的 `markRunning()` 在成功后**：当前设计是执行完成后一次性调用 `markRunning()` + `complete()`，因为无法精确获知 sandbox 何时真正开始处理。`startedAtMs` 实际反映的是 agent turn 的开始到结束，而非 sandbox 运行时间。
4. **旧兼容方法（record/recordHostCall/recordAgentTurn/recordSandboxExecution）** 仍然存在且未改造成生命周期模式，新旧 API 并存。后续可逐步迁移。

## 回滚指南

```bash
git revert 6d24826bf0657b9e294b105e89a2fb7b417b6528
```

恢复后需重新初始化 SQLite 数据库（新增列会保留，但代码不再使用）。
