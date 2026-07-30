import { ExecutionRecord, ExecutionStatus, ExecutionTreeNode, ExecutionTimeline, ExecutionAnalytics, SourceAnalytics, MethodAnalytics, SlowExecution, ExecutionAlert, CreateAlertPayload, AlertStatus, AlertRuleType, AlertSeverity } from "./execution-record.types";
import { ExecutionRecordStore, type ExecutionStats } from "./execution-record-store";
import type { AlertStore } from "./alert-store";

const MAX_ERROR_MESSAGE_LENGTH = 2000;
const MAX_ERROR_TYPE_LENGTH = 200;

const SENSITIVE_METHODS = new Set([
    "runtime.env.get",
    "runtime.env.set",
    "runtime.env.delete",
    "runtime.env.list",
]);

const TERMINAL_STATUSES: ReadonlySet<ExecutionStatus> = new Set([
    "success",
    "failure",
    "interrupted",
    "policy_denied",
    "timed_out",
]);

const VALID_TRANSITIONS: Record<ExecutionStatus, ExecutionStatus[]> = {
    pending: ["running", "policy_denied"],
    running: ["success", "failure", "interrupted", "timed_out"],
    success: [],
    failure: [],
    interrupted: [],
    policy_denied: [],
    timed_out: [],
};

export class ExecutionRecordService {
    constructor(
        private store: ExecutionRecordStore,
        private alertStore?: AlertStore,
    ) {}

    // ──────────────────────────────────────────────
    //  Lifecycle methods
    // ──────────────────────────────────────────────

    start(params: {
        runId?: string;
        sessionId?: string;
        taskId?: string;
        agentId?: string;

        parentId?: string;
        sequence?: number;

        source: ExecutionRecord["source"];
        method: string;

        timeoutMs?: number;
    }): string {
        const id = crypto.randomUUID();

        this.store.insert({
            id,
            runId: params.runId,
            sessionId: params.sessionId,
            taskId: params.taskId,
            agentId: params.agentId,

            parentId: params.parentId,
            sequence: params.sequence,

            source: params.source,
            method: params.method,

            status: "pending",

            timeoutMs: params.timeoutMs,

            createdAtMs: Date.now(),
        });

        return id;
    }

    markRunning(id: string): void {
        const record = this.store.getById(id);
        if (!record) return;

        this.transition(record, "running");
        this.store.update(id, { startedAtMs: Date.now() });
    }

    complete(id: string, status: ExecutionStatus, extra?: {
        durationMs?: number;
        error?: { type?: string; message?: string };
    }): void {
        const record = this.store.getById(id);
        if (!record) return;

        // ═══ completeOnce protection: only running/pending can complete ═══
        if (record.status !== "running" && record.status !== "pending") {
            return;
        }

        const now = Date.now();
        const patch: Partial<ExecutionRecord> = {
            completedAtMs: now,
        };

        if (extra?.durationMs !== undefined) {
            patch.durationMs = extra.durationMs;
        } else {
            // Auto-calculate from startedAtMs if available
            if (record.startedAtMs !== undefined) {
                patch.durationMs = now - record.startedAtMs;
            }
        }

        if (extra?.error) {
            patch.error = {
                type: extra.error.type?.slice(0, MAX_ERROR_TYPE_LENGTH),
                message: extra.error.message?.slice(0, MAX_ERROR_MESSAGE_LENGTH),
            };
        }

        this.transition(record, status);
        this.store.update(id, { ...patch, status });
    }

    private transition(current: ExecutionRecord, to: ExecutionStatus): void {
        const allowed = VALID_TRANSITIONS[current.status];
        if (!allowed || !allowed.includes(to)) {
            console.warn(
                `ExecutionRecordService: invalid transition ${current.status} -> ${to} for ${current.id}`
            );
            return;
        }
    }

    // ──────────────────────────────────────────────
    //  Convenience methods (old-style, now using lifecycle)
    // ──────────────────────────────────────────────

    record(record: ExecutionRecord): void {
        const sanitized: ExecutionRecord = {
            ...record,
            error: record.error
                ? {
                    type: record.error.type
                        ?.slice(0, MAX_ERROR_TYPE_LENGTH),
                    message: record.error.message
                        ?.slice(0, MAX_ERROR_MESSAGE_LENGTH),
                }
                : undefined,
        };

        if (SENSITIVE_METHODS.has(record.method)) {
            // Reserved:
            // Do not add args/result fields without filtering these methods.
        }

        this.store.insert(sanitized);
    }

    recordHostCall(params: {
        runId?: string;
        sessionId?: string;
        taskId?: string;
        agentId?: string;

        method: string;

        status: ExecutionStatus;

        durationMs?: number;

        error?: {
            type?: string;
            message?: string;
        };
    }): void {
        this.record({
            id: crypto.randomUUID(),
            runId: params.runId,
            sessionId: params.sessionId,
            taskId: params.taskId,
            agentId: params.agentId,

            source: "sandbox",

            method: params.method,

            status: params.status,

            durationMs: params.durationMs,

            error: params.error,

            createdAtMs: Date.now(),
        });
    }

    recordAgentTurn(params: {
        sessionId?: string;
        runId?: string;
        taskId?: string;
        agentId?: string;

        status: ExecutionStatus;

        durationMs?: number;

        error?: {
            type?: string;
            message?: string;
        };
    }): void {
        this.record({
            id: crypto.randomUUID(),
            runId: params.runId,
            sessionId: params.sessionId,
            taskId: params.taskId,
            agentId: params.agentId,

            source: "agent",

            method: "agent.turn",

            status: params.status,

            durationMs: params.durationMs,

            error: params.error,

            createdAtMs: Date.now(),
        });
    }

    recordSandboxExecution(params: {
        sessionId?: string;
        runId?: string;
        taskId?: string;
        agentId?: string;

        status: ExecutionStatus;

        durationMs?: number;

        error?: {
            type?: string;
            message?: string;
        };
    }): void {
        this.record({
            id: crypto.randomUUID(),
            runId: params.runId,
            sessionId: params.sessionId,
            taskId: params.taskId,
            agentId: params.agentId,

            source: "sandbox",

            method: "sandbox.execute",

            status: params.status,

            durationMs: params.durationMs,

            error: params.error,

            createdAtMs: Date.now(),
        });
    }

    // ──────────────────────────────────────────────
    //  Analytics
    // ──────────────────────────────────────────────

    getAnalytics(): ExecutionAnalytics {
        return this.store.queryAnalytics();
    }

    getErrorSummary(): { errorType: string; count: number; lastOccurredAtMs: number }[] {
        const analytics = this.store.queryAnalytics();
        return analytics.errorRanking;
    }

    getSlowExecutions(limit = 10): SlowExecution[] {
        const analytics = this.store.queryAnalytics();
        return analytics.slowExecutions.slice(0, limit);
    }

    getSourceAnalytics(): SourceAnalytics[] {
        const analytics = this.store.queryAnalytics();
        return analytics.bySource;
    }

    getMethodAnalytics(): MethodAnalytics[] {
        const analytics = this.store.queryAnalytics();
        return analytics.byMethod;
    }

    // ──────────────────────────────────────────────
    //  Alerting
    // ──────────────────────────────────────────────

    createAlert(payload: CreateAlertPayload, cooldownMs?: number): ExecutionAlert | undefined {
        return this.alertStore?.insertOrUpdate(payload, cooldownMs);
    }

    queryAlerts(options: {
        status?: AlertStatus;
        severity?: AlertSeverity;
        ruleType?: AlertRuleType;
        sourceComponent?: string;
        limit?: number;
        offset?: number;
    }): ExecutionAlert[] {
        return this.alertStore?.query(options) ?? [];
    }

    updateAlertStatus(alertId: string, status: AlertStatus): void {
        this.alertStore?.updateStatus(alertId, status);
    }

    getAlertContext(alertId: string): object | undefined {
        const alert = this.alertStore?.getById(alertId);
        if (!alert) return undefined;

        // Build rich context for Meta consumption
        const context: Record<string, unknown> = {
            alertId: alert.alertId,
            ruleType: alert.ruleType,
            severity: alert.severity,
            status: alert.status,
            sourceComponent: alert.sourceComponent,
            occurrenceCount: alert.occurrenceCount,
            contextSummary: alert.contextSummary,
            createdAt: new Date(alert.createdAtMs).toISOString(),
            lastObservedAt: new Date(alert.lastObservedAtMs).toISOString(),
        };

        // Attach related execution if available
        if (alert.executionId) {
            const record = this.store.getById(alert.executionId);
            if (record) {
                context.relatedExecution = {
                    id: record.id,
                    source: record.source,
                    method: record.method,
                    status: record.status,
                    durationMs: record.durationMs,
                    error: record.error,
                };
                // Also attach trace tree
                try {
                    const tree = this.getTrace(alert.executionId);
                    if (tree) {
                        context.executionTrace = tree;
                    }
                } catch {
                    // Silently skip if trace fails
                }
            }
        }

        return context;
    }

    getActiveAlertCount(): number {
        return this.alertStore?.getActiveAlertCount() ?? 0;
    }

    getById(id: string): ExecutionRecord | undefined {
        return this.store.getById(id);
    }

    getActive(): ExecutionRecord[] {
        return this.store.queryActive();
    }

    getTrace(id: string): ExecutionTreeNode | undefined {
        const record = this.store.getById(id);
        if (!record) return undefined;

        // If this record has a parent, return the full tree from the root
        if (record.parentId) {
            return this.store.getExecutionTree(record.parentId);
        }

        return this.store.getExecutionTree(id);
    }

    getTimeline(id: string): ExecutionTimeline | undefined {
        const record = this.store.getById(id);
        if (!record) return undefined;

        const events: ExecutionTimeline["events"] = [
            { type: "created", atMs: record.createdAtMs, label: "Execution created" },
        ];

        if (record.startedAtMs !== undefined) {
            events.push({ type: "started", atMs: record.startedAtMs, label: "Execution started" });
        }

        if (record.completedAtMs !== undefined) {
            events.push({ type: "completed", atMs: record.completedAtMs, label: "Execution completed" });
        }

        events.sort((a, b) => a.atMs - b.atMs);

        const timeline: ExecutionTimeline = {
            id: record.id,
            events,
        };

        if (record.startedAtMs !== undefined) {
            timeline.queueTimeMs = record.startedAtMs - record.createdAtMs;
        }

        if (record.startedAtMs !== undefined && record.completedAtMs !== undefined) {
            timeline.runTimeMs = record.completedAtMs - record.startedAtMs;
        }

        if (record.completedAtMs !== undefined) {
            timeline.totalTimeMs = record.completedAtMs - record.createdAtMs;
        }

        return timeline;
    }

    listByTask(taskId: string): ExecutionRecord[] {
        return this.store.query({
            taskId,
        });
    }

    listByRun(runId: string): ExecutionRecord[] {
        return this.store.query({
            runId,
        });
    }

    listBySession(sessionId: string): ExecutionRecord[] {
        return this.store.query({
            sessionId,
        });
    }

    listRecent(params: {
        limit?: number;
        offset?: number;
        source?: string;
        status?: ExecutionStatus;
        method?: string;
    }): ExecutionRecord[] {
        return this.store.query({
            source: params.source,
            status: params.status,
            method: params.method,
            limit: params.limit,
            offset: params.offset,
        });
    }

    getStats(): ExecutionStats {
        return this.store.queryStats();
    }

    listFailures(limit = 50): ExecutionRecord[] {
        return this.store.query({
            status: "failure",
        }).slice(0, limit);
    }

    listByMethod(method: string): ExecutionRecord[] {
        return this.store.query({
            method,
        });
    }
}