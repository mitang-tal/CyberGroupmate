export type ExecutionStatus =
    | "success"
    | "failure"
    | "interrupted"
    | "policy_denied";

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

    source: ExecutionSource;

    method: string;

    status: ExecutionStatus;

    durationMs?: number;

    error?: {
        type?: string;
        message?: string;
    };

    createdAtMs: number;
}