export type ExecutionStatus =
    | "pending"
    | "running"
    | "success"
    | "failure"
    | "interrupted"
    | "policy_denied"
    | "timed_out";

export type ExecutionSource =
    | "sandbox"
    | "meta"
    | "adapter"
    | "system"
    | "agent"
    | "host_call";

/**
 * 失败分类（Audit Fix Phase 1.1）
 * - policy_denied: 治理拦截（Kill Switch / 护栏）——不进入失败经验库
 * - execution_error: 真实执行错误
 * - timeout: 超时
 * - capability_error: 能力/方法不存在或不可用
 */
export type FailureCategoryCode =
    | "policy_denied"
    | "execution_error"
    | "timeout"
    | "capability_error";

export interface ExecutionRecord {
    id: string;
    runId?: string;
    sessionId?: string;
    taskId?: string;
    agentId?: string;

    parentId?: string;
    sequence?: number;

    /** Meta 决策执行关联的决策 id（decisionId → execution 端到端可回溯） */
    decisionId?: string;
    /** Meta 决策真实验证结果（真实回读 ExecutionRecord 状态后产出，非标志位） */
    verificationResult?: {
        verifiedAtMs: number;
        executionId: string;
        executionStatus: string;
        verified: boolean;
        detail: string;
    };

    source: ExecutionSource;

    method: string;

    status: ExecutionStatus;

    /** 失败分类（用于区分治理拦截与真实执行错误，policy_denied 不进入失败经验库） */
    failureCategory?: FailureCategoryCode;

    durationMs?: number;
    timeoutMs?: number;

    error?: {
        type?: string;
        message?: string;
    };

    createdAtMs: number;
    startedAtMs?: number;
    completedAtMs?: number;
}

export interface ExecutionTreeNode {
    record: ExecutionRecord;
    children: ExecutionTreeNode[];
}

export interface ExecutionTimelineEvent {
    type: "created" | "started" | "completed";
    atMs: number;
    label: string;
}

export interface ExecutionTimeline {
    id: string;
    events: ExecutionTimelineEvent[];
    queueTimeMs?: number;
    runTimeMs?: number;
    totalTimeMs?: number;
}

// ──────────────────────────────────────────────
//  Analytics types
// ──────────────────────────────────────────────

export interface ExecutionAnalyticsOverview {
    totalExecutions: number;
    successCount: number;
    failureCount: number;
    interruptedCount: number;
    timedOutCount: number;
    policyDeniedCount: number;
    successRate: number;
    avgDurationMs: number;
    maxDurationMs: number;
}

export interface SourceAnalytics {
    source: string;
    count: number;
    failureCount: number;
    successRate: number;
    avgDurationMs: number;
}

export interface MethodAnalytics {
    method: string;
    source: string;
    count: number;
    failureCount: number;
    successRate: number;
    avgDurationMs: number;
}

export interface ErrorAnalytics {
    errorType: string;
    count: number;
    lastOccurredAtMs: number;
}

export interface SlowExecution {
    id: string;
    source: string;
    method: string;
    status: string;
    durationMs: number;
    createdAtMs: number;
}

export interface ExecutionAnalytics {
    overview: ExecutionAnalyticsOverview;
    statusDistribution: { status: string; count: number }[];
    bySource: SourceAnalytics[];
    byMethod: MethodAnalytics[];
    errorRanking: ErrorAnalytics[];
    slowExecutions: SlowExecution[];
}

// ──────────────────────────────────────────────
//  Alerting types
// ──────────────────────────────────────────────

export type AlertRuleType =
    | "CONTINUOUS_FAILURE"
    | "FAILURE_RATE_SPIKE"
    | "EXECUTION_TIMEOUT"
    | "ERROR_CLUSTER";

export type AlertSeverity = "low" | "medium" | "high" | "critical";

export type AlertStatus = "active" | "acknowledged" | "resolved";

export interface ExecutionAlert {
    alertId: string;
    ruleType: AlertRuleType;
    severity: AlertSeverity;
    status: AlertStatus;
    sourceComponent: string;
    executionId?: string;
    occurrenceCount: number;
    contextSummary: {
        message: string;
        sampleErrorLogs?: string[];
        metricsSnapshot?: Record<string, unknown>;
    };
    createdAtMs: number;
    lastObservedAtMs: number;
    resolvedAtMs?: number;
}

export interface CreateAlertPayload {
    ruleType: AlertRuleType;
    severity: AlertSeverity;
    sourceComponent: string;
    executionId?: string;
    contextSummary: {
        message: string;
        sampleErrorLogs?: string[];
        metricsSnapshot?: Record<string, unknown>;
    };
}

// ──────────────────────────────────────────────
//  Healing types
// ──────────────────────────────────────────────

export type HealingStrategy = "retry" | "fallback" | "meta_diagnosis" | "escalate";

export type HealingActionStatus = "pending" | "in_progress" | "succeeded" | "failed";

export interface ExecutionHealingAction {
    actionId: string;
    alertId: string;
    executionId: string;
    strategy: HealingStrategy;
    status: HealingActionStatus;
    attemptCount: number;
    decisionReason: string;
    actionDetails?: Record<string, unknown>;
    error?: string;
    createdAtMs: number;
    completedAtMs?: number;
}