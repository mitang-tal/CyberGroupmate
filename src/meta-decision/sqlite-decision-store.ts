import Database from "better-sqlite3";
import crypto from "node:crypto";
import { MetaDecision, DecisionStatus, DecisionType, DecisionTriggerEventType, DecisionVerificationResult } from "./types";
import { DecisionStore, DecisionStatusUpdate } from "./decision-store";
import { assertTransition, IllegalDecisionTransitionError } from "./state-machine";

export class SqliteDecisionStore implements DecisionStore {
    private db: Database.Database;

    constructor(dbPath: string) {
        this.db = new Database(dbPath);
        this.db.pragma("journal_mode = WAL");
        this.initTables();
    }

    private initTables() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS meta_decisions (
                decision_id TEXT PRIMARY KEY,
                trigger_event_type TEXT NOT NULL,
                trigger_source_id TEXT NOT NULL,
                trigger_detail TEXT,
                decision_type TEXT NOT NULL,
                target_component TEXT NOT NULL,
                action_params TEXT NOT NULL,
                confidence_score REAL NOT NULL,
                reasoning_text TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'proposed',
                created_at_ms INTEGER NOT NULL,
                executed_at_ms INTEGER
            );

            CREATE INDEX IF NOT EXISTS idx_md_status
            ON meta_decisions(status);

            CREATE INDEX IF NOT EXISTS idx_md_type
            ON meta_decisions(decision_type);

            CREATE INDEX IF NOT EXISTS idx_md_target
            ON meta_decisions(target_component);
        `);

        // Add execution_result column if it doesn't exist (migration for existing tables)
        try {
            this.db.exec("ALTER TABLE meta_decisions ADD COLUMN execution_result TEXT");
        } catch {
            // Column already exists — safe to ignore
        }
        // Phase 3.1 migration：decision → execution 链路与验证结果字段
        try {
            this.db.exec("ALTER TABLE meta_decisions ADD COLUMN execution_id TEXT");
        } catch {
            // Column already exists — safe to ignore
        }
        try {
            this.db.exec("ALTER TABLE meta_decisions ADD COLUMN verification_result TEXT");
        } catch {
            // Column already exists — safe to ignore
        }
        try {
            this.db.exec("ALTER TABLE meta_decisions ADD COLUMN transition_error TEXT");
        } catch {
            // Column already exists — safe to ignore
        }
    }

    insert(decision: MetaDecision): void {
        this.db.prepare(`
            INSERT INTO meta_decisions (
                decision_id, trigger_event_type, trigger_source_id, trigger_detail,
                decision_type, target_component, action_params, confidence_score,
                reasoning_text, status, created_at_ms, executed_at_ms, execution_result,
                execution_id, verification_result, transition_error
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            decision.decisionId,
            decision.triggerEvent.eventType,
            decision.triggerEvent.sourceId,
            decision.triggerEvent.detail ?? null,
            decision.decisionType,
            decision.targetComponent,
            JSON.stringify(decision.actionParams),
            decision.confidenceScore,
            decision.reasoningText,
            decision.status,
            decision.createdAtMs,
            decision.executedAtMs ?? null,
            decision.executionResult ?? null,
            decision.executionId ?? null,
            decision.verificationResult ? JSON.stringify(decision.verificationResult) : null,
            decision.transitionError ?? null,
        );
    }

    updateStatus(decisionId: string, status: DecisionStatus, meta?: DecisionStatusUpdate): void {
        const current = this.getById(decisionId);
        if (!current) throw new Error(`decision not found: ${decisionId}`);

        // ═══ Phase 3.1 状态机强制：非法 transition 抛错并记录 ═══
        try {
            assertTransition(decisionId, current.status, status);
            if (status === "executed" && !meta?.executionId) {
                throw new Error(`executed requires execution_id (decision ${decisionId})`);
            }
        } catch (err) {
            // 记录非法尝试（不改变当前状态）
            const msg = err instanceof Error ? err.message : String(err);
            this.db.prepare(
                "UPDATE meta_decisions SET transition_error = ? WHERE decision_id = ?"
            ).run(`${msg} (attempted at ${Date.now()})`, decisionId);
            throw err;
        }

        const now = meta?.executedAtMs ?? Date.now();
        const executionId = meta?.executionId ?? null;
        const verificationResult = meta?.verificationResult
            ? JSON.stringify(meta.verificationResult)
            : null;
        const executionResult = meta?.executionResult ?? null;

        if (status === "executed" || status === "verified" || status === "failed") {
            this.db.prepare(`
                UPDATE meta_decisions
                SET status = ?, executed_at_ms = ?, execution_result = ?, execution_id = ?,
                    verification_result = ?
                WHERE decision_id = ?
            `).run(status, now, executionResult, executionId, verificationResult, decisionId);
        } else if (status === "approved" || status === "executing") {
            this.db.prepare(
                "UPDATE meta_decisions SET status = ?, transition_error = NULL WHERE decision_id = ?"
            ).run(status, decisionId);
        } else {
            this.db.prepare("UPDATE meta_decisions SET status = ? WHERE decision_id = ?")
                .run(status, decisionId);
        }
    }

    getById(decisionId: string): MetaDecision | undefined {
        const row = this.db.prepare(
            "SELECT * FROM meta_decisions WHERE decision_id = ?"
        ).get(decisionId) as any;
        return row ? this.mapRow(row) : undefined;
    }

    query(options: {
        decisionType?: DecisionType;
        status?: DecisionStatus;
        triggerEventType?: DecisionTriggerEventType;
        targetComponent?: string;
        limit?: number;
        offset?: number;
    }): MetaDecision[] {
        let sql = "SELECT * FROM meta_decisions WHERE 1 = 1";
        const params: unknown[] = [];

        if (options.decisionType) {
            sql += " AND decision_type = ?";
            params.push(options.decisionType);
        }
        if (options.status) {
            sql += " AND status = ?";
            params.push(options.status);
        }
        if (options.triggerEventType) {
            sql += " AND trigger_event_type = ?";
            params.push(options.triggerEventType);
        }
        if (options.targetComponent) {
            sql += " AND target_component = ?";
            params.push(options.targetComponent);
        }

        sql += " ORDER BY created_at_ms DESC";

        const limit = options.limit ?? 50;
        const offset = options.offset ?? 0;
        sql += " LIMIT ? OFFSET ?";
        params.push(limit, offset);

        const rows = this.db.prepare(sql).all(...params) as any[];
        return rows.map((row: any) => this.mapRow(row));
    }

    getRecentByTarget(targetComponent: string, windowMs: number): MetaDecision[] {
        const cutoff = Date.now() - windowMs;
        const rows = this.db.prepare(`
            SELECT * FROM meta_decisions
            WHERE target_component = ?
              AND created_at_ms > ?
            ORDER BY created_at_ms DESC
        `).all(targetComponent, cutoff) as any[];
        return rows.map((row: any) => this.mapRow(row));
    }

    countByStatus(status: DecisionStatus): number {
        const row = this.db.prepare(
            "SELECT COUNT(*) as cnt FROM meta_decisions WHERE status = ?"
        ).get(status) as any;
        return row.cnt;
    }

    private mapRow(row: any): MetaDecision {
        return {
            decisionId: row.decision_id,
            triggerEvent: {
                eventType: row.trigger_event_type,
                sourceId: row.trigger_source_id,
                detail: row.trigger_detail ?? undefined,
            },
            decisionType: row.decision_type,
            targetComponent: row.target_component,
            actionParams: JSON.parse(row.action_params),
            confidenceScore: row.confidence_score,
            reasoningText: row.reasoning_text,
            status: row.status,
            createdAtMs: row.created_at_ms,
            executedAtMs: row.executed_at_ms ?? undefined,
            executionResult: row.execution_result ?? undefined,
            executionId: row.execution_id ?? undefined,
            verificationResult: row.verification_result ? JSON.parse(row.verification_result) : undefined,
            transitionError: row.transition_error ?? undefined,
        };
    }
}
