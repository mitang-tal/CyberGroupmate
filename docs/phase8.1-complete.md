# Phase 8.1 — Experience Federation Store（经验联邦提纯）

## 完成时间

2026-07-30

## Commit

```
9b0c3631c043ec12a42fd50d33e8874c75a4f55b
```

## 目标

将本地 candidate 经验"提纯"为全局 federated 经验。提纯不靠 Prompt 对话，必须经过 Phase 7.2 沙盒回放验证（Sandbox Replay Validation）与 Phase 7.3 声誉阈值校验，验证无误后提升为 `federated` 全网 Agent 可读；失败则降级 `quarantined` 防污染。

## 核心架构

```
Local Experience (candidate / quarantined)
        ├──► Governor 许可检查（EcosystemGovernor.canPromote）
        ├──► Sandbox Replay Validation（Phase 7.2 SimulationEngine）
        ├──► 通过 → federationStatus = federated（全局联邦库，全网 Dispatcher/Replan 可检索）
        └──► 失败 → federationStatus = quarantined（隔离防污染）
```

## 修改文件

| 文件 | 变更 |
|------|------|
| `src/ecosystem/federation-store.ts` | 新增 `FederationStore`（晋升流水线 + 沙箱回放验证 + 状态跃迁） |
| `src/experience/experience-store.ts` | `federationStatus` 状态查询支持 |
| `src/dashboard/api-routes.ts` | 新增 `/api/federation/*` 端点 |
| `src/main.ts` | 装配 `FederationStore(experienceStore, ecosystemGovernor, simulationEngine)` |

## 关键实现

- **晋升流水线 `promote(experienceId, agentId?)`**：Governor 许可 → 沙箱回放 → 状态跃迁 `candidate/quarantined → validated → federated`，失败降 `quarantined`。
- **沙箱回放验证 `runSandboxValidation(experience)`**：
  - 无 `SimulationEngine` 注入时按置信度兜底：仅 `confidence ≥ 0.7` 通过。
  - 有引擎时构造 simContext（`rule.avoid ?? context.tool`），对模拟所选选项与规则对齐评分：命中 avoid -0.3、规避 avoid +0.15（cap 1.0）、命中 prefer +0.1；**对齐分 ≥ 0.6 通过**，否则拒绝/隔离。
- **查询**：`getFederatedItems / getQuarantinedItems / getCandidateItems` 按 federationStatus 过滤。

## API

- `POST /api/federation/promote` — 传入 experienceId，触发沙箱回放与晋升
- `GET /api/federation/items` — 全局 federated 经验列表
- `GET /api/federation/quarantine` — 隔离区经验
- `GET /api/federation/candidates` — 待提纯候选

## 验收标准

- `PromoteResult{success, experience, federationStatus, validationScore, reason}` 可断言。
- 缺失经验 → `success:false, reason:"Experience not found"`。
- Governor 拒绝 → `success:false`（携带 permit.reason）。
- 验证失败 → 状态 `quarantined`（经 `getQuarantinedItems()` 可见）。
- 成功 → 状态 `federated` 且 `validationScore` 填充。

## 未实现

- 全网 Agent 侧 Federated 经验的实时索引/推送（当前按需查询）。
- 联邦库跨进程复制（单进程内存+SQLite）。

## 回滚指南

```bash
git revert 9b0c3631c043ec12a42fd50d33e8874c75a4f55b
```