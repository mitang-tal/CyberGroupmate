import Database from "better-sqlite3";
import crypto from "node:crypto";
import { MetaSelfTestReport, MetaSelfTestProbeResult, HealthStatus, ProbeCategory } from "./types";
import { SelfTestStore } from "./self-test-store";

export class SqliteSelfTestStore implements SelfTestStore {
    private db: Database.Database;

    constructor(dbPath: string) {
        this.db = new Database(dbPath);
        this.db.pragma("journal_mode = WAL");
        this.initTables();
    }

    private initTables() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS meta_self_test_reports (
                report_id TEXT PRIMARY KEY,
                overall_health_score REAL NOT NULL,
                status TEXT NOT NULL,
                probe_results TEXT NOT NULL,
                recommendations TEXT NOT NULL,
                created_at_ms INTEGER NOT NULL
            );
        `);
    }

    insertReport(report: MetaSelfTestReport): void {
        this.db.prepare(`
            INSERT INTO meta_self_test_reports
                (report_id, overall_health_score, status, probe_results, recommendations, created_at_ms)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(
            report.reportId,
            report.overallHealthScore,
            report.status,
            JSON.stringify(report.probeResults),
            JSON.stringify(report.recommendations),
            report.createdAtMs,
        );
    }

    getLatestReport(): MetaSelfTestReport | undefined {
        const row = this.db.prepare(
            "SELECT * FROM meta_self_test_reports ORDER BY created_at_ms DESC LIMIT 1"
        ).get() as any;
        return row ? this.mapRow(row) : undefined;
    }

    queryHistory(limit = 20): MetaSelfTestReport[] {
        const rows = this.db.prepare(
            "SELECT * FROM meta_self_test_reports ORDER BY created_at_ms DESC LIMIT ?"
        ).all(limit) as any[];
        return rows.map((row: any) => this.mapRow(row));
    }

    private mapRow(row: any): MetaSelfTestReport {
        return {
            reportId: row.report_id,
            overallHealthScore: row.overall_health_score,
            status: row.status,
            probeResults: JSON.parse(row.probe_results),
            recommendations: JSON.parse(row.recommendations),
            createdAtMs: row.created_at_ms,
        };
    }
}
