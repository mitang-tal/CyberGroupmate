# Phase 7.2 — Sandbox Simulation（沙盒推演引擎）

## 完成时间

2026-07-30

## Commit

```
7503de74e7a09e52ca0371c649a375d9572109bc
```

## 目标

在 Meta 面对复杂决策（策略切换、多节点重路由、降级、动态重规划）时，不再盲目在生产环境执行，而是先在内存沙盒中对候选方案（Option A/B/C）做轻量级推演：结合 7.1 历史经验过滤与风险/成本评分，选择综合风险最低的方案落地。

## 核心架构

```
Meta Trigger / Decision Event
        ├──► Candidate Option Generator（固定 3 方案）
        ├──► Sandbox Simulation Engine
        │     ├── 1. Experience Memory Filter（7.1 避坑规则）
        │     ├── 2. State Rollback Virtualizer
        │     └── 3. Predictor & Scorer（成功率/成本/延迟/风险）
        ├──► Optimal Option Selector ──► Production Execution
```

## 修改文件

| 文件 | 变更 |
|------|------|
| `src/simulation/types.ts` | 新增 `SimulationOption`、`SimulationResult`、`ExperienceHitRecord` |
| `src/simulation/simulation-engine.ts` | 新增 `SimulationEngine`（选项生成 + 评分 + 命中/避坑追踪） |
| `src/dashboard/api-routes.ts` | 新增 `/simulation/run`、`/simulation/metrics` |

## 关键实现

- **候选生成**：固定 3 方案——A. 标准重试 `retry`（maxRetries 3，命中 avoid 时成功率 0.7→0.4）、B. 替代路由 `redispatch`（preferOverrides）、C. 降级 `degrade`（标注 `May return stale data` 风险）。
- **评分公式**（`scoreOptions`）：
  ```
  W_SUCCESS=10.0, W_COST=0.01, W_RISK=5.0
  avoid 命中: riskPenalty += (1 - confidence)*2
  prefer 命中: predictedSuccessRate += 0.1 (cap 0.99)
  riskScore = riskPenalty + riskFactors.length * 0.5
  overallScore = P*10 - (cost/1000)*0.01 - risk*5
  ```
  取最高分方案为 `selectedOptionId`。
- **经验命中追踪**：命中匹配经验记为 `matched`，被选中方案对应避坑记为 `avoidedError`；`getHitMetrics()` 输出 `totalSimulations / totalHits / avoidedErrors / experienceROI`（ROI = avoidedErrors/totalHits，保留 2 位小数）。

## API

- `POST /simulation/run` — 传入决策上下文，返回 3 方案评估结果
- `GET /simulation/metrics` — 沙盒推演统计与经验命中/避坑收益率

## 验收标准

- 输入决策事件输出 ≥2 个候选方案，各自含预测成功率、成本、延迟、综合得分。
- 命中 7.1 `avoid` 规则的方案风险显著上升、综合得分下降，系统优先选无踩坑记录方案。
- Dashboard 可直观看到经验命中次数、避坑次数与推演评分对比（ROI）。

## 未实现

- 将沙盒推演纳入 Meta Decision Engine 前置决策链（设计稿 Commit 3 中提及，当前仅独立 API）。
- 真实成本/延迟的在线校准（当前为启发式常量估值）。

## Review 约束落地（本轮）

| review 项 | 决策 / 落地 |
|-----------|------------|
| #11 热路径缓存（漏项） | 新增 `src/experience/query-cache.ts`（`TTLQueryCache`，默认 TTL 5s，浅拷贝防污染）；`FailureExtractor.queryRelevantExperience` 走缓存，`extractFromFailure` / `runDecay` 后 `invalidate()`；Dispatch/Replan/推演共用同一缓存层 |
| #14 评分权重 | 拆出 `src/simulation/scorer.ts`：`SimulationScorer` 接口 + `StaticWeightedScorer`（权重可注入，默认 10/0.01/5），预留动态 ROI 回归 scorer 切换位 |
| #15 State Rollback | `src/simulation/state-virtualizer.ts`（`SandboxStateVirtualizer` 快照/恢复）；`runSimulation` 在 `finally` 中 restore，确保推演无副作用 |
| #17 决策推演延迟分档 | `runSimulation(context, {mode})`：`full` 3 候选 / `fast` 单候选快速路径；`POST /simulation/run` 透传 `mode` |

验收：`npx tsx scripts/phase72-sandbox-verify.ts` → **18/18 通过**；`npx tsc --noEmit` 通过；`vite build` 通过。

## 回滚指南

```bash
git revert 7503de74e7a09e52ca0371c649a375d9572109bc
```