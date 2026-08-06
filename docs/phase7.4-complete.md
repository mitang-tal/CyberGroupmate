# Phase 7.4 — Meta Self-Test（自检 / 健康审计全套）

## 完成时间

2026-07-30（初版） / 2026-08-07（review 补齐 #25-#28）

## Commit

```
76f25db86f417c385daf3253436a972aa118efd0  # 初版：4 探针 + 健康分 + API
9fad990  #25 加权健康分（guardrail/kill_switch 1.5，其余 1.0）
d85f347  #27 探针串行隔离（try/finally 恢复 guardrail 状态）
63b1079  #26 cron 定时自检（meta_self_test.schedule）
e5f7c65  #28 失败自动响应（system.meta_health_alert 事件）
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

- **健康分**：`overallHealthScore = weighted mean(probe scores)`（#25：guardrail/kill_switch 权重 1.5 > deadlock/rigidity 1.0，可配置 `HealthWeights`）；`status`——`≥0.8 healthy`、`≥0.5 degraded`、`else critical`。
- **建议生成**：各失败探针映射为可执行建议串；全通过输出 "All probes passed..."。

## Review 补齐（#25-#28）

1. **#25 加权健康分**：`calculateHealthScore` 由简单平均改为类别加权平均（`Σ(score×weight)/Σ(weight)`）。Guardrail Respect / Self-Kill（安全关键）权重 1.5，Deadlock / Rigidity 1.0；构造函数可注入 `healthWeights` 覆盖。engine 新增 `buildReport(probes)` 供测试与编排复用。
2. **#27 探针串行隔离**：`runGuardrailRespectProbe` / `runSelfKillProbe` 将 `toggleKillSwitch` / `setReplanCounterProvider` 包进 `try/finally`，无论探针成败都恢复到测试前状态，杜绝 kill switch 泄漏污染后续探针与真实调度。
3. **#26 cron 定时自检**：`startAutoRun(schedule, checkIntervalMs)` 按 5 字段 cron 表达式（复用 `core/cron-matcher`）周期性触发 `runFullSuite`，同一分钟去重；`stopAutoRun()` 清理。配置 `meta_self_test.schedule`（yaml `meta_self_test.schedule`）+ `check_interval_ms`，main.ts 启动时接线、shutdown 时停止。
4. **#28 失败自动响应**：engine 注入 `alertEmitter(report, changed)`；`healthy` 静默，`degraded`/`critical` 触发回调，`changed` 区分新故障与持续故障。main.ts 接入 `NotificationCenter`，推送 `system.meta_health_alert`（status / healthScore / recommendations）。

## API

- `POST /api/meta-test/run` — 立即运行全套自检
- `GET /api/meta-test/report/latest` — 最新健康报告（无则 404）
- `GET /api/meta-test/history` — 历史体检记录（limit 默认 20、封顶 100）

## 验收标准

- 运行 Self-Test 能自动模拟死锁与 Guardrail 越权场景，准确验证 Meta 是否正确被阻断/杀死。
- 故意加入阻断全网某能力（如禁用全部 telegram 接口）的经验规则后，Rigidity Probe 能侦测并在报告提 warning 与解封建议。
- Dashboard 直观显示 0~100 健康分、各探针通过状态，并可一键手动触发全套自检。
- review：#25 加权后 guardrail 单独失败比 deadlock 单独失败更严重；#27 探针中途崩溃不泄漏 kill switch；#26 cron 命中触发/未命中不触发/同分钟去重；#28 critical 告警、healthy 静默、状态转移 `changed` 标记。全部由 `scripts/phase74-meta-test-verify.ts` 覆盖（15 断言）。

## 未实现

- 自检失败后的主动自愈动作（当前仅事件告警，由下游消费）。

## 回滚指南

```bash
git revert 76f25db86f417c385dfa3253436aaa118efd0
```