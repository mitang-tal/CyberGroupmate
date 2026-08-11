import Database from "better-sqlite3";
import crypto from "node:crypto";
import { FailurePattern, ExperienceItem, ExperienceQuery, ExperienceStatus, FailureCategory, ExperienceType } from "./types";
import { ExperienceStore } from "./experience-store";

export class SqliteExperienceStore implements ExperienceStore {
    private db: Database.Database;

    constructor(dbPath: string) {
        this.db = new Database(dbPath);
        this.db.pragma("journal_mode = WAL");
        // 跨进程写竞争等待（配合 withTransaction 的 BEGIN IMMEDIATE）
        this.db.pragma("busy_timeout = 5000");
        this.initTables();
    }

    private initTables() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS failure_patterns (
                pattern_id TEXT PRIMARY KEY,
                category TEXT NOT NULL,
                trigger_context TEXT NOT NULL,
                symptom TEXT NOT NULL,
                root_cause TEXT NOT NULL,
                frequency INTEGER NOT NULL DEFAULT 1,
                confidence REAL NOT NULL DEFAULT 0.5,
                first_observed_at_ms INTEGER NOT NULL,
                last_observed_at_ms INTEGER NOT NULL,
                source_alert_ids TEXT NOT NULL DEFAULT '[]'
            );

            CREATE TABLE IF NOT EXISTS experience_items (
                experience_id TEXT PRIMARY KEY,
                pattern_id TEXT NOT NULL,
                type TEXT NOT NULL,
                context_tool TEXT,
                context_capability TEXT,
                context_agent_id TEXT,
                rule_avoid TEXT,
                rule_prefer TEXT,
                rule_constraints TEXT,
                confidence REAL NOT NULL DEFAULT 0.5,
                frequency INTEGER NOT NULL DEFAULT 1,
                status TEXT NOT NULL DEFAULT 'active',
                expires_at_ms INTEGER NOT NULL,
                created_at_ms INTEGER NOT NULL,
                updated_at_ms INTEGER NOT NULL,
                origin_agent_id TEXT,
                origin_trust_score REAL,
                federation_status TEXT NOT NULL DEFAULT 'candidate'
            );

            CREATE INDEX IF NOT EXISTS idx_fp_trigger
            ON failure_patterns(trigger_context);

            CREATE INDEX IF NOT EXISTS idx_ei_status
            ON experience_items(status);

