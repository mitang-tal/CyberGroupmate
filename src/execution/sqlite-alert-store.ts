import Database from "better-sqlite3";
import crypto from "node:crypto";
import { ExecutionAlert, CreateAlertPayload, AlertStatus, AlertRuleType, AlertSeverity } from "./execution-record.types";
import { AlertStore } from "./alert-store";

const DEFAULT_COOLDOWN_MS = 60_000; // 1 minute

export class SqliteAlertStore implements AlertStore {
    private db: Database.Database;

    constructor(dbPath: string) {
        this.db = new Database(dbPath);
        this.db.pragma("journal_mode = WAL");
        this.initTables();
    }

    private initTables() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS execution_alerts (
                alert_id TEXT PRIMARY KEY,
                rule_type TEXT NOT NULL,
                severity TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'active',
                source_component TEXT NOT NULL,
                execution_id TEXT,
                occurrence_count INTEGER NOT NULL DEFAULT 1,
                context_summary TEXT NOT NULL,
                created_at_ms INTEGER NOT NULL,
                last_observed_at_ms INTEGER NOT NULL,
                resolved_at_ms INTEGER
            );

            CREATE INDEX IF NOT EXISTS idx_alert_status
            ON execution_alerts(status);

            CREATE INDEX IF NOT EXISTS idx_alert_severity
            ON execution_alerts(severity);

            CREATE INDEX IF NOT EXISTS idx_alert_source
            ON execution_alerts(source_component);
        `);
    }

    insertOrUpdate(payload: CreateAlertPayload, cooldownMs = DEFAULT_COOLDOWN_MS): ExecutionAlert {
        const now = Date.now();

        // Check for existing active/acknowledged alert with same rule+source (within cooldown)
        const existing = this.db.prepare(`
            SELECT * FROM execution_alerts
            WHERE rule_type = ?
              AND source_component = ?
              AND status IN ('active', 'acknowledged')
              AND last_observed_at_ms > ?
            ORDER BY last_observed_at_ms DESC
            LIMIT 1
        `).get(payload.ruleType, payload.sourceComponent, now - cooldownMs) as any;

        if (existing) {
            // Update occurrence count and timestamp
            this.db.prepare(`
                UPDATE execution_alerts
                SET occurrence_count = occurrence_count + 1,
                    last_observed_at_ms = ?,
                    context_summary = ?,
                    status = 'active'
                WHERE alert_id = ?
            `).run(now, JSON.stringify(payload.contextSummary), existing.alert_id);

            return this.getById(existing.alert_id)!;
        }

        // Create new alert
        const alertId = crypto.randomUUID();
        this.db.prepare(`
            INSERT INTO execution_alerts (
                alert_id, rule_type, severity, status, source_component,
                execution_id, occurrence_count, context_summary,
                created_at_ms, last_observed_at_ms
            )
            VALUES (?, ?, ?, 'active', ?, ?, 1, ?, ?, ?)
        `).run(
            alertId,
            payload.ruleType,
            payload.severity,
            payload.sourceComponent,
            payload.executionId ?? null,
            JSON.stringify(payload.contextSummary),
            now,
            now,
        );

        return this.getById(alertId)!;
    }

    getById(alertId: string): ExecutionAlert | undefined {
        const row = this.db.prepare(
            "SELECT * FROM execution_alerts WHERE alert_id = ?"
        ).get(alertId) as any;
        return row ? this.mapRow(row) : undefined;
    }

    query(options: {
        status?: AlertStatus;
        severity?: AlertSeverity;
        ruleType?: AlertRuleType;
        sourceComponent?: string;
        limit?: number;
        offset?: number;
    }): ExecutionAlert[] {
        let sql = "SELECT * FROM execution_alerts WHERE 1 = 1";
        const params: unknown[] = [];

        if (options.status) {
            sql += " AND status = ?";
            params.push(options.status);
        }
        if (options.severity) {
            sql += " AND severity = ?";
            params.push(options.severity);
        }
        if (options.ruleType) {
            sql += " AND rule_type = ?";
            params.push(options.ruleType);
        }
        if (options.sourceComponent) {
            sql += " AND source_component = ?";
            params.push(options.sourceComponent);
        }

        sql += " ORDER BY last_observed_at_ms DESC";

        const limit = options.limit ?? 50;
        const offset = options.offset ?? 0;
        sql += " LIMIT ? OFFSET ?";
        params.push(limit, offset);

        const rows = this.db.prepare(sql).all(...params) as any[];
        return rows.map((row: any) => this.mapRow(row));
    }

    updateStatus(alertId: string, status: AlertStatus): void {
        const now = Date.now();
        if (status === "resolved") {
            this.db.prepare(`
                UPDATE execution_alerts SET status = ?, resolved_at_ms = ? WHERE alert_id = ?
            `).run(status, now, alertId);
        } else {
            this.db.prepare(`
                UPDATE execution_alerts SET status = ? WHERE alert_id = ?
            `).run(status, alertId);
        }
    }

    getActiveAlertCount(): number {
        const row = this.db.prepare(
            "SELECT COUNT(*) as cnt FROM execution_alerts WHERE status = 'active'"
        ).get() as any;
        return row.cnt;
    }

    private mapRow(row: any): ExecutionAlert {
        return {
            alertId: row.alert_id,
            ruleType: row.rule_type,
            severity: row.severity,
            status: row.status,
            sourceComponent: row.source_component,
            executionId: row.execution_id ?? undefined,
            occurrenceCount: row.occurrence_count,
            contextSummary: JSON.parse(row.context_summary),
            createdAtMs: row.created_at_ms,
            lastObservedAtMs: row.last_observed_at_ms,
            resolvedAtMs: row.resolved_at_ms ?? undefined,
        };
    }
}
