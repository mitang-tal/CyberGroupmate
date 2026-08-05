# Phase 7.4 — Meta Self-Test（自检 / 健康审计全套）

## 完成时间

2026-07-30

## Commit

```
76f25db86f417c385daf3253436a972aa118efd0
```

## 目标

把决策引擎、重规划引擎、经验规则库与安全护栏本身纳入定期审计与"自我体检"。重点验证：规则是否过度膨胀引发全局僵化、Guardrail 能否在极限场景约束 Meta 自身、系统是否存在逻辑死锁，形成无盲区的自我审计闭环（Phase 7 收官）。

## 核心架构

```
Scheduled Cron / Admin Trigger
        ├──► Meta Self-Test Suite（自检编排器）
        ├── 1. Deadlock & Loop Probe（死锁/递归检查）
        ├── 2. Guardrail Respect Probe（配额/限制自测）
        ├── 3. Experience Rigidity Audit（规则僵化检测）
        ├── 4. Self-Kill Simulation（一键自杀测试）
        ├── 5. Health Score Calculator（综合健康分）
        └──► Meta Health Report & Action Log（自动修复 / 全局预警）
```

## 修改文件

| 文件 | 变更 |
|------|------|
| `src/meta-test/types.ts` | 新增 `MetaSelfTestProbeResult`、`MetaSelfTestReport`、`ProbeCategory`、`HealthStatus` |
| `src/meta-test/meta-self-test-engine.ts` | 新增 `MetaSelfTestEngine`（4 大探针 + 健康分 + 建议 + 报告持久化） |
| `src/meta-test/self-test-store.ts` | 新增 `MetaSelfTestStore` 接口 |
| `src/meta-test/sqlite-self-test-store.ts` | 新增：基于 better-sqlite3 持久化（`meta-self-test.db`，表 `meta_self_test_reports`） |
| `src/dashboard/api-routes.ts` | 新增 `/api/meta-test/*` 端点 |

## 关键实现（4 大探针）

1. **死锁探针**：模拟 A→B→C→A 环，`loopDetected` 由回访检测；检测到 score 1.0 / 未检测 0.3 / 异常 0。
2. **Guardrail 尊重探针**：测试 kill-switch 阻断与循环重规划（默认 `MAX_REPLAN=3`，探针注入 counter=5）；两者均拦 1.0 / 仅 kill 0.6 / 其余 0.3。
3. **经验僵化探针**：扫描 7.1 extractor，按 tool 统计 active avoid 规则；`count>3` 判全网过度约束，`score = max(0.2, 1.0 - overCount*0.2)`，并在 `recommendations` 提示衰减/解封。
4. **自杀/冻结探针**：engage kill-switch 后必须阻断 `meta_decision` / `task_patch` / `dispatch`，再 disengage 允许恢复；按阻断/恢复程度记 0.2 / 0.7 / 1.0。

- **健康分**：`overallHealthScore = mean(probe scores)` 保留 2 位；`status`——`≥0.8 healthy`、`≥0.5 degraded`、`else critical`。
- **建议生成**：各失败探针映射为可执行建议串；全通过输出 "All probes passed..."。

## API

- `POST /api/meta-test/run` — 立即运行全套自检
- `GET /api/meta-test/report/latest` — 最新健康报告（无则 404）
- `GET /api/meta-test/history` — 历史体检记录（limit 默认 20、封顶 100）

## 验收标准

- 运行 Self-Test 能自动模拟死锁与 Guardrail 越权场景，准确验证 Meta 是否正确被阻断/杀死。
- 故意加入阻断全网某能力（如禁用全部 telegram 接口）的经验规则后，Rigidity Probe 能侦测并在报告提 warning 与解封建议。
- Dashboard 直观显示 0~100 健康分、各探针通过状态，并可一键手动触发全套自检。

## 未实现

- 定时 Cron 自动触发链（当前仅手动 API 触发）。
- 系统级告警推送（当前仅建议文本）。

## 回滚指南

```bash
git revert 76f25db86f417c385dfa3253436aaa118efd0
```