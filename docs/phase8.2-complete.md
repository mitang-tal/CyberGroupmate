# Phase 8.2 — Structured Contract-Net Negotiation（密封出价协商）

## 完成时间

2026-07-30

## Commit

```
c8af9aa02358b793442b07def93529904a94bfa8
```

## 目标

把 Phase 6.1 Dispatcher 的单向"强行指派"升级为结构化 Contract-Net 协商：Meta 发布标案，目标 Agent 按 JSON Schema 密封出价（含数值成本/延迟/置信度），限时最多 2 轮。超时或弃标则回退至 Dispatcher 或 Conflict Resolver。

## 核心架构

```
Meta ──TaskProposal──► Agents ──AgentBid(sealed)──► NegotiationEngine
        ├── 评标 UtilityScore（成本/延迟/置信度加权）
        ├── 最多 2 轮（第 1 轮初报、第 2 轮修正）、500ms/轮硬超时
        └──► ContractAward（最高分中标）；空标回退 Dispatcher/仲裁
```

## 修改文件

| 文件 | 变更 |
|------|------|
| `src/negotiation/types.ts` | 新增 `TaskProposal`、`AgentBid`、`ContractAward`、`NegotiationRound` |
| `src/negotiation/negotiation-engine.ts` | 新增 `NegotiationEngine`（评标 + 2 轮 + 超时 + 回退） |
| `src/dashboard/api-routes.ts` | 新增 `/api/negotiation/*` 端点 |
| `src/main.ts` | 装配 `NegotiationEngine({dispatcher, conflictResolver})` |

## 关键实现

- **评标公式 `UtilityScore`**：
  ```
  = confidence*0.5 + (1 - min(cost/maxCost,1))*0.3 + (1 - min(latency/slaLatency,1))*0.2
  ```
  最高分胜出；`roundSettled` 记录胜标轮次。
- **约束校验**：`submitBid` 中 `cost > maxCost` 或 `latency > slaLatency` 直接 `throw`。
- **限轮/超时**：`MAX_ROUNDS=2`、`BID_TIMEOUT_MS=500`；超时未响应视为弃标。
- **回退**：空标回退 CapabilityDispatcher，再落 "No Agent Available"（utility 0.5 / 0），reasoning 注明 matchType。
- **统计**：`getStats()` 暴露 `totalNegotiations / avgUtilityScore / round1Settled / round2Settled`。

## API

- `POST /api/negotiation/publish` — 发布标案执行协商（投标窗口 500ms）
- `POST /api/negotiation/submit-bid` — 提交密封出价（缺字段/越限回 400）
- `GET /api/negotiation/history`
- `GET /api/negotiation/stats`

## 验收标准

- `ContractAward{awardId, proposalId, winnerBid, utilityScore, roundSettled, reasoning, awardedAtMs}` 可断言。
- 投标超预算/超 SLA → 抛描述性错误。
- `getStats()` 计数可测；零标拍卖 → dispatcher 回退（0.5）或无 agent 出价（0），均有 reasoning。

## 未实现

- Agent 侧真实异步竞标线程（当前出价经由独立 `submitBid` API 写入 / 模拟窗口轮询）。
- 多目标标书批量发布/撤销。

## 回滚指南

```bash
git revert c8af9aa02358b358442b07def93529929c94baf8
```