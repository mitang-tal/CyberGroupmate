export interface ExecutionContext {
    runId: string;

    sessionId?: string;

    taskId?: string;

    agentId?: string;

    /** 当前执行链中最近的 executionId，用于子执行设置 parentId */
    executionId?: string;
}