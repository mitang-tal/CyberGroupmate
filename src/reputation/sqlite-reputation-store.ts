import Database from "better-sqlite3";
import { AgentReputation, CapabilityScore, TrustState } from "./types";
import { ReputationStore } from "./reputation-store";

export class SqliteReputationStore implements ReputationStore {
    private db: Database.Database;

    constructor(dbPath: string) {
        this.db = new Database(dbPath);
        this.db.pragma("journal_mode = WAL");
        this.initTables();
    }

    private initTables() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS agent_reputation (
                agent_id TEXT PRIMARY KEY,
                agent_name TEXT NOT NULL,
                trust_score REAL NOT NULL DEFAULT 0.5,
                trust_state TEXT NOT NULL DEFAULT 'normal',
                reliability REAL NOT NULL DEFAULT 0.5,
                risk_probability REAL NOT NULL DEFAULT 0,
                avg_latency_ms REAL NOT NULL DEFAULT 0,
                total_executions INTEGER NOT NULL DEFAULT 0,
                total_failures INTEGER NOT NULL DEFAULT 0,
                capability_scores TEXT NOT NULL DEFAULT '[]',
                probation_until_ms INTEGER,
                last_evaluated_at_ms INTEGER NOT NULL,
                updated_at_ms INTEGER NOT NULL
            );
        `);
    }

    upsert(reputation: AgentReputation): void {
        this.db.prepare(`
            INSERT OR REPLACE INTO agent_reputation
                (agent_id, agent_name, trust_score, trust_state, reliability,
                 risk_probability, avg_latency_ms, total_executions, total_failures,
                 capability_scores, probation_until_ms, last_evaluated_at_ms, updated_at_ms)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            reputation.agentId, reputation.agentName,
            reputation.trustScore, reputation.trustState, reputation.reliability,
            reputation.riskProbability, reputation.avgLatencyMs,
            reputation.totalExecutions, reputation.totalFailures,
            JSON.stringify(reputation.capabilityScores),
            reputation.probationUntilMs ?? null,
            reputation.lastEvaluatedAtMs, reputation.updatedAtMs,
        );
    }

    getByAgentId(agentId: string): AgentReputation | undefined {
        const row = this.db.prepare("SELECT * FROM agent_reputation WHERE agent_id = ?").get(agentId) as any;
        return row ? this.mapRow(row) : undefined;
    }

    listAll(): AgentReputation[] {
        const rows = this.db.prepare("SELECT * FROM agent_reputation ORDER BY trust_score DESC").all() as any[];
        return rows.map((row: any) => this.mapRow(row));
    }

    updateTrustState(agentId: string, state: TrustState, probationUntilMs?: number): void {
        const now = Date.now();
        if (probationUntilMs !== undefined) {
            this.db.prepare(
                "UPDATE agent_reputation SET trust_state = ?, probation_until_ms = ?, updated_at_ms = ? WHERE agent_id = ?"
            ).run(state, probationUntilMs, now, agentId);
        } else {
            this.db.prepare(
                "UPDATE agent_reputation SET trust_state = ?, updated_at_ms = ? WHERE agent_id = ?"
            ).run(state, now, agentId);
        }
    }

    delete(agentId: string): void {
        this.db.prepare("DELETE FROM agent_reputation WHERE agent_id = ?").run(agentId);
    }

    private mapRow(row: any): AgentReputation {
        return {
            agentId: row.agent_id,
            agentName: row.agent_name,
            trustScore: row.trust_score,
            trustState: row.trust_state,
            reliability: row.reliability,
            riskProbability: row.risk_probability,
            avgLatencyMs: row.avg_latency_ms,
            totalExecutions: row.total_executions,
            totalFailures: row.total_failures,
            capabilityScores: JSON.parse(row.capability_scores || "[]"),
            probationUntilMs: row.probation_until_ms ?? undefined,
            lastEvaluatedAtMs: row.last_evaluated_at_ms,
            updatedAtMs: row.updated_at_ms,
        };
    }
}
