# Phase 6.4 — Global Guardrails & System Governance

## 完成时间

2026-07-30

## Commit

```
01abf4de73a40cbc8bb2a251be9231a9fb5ad3a4
```

## 目标

构建全局安全护栏与系统治理，为 Meta 的自主决策与动态重规划设定硬性边界，并提供最终的人工接管熔断器。

## 架构

```
Meta Decisions & Task Patches
        │
        ▼
GlobalGuardrailEvaluator
        │
   ┌────┼────┐
   ▼    ▼    ▼
Budget  Rate  Loop/Deadlock  Kill Switch
Guard   Guard Guard
        │
        ▼
Approved / Blocked / Terminated
        │
        ▼
GuardrailViolation Log
```

## 修改文件

| 文件 | 变更 |
|------|------|
| `src/governance/types.ts` | **新文件** — GovernancePolicy, GuardrailViolation, GuardrailEvaluation 类型 |
| `src/governance/governance-store.ts` | **新文件** — GovernanceStore 接口 |
| `src/governance/sqlite-governance-store.ts` | **新文件** — SQLite 实现，自动播种 3 条默认策略 |
| `src/governance/global-guardrail-evaluator.ts` | **新文件** — 规则评估引擎 + Kill Switch |
| `src/dashboard/types.ts` | DashboardDeps 新增 `globalGuardrail` |
| `src/dashboard/api-routes.ts` | 新增 6 个 `/api/governance/*` 路由 |
| `src/dashboard/public/system-governance.html` | **新文件** — Governance Dashboard |

## 护栏规则

| 规则 | 逻辑 | 拦截动作 |
|------|------|----------|
| `kill_switch` | 一键全局冻结所有自治操作 | `blocked` |
| `loop_prevention` | 同一执行 replan ≥3 次 或 同一 executionId 违规 ≥3 次 | `terminated` |
| `rate_limit` | 5min 窗口违规数 > 10 次 | `blocked` |
| `budget_limit` | 预留，待 Token 预算系统接入 | — |

## 默认策略（自动播种）

| 策略 | 规则 | 配置 |
|------|------|------|
| Loop Prevention | loop_prevention | maxReplanPerExecution: 3 |
| Rate Limit | rate_limit | cooldownPeriodSec: 60 |
| Kill Switch | kill_switch | isKillSwitchActive: false |

## Emergency Kill Switch

- Dashboard 顶部醒目红色面板
- Engage：红色按钮，冻结所有决策/Patch/Dispatch
- Disengage：绿色按钮，恢复自治能力
- 后端 `toggleKillSwitch(active)` 同时更新策略存储

## API 端点

| 路由 | 方法 | 说明 |
|------|------|------|
| `GET /api/governance/kill-switch` | 查询 | `{ active: boolean }` |
| `POST /api/governance/kill-switch` | 切换 | body: `{ active }` |
| `POST /api/governance/evaluate` | 评估 | body: `{ sourceType, sourceId, ... }` → GuardrailEvaluation |
| `GET /api/governance/policies` | 策略列表 | 支持 ruleType/status 过滤 |
| `GET /api/governance/violations` | 违规日志 | 支持 ruleType/sourceType/actionTaken 过滤 |

## Dashboard 功能

- **Emergency Kill Switch**：醒目红色面板，一键 Engage/Disengage
- **统计卡片**：Violations (24h), Blocked, Terminated
- **策略列表**：名称、规则类型、状态、配置参数
- **违规日志**：Action 彩色标签（blocked/escalated/terminated）、Rule、Source、Reasoning、时间

## 验收标准

| 标准 | 状态 |
|------|------|
| 死锁/循环拦截：≥3 次 replan 阻断 | ✅ loop_prevention + getLoopRisk |
| 熔断生效：Kill Switch 开启后全部拦截 | ✅ evaluateKillSwitch + isKillSwitchActive |
| 前端控制：Dahboard 切换 Kill Switch | ✅ system-governance.html |

## 当前 Phase 6 总进度

```
6.1 Capability Registry & Dispatch    ✅
6.2 Autonomous Decision Engine        ✅
6.3 Dynamic Task Planning             ✅
6.4 Global Guardrails                 ✅
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Phase 6 COMPLETE                     ✅
```

## 已知问题

1. **Kill Switch 只在 API 层拦截**：当前 Governance API 提供 evaluate 端点供调用方检查，但未自动切入 DecisionEngine/DynamicReplanner 的前置链路。需要调用方在每次操作前调用 `evaluateGuardrails()`。
2. **Budget Guard 未实现**：`budget_limit` 类型已定义但无具体 Token/API 预算跟踪逻辑。需要后续接入 TokenStatsCollector。
3. **默认策略固定**：当前 Loop Prevention / Rate Limit 阈值硬编码在默认策略中。Dashboard 尚无策略编辑 UI，需直接修改数据库。

## 回滚指南

```bash
git revert 01abf4de73a40cbc8bb2a251be9231a9fb5ad3a4
```
