// execution-record-store.ts
import { ExecutionRecord, ExecutionStatus, ExecutionTreeNode } from "./execution-record.types";

export interface ExecutionSourceStats {
    source: string;
    count: number;
}

export interface ExecutionStatusStats {
    status: string;
    count: number;
}

export interface ExecutionErrorStats {
    errorType: string;
    count: number;
}

export interface ExecutionStats {
    total: number;
    bySource: ExecutionSourceStats[];
    byStatus: ExecutionStatusStats[];
    errorDistribution: ExecutionErrorStats[];
}

export interface ExecutionRecordStore {
    insert(record: ExecutionRecord): void;

    update(id: string, patch: Partial<ExecutionRecord>): void;

    getById(id: string): ExecutionRecord | undefined;

    getChildren(parentId: string): ExecutionRecord[];

    getExecutionTree(id: string, maxDepth?: number): ExecutionTreeNode | undefined;

    queryActive(): ExecutionRecord[];

    query(options: {
        sessionId?: string;
        runId?: string;
        taskId?: string;
        method?: string;
        status?: ExecutionStatus;
        source?: string;
        limit?: number;
        offset?: number;
    }): ExecutionRecord[];

    queryStats(): ExecutionStats;
}
