import Database from "better-sqlite3";
import crypto from "node:crypto";
import { GovernancePolicy, GuardrailViolation, GuardrailRuleType, PolicyStatus, ViolationSourceType, ViolationAction } from "./types";
import { GovernanceStore } from "./governance-store";

export class SqliteGovernanceStore implements GovernanceStore {
    private db: Database.Database;

    constructor(dbPath: string) {
        this.db = new Database(dbPath);
        this.db.pragma("journal_mode = WAL");
        this.initTables();
    }

    private initTables() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS governance_policies (
                policy_id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                rule_type TEXT NOT NULL,
                config TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'active',
                created_at_ms INTEGER NOT NULL,
                updated_at_ms INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS guardrail_violations (
                violation_id TEXT PRIMARY KEY,
                policy_id TEXT NOT NULL,
                rule_type TEXT NOT NULL,
                source_type TEXT NOT NULL,
                source_id TEXT NOT NULL,
                action_taken TEXT NOT NULL,
                reasoning TEXT NOT NULL,
                created_at_ms INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_gv_rule
            ON guardrail_violations(rule_type);

            CREATE INDEX IF NOT EXISTS idx_gv_source
            ON guardrail_violations(source_type);
        `);

        // Seed default policies if empty
        const count = this.db.prepare("SELECT COUNT(*) as cnt FROM governance_policies").get() as any;
        if (count.cnt === 0) {
            this.seedDefaultPolicies();
        }
    }

    private seedDefaultPolicies(): void {
        const now = Date.now();
        const defaults: GovernancePolicy[] = [
            {
                policyId: crypto.randomUUID(),
                name: "Loop Prevention",
                ruleType: "loop_prevention",
                config: { maxReplanPerExecution: 3 },
                status: "active",
                createdAtMs: now,
                updatedAtMs: now,
            },
            {
                policyId: crypto.randomUUID(),
                name: "Rate Limit",
                ruleType: "rate_limit",
                config: { cooldownPeriodSec: 60 },
                status: "active",
                createdAtMs: now,
                updatedAtMs: now,
            },
            {
                policyId: crypto.randomUUID(),
                name: "Kill Switch",
                ruleType: "kill_switch",
                config: { isKillSwitchActive: false },
                status: "active",
                createdAtMs: now,
                updatedAtMs: now,
            },
        ];

        for (const p of defaults) {
            this.upsertPolicy(p);
        }
    }

    listPolicies(ruleType?: GuardrailRuleType, status?: PolicyStatus): GovernancePolicy[] {
        let sql = "SELECT * FROM governance_policies WHERE 1 = 1";
        const params: unknown[] = [];
        if (ruleType) { sql += " AND rule_type = ?"; params.push(ruleType); }
        if (status) { sql += " AND status = ?"; params.push(status); }
        sql += " ORDER BY created_at_ms ASC";
        const rows = this.db.prepare(sql).all(...params) as any[];
        return rows.map((row: any) => this.mapPolicy(row));
    }

    getPolicy(policyId: string): GovernancePolicy | undefined {
        const row = this.db.prepare("SELECT * FROM governance_policies WHERE policy_id = ?").get(policyId) as any;
        return row ? this.mapPolicy(row) : undefined;
    }

    upsertPolicy(policy: GovernancePolicy): void {
        this.db.prepare(`
            INSERT OR REPLACE INTO governance_policies
                (policy_id, name, rule_type, config, status, created_at_ms, updated_at_ms)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
            policy.policyId,
            policy.name,
            policy.ruleType,
            JSON.stringify(policy.config),
            policy.status,
            policy.createdAtMs,
            policy.updatedAtMs,
        );
    }

    updatePolicyStatus(policyId: string, status: PolicyStatus): void {
        this.db.prepare(
            "UPDATE governance_policies SET status = ?, updated_at_ms = ? WHERE policy_id = ?"
        ).run(status, Date.now(), policyId);
    }

    insertViolation(violation: GuardrailViolation): void {
        this.db.prepare(`
            INSERT INTO guardrail_violations
                (violation_id, policy_id, rule_type, source_type, source_id, action_taken, reasoning, created_at_ms)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            violation.violationId,
            violation.policyId,
            violation.ruleType,
            violation.sourceType,
            violation.sourceId,
            violation.actionTaken,
            violation.reasoning,
            violation.createdAtMs,
        );
    }

    queryViolations(options: {
        ruleType?: GuardrailRuleType;
        sourceType?: ViolationSourceType;
        actionTaken?: ViolationAction;
        limit?: number;
        offset?: number;
    }): GuardrailViolation[] {
        let sql = "SELECT * FROM guardrail_violations WHERE 1 = 1";
        const params: unknown[] = [];
        if (options.ruleType) { sql += " AND rule_type = ?"; params.push(options.ruleType); }
        if (options.sourceType) { sql += " AND source_type = ?"; params.push(options.sourceType); }
        if (options.actionTaken) { sql += " AND action_taken = ?"; params.push(options.actionTaken); }
        sql += " ORDER BY created_at_ms DESC";
        const limit = options.limit ?? 50;
        const offset = options.offset ?? 0;
        sql += " LIMIT ? OFFSET ?";
        params.push(limit, offset);
        const rows = this.db.prepare(sql).all(...params) as any[];
        return rows.map((row: any) => this.mapViolation(row));
    }

    countViolationsSince(windowMs: number, ruleType?: GuardrailRuleType): number {
        const cutoff = Date.now() - windowMs;
        if (ruleType) {
            const row = this.db.prepare(
                "SELECT COUNT(*) as cnt FROM guardrail_violations WHERE created_at_ms > ? AND rule_type = ?"
            ).get(cutoff, ruleType) as any;
            return row.cnt;
        }
        const row = this.db.prepare(
            "SELECT COUNT(*) as cnt FROM guardrail_violations WHERE created_at_ms > ?"
        ).get(cutoff) as any;
        return row.cnt;
    }

    private mapPolicy(row: any): GovernancePolicy {
        return {
            policyId: row.policy_id,
            name: row.name,
            ruleType: row.rule_type,
            config: JSON.parse(row.config),
            status: row.status,
            createdAtMs: row.created_at_ms,
            updatedAtMs: row.updated_at_ms,
        };
    }

    private mapViolation(row: any): GuardrailViolation {
        return {
            violationId: row.violation_id,
            policyId: row.policy_id,
            ruleType: row.rule_type,
            sourceType: row.source_type,
            sourceId: row.source_id,
            actionTaken: row.action_taken,
            reasoning: row.reasoning,
            createdAtMs: row.created_at_ms,
        };
    }
}
