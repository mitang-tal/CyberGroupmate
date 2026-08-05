import Database from "better-sqlite3";
import { ExecutionRecord, ExecutionStatus, ExecutionTreeNode, ExecutionAnalytics, SourceAnalytics, MethodAnalytics, ErrorAnalytics, SlowExecution } from "./execution-record.types";
import { ExecutionRecordStore, type ExecutionStats } from "./execution-record-store";

export class SqliteExecutionRecordStore
    implements ExecutionRecordStore {

    private db: Database.Database;

    constructor(dbPath: string) {
        this.db = new Database(dbPath);
        this.db.pragma("journal_mode = WAL");
        this.initTables();
        this.migrateTables();
    }

    private initTables() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS execution_records (
                id TEXT PRIMARY KEY,
                run_id TEXT,
                session_id TEXT,
                task_id TEXT,
                agent_id TEXT,
                parent_id TEXT,
                sequence INTEGER,
                source TEXT,
                method TEXT NOT NULL,
                status TEXT NOT NULL,
                duration_ms INTEGER,
                timeout_ms INTEGER,
                error_type TEXT,
                error_message TEXT,
                failure_category TEXT,
                created_at INTEGER NOT NULL,
                started_at_ms INTEGER,
                completed_at_ms INTEGER
            );

            CREATE INDEX IF NOT EXISTS idx_exec_run
            ON execution_records(run_id);

            CREATE INDEX IF NOT EXISTS idx_exec_session
            ON execution_records(session_id);

            CREATE INDEX IF NOT EXISTS idx_exec_task
            ON execution_records(task_id);

            CREATE INDEX IF NOT EXISTS idx_exec_parent
            ON execution_records(parent_id);

            CREATE INDEX IF NOT EXISTS idx_exec_method
            ON execution_records(method);

            CREATE INDEX IF NOT EXISTS idx_exec_status
            ON execution_records(status);

            CREATE INDEX IF NOT EXISTS idx_exec_created
            ON execution_records(created_at);
        `);
    }

    /**
     * Migrate an existing database that may be missing columns added in later
     * versions of the schema.  Each missing column is added via
     * ALTER TABLE … ADD COLUMN.
     */
    private migrateTables() {
        const columns = this.db.pragma("table_info(execution_records)") as {
            cid: number;
            name: string;
            type: string;
            notnull: number;
            dflt_value: string | null;
            pk: number;
        }[];

        const existing = new Set(columns.map((c) => c.name));

        const migrations: { name: string; def: string }[] = [
            { name: "parent_id", def: "parent_id TEXT" },
            { name: "agent_id", def: "agent_id TEXT" },
            { name: "sequence", def: "sequence INTEGER" },
            { name: "timeout_ms", def: "timeout_ms INTEGER" },
            { name: "started_at_ms", def: "started_at_ms INTEGER" },
            { name: "completed_at_ms", def: "completed_at_ms INTEGER" },
            { name: "failure_category", def: "failure_category TEXT" },
            { name: "decision_id", def: "decision_id TEXT" },
            { name: "verification_result", def: "verification_result TEXT" },
        ];

        for (const col of migrations) {
            if (!existing.has(col.name)) {
                this.db.exec(
                    `ALTER TABLE execution_records ADD COLUMN ${col.def}`
                );
            }
        }
    }

    insert(record: ExecutionRecord) {
        this.db.prepare(`
            INSERT INTO execution_records (
                id,
                run_id,
                session_id,
                task_id,
                agent_id,
                parent_id,
                sequence,
                source,
                method,
                status,
                duration_ms,
                timeout_ms,
                error_type,
                error_message,
                failure_category,
                decision_id,
                verification_result,
                created_at,
                started_at_ms,
                completed_at_ms
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            record.id,
            record.runId ?? null,
            record.sessionId ?? null,
            record.taskId ?? null,
            record.agentId ?? null,
            record.parentId ?? null,
            record.sequence ?? null,
            record.source,
            record.method,
            record.status,
            record.durationMs ?? null,
            record.timeoutMs ?? null,
            record.error?.type ?? null,
            record.error?.message ?? null,
            record.failureCategory ?? null,
            record.decisionId ?? null,
            record.verificationResult ? JSON.stringify(record.verificationResult) : null,
            record.createdAtMs,
            record.startedAtMs ?? null,
            record.completedAtMs ?? null
        );
    }


    private mapRow(row: any): ExecutionRecord {
        return {
            id: row.id,
            runId: row.run_id ?? undefined,
            sessionId: row.session_id ?? undefined,
            taskId: row.task_id ?? undefined,
            agentId: row.agent_id ?? undefined,
            parentId: row.parent_id ?? undefined,
            sequence: row.sequence ?? undefined,
            source: row.source,
            method: row.method,
            status: row.status,
            durationMs: row.duration_ms ?? undefined,
            timeoutMs: row.timeout_ms ?? undefined,
            error: row.error_type || row.error_message
                ? {
                    type: row.error_type ?? undefined,
                    message: row.error_message ?? undefined,
                }
                : undefined,
            failureCategory: row.failure_category ?? undefined,
            decisionId: row.decision_id ?? undefined,
            verificationResult: row.verification_result ? JSON.parse(row.verification_result) : undefined,
            createdAtMs: row.created_at,
            startedAtMs: row.started_at_ms ?? undefined,
            completedAtMs: row.completed_at_ms ?? undefined,
        };
    }

    update(id: string, patch: Partial<ExecutionRecord>): void {
        const sets: string[] = [];
        const params: unknown[] = [];

        if (patch.status !== undefined) {
            sets.push("status = ?");
            params.push(patch.status);
        }
        if (patch.durationMs !== undefined) {
            sets.push("duration_ms = ?");
            params.push(patch.durationMs);
        }
        if (patch.timeoutMs !== undefined) {
            sets.push("timeout_ms = ?");
            params.push(patch.timeoutMs);
        }
        if (patch.error !== undefined) {
            sets.push("error_type = ?", "error_message = ?");
            params.push(patch.error?.type ?? null, patch.error?.message ?? null);
        }
        if (patch.failureCategory !== undefined) {
            sets.push("failure_category = ?");
            params.push(patch.failureCategory);
        }
        if (patch.decisionId !== undefined) {
            sets.push("decision_id = ?");
            params.push(patch.decisionId);
        }
        if (patch.verificationResult !== undefined) {
            sets.push("verification_result = ?");
            params.push(patch.verificationResult ? JSON.stringify(patch.verificationResult) : null);
        }
        if (patch.startedAtMs !== undefined) {
            sets.push("started_at_ms = ?");
            params.push(patch.startedAtMs);
        }
        if (patch.completedAtMs !== undefined) {
            sets.push("completed_at_ms = ?");
            params.push(patch.completedAtMs);
        }
        if (patch.sequence !== undefined) {
            sets.push("sequence = ?");
            params.push(patch.sequence);
        }
        if (patch.source !== undefined) {
            sets.push("source = ?");
            params.push(patch.source);
        }
        if (patch.method !== undefined) {
            sets.push("method = ?");
            params.push(patch.method);
        }

        if (sets.length === 0) return;

        params.push(id);
        this.db.prepare(
            `UPDATE execution_records SET ${sets.join(", ")} WHERE id = ?`
        ).run(...params);
    }

    getById(id: string): ExecutionRecord | undefined {
        const row = this.db.prepare(
            "SELECT * FROM execution_records WHERE id = ?"
        ).get(id) as any;
        return row ? this.mapRow(row) : undefined;
    }

    getChildren(parentId: string): ExecutionRecord[] {
        const rows = this.db.prepare(
            "SELECT * FROM execution_records WHERE parent_id = ? ORDER BY sequence ASC, created_at ASC"
        ).all(parentId) as any[];
        return rows.map((row) => this.mapRow(row));
    }

    getExecutionTree(id: string, maxDepth = 10): ExecutionTreeNode | undefined {
        const record = this.getById(id);
        if (!record) return undefined;

        const node: ExecutionTreeNode = {
            record,
            children: [],
        };

        if (maxDepth > 0) {
            const children = this.getChildren(id);
            for (const child of children) {
                const subtree = this.getExecutionTree(child.id, maxDepth - 1);
                if (subtree) {
                    node.children.push(subtree);
                }
            }
        }

        return node;
    }

    queryActive(): ExecutionRecord[] {
        const rows = this.db.prepare(
            "SELECT * FROM execution_records WHERE status IN ('pending', 'running') ORDER BY created_at ASC"
        ).all() as any[];
        return rows.map((row) => this.mapRow(row));
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
            parent_id,
            sequence,
            source,
            method,
            status,
            duration_ms,
            timeout_ms,
            error_type,
            error_message,
            failure_category,
            decision_id,
            verification_result,
            created_at,
            started_at_ms,
            completed_at_ms
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
        .map((row: any) => this.mapRow(row));
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

    queryAnalytics(): ExecutionAnalytics {
        // ─── Overview ───
        const overviewRow = this.db.prepare(`
            SELECT
                COUNT(*) as total,
                COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0) as success_count,
                COALESCE(SUM(CASE WHEN status = 'failure' THEN 1 ELSE 0 END), 0) as failure_count,
                COALESCE(SUM(CASE WHEN status = 'interrupted' THEN 1 ELSE 0 END), 0) as interrupted_count,
                COALESCE(SUM(CASE WHEN status = 'timed_out' THEN 1 ELSE 0 END), 0) as timed_out_count,
                COALESCE(SUM(CASE WHEN status = 'policy_denied' THEN 1 ELSE 0 END), 0) as policy_denied_count,
                AVG(CASE WHEN duration_ms IS NOT NULL THEN duration_ms ELSE 0 END) as avg_duration,
                MAX(CASE WHEN duration_ms IS NOT NULL THEN duration_ms ELSE 0 END) as max_duration
            FROM execution_records
        `).get() as any;

        const total = overviewRow.total;
        const successCount = overviewRow.success_count;
        const failureCount = overviewRow.failure_count;
        const terminalCount = successCount + failureCount + overviewRow.interrupted_count + overviewRow.timed_out_count + overviewRow.policy_denied_count;

        const overview: ExecutionAnalytics["overview"] = {
            totalExecutions: total,
            successCount,
            failureCount,
            interruptedCount: overviewRow.interrupted_count,
            timedOutCount: overviewRow.timed_out_count,
            policyDeniedCount: overviewRow.policy_denied_count,
            successRate: terminalCount > 0 ? Math.round((successCount / terminalCount) * 10000) / 10000 : 0,
            avgDurationMs: Math.round(overviewRow.avg_duration),
            maxDurationMs: overviewRow.max_duration,
        };

        // ─── Status Distribution ───
        const statusDistribution = this.db.prepare(
            "SELECT status, COUNT(*) as count FROM execution_records GROUP BY status ORDER BY count DESC"
        ).all() as { status: string; count: number }[];

        // ─── By Source ───
        const bySource = this.db.prepare(`
            SELECT
                source,
                COUNT(*) as count,
                SUM(CASE WHEN status IN ('failure', 'timed_out') THEN 1 ELSE 0 END) as failure_count,
                AVG(CASE WHEN duration_ms IS NOT NULL THEN duration_ms ELSE 0 END) as avg_duration
            FROM execution_records
            GROUP BY source
            ORDER BY count DESC
        `).all() as any[];

        const sourceAnalytics: SourceAnalytics[] = bySource.map((row: any) => {
            const sTotal = row.count;
            const sFailures = row.failure_count;
            return {
                source: row.source,
                count: sTotal,
                failureCount: sFailures,
                successRate: sTotal > 0 ? Math.round(((sTotal - sFailures) / sTotal) * 10000) / 10000 : 0,
                avgDurationMs: Math.round(row.avg_duration),
            };
        });

        // ─── By Method ───
        const byMethod = this.db.prepare(`
            SELECT
                method,
                source,
                COUNT(*) as count,
                SUM(CASE WHEN status IN ('failure', 'timed_out') THEN 1 ELSE 0 END) as failure_count,
                AVG(CASE WHEN duration_ms IS NOT NULL THEN duration_ms ELSE 0 END) as avg_duration
            FROM execution_records
            GROUP BY method
            ORDER BY count DESC
        `).all() as any[];

        const methodAnalytics: MethodAnalytics[] = byMethod.map((row: any) => {
            const mTotal = row.count;
            const mFailures = row.failure_count;
            return {
                method: row.method,
                source: row.source,
                count: mTotal,
                failureCount: mFailures,
                successRate: mTotal > 0 ? Math.round(((mTotal - mFailures) / mTotal) * 10000) / 10000 : 0,
                avgDurationMs: Math.round(row.avg_duration),
            };
        });

        // ─── Error Ranking ───
        const errorRanking = this.db.prepare(`
            SELECT
                COALESCE(error_type, 'none') as errorType,
                COUNT(*) as count,
                MAX(created_at) as lastOccurredAtMs
            FROM execution_records
            WHERE status IN ('failure', 'policy_denied', 'timed_out')
              AND error_type IS NOT NULL
            GROUP BY errorType
            ORDER BY count DESC
            LIMIT 20
        `).all() as { errorType: string; count: number; lastOccurredAtMs: number }[];

        // ─── Slow Executions ───
        const slowExecutions = this.db.prepare(`
            SELECT
                id,
                source,
                method,
                status,
                duration_ms,
                created_at
            FROM execution_records
            WHERE duration_ms IS NOT NULL
              AND status NOT IN ('pending', 'running')
            ORDER BY duration_ms DESC
            LIMIT 20
        `).all() as any[];

        const slowList: SlowExecution[] = slowExecutions.map((row: any) => ({
            id: row.id,
            source: row.source,
            method: row.method,
            status: row.status,
            durationMs: row.duration_ms,
            createdAtMs: row.created_at,
        }));

        return {
            overview,
            statusDistribution,
            bySource: sourceAnalytics,
            byMethod: methodAnalytics,
            errorRanking,
            slowExecutions: slowList,
        };
    }
}
