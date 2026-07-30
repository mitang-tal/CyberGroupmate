import { ExecutionRecord, ExecutionStatus } from "./execution-record.types";
import { ExecutionRecordStore, type ExecutionStats } from "./execution-record-store";

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
        private store: ExecutionRecordStore
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
    //  Query helpers
    // ──────────────────────────────────────────────

    getById(id: string): ExecutionRecord | undefined {
        return this.store.getById(id);
    }

    getActive(): ExecutionRecord[] {
        return this.store.queryActive();
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