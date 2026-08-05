# Phase 8.5a — Minimal Ecosystem Governor（安全刹车网）

## 完成时间

2026-07-30

## Commit

```
a70643f3e02524931bf569ff299c1f045879e0bf
```

## 目标

Phase 8 的第一步先建"安全刹车网"：扩展 ExperienceItem schema（`agentId / trustScore / federationStatus`），实现 Minimal EcosystemGovernor，接入 Phase 7.4 告警链，提供经验写入限流与群体 Kill-Switch，为后续经验联邦（8.1）提供准入闸门。

## 修改文件

| 文件 | 变更 |
|------|------|
| `src/experience/types.ts` | `ExperienceItem` 扩展 `originAgentId / originTrustScore / federationStatus`；新增 `FederationStatus`（candidate/validated/quarantined/federated） |
| `src/ecosystem/ecosystem-governor.ts` | 新增 `EcosystemGovernor`（限流 + 隔离分类 + kill-switch 熔断 + 候选评估） |
| `src/ecosystem/federation-store.ts` | 预留（8.1 落位） |
| `src/dashboard/api-routes.ts` | 新增 governor 相关端点 |

## 关键实现

- **写入限流**：`checkSubmitPermission(agentId)` 按 agent 窗口限流（`DEFAULT_RATE_LIMIT=10/分`、`RATE_WINDOW_MS=60s`）。
- **候选评估**：`evaluateCandidate({originTrustScore, category, frequency, confidence})` 决定 candidate / quarantined（`QUARANTINE_TRUST_THRESHOLD=0.55`）。
- **准入闸门**：`canPromote(agentId, federationStatus)` 拒绝 kill-switch 激活或已 federated 的经验。
- **群体 Kill-Switch**：`engageKillSwitch / disengageKillSwitch / isKillSwitchActive`，可一键熔断全生态（接 7.4 自杀/告警链）。
- **隔离分类**：`add/remove/getQuarantineCategories`，默认 `["resource_exhausted","logic_deadlock"]`。
- **其他**：`approveQuarantine / federate / setRateLimit / getRateLimit / getRateLimitStatus / reset`。

## API

- `GET /ecosystem/rate-limit`
- `POST /ecosystem/check-submit`
- `POST /ecosystem/evaluate-candidate`
- `POST /ecosystem/reset`

## 验收标准

- 经验写入受按 agent 限流约束，超限被拒。
- kill-switch 激活后所有 promote / 提交路径被阻断。
- 低 trustScore / 高隔离分类的经验被归入 `quarantined`。

## 未实现

- 与 7.4 告警链的显式事件推送（当前由面板触发熔断）。
- 限流/隔离参数的运行时热更新——后续 Phase 4.1 收敛中经 Gov2 `syncToComponents` 补齐。

## 回滚指南

```bash
git revert a70643f3e02524931bf569ff299c1f045879e0bf
```