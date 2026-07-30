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

export interface ExecutionRecord {
    id: string;
    runId?: string;
    sessionId?: string;
    taskId?: string;
    agentId?: string;

    parentId?: string;
    sequence?: number;

    source: ExecutionSource;

    method: string;

    status: ExecutionStatus;

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