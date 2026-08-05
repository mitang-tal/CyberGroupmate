# Phase 5.4 — Execution Analytics v1

## 完成时间

2026-07-30

## Commit

```
826c086af865e1e245b02713bbb3400a1502fd48
```

## 目标

将 Execution 从"记录执行过程"升级为"分析执行质量"。

系统现在可以回答：
- 当前 Agent 运行是否健康？（成功率、状态分布）
- 最近失败主要原因？（错误聚合排行）
- 哪些工具最容易失败？（Method Analytics）
- 哪些执行最耗时？（Slow Executions）
- 哪些异常正在重复发生？（Error Ranking）

## 数据模型

| 类型 | 字段 |
|------|------|
| `ExecutionAnalyticsOverview` | totalExecutions, successCount, failureCount, interruptedCount, timedOutCount, policyDeniedCount, successRate, avgDurationMs, maxDurationMs |
| `SourceAnalytics` | source, count, failureCount, successRate, avgDurationMs |
| `MethodAnalytics` | method, source, count, failureCount, successRate, avgDurationMs |
| `ErrorAnalytics` | errorType, count, lastOccurredAtMs |
| `SlowExecution` | id, source, method, status, durationMs, createdAtMs |
| `ExecutionAnalytics` | overview, statusDistribution, bySource, byMethod, errorRanking, slowExecutions |

## 修改文件

| 文件 | 变更 |
|------|------|
| `src/execution/execution-record.types.ts` | 新增 6 个 Analytics 类型定义 |
| `src/execution/execution-record-store.ts` | 接口新增 `queryAnalytics()` |
| `src/execution/sqlite-execution-record-store.ts` | 实现 `queryAnalytics()`：6 条 SQL 实时聚合（overview, status, source, method, error, slow） |
| `src/execution/execution-record-service.ts` | 新增 `getAnalytics()`, `getErrorSummary()`, `getSlowExecutions()`, `getSourceAnalytics()`, `getMethodAnalytics()` |
| `src/dashboard/api-routes.ts` | 新增 6 个 `/api/execution-analytics/*` 路由 |
| `src/dashboard/public/execution-analytics.html` | **新文件** — Analytics 仪表盘页面 |

## 设计原则

- **直接基于 execution_records 实时聚合**，不新增统计表
- 数据量当前可控，保持 Execution 单一事实来源
- 未来数据量增长后再考虑独立 Analytics 存储

## API 端点

| 路由 | 返回 |
|------|------|
| `GET /api/execution-analytics/overview` | `ExecutionAnalyticsOverview` |
| `GET /api/execution-analytics/full` | `ExecutionAnalytics`（完整） |
| `GET /api/execution-analytics/errors` | `ErrorAnalytics[]` |
| `GET /api/execution-analytics/slow?limit=10` | `SlowExecution[]` |
| `GET /api/execution-analytics/by-source` | `SourceAnalytics[]` |
| `GET /api/execution-analytics/by-method` | `MethodAnalytics[]` |

## Dashboard 页面

页面 `/execution-analytics.html` 包含：

- **Overview 卡片**：Total、Success Rate、Failures、Avg Duration、Max Duration、Timed Out
- **Status Distribution**：带百分比条形图的状态分布表
- **By Source**：按执行来源统计（调用次数、失败数、成功率、平均耗时）
- **By Method**：按具体方法统计（Top 50）
- **Error Ranking**：高频错误类型排行（错误类型、出现次数、最近出现时间）
- **Slow Executions**：耗时最高的执行（Top 20）

## 完成状态

Phase 5.4 完成后，Execution 系统具备：

| 能力 | Phase |
|------|-------|
| 记录执行生命周期 | 5.2 ✅ |
| 理解执行调用链 | 5.3 ✅ |
| 分析执行质量 | 5.4 ✅ |

Execution 已成为 Agent 运行观测、诊断和优化的基础设施。

## 已知问题

1. **实时聚合性能**：当前所有统计直接在 `execution_records` 表上 `GROUP BY` + `AVG` + `COUNT`，数据量大时可能变慢。后续可考虑缓存或物化视图。
2. **成功率计算**：成功率的分子是 success，分母是 terminal 状态（success + failure + interrupted + timed_out + policy_denied），pending/running 不计入。
3. **错误聚合**：`error_type` 为 NULL 的执行不计入错误排行，仅统计有明确错误类型的失败记录。

## 回滚指南

```bash
git revert 826c086af865e1e245b02713bbb3400a1502fd48
```
