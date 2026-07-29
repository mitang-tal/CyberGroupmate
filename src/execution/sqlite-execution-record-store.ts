import Database from "better-sqlite3";
import { ExecutionRecord, ExecutionStatus} from "./execution-record.types";
import { ExecutionRecordStore, type ExecutionStats } from "./execution-record-store";

export class SqliteExecutionRecordStore
    implements ExecutionRecordStore {

    private db: Database.Database;

    constructor(dbPath: string) {
        this.db = new Database(dbPath);
        this.db.pragma("journal_mode = WAL");
        this.initTables();
    }

    private initTables() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS execution_records (
                id TEXT PRIMARY KEY,
                run_id TEXT,
                session_id TEXT,
                task_id TEXT,
                agent_id TEXT,
                source TEXT,
                method TEXT NOT NULL,
                status TEXT NOT NULL,
                duration_ms INTEGER,
                error_type TEXT,
                error_message TEXT,
                created_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_exec_run
            ON execution_records(run_id);

            CREATE INDEX IF NOT EXISTS idx_exec_session
            ON execution_records(session_id);

            CREATE INDEX IF NOT EXISTS idx_exec_task
            ON execution_records(task_id);

            CREATE INDEX IF NOT EXISTS idx_exec_method
            ON execution_records(method);

            CREATE INDEX IF NOT EXISTS idx_exec_status
            ON execution_records(status);

            CREATE INDEX IF NOT EXISTS idx_exec_created
            ON execution_records(created_at);
        `);
    }

    insert(record: ExecutionRecord) {
        this.db.prepare(`
            INSERT INTO execution_records (
                id,
                run_id,
                session_id,
                task_id,
                agent_id,
                source,
                method,
                status,
                duration_ms,
                error_type,
                error_message,
                created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            record.id,
            record.runId ?? null,
            record.sessionId ?? null,
            record.taskId ?? null,
            record.agentId ?? null,
            record.source,
            record.method,
            record.status,
            record.durationMs ?? null,
            record.error?.type ?? null,
            record.error?.message ?? null,
            record.createdAtMs
        );
    }


    query(options: {
    runId?: string;
    sessionId?: string;
    taskId?: string;
    method?: string;
    status?: ExecutionStatus;
    source?: string;
    limit?: number;
    offset?: number;
}): ExecutionRecord[] {

	let sql = `
        SELECT
            id,
            run_id,
            session_id,
            task_id,
            agent_id,
            source,
            method,
            status,
            duration_ms,
            error_type,
            error_message,
            created_at
        FROM execution_records
        WHERE 1 = 1
    `;

    const params: unknown[] = [];
	if (options.runId) {
        sql += " AND run_id = ?";
        params.push(options.runId);
    }

    if (options.sessionId) {
        sql += " AND session_id = ?";
        params.push(options.sessionId);
    }

    if (options.taskId) {
        sql += " AND task_id = ?";
        params.push(options.taskId);
    }

    if (options.method) {
        sql += " AND method = ?";
        params.push(options.method);
    }

    if (options.status) {
        sql += " AND status = ?";
        params.push(options.status);
    }

    if (options.source) {
        sql += " AND source = ?";
        params.push(options.source);
    }

    sql += " ORDER BY created_at DESC";

    if (options.limit !== undefined) {
        sql += " LIMIT ?";
        params.push(options.limit);
    }

    if (options.offset !== undefined) {
        sql += " OFFSET ?";
        params.push(options.offset);
    }

    return this.db
        .prepare(sql)
        .all(...params)
        .map((row: any) => ({
            id: row.id,
            runId: row.run_id ?? undefined,
            sessionId: row.session_id ?? undefined,
            taskId: row.task_id ?? undefined,
            agentId: row.agent_id ?? undefined,
            source: row.source,
            method: row.method,
            status: row.status,
            durationMs: row.duration_ms ?? undefined,
            error: row.error_type || row.error_message
                ? {
                    type: row.error_type ?? undefined,
                    message: row.error_message ?? undefined,
                }
                : undefined,
            createdAtMs: row.created_at,
        }));
    }

    queryStats(): ExecutionStats {
        const total = (
            this.db.prepare("SELECT COUNT(*) as cnt FROM execution_records").get() as any
        ).cnt;

        const bySource = (
            this.db.prepare(
                "SELECT source, COUNT(*) as count FROM execution_records GROUP BY source ORDER BY count DESC"
            ).all() as { source: string; count: number }[]
        );

        const byStatus = (
            this.db.prepare(
                "SELECT status, COUNT(*) as count FROM execution_records GROUP BY status ORDER BY count DESC"
            ).all() as { status: string; count: number }[]
        );

        const errorDistribution = (
            this.db.prepare(
                `SELECT COALESCE(error_type, 'none') as errorType, COUNT(*) as count
                 FROM execution_records
                 WHERE status IN ('failure', 'policy_denied')
                 GROUP BY errorType
                 ORDER BY count DESC`
            ).all() as { errorType: string; count: number }[]
        );

        return { total, bySource, byStatus, errorDistribution };
    }
}