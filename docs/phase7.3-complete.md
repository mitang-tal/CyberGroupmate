# Phase 7.3 — Agent Reputation System（多维声誉 / 信任加权路由）

## 完成时间

2026-07-30

## Commit

```
1da77fe6ca3e3ec0f4ba8b3def6f67817981d724
```

## 目标

建立「多维 Agent 信用画像」而非单一战力榜：基于能力匹配度、执行可靠性、风险概率与历史恢复力的多维声誉，实时反馈至 Dispatcher 与 7.2 沙盒推演，形成「调度 → 执行 → 评估 → 信任更新 → 优化下次调度」正反馈闭环。

## 核心架构

```
Execution Record(5.1)/Trace(5.3)/Alert(5.5)/Experience(7.1)
                ├──► Reputation Evaluator（能力掌握度 / 可靠性 / 风险画像）
                ├──► Reputation Store（衰减 + 滑动窗口 + 信任状态机）
                ├──► Phase 6.1 Dispatcher（信任加权路由）
                └──► Phase 7.2 Sandbox Engine（预测参数注入）
```

## 修改文件

| 文件 | 变更 |
|------|------|
| `src/reputation/types.ts` | 新增 `AgentReputation`、`CapabilityScore`、`TrustState`、`ReputationEvaluationInput` |
| `src/reputation/reputation-evaluator.ts` | 新增 `ReputationEvaluator`（多维评分 + 信任状态机 + `getDispatchWeight`） |
| `src/reputation/reputation-store.ts` | 新增 `ReputationStore` 接口 |
| `src/reputation/sqlite-reputation-store.ts` | 新增：基于 better-sqlite3 持久化（`reputation.db`） |
| `src/capability-registry/capability-dispatcher.ts` | 集成：`setReputationProvider` + `getReputationWeight`（信任加权候选排序 / 屏蔽 untrusted） |
| `src/dashboard/api-routes.ts` | 新增 `/api/reputation/*` 端点 |

## 关键实现

- **能力维 `capabilityScores`**：按 capability 分堆，`mastery = success/total`。
- **可靠性维**：`reliability = 总成功/总`；`avgLatencyMs` 滑动均值。
- **风险维 `riskProbability`**：`min(recentAlerts/total, 1)`。
- **综合信任 `calculateTrustScore`**：默认 0.5；`riskPenalty = riskProbability*0.3`、`failureRatePenalty = failures/total*0.2`，`score = reliability - 两项罚分`，夹 [0,1]。
- **信任状态机 `determineTrustState`**：`≥0.85 → trusted`、`≥0.55 → normal`、`≥0.30 → probation`、`<0.30 → untrusted`（untrusted 仅在前态 trust/normal 且 risk>0.8 时直落，否则 probation）；`PROBATION_PERIOD_MS=24h`，到期且 score≥0.55 恢复 normal。
- **路由加权**：`getReputationWeight` — untrusted→0、probation→trustScore×0.5、其余→trustScore，用于候选排序（confidence 降序 → 声誉降序 → 活动任务数升序）；`isTrustedAgent` 硬性排除 untrusted。

## API

- `POST /api/reputation/evaluate` — 单 Agent 评估
- `POST /api/reputation/evaluate-all` — 全量评估（当前实现按空 agent 列表返回 count=0，待接离线源）
- `GET /api/reputation/agents` — 全量画像
- `GET /api/reputation/agent/:agentId` — 单 Agent 路由权重（`getDispatchWeight`）

## 验收标准

- 系统能基于历史数据自动算出 Agent 在若干 capability 下掌握度、可靠性与风险概率。
- 高频工具错误 / 死锁 Agent trustScore 下降并进入 probation；连续成功后逐渐恢复。
- Capability Dispatch 自动避开低信用 / 高风险 Agent，优先分给信任加权最高且最匹配实例。

## 未实现

- `evaluate-all` 接入真实 agent 列表来源（当前透传空数组）。
- 任务难度修正 / 学习率（重复犯错率）维度——设计稿预留。

## 回滚指南

```bash
git revert 1da77fe6f3e3e0f4ba8b3defde6f67817981d724
```