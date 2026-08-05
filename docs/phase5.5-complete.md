# Phase 5.5 — Execution Alerting & Anomaly Detection v1

## 完成时间

2026-07-30

## Commit

```
62f940081788c38aa6145d6dd9e444d080fe20b2
```

## 目标

将 Execution 系统的观测能力从"被动查询（人看 Dashboard）"升级为"主动感知（系统主动抛出 Alert）"，为后续 Meta 自愈/重试机制打下基础。

## 架构

```
Execution Analytics / Logs
        │
        ▼
Execution Anomaly Detector (规则引擎 + 降噪)
        │
        ▼
Alert Store (ExecutionAlert)
        │
        ├──► Dashboard (execution-alerts.html)
        │
        └──► Meta Node API (getAlertContext)
```

## 修改文件

| 文件 | 变更 |
|------|------|
| `src/execution/execution-record.types.ts` | 新增 `ExecutionAlert`, `CreateAlertPayload`, `AlertRuleType`, `AlertSeverity`, `AlertStatus` 类型 |
| `src/execution/alert-store.ts` | **新文件** — AlertStore 接口：`insertOrUpdate()`, `getById()`, `query()`, `updateStatus()`, `getActiveAlertCount()` |
| `src/execution/sqlite-alert-store.ts` | **新文件** — SQLite 实现：`execution_alerts` 表，带冷却去重的 `insertOrUpdate()`，状态更新 |
| `src/execution/execution-anomaly-detector.ts` | **新文件** — 规则引擎：4 条检测规则 + 风暴频控 |
| `src/execution/execution-record-service.ts` | 构造器注入 AlertStore；新增 `createAlert()`, `queryAlerts()`, `updateAlertStatus()`, `getAlertContext()`, `getActiveAlertCount()` |
| `src/dashboard/api-routes.ts` | 新增 5 个 `/api/execution-alerts/*` 路由 |
| `src/dashboard/public/execution-alerts.html` | **新文件** — Alerts Dashboard：列表、筛选、详情弹窗、Acknowledge/Resolve 操作 |

## 异常规则

| 规则 | 触发条件 | Severity | 冷却 |
|------|----------|----------|------|
| `EXECUTION_TIMEOUT` | status=timed_out | high | 1min |
| `CONTINUOUS_FAILURE` | 同一方法连续失败 ≥3 次（1h 内） | high | 1min |
| `FAILURE_RATE_SPIKE` | 5min 窗口内失败率 ≥50%（样本 ≥5） | high/critical | 1min |
| `ERROR_CLUSTER` | 同 error_type 在 2min 内出现 ≥5 次 | medium | 1min |

## 防风暴控制

同一 `ruleType` + `sourceComponent` 在冷却期内（默认 60s）触发：
- 不新建 Alert
- 递增 `occurrenceCount`
- 更新 `lastObservedAtMs`
- 更新 `contextSummary`

## API 端点

| 路由 | 方法 | 说明 |
|------|------|------|
| `GET /api/execution-alerts` | 查询 | 支持 status/severity/ruleType 过滤, 分页 |
| `GET /api/execution-alerts/count` | 活跃数 | `{ active: number }` |
| `POST /api/execution-alerts/:id/acknowledge` | 确认 | status → acknowledged |
| `POST /api/execution-alerts/:id/resolve` | 解决 | status → resolved + resolvedAtMs |
| `GET /api/execution-alerts/:id/context` | 上下文 | 供 Meta 消费：包含 alert 详情 + 关联执行记录 + Trace Tree |

## Dashboard 功能

- 按 Status / Severity 筛选
- Severity 彩色标签（critical=红, high=黄, medium=绿, low=蓝）
- 点击行打开详情弹窗
- 详情弹窗显示：规则类型、Severity、Source、出现次数、Message、Error Logs、Metrics、关联 Execution、Trace
- Acknowledge / Resolve 按钮

## 验收标准

| 标准 | 状态 |
|------|------|
| 规则触发：模拟失败可自动生成 active Alert | ✅ AnomalyDetector.checkContinuousFailure/FailureRateSpike/Timeout/ErrorCluster |
| 频控验证：高频触发不生成冗余 Alert | ✅ SqliteAlertStore.insertOrUpdate 冷却期聚合 |
| Meta 上下文调取：getAlertContext 返回完整 JSON | ✅ 含 alert + relatedExecution + executionTrace |
| 前端闭环：可查看 Alert + 标记 Resolved | ✅ Dashboard 弹窗 + Acknowledge/Resolve |

## 已知问题

1. **主动触发入口**：当前 `ExecutionAnomalyDetector.onExecutionCompleted()` 需要调用方在每次 execution 完成后显式调用。尚未接入 sandbox/host-call-handler/code-act-executor 的完成回调（Phase 5.6 接入）。
2. **规则阈值可配置**：当前阈值硬编码为 `DEFAULT_CONFIG`，可通过构造器传入 `Partial<AnomalyDetectorConfig>` 覆盖。
3. **getAlertContext 的 Trace 深度**：当前使用 `getTrace()` 递归获取完整树，深度默认 10，复杂链可能较大。

## 回滚指南

```bash
git revert 62f940081788c38aa6145d6dd9e444d080fe20b2
```
