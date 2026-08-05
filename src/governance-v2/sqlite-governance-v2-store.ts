/**
 * SqliteGovernanceV2Store — 治理 v2 持久化（复用 governance.db）
 *
 * 表：
 * - governance_v2_state     单行（id=1）当前策略版本 + values
 * - governance_audit_log    治理变更审计（create / update / rollback / kill_switch）
 */
import Database from "better-sqlite3";
import { GovernancePolicyValues, GovernanceAuditLog } from "./types";
import { GovernanceV2Store, GovernanceV2State } from "./governance-v2-store";

export class SqliteGovernanceV2Store implements GovernanceV2Store {
    private db: Database.Database;

    constructor(dbPath: string) {
        this.db = new Database(dbPath);
        this.db.pragma("journal_mode = WAL");
        this.initTables();
    }

    private initTables() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS governance_v2_state (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                version TEXT NOT NULL,
                values TEXT NOT NULL,
                updated_at_ms INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS governance_audit_log (
                log_id TEXT PRIMARY KEY,
                action TEXT NOT NULL,
                from_version TEXT,
                to_version TEXT NOT NULL,
                change_diff TEXT NOT NULL,
                origin TEXT NOT NULL,
                reason TEXT NOT NULL,
                created_at_ms INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_gal_created
            ON governance_audit_log(created_at_ms);
        `);
    }

    loadState(): GovernanceV2State | undefined {
        const row = this.db.prepare(
            "SELECT * FROM governance_v2_state WHERE id = 1"
        ).get() as any;
        if (!row) return undefined;
        return {
            version: row.version,
            values: JSON.parse(row.values),
            updatedAtMs: row.updated_at_ms,
        };
    }

    saveState(version: string, values: GovernancePolicyValues): void {
        this.db.prepare(`
            INSERT INTO governance_v2_state (id, version, values, updated_at_ms)
            VALUES (1, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                version = excluded.version,
                values = excluded.values,
                updated_at_ms = excluded.updated_at_ms
        `).run(version, JSON.stringify(values), Date.now());
    }

    insertAudit(log: GovernanceAuditLog): void {
        this.db.prepare(`
            INSERT INTO governance_audit_log
                (log_id, action, from_version, to_version, change_diff, origin, reason, created_at_ms)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            log.logId,
            log.action,
            log.fromVersion ?? null,
            log.toVersion,
            log.changeDiff,
            log.origin,
            log.reason,
            log.createdAtMs,
        );
    }

    listAudit(limit = 100): GovernanceAuditLog[] {
        const rows = this.db.prepare(
            "SELECT * FROM governance_audit_log ORDER BY created_at_ms DESC LIMIT ?"
        ).all(limit) as any[];
        return rows.map((row: any) => ({
            logId: row.log_id,
            action: row.action,
            fromVersion: row.from_version ?? undefined,
            toVersion: row.to_version,
            changeDiff: row.change_diff,
            origin: row.origin,
            reason: row.reason,
            createdAtMs: row.created_at_ms,
        }));
    }
}