            CREATE INDEX IF NOT EXISTS idx_ei_tool
            ON experience_items(context_tool);
        `);
    }

    insertPattern(pattern: FailurePattern): void {
        this.db.prepare(`
            INSERT INTO failure_patterns
                (pattern_id, category, trigger_context, symptom, root_cause,
                 frequency, confidence, first_observed_at_ms, last_observed_at_ms, source_alert_ids)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            pattern.patternId, pattern.category, pattern.triggerContext, pattern.symptom, pattern.rootCause,
            pattern.frequency, pattern.confidence, pattern.firstObservedAtMs, pattern.lastObservedAtMs,
            JSON.stringify(pattern.sourceAlertIds),
        );
    }

    updatePattern(patternId: string, updates: Partial<FailurePattern>): void {
        const sets: string[] = [];
        const params: unknown[] = [];

        if (updates.frequency !== undefined) { sets.push("frequency = ?"); params.push(updates.frequency); }
        if (updates.confidence !== undefined) { sets.push("confidence = ?"); params.push(updates.confidence); }
        if (updates.lastObservedAtMs !== undefined) { sets.push("last_observed_at_ms = ?"); params.push(updates.lastObservedAtMs); }
        if (updates.sourceAlertIds !== undefined) { sets.push("source_alert_ids = ?"); params.push(JSON.stringify(updates.sourceAlertIds)); }
        if (updates.rootCause !== undefined) { sets.push("root_cause = ?"); params.push(updates.rootCause); }

        if (sets.length === 0) return;
        params.push(patternId);
        this.db.prepare(`UPDATE failure_patterns SET ${sets.join(", ")} WHERE pattern_id = ?`).run(...params);
    }

    getPattern(patternId: string): FailurePattern | undefined {
        const row = this.db.prepare("SELECT * FROM failure_patterns WHERE pattern_id = ?").get(patternId) as any;
        return row ? this.mapPattern(row) : undefined;
    }

    queryPatterns(category?: FailureCategory, minConfidence?: number): FailurePattern[] {
        let sql = "SELECT * FROM failure_patterns WHERE 1 = 1";
        const params: unknown[] = [];
        if (category) { sql += " AND category = ?"; params.push(category); }
        if (minConfidence !== undefined) { sql += " AND confidence >= ?"; params.push(minConfidence); }
        sql += " ORDER BY frequency DESC, confidence DESC";
        const rows = this.db.prepare(sql).all(...params) as any[];
        return rows.map((row: any) => this.mapPattern(row));
    }

    findExistingPattern(triggerContext: string, symptom: string): FailurePattern | undefined {
        const row = this.db.prepare(
            "SELECT * FROM failure_patterns WHERE trigger_context = ? AND symptom = ?"
        ).get(triggerContext, symptom) as any;
        return row ? this.mapPattern(row) : undefined;
    }

    insertExperience(item: ExperienceItem): void {
        this.db.prepare(`
            INSERT INTO experience_items
                (experience_id, pattern_id, type,
                 context_tool, context_capability, context_agent_id,
                 rule_avoid, rule_prefer, rule_constraints,
                 confidence, frequency, status, expires_at_ms, created_at_ms, updated_at_ms,
                 origin_agent_id, origin_trust_score, federation_status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            item.experienceId, item.patternId, item.type,
            item.context.tool ?? null, item.context.capability ?? null, item.context.agentId ?? null,
            item.rule.avoid ?? null, item.rule.prefer ?? null,
            item.rule.constraints ? JSON.stringify(item.rule.constraints) : null,
            item.confidence, item.frequency, item.status,
            item.expiresAtMs, item.createdAtMs, item.updatedAtMs,
            item.originAgentId ?? null, item.originTrustScore ?? null,
            item.federationStatus ?? "candidate",
        );
    }

    /**
     * 跨进程写锁：BEGIN IMMEDIATE 事务串行化写路径（配合 WAL + busy_timeout）。
     * fn 抛错时回滚；锁竞争由 SQLite 文件锁 + busy_timeout 兑底。
     */
    withTransaction<T>(fn: () => T): T {
        // 嵌套调用：已在事务中则直接执行，随外层事务一起提交/回滚
        if (this.db.inTransaction) return fn();
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const result = fn();
            this.db.exec("COMMIT");
            return result;
        } catch (err) {
            this.db.exec("ROLLBACK");
            throw err;
        }
    }

    private updateExperienceTx: ((experienceId: string, updates: Partial<ExperienceItem>) => void) | null = null;

    updateExperience(experienceId: string, updates: Partial<ExperienceItem>): void {
        // 应用层锁：事务包裹（含 federationStatus 字段更新），避免 last-write-wins 半程状态
        // 懒初始化：db 在构造函数中赋值，类字段初始化器在构造前执行会引用未初始化的 db
        if (!this.updateExperienceTx) {
            this.updateExperienceTx = this.db.transaction((id: string, u: Partial<ExperienceItem>) => {
                const sets: string[] = [];
                const params: unknown[] = [];

                if (u.confidence !== undefined) { sets.push("confidence = ?"); params.push(u.confidence); }
                if (u.frequency !== undefined) { sets.push("frequency = ?"); params.push(u.frequency); }
                if (u.status !== undefined) { sets.push("status = ?"); params.push(u.status); }
                if (u.expiresAtMs !== undefined) { sets.push("expires_at_ms = ?"); params.push(u.expiresAtMs); }
                if (u.federationStatus !== undefined) { sets.push("federation_status = ?"); params.push(u.federationStatus); }
                sets.push("updated_at_ms = ?"); params.push(Date.now());

                if (sets.length === 0) return;
                params.push(id);
                this.db.prepare(`UPDATE experience_items SET ${sets.join(", ")} WHERE experience_id = ?`).run(...params);
            });
        }
        this.updateExperienceTx(experienceId, updates);
    }

    getExperience(experienceId: string): ExperienceItem | undefined {
        const row = this.db.prepare("SELECT * FROM experience_items WHERE experience_id = ?").get(experienceId) as any;
        return row ? this.mapExperience(row) : undefined;
    }

    queryExperiences(query: ExperienceQuery): ExperienceItem[] {
        let sql = "SELECT * FROM experience_items WHERE 1 = 1";
        const params: unknown[] = [];

        if (query.tool) { sql += " AND context_tool = ?"; params.push(query.tool); }
        if (query.capability) { sql += " AND context_capability = ?"; params.push(query.capability); }
        if (query.agentId) { sql += " AND context_agent_id = ?"; params.push(query.agentId); }
        if (query.minConfidence !== undefined) { sql += " AND confidence >= ?"; params.push(query.minConfidence); }
        if (query.status) { sql += " AND status = ?"; params.push(query.status); }

        sql += " ORDER BY confidence DESC, frequency DESC";
        const rows = this.db.prepare(sql).all(...params) as any[];
        return rows.map((row: any) => this.mapExperience(row));
    }

    listExpiredExperiences(): ExperienceItem[] {
        const now = Date.now();
        const rows = this.db.prepare(
            "SELECT * FROM experience_items WHERE status = 'active' AND expires_at_ms < ?"
        ).all(now) as any[];
        return rows.map((row: any) => this.mapExperience(row));
    }

    decayExperiences(): number {
        const now = Date.now();
        // Mark expired items
        const expiredResult = this.db.prepare(
            "UPDATE experience_items SET status = 'expired', updated_at_ms = ? WHERE status = 'active' AND expires_at_ms < ?"
        ).run(now, now);

        // Decay confidence of items with low frequency (no recent reinforcement)
        const decayCutoff = now - 7 * 24 * 3600_000; // 7 days without update
        this.db.prepare(`
            UPDATE experience_items
            SET confidence = MAX(confidence * 0.8, 0.1),
                updated_at_ms = ?
            WHERE status = 'active'
              AND updated_at_ms < ?
              AND frequency < 3
        `).run(now, decayCutoff);

        return expiredResult.changes;
    }

    private mapPattern(row: any): FailurePattern {
        return {
            patternId: row.pattern_id,
            category: row.category,
            triggerContext: row.trigger_context,
            symptom: row.symptom,
            rootCause: row.root_cause,
            frequency: row.frequency,
            confidence: row.confidence,
            firstObservedAtMs: row.first_observed_at_ms,
            lastObservedAtMs: row.last_observed_at_ms,
            sourceAlertIds: JSON.parse(row.source_alert_ids || "[]"),
        };
    }

    private mapExperience(row: any): ExperienceItem {
        return {
            experienceId: row.experience_id,
            patternId: row.pattern_id,
            type: row.type,
            context: {
                tool: row.context_tool ?? undefined,
                capability: row.context_capability ?? undefined,
                agentId: row.context_agent_id ?? undefined,
            },
            rule: {
                avoid: row.rule_avoid ?? undefined,
                prefer: row.rule_prefer ?? undefined,
                constraints: row.rule_constraints ? JSON.parse(row.rule_constraints) : undefined,
            },
            confidence: row.confidence,
            frequency: row.frequency,
            status: row.status,
            expiresAtMs: row.expires_at_ms,
            createdAtMs: row.created_at_ms,
            updatedAtMs: row.updated_at_ms,
            originAgentId: row.origin_agent_id ?? undefined,
            originTrustScore: row.origin_trust_score ?? undefined,
            federationStatus: row.federation_status ?? "candidate",
        };
    }
}
