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