# Phase 8.3 — Deterministic Conflict Resolver（确定性冲突仲裁）

## 完成时间

2026-07-30

## Commit

```
3ff3a2165e72f56cf758b9ea80436f690e94449a
```

## 目标

多 Agent 对同一任务/资源提出相互冲突方案时，以纯代码、0 Token 确定性仲裁在毫秒级裁决，避免死锁与无限讨论。输出确定的 `ArbitrationVerdict` 并命名采用的 Tie-Breaker 规则。

## 核心架构

```
Conflicting Proposals（同 resourceId/conflictType）
        ├──► ConflictResolver.resolve() ──► 确定性 Tie-Breaker 矩阵 ──► ArbitrationVerdict
        └──► 复杂平票 + complexContext → LLM 建议（1000ms 硬超时）→ 超时回退规则仲裁
```

## 修改文件

| 文件 | 变更 |
|------|------|
| `src/conflict/types.ts` | 新增 `ConflictCase`、`Proposal`、`ArbitrationVerdict`、`AgentTier` |
| `src/conflict/conflict-resolver.ts` | 新增 `ConflictResolver`（纯代码裁决 + 硬超时兜底 + 统计） |
| `src/dashboard/api-routes.ts` | 新增 `/api/conflict/*` 端点 |

## 关键实现

- **确定性 Tie-Breaker 矩阵**（按层级向下 fallback，绝不随机）：
  1. **Reputation**：最高 `trustScore`。
  2. **Risk**：最低 `riskScore`。
  3. **Tier**：`TIER_ORDER = { meta_council:0, primary_worker:1, fallback_worker:2 }`。
  4. **Timestamp**：最早 `submittedAtMs`。
  5. **LLM 兜底**：仅当 `complexContext===true` 且仍平票才启用，`LLM_TIMEOUT_MS=1000`；当前实现模拟超时返回首个平票方案，**保证无活锁**。
  6. **终极兜底**：数组首个 proposal。
- **边界**：空列表 `throw`；单 proposal 自动通过（`tieBreakerUsed:"reputation"`）。
- **批处理**：`resolveBatch(cases)` 原子遍历。
- **统计**：`getStats()` 暴露 `{ total, byTieBreaker, tieRate }`（`tieRate` = 非 reputation 裁决占比）。

## API

- `POST /api/conflict/resolve` — 传冲突案例，输出裁决与 reasoning（缺 resourceId/conflictType/proposals 返回 400）
- `POST /api/conflict/resolve-batch`
- `GET /api/conflict/history`
- `GET /api/conflict/stats`

## 验收标准

- `ArbitrationVerdict{verdictId, conflictCaseId, winner, reasoning, tieBreakerUsed, ruledAtMs}` 每项可断言。
- `tieBreakerUsed ∈ {reputation,risk,tier,timestamp,llm_fallback}` 各层可由构造平票触发。
- 空 proposals → Error；单 proposal → 自动通过。
- LLM 路径仅 `complexContext=true` 启用，否则落默认第一候选。
- `getStats().byTieBreaker / tieRate` 反映分布。

## 未实现

- 真实 LLM 仲裁接入（当前占位为确定性超时回退）。
- 与调度循环的显式挂起/超时集成信号。

## 回滚指南

```bash
git revert 3ff3a2165e72f56cf758b9ea80436f69e94449a
```