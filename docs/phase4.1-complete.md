# Phase 4.1 — Governance Convergence (Gov2 单源 + 持久化 + DI)

## 完成时间

2026-08-06

## Commit

```
cfd8cf6592d21642e347858a0b24394940e387a3
```

> 注：本阶段与既有 Phase 0–3 修复、Dashboard 面板、验证脚本一同以 checkpoint 提交落账（文件层无法剥离）。本文件描述其中的 4.1 部分。

## 目标

收敛"治理三件套"（GlobalGuardrailEvaluator / EcosystemGovernor / EcosystemGovernance）之间的重复与分歧，建立 Gov2（EcosystemGovernance）为单一事实来源：

1. **kill-switch 收敛**：原先存在于 `/governance/kill-switch`（Guardrail 系）与 `/ecosystem/kill-switch`（Governor 系）两条平行链路，改为由 Gov2 统一持有 `killSwitch` 状态并广播到 Guardrail 与 Governor。
2. **Governor DI**：EcosystemGovernor 不再硬编码限流/隔离常量，改为构造注入 Gov2，运行时由 `syncToComponents` 热更新。
3. **Audit 持久化**：治理操作（含 rollback）落 sqlite `governance_audit_log`；snapshots 保持内存态。

## 决策记录

| # | 分歧点 | 决策 |
|---|--------|------|
| ① | kill-switch 归属 | 合并进 Gov2：`GovernancePolicyValues.killSwitch` 为唯一事实来源，persist 到 `governance.db` |
| ② | Governor 依赖方式 | 构造注入：`new EcosystemGovernor(governance)`，删除硬编码常量 |
| ③ | audit 持久化 | Gov2 audit 落 sqlite `governance_audit_log` 表；snapshots 留内存 |

## 修改文件

| 文件 | 变更 |
|------|------|
| `src/governance-v2/governance-v2-store.ts` | 新增 `GovernanceV2Store` 接口：load/save state、appendAuditLog、loadAuditLogs |
| `src/governance-v2/sqlite-governance-v2-store.ts` | 新增实现：复用 `governance.db`，`governance_v2_state` 单行哨兵 + `governance_audit_log` 表（含迁移） |
| `src/governance-v2/types.ts` | `GovernancePolicyValues` 新增 `killSwitch: boolean`（DEFAULT=false）；audit action 联合新增 `"kill_switch"` |
| `src/governance-v2/ecosystem-governance.ts` | 重写：可注入 store 恢复/持久化状态；`setKillSwitch()`；`attachTargets()`/`syncToComponents()` 广播；`update()` 持久化；`rollback()` 持久化并追加 audit |
| `src/ecosystem/ecosystem-governor.ts` | DI 改造：constructor 注入 `governance?`；删除 `DEFAULT_RATE_LIMIT`/`QUARANTINE_*` 硬编码改从 Gov2 读取；新增 `setKillSwitch/setRateLimit/setQuarantineCategories` 与 `syncFromGovernance()`；`reset()` 经 governance 恢复 |
| `src/dashboard/api-routes.ts` | 删除 `POST /governance/kill-switch` 与 `POST /ecosystem/kill-switch`（保留对应 GET 兼容读）；新增 `GET/POST /governance-v2/kill-switch` |
| `src/main.ts` | `new EcosystemGovernance(new SqliteGovernanceV2Store(governance.db))` → `new EcosystemGovernor(governance)` → `attachTargets({ governor, guardrail: { setKillSwitch } })` |
| `src/dashboard/ui/src/panels/GovernancePanel.svelte` | kill-switch 切换改调 `POST /governance-v2/kill-switch` |
| `src/dashboard/ui/src/panels/EcosystemPanel.svelte` | engage/disengage 改调 `POST /governance-v2/kill-switch` |
| `scripts/phase41-e2e-verify.ts` | 新增端到端验证（内存 store 版） |

## 数据流

```
GovernancePanel / EcosystemPanel
        │  POST /governance-v2/kill-switch
        ▼
api-routes → EcosystemGovernance.setKillSwitch()
        │   ├─ 持久化 governance_v2_state（governance.db）
        │   └─ append audit（action="kill_switch"）
        ▼
syncToComponents()  ──→ guardrail.setKillSwitch(active)  [GlobalGuardrailEvaluator]
                      ──→ governor.setKillSwitch(active)   [EcosystemGovernor]
```

Gov2 其它字段（rateLimit、quarantineCategories 等）更新后同样经 `syncToComponents()` 广播给 Governor（限流窗口/隔离名单热更新）。

## 验收

- `npx tsx scripts/phase41-e2e-verify.ts` → **29/29 通过，EXIT=0**
- `npx tsc --noEmit` → 通过
- `npm run build`（vite）→ 通过

## 未实现（留给后续）

- 历史 audit 的 Dashboard 展示界面
- kill-switch 事件的实时推送（当前为轮询面板刷新）
- snapshot 从内存迁移到持久化存储

## 回滚指南

本阶段整体包含于 checkpoint commit `cfd8cf6`，如需撤销 4.1 单独改动需手工还原相关文件（见"修改文件"表），不建议整体 revert（会连带撤销 P 系列修复与 UI 面板）。
