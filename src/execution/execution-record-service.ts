import { ExecutionRecord, ExecutionStatus} from "./execution-record.types";
import { ExecutionRecordStore } from "./execution-record-store";

const MAX_ERROR_MESSAGE_LENGTH = 2000;
const MAX_ERROR_TYPE_LENGTH = 200;

const SENSITIVE_METHODS = new Set([
    "runtime.env.get",
    "runtime.env.set",
    "runtime.env.delete",
    "runtime.env.list",
]);

export class ExecutionRecordService {
    constructor(
        private store: ExecutionRecordStore
    ) {}

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