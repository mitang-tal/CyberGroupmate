// execution-record-store.ts
import { ExecutionRecord,ExecutionStatus } from "./execution-record.types";

export interface ExecutionRecordStore {
    insert(record: ExecutionRecord): void;

    query(options: {
        sessionId?: string;
        runId?: string;
        taskId?: string;
        method?: string;
        status?: ExecutionStatus;
    }): ExecutionRecord[];
}
