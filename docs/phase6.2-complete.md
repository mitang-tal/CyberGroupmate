# Phase 6.2 — Meta Autonomous Decision Engine

## 完成时间

2026-07-30

## Commit

```
4db24ec6b4d38d392e2cbfa6bb606841529958a6
```

## 目标

建立 Meta 自主决策引擎，让 Meta 基于告警上下文、系统负载、执行 Trace 及 Agent 能力拓扑，自主做出策略调整、路由重定向、服务降级、节点扩缩等高阶决策。

## 架构

```
Execution Alerts & System Metrics
        │
        ▼
Meta DecisionEngine (状态评估 + 推理)
        │
   ┌────┼────┐
   ▼    ▼    ▼
Policy  Re-   Degrade/
Switch  route Scale
        │
        ▼
MetaDecision Log & PolicyState
```

## 修改文件

| 文件 | 变更 |
|------|------|
| `src/meta-decision/types.ts` | **新文件** — MetaDecision, DecisionTriggerEvent, MetaPolicyState 类型 |
| `src/meta-decision/decision-store.ts` | **新文件** — DecisionStore 接口 |
| `src/meta-decision/sqlite-decision-store.ts` | **新文件** — SQLite 实现：`meta_decisions` 表 |
| `src/meta-decision/meta-decision-engine.ts` | **新文件** — 决策引擎：onAlertRaised, evaluateSystemState, executeDecision, rejectDecision |
| `src/dashboard/types.ts` | DashboardDeps 新增 `metaDecisionEngine` |
| `src/dashboard/api-routes.ts` | 新增 6 个 `/api/meta-decisions/*` 路由 |
| `src/dashboard/public/meta-decisions.html` | **新文件** — Decision Center Dashboard |

## 决策逻辑

| 触发 | 决策类型 | 条件 | Confidence |
|------|----------|------|------------|
| Alert: critical/high | degrade | 严重告警自动降级组件 | 0.6 |
| Alert: CONTINUOUS_FAILURE / FAILURE_RATE_SPIKE | redispatch | 有可用替代 Agent 时路由切换 | 0.7 |
| Alert: EXECUTION_TIMEOUT | switch_policy | 超时模式切换严格模式 | 0.5 |
| 系统评估: capacity_drop | scale_agent | 在线 Agent < 50% | 0.7 |
| 系统评估: system_overload | redispatch | Agent 活跃任务 > 5 | 0.5 |

## 全局政策状态

`MetaPolicyState` 跟踪：
- `activeDecisions` — 已执行的决策列表
- `degradedComponents` — 当前降级的组件
- `circuitBrokenComponents` — 熔断组件
- `lastEvaluatedAtMs` — 最后评估时间

## 冷却控制

同一 `targetComponent` 在 2 分钟内不重复触发决策。

## API 端点

| 路由 | 方法 | 说明 |
|------|------|------|
| `GET /api/meta-decisions` | 查询 | 支持 status/decisionType 过滤 |
| `GET /api/meta-decisions/:id` | 详情 | — |
| `POST /api/meta-decisions/:id/execute` | 执行 | 落地决策 |
| `POST /api/meta-decisions/:id/reject` | 拒绝 | 拒绝决策 |
| `POST /api/meta-decisions/evaluate` | 触发评估 | 触发系统级扫描 |
| `GET /api/meta-decisions/policy-state` | 政策状态 | 当前降级/熔断状态 |

## Dashboard 功能

- **统计卡片**：Proposed / Executed / Rejected / Degraded 组件数
- **Policy State**：当前降级组件、活跃决策列表、最后评估时间
- **Decision Log**：类型彩色标签、Status 图标、Target、Reasoning、Confidence、Approve/Reject 按钮
- **Evaluate Now**：手动触发系统状态评估
- **Approve/Reject**：对 proposed 决策进行手动干预

## 验收标准

| 标准 | 状态 |
|------|------|
| 自主评估：高危 Alert 可推导结构化决策 | ✅ onAlertRaised() 4 种推理路径 |
| 决策执行：redispatch/degrade 影响系统状态 | ✅ executeDecision() 更新 PolicyState |
| 前端闭环：Dahboard 可视化推理决策流 + 手动操作 | ✅ meta-decisions.html |

## 当前 Phase 6 总进度

```
6.1 Capability Registry & Dispatch    ✅
6.2 Autonomous Decision Engine        ✅
6.3 Dynamic Task Planning             ⬜
6.4 Global Guardrails                 ⬜
```

## 已知问题

1. **决策引擎未自动接入告警流**：当前 `onAlertRaised` 需要调用方在 Alert 创建后显式调用。后续需在 AlertStore 或 AnomalyDetector 中集成事件回调。
2. **Decision 与 Healing Action 未联动**：目前 `MetaDecisionEngine` 和 `HealingPolicyEngine` 各自独立运行。后续可统一决策链路：Alert → HealingPolicyEngine (战术) → MetaDecisionEngine (战略)。
3. **API 受 `DashboardDeps` 可选保护**：如果 `metaDecisionEngine` 未注入，路由自动跳过。

## 回滚指南

```bash
git revert 4db24ec6b4d38d392e2cbfa6bb606841529958a6
```
