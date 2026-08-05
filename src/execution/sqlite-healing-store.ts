import Database from "better-sqlite3";
import crypto from "node:crypto";
import { ExecutionHealingAction, HealingStrategy, HealingActionStatus } from "./execution-record.types";
import { HealingStore } from "./healing-store";

export class SqliteHealingStore implements HealingStore {
    private db: Database.Database;

    constructor(dbPath: string) {
        this.db = new Database(dbPath);
        this.db.pragma("journal_mode = WAL");
        this.initTables();
    }

    private initTables() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS execution_healing_actions (
                action_id TEXT PRIMARY KEY,
                alert_id TEXT NOT NULL,
                execution_id TEXT NOT NULL,
                strategy TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                attempt_count INTEGER NOT NULL DEFAULT 1,
                decision_reason TEXT NOT NULL,
                action_details TEXT,
                error TEXT,
                created_at_ms INTEGER NOT NULL,
                completed_at_ms INTEGER
            );

            CREATE INDEX IF NOT EXISTS idx_healing_alert
            ON execution_healing_actions(alert_id);

            CREATE INDEX IF NOT EXISTS idx_healing_execution
            ON execution_healing_actions(execution_id);

            CREATE INDEX IF NOT EXISTS idx_healing_status
            ON execution_healing_actions(status);
        `);
    }

    insert(action: ExecutionHealingAction): void {
        this.db.prepare(`
            INSERT INTO execution_healing_actions (
                action_id, alert_id, execution_id, strategy, status,
                attempt_count, decision_reason, action_details, error,
                created_at_ms, completed_at_ms
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            action.actionId,
            action.alertId,
            action.executionId,
            action.strategy,
            action.status,
            action.attemptCount,
            action.decisionReason,
            action.actionDetails ? JSON.stringify(action.actionDetails) : null,
            action.error ?? null,
            action.createdAtMs,
            action.completedAtMs ?? null,
        );
    }

    updateStatus(actionId: string, status: HealingActionStatus, error?: string, completedAtMs?: number, actionDetails?: Record<string, unknown>): void {
        const now = completedAtMs ?? Date.now();
        const patch: Record<string, unknown> = { status };
        if (status === "succeeded" || status === "failed") {
            patch.completed_at_ms = now;
        }
        if (error !== undefined) {
            patch.error = error;
        }
        if (actionDetails !== undefined) {
            patch.action_details = JSON.stringify(actionDetails);
        }

        const sets: string[] = [];
        const params: unknown[] = [];
        for (const [key, value] of Object.entries(patch)) {
            sets.push(`${key} = ?`);
            params.push(value);
        }
        params.push(actionId);

        this.db.prepare(
            `UPDATE execution_healing_actions SET ${sets.join(", ")} WHERE action_id = ?`
        ).run(...params);
    }

    getById(actionId: string): ExecutionHealingAction | undefined {
        const row = this.db.prepare(
            "SELECT * FROM execution_healing_actions WHERE action_id = ?"
        ).get(actionId) as any;
        return row ? this.mapRow(row) : undefined;
    }

    query(options: {
        alertId?: string;
        executionId?: string;
        strategy?: HealingStrategy;
        status?: HealingActionStatus;
        limit?: number;
        offset?: number;
    }): ExecutionHealingAction[] {
        let sql = "SELECT * FROM execution_healing_actions WHERE 1 = 1";
        const params: unknown[] = [];

        if (options.alertId) {
            sql += " AND alert_id = ?";
            params.push(options.alertId);
        }
        if (options.executionId) {
            sql += " AND execution_id = ?";
            params.push(options.executionId);
        }
        if (options.strategy) {
            sql += " AND strategy = ?";
            params.push(options.strategy);
        }
        if (options.status) {
            sql += " AND status = ?";
            params.push(options.status);
        }

        sql += " ORDER BY created_at_ms DESC";

        const limit = options.limit ?? 50;
        const offset = options.offset ?? 0;
        sql += " LIMIT ? OFFSET ?";
        params.push(limit, offset);

        const rows = this.db.prepare(sql).all(...params) as any[];
        return rows.map((row: any) => this.mapRow(row));
    }

    countRecentBySource(executionId: string, windowMs: number): number {
        const cutoff = Date.now() - windowMs;
        const row = this.db.prepare(`
            SELECT COUNT(*) as cnt FROM execution_healing_actions
            WHERE execution_id = ?
              AND created_at_ms > ?
              AND status IN ('in_progress', 'succeeded', 'failed')
        `).get(executionId, cutoff) as any;
        return row.cnt;
    }

    private mapRow(row: any): ExecutionHealingAction {
        return {
            actionId: row.action_id,
            alertId: row.alert_id,
            executionId: row.execution_id,
            strategy: row.strategy,
            status: row.status,
            attemptCount: row.attempt_count,
            decisionReason: row.decision_reason,
            actionDetails: row.action_details ? JSON.parse(row.action_details) : undefined,
            error: row.error ?? undefined,
            createdAtMs: row.created_at_ms,
            completedAtMs: row.completed_at_ms ?? undefined,
        };
    }
}
