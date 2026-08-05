# Phase 8.0 — Multi-Agent Ecosystem Dashboard（生态治理中心）

## 完成时间

2026-07-30

## Commit

```
f9b7fac66cc12277769477a7cde7389ef323e7d5
```

## 目标

Phase 8 后端 6 大模块闭环后，在 Web Dashboard 中新增 Ecosystem Center（生态治理中心），将生态运行状态、经验提纯流水线、仲裁结果、竞标矩阵、角色演化与版本回滚统一呈现，让运维者全盘掌握群体智能动态（Phase 8 收官）。

## 核心 UI / 页面结构（5 大视觉区）

1. **Top Bar & Ecosystem Health**：当前 Governance Policy SemVer 版本号、Governor 状态（Kill-Switch 熔断指示灯、Rate Limit 计数）、一键 Kill-Switch 触发/解冻按钮。
2. **Experience Federation Pipeline**：`candidate → validated → federated` 提纯统计；Quarantine 隔离区列表；"一键触发 Sandbox 验证"。
3. **Conflict & Negotiation Analytics**：5 层 Tie-Breaker 命中分布（Reputation/Risk/Tier/Timestamp/LLM Fallback）、CNP 竞标矩阵（Proposals、轮数、UtilityScore 获奖者）。
4. **Agent Evolution & Specialization**：带 `SpecializationTag` 的 Agent 列表；`pending_approval` 建议审核列表（Approve/Reject）；14 天冷却倒计时。
5. **Governance Versioning & Audit**：当前生效参数面板、版本历史回滚（Snapshot Diff 预览 + Rollback）、审计日志。

## 修改文件

| 文件 | 变更 |
|------|------|
| `src/dashboard/ui/src/panels/EcosystemPanel.svelte` | 新增生态治理中心面板（联邦/竞标/仲裁/演化/治理/熔断） |
| `src/dashboard/ui/src/App.svelte` | 面板注册 / 路由挂载 |
| `src/dashboard/ui/src/components/TabNav.svelte` | 新增 Ecosystem 入口 |
| `src/dashboard/api-routes.ts` | 接 ag间接 `/api/governance-v2|federation|conflict|negotiation|evolution|reputation|meta-test` 全量接口 |

## 关键实现

- 接入 `GovernancePanel / EcosystemPanel` 等 SPA 面板，统一通过 `/api/*` REST 读取后端各 Phase 8 模块。
- 生态大盘展示 governor 熔断、联邦状态、仲裁统计、竞标胜负与演化审批。
- 后续 P 系列巡检中逐项修复：UPDATE 策略编辑（P1-5）、回滚 toast（P1-7）、无效日期显示（P1-6）等（见 `docs` 相关记录）。

## 验收标准

- Ecosystem 视图显示当前 SemVer 版本与 Kill-Switch 熔断状态。
- 联邦提纯/隔离区、仲裁 Tie-Breaker 分布、竞标矩阵、演化审批、版本回滚、审计日志均在面板呈现并可操作。
- 全链路零报错，`vite build` 通过。

## 未实现

- 实时推送（当前为轮询/手动刷新）。
- 仲裁 LLM 命中分布需真实 LLM 接入后才会有非零值（当前占位确定性回退）。

## 回滚指南

```bash
git revert f9b7fac66cc12277769477a7cde7389ef323e7d5
```

> Phase 8 完整回退参考 commit 序列（由 8.5a 至 8.0）。