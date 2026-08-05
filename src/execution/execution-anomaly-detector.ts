/**
 * ExecutionAnomalyDetector — 规则引擎 + 降噪
 *
 * 监听 ExecutionRecord 完成事件，检测异常并触发 Alert。
 *
 * 规则：
 * - CONTINUOUS_FAILURE: 某方法连续失败 N 次
 * - FAILURE_RATE_SPIKE: 滑动窗口内失败率超过阈值
 * - EXECUTION_TIMEOUT: 单次执行耗时超过阈值
 * - ERROR_CLUSTER: 某错误类型在短时间内大量出现
 */

import type { ExecutionRecord, ExecutionStatus, AlertRuleType, AlertSeverity, CreateAlertPayload } from "./execution-record.types";
import type { ExecutionRecordStore } from "./execution-record-store";
import type { ExecutionRecordService } from "./execution-record-service";

export interface AnomalyDetectorConfig {
    /** 连续失败次数阈值 */
    continuousFailureThreshold: number;
    /** 失败率窗口大小（毫秒） */
    failureRateWindowMs: number;
    /** 失败率阈值（百分比） */
    failureRateThresholdPercent: number;
    /** 耗时 P95 倍数阈值（相对平均耗时） */
    durationMultiplierThreshold: number;
    /** 错误聚类窗口（毫秒） */
    errorClusterWindowMs: number;
    /** 错误聚类触发次数 */
    errorClusterThreshold: number;
    /** 冷却时间（毫秒） */
    cooldownMs: number;
}

const DEFAULT_CONFIG: AnomalyDetectorConfig = {
    continuousFailureThreshold: 3,
    failureRateWindowMs: 5 * 60 * 1000,  // 5 minutes
    failureRateThresholdPercent: 50,
    durationMultiplierThreshold: 3,
    errorClusterWindowMs: 2 * 60 * 1000, // 2 minutes
    errorClusterThreshold: 5,
    cooldownMs: 60 * 1000, // 1 minute
};

export class ExecutionAnomalyDetector {
    private config: AnomalyDetectorConfig;
    private store: ExecutionRecordStore;
    private service: ExecutionRecordService;

    constructor(
        store: ExecutionRecordStore,
        service: ExecutionRecordService,
        config?: Partial<AnomalyDetectorConfig>,
    ) {
        this.store = store;
        this.service = service;
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    /**
     * 入口：每次 execution 完成后调用
     */
    onExecutionCompleted(record: ExecutionRecord): void {
        if (!this.service.createAlert) return;

        // 1. Check timeout
        this.checkTimeout(record);

        if (record.status === "failure" || record.status === "timed_out") {
            // 2. Check continuous failure
            this.checkContinuousFailure(record);

            // 3. Check failure rate spike
            this.checkFailureRateSpike(record);

            // 4. Check error cluster
            if (record.error?.type) {
                this.checkErrorCluster(record);
            }
        }
    }

    private createAlert(ruleType: AlertRuleType, severity: AlertSeverity, sourceComponent: string, executionId: string, message: string, errorLogs?: string[], metrics?: Record<string, unknown>): void {
        const payload: CreateAlertPayload = {
            ruleType,
            severity,
            sourceComponent,
            executionId,
            contextSummary: {
                message,
                sampleErrorLogs: errorLogs,
                metricsSnapshot: metrics,
            },
        };
        this.service.createAlert(payload, this.config.cooldownMs);
    }

    // ─── Rule 1: Timeout ───

    private checkTimeout(record: ExecutionRecord): void {
        if (record.status !== "timed_out") return;

        this.createAlert(
            "EXECUTION_TIMEOUT",
            "high",
            record.method,
            record.id,
            `Execution timed out: ${record.method} (source=${record.source})`,
            undefined,
            {
                durationMs: record.durationMs,
                timeoutMs: record.timeoutMs,
                source: record.source,
            },
        );
    }

    // ─── Rule 2: Continuous Failure ───

    private checkContinuousFailure(record: ExecutionRecord): void {
        const threshold = this.config.continuousFailureThreshold - 1; // current failure counts as 1
        if (threshold <= 0) return;

        // Count recent consecutive failures for the same method.
        // 当前 record 已入库（detector 在 complete() 后调用），query 会包含它，
        // 因此 limit 用 threshold + 1，排除当前记录后仍能凑够 threshold 个先前失败。
        const recent = this.store.query({
            method: record.method,
            status: "failure" as ExecutionStatus,
            limit: threshold + 1,
        });

        // Exclude current record, check if we have `threshold` consecutive failures
        const otherFailures = recent.filter(r => r.id !== record.id);
        if (otherFailures.length < threshold) return;

        // Verify they are within a reasonable time window (last hour)
        const oneHourAgo = Date.now() - 3600_000;
        const recentEnough = otherFailures.filter(r => r.createdAtMs > oneHourAgo);
        if (recentEnough.length < threshold) return;

        this.createAlert(
            "CONTINUOUS_FAILURE",
            "high",
            record.method,
            record.id,
            `Method "${record.method}" failed ${recentEnough.length + 1} times consecutively`,
            [record.error?.message].filter(Boolean) as string[],
            {
                failureCount: recentEnough.length + 1,
                method: record.method,
                source: record.source,
            },
        );
    }

    // ─── Rule 3: Failure Rate Spike ───

    private checkFailureRateSpike(record: ExecutionRecord): void {
        const windowStart = Date.now() - this.config.failureRateWindowMs;

        // Get total executions for this method in the window
        const allForMethod = this.store.query({
            method: record.method,
            limit: 1000,
        }).filter(r => r.createdAtMs > windowStart && r.status !== "pending" && r.status !== "running");

        const totalInWindow = allForMethod.length;
        if (totalInWindow < 5) return; // Not enough data

        const failedInWindow = allForMethod.filter(r =>
            r.status === "failure" || r.status === "timed_out"
        ).length;

        const ratePercent = (failedInWindow / totalInWindow) * 100;
        if (ratePercent < this.config.failureRateThresholdPercent) return;

        this.createAlert(
            "FAILURE_RATE_SPIKE",
            ratePercent >= 80 ? "critical" : "high",
            record.method,
            record.id,
            `Failure rate spike for "${record.method}": ${ratePercent.toFixed(0)}% (${failedInWindow}/${totalInWindow}) in last ${this.config.failureRateWindowMs / 60000}min`,
            [record.error?.message].filter(Boolean) as string[],
            {
                failureRatePercent: Math.round(ratePercent * 10) / 10,
                failedCount: failedInWindow,
                totalCount: totalInWindow,
                windowMs: this.config.failureRateWindowMs,
                method: record.method,
            },
        );
    }

    // ─── Rule 4: Error Cluster ───

    private checkErrorCluster(record: ExecutionRecord): void {
        const errorType = record.error?.type;
        if (!errorType) return;

        const windowStart = Date.now() - this.config.errorClusterWindowMs;

        // Count same error type in the window
        // 当前 record 已入库，limit 用 threshold + 1 避免当前记录挤掉真实历史
        const recentErrors = this.store.query({
            status: "failure" as ExecutionStatus,
            limit: this.config.errorClusterThreshold + 1,
        }).filter(r =>
            r.id !== record.id &&
            r.createdAtMs > windowStart &&
            r.error?.type === errorType
        );

        const totalInCluster = recentErrors.length + 1; // +1 for current
        if (totalInCluster < this.config.errorClusterThreshold) return;

        this.createAlert(
            "ERROR_CLUSTER",
            "medium",
            errorType,
            record.id,
            `Error type "${errorType}" occurred ${totalInCluster} times in ${this.config.errorClusterWindowMs / 60000}min`,
            [errorType, record.error?.message].filter(Boolean) as string[],
            {
                errorType,
                occurrenceCount: totalInCluster,
                windowMs: this.config.errorClusterWindowMs,
            },
        );
    }
}
