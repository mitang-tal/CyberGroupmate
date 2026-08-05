# Phase 8.4 — Offline Agent Evolution Analyzer（离线演化 + 冷却窗）

## 完成时间

2026-07-30

## Commit

```
9f73a709825de6ac203530bbb11b38cef2da6a4c
```

## 目标

基于长期运行数据（30 天 Trace + Reputation）识别 Agent 优势领域并产出专业化建议（Specialization Suggestion），拒绝实时动态切角色。引入 14 天冷却窗口避免角色翻转震荡，且需人工/治理闸门确认后才生效。

## 核心架构

```
Reputation.capabilityScores + 30d TraceRecord
        ├──► EvolutionAnalyzer 离线批处理
        ├──► 特化判定（高出全局均值 ≥20% 且样本 >20 次）
        ├──► Cooling Window Gate（距上次变更 <14 天则拒绝）
        └──► EvolutionProposal（pending_approval → approved/rejected，非自动生效）
```

## 修改文件

| 文件 | 变更 |
|------|------|
| `src/evolution/types.ts` | 新增 `EvolutionProposal`、`SpecializationTag`、`EvolutionHistoryEntry` |
| `src/evolution/evolution-analyzer.ts` | 新增 `EvolutionAnalyzer`（离线采样 + 特化判定 + 冷却窗 + 审批） |
| `src/reputation/reputation-evaluator.ts` | 提供 `capabilityScores 数据源（进化分析输入 `linkDomainExpert`） |
| `src/dashboard/api-routes.ts` | 新增 `/api/evolution/*` 端点 |
| `src/main.ts` | 装配 `EvolutionAnalyzer(reputationEvaluator` |

## 关键实现

- **特化判定**（常量 `SAMPLING_DAYS=30`、`MIN_EXECUTIONS=20`、`SPECIALIZATION_THRESHOLD=0.2`）：
 ：
  - 特化标签：`executionCount ≥ 20 且 mastery/globalAvg ≥ 1+0.2。
  - 弃用标签：`mastery < 0.5 且 executionCount > 20`。
- **标签命名 `generateTagName`**：`mastery≥0.9 → domain_expert:<cap>`、`≥0.75 → specialist:<cap>`、`else practitioner:<cap>`。
- **冷却窗口**：`COOLING_DAYS=14`；`Date.now < lastEvolvedAt+14d` 则跳过（返回 undefined）；`getCoolingStatus(agentId)` 返回 `{inCooling, coolingDeadlineMs?, remainingDays?}`，proposal 上携带 `coolingDeadlineMs`。
- **闸门**：`approveProposal / rejectProposal` 仅作用于 `pending_approval`；批准记录冷却窗起算时间。

## API

- `POST /api/evolution/analyze` — 单 Agent 或全量（无特化时返回 `{proposal:null, reason:"No specialization identified or in cooling window"`）
- `GET /api/evolution/proposals?status=`
- `POST /api/evolution/approve`（非 pending → 404）
- `POST /api/evolution/reject`（非 pending → 404）
- `GET /api/evolution/history` — 仅已批准
- `GET /api/evolution/cooling/:agentId`

## 验收标准

- `EvolutionProposal{proposalId, agentId, ..., analysis{sampleSize, samplingPeriodDays, topCapability, worstCapability, globalAvgMastery}, status, coolingDeadlineMs}` 可断言。
- `status` 生命周期 `pending_approval → approved | rejected`。
- 14 天内二次分析返回 `undefined`；`getCoolingStatus` 报 `inCooling:true + remainingDays`。
- 低于阈值（mastery 低于全局 20% 或 count<20）无建议标签。

## 未实现

- 批准后向 `AgentRegistration.metadata` 的实际回写（当前由下游/治理闸门消费）。
- 离线 Cron 自动触发（当前手动 / 全量触券）。

## 回滚指南

```bash
git revert 9f73a709825de6ac20a530b88b38cef2da68a4c
```