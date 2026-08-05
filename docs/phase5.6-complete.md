# Phase 5.6 — Execution Self-Healing & Self-Diagnosis v1

## 完成时间

2026-07-30

## Commit

```
dcf23f7465b2efe262d5b3d1c72622e4089d4bcd
```

## 目标

将 Execution 从"主动感知系统"升级为"受控的自愈系统"。基于异常类型自动执行轻量级重试、降级策略，或引导 Meta 进行自我诊断。

## 架构

```
Execution Alert (Phase 5.5)
        │
        ▼
  HealingPolicyEngine (策略路由 & 频控)
        │
  ┌─────┴─────┐
  ▼           ▼
 自动恢复策略   Meta Node (自愈决策)
 (重试/降级)   (复杂根因分析 & 修复指令)
  │           │
  └─────┬─────┘
        ▼
  Execution Record / Trace
```

## 修改文件

| 文件 | 变更 |
|------|------|
| `src/execution/execution-record.types.ts` | 新增 `ExecutionHealingAction`, `HealingStrategy`, `HealingActionStatus` 类型 |
| `src/execution/healing-store.ts` | **新文件** — HealingStore 接口：insert, updateStatus, getById, query, countRecentBySource |
| `src/execution/sqlite-healing-store.ts` | **新文件** — SQLite 实现：`execution_healing_actions` 表 |
| `src/execution/healing-policy-engine.ts` | **新文件** — 自愈策略引擎：路由、指数退避重试、Meta 诊断、防爆闸 |
| `src/execution/execution-record-service.ts` | 构造器注入 HealingStore；新增 `triggerSelfHealing()`, `queryHealingActions()`, `getHealingAction()`, `diagnoseExecution()` |
| `src/dashboard/api-routes.ts` | 新增 4 个 `/api/execution-heal/*` 路由 |
| `src/dashboard/public/execution-healing.html` | **新文件** — Self-Healing Dashboard：统计卡片 + 动作列表 + 详情弹窗 |

## 自愈策略

| Alert 类型 | 策略 | 说明 |
|-----------|------|------|
| `EXECUTION_TIMEOUT` | retry | 指数退避重试（1s, 2s, 4s, 8s…上限 30s, 最多 3 次） |
| `CONTINUOUS_FAILURE` | retry | 重试，若失败转为 escalate |
| `ERROR_CLUSTER` | meta_diagnosis | 调用 Meta 诊断接口获取根因分析 |
| `FAILURE_RATE_SPIKE` | meta_diagnosis | 调用 Meta 诊断接口获取根因分析 |

## 安全防爆闸

- **窗口**：10 分钟
- **上限**：同一 executionId 最多 2 次自愈尝试
- **超出**：自动升轨为 `critical` Alert，通知人工介入

## 指数退避重试

```typescript
backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 30_000);
// attempt 1: 1000ms
// attempt 2: 2000ms
// attempt 3: 4000ms
// max: 30000ms
```

## API 端点

| 路由 | 方法 | 说明 |
|------|------|------|
| `POST /api/execution-heal/:alertId/trigger` | 触发自愈 | 返回创建的 `ExecutionHealingAction` |
| `GET /api/execution-heal/actions` | 查询列表 | 支持 alertId/executionId/strategy/status 过滤 |
| `GET /api/execution-heal/actions/:actionId` | 详情 | 单条 healing action |
| `POST /api/execution-heal/diagnose/:alertId` | Meta 诊断 | 返回根因 + 修复建议 + 关联 Action |

## Dashboard 功能

- 统计卡片：Total Actions, Succeeded, Failed, Success Rate
- 自愈动作列表：Strategy 彩色标签, Status 图标, Alert ID, Decision, Attempts, Time
- 详情弹窗：Strategy, Status, Alert ID, Execution ID, Decision Reason, Error, Action Details

## 验收标准

| 标准 | 状态 |
|------|------|
| 瞬态重试：超时可触发指数退避重试 | ✅ `HealingPolicyEngine.applyRetry()` 带退避循环 |
| 防爆闸：连续失败达上限后升轨 critical | ✅ `guardrailCheck()` + escalate |
| Meta 诊断：输出根因与可操作修复建议 | ✅ `diagnoseExecution()` + `applyMetaDiagnosis()` |
| 前端闭环：Dashboard 可查看自愈动作日志 | ✅ `execution-healing.html` |

## 已知问题

1. **applyRetry 模拟重试**：当前 `applyRetry()` 的重试逻辑是新创建一个 `start/markRunning/complete` 序列，实际重试执行原操作需要接入具体的 handler（sandbox.execute / host_call 等），这部分在 Phase 6 中完成。
2. **Meta 诊断为模拟输出**：当前 `applyMetaDiagnosis()` 的 rootCause 和 recommendedAction 是基于规则模板生成。真正的 Meta LLM 集成在后续 Phase 中完成。
3. **HealingStore 初始化**：需要将 `SqliteHealingStore` 实例化并注入 `ExecutionRecordService` 构造器。如果 heuristic store 未传入，自愈功能自动跳过。

## 回滚指南

```bash
git revert dcf23f7465b2efe262d5b3d1c72622e4089d4bcd
```
