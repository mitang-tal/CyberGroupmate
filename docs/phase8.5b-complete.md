# Phase 8.5b — Ecosystem Governance & Rule Versioning（治理 / 版本控制）

## 完成时间

2026-07-30

## Commit

```
cdc9a013389e128973979b789f49d792bdfcd792
```

## 目标

将前序模块依赖的控制参数与规则策略（Policy）纳入完整生态治理：支持语义化版本控制（SemVer，如 v1.2.0）、策略变更变更日志（Audit Log）与一键快照回滚（Rollback），确保任何治理策略调整有迹可循，异常时秒级恢复已知稳定版本。

## 核心架构

```
Governance Policy Definition（federationMinTrustScore / negotiationTimeoutMs /
                               evolutionCoolingDays / governorRateLimit ...）
        ├──► 每次更新自动递增 SemVer + 生成 PolicySnapshot（SQLite）
        ├──► 记录 Origin / Reason / ChangeDiff
        └──► rollbackToVersion(target) ──► 原子置换 + 生成 rollback 审计日志
```

## 修改文件

| 文件 | 变更 |
|------|------|
| `src/ecosystem/ecosystem-governance.ts`（初始） | 新增 `EcosystemGovernance`（策略版本管理 / 快照 / ChangeDiff / 原子回滚） |
| `src/governance-v2/types.ts` | `GovernancePolicyValues` 相关治理参数集 |
| `src/dashboard/api-routes.ts` | 新增 `/api/governance-current/update/snapshots/rollback` |
| 各消费模块 | Governor / FederationStore / NegotiationEngine / EvolutionAnalyzer 统一读取 Governance 策略 |

## 关键实现

- **策略定义**：封装当前生态全部治理参数（`federationMinTrustScore`、`negotiationTimeoutMs`、`evolutionCoolingDays`、`governorRateLimit` 等）。
- **版本与快照**：每次 `update` 自动递增 SemVer 版本，生成 `PolicySnapshot` 持久化至 SQLite；记录 `Origin / Reason` 与历史 ChangeDiff。
- **一键回滚**：`rollbackToVersion(targetVersion)` 恢复对应快照全局参数，原子置换当前状态，生成一条 `rollback` 类型审计日志。
- **统一消费**：EcosystemGovernor、FederationStore、NegotiationEngine、EvolutionAnalyzer 均以当前 Governance 策略为准。

## API

- `GET /api/governance/current` — 当前生效策略与版本
- `POST /api/governance/update` — 提交修改，产出新版本快照
- `GET /api/governance/snapshots` — 历史版本快照列表
- `POST /api/governance/rollback` — 传 targetVersion 一键秒级回滚

## 验收标准

- 每次策略更新产生单调递增 SemVer 与快照；变更含 diff（Origin/Reason）。
- 回滚后全局参数恢复指定版本，并生成 rollback 审计日志。
- 下游模块读取的是回滚后的最新策略值。

## 未实现 / 后续收敛

- 本轮 kill-switch/限流等运行参数与策略的持久化存储（原先分散于内存与各 store，后续 **Phase 4.1** 收敛为 `governance.db` 的 `governance_v2_state` 单行持久化 + `governance_audit_log`，并用 `attachTargets/syncToComponents` 热广播到 Guardrail / Governor）。

## 回滚指南

```bash
git revert cdc9a013389e12897397bb789f49d46bd15792c3
```