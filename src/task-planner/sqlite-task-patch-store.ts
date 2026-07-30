import Database from "better-sqlite3";
import crypto from "node:crypto";
import { TaskPatch, PatchType, PatchStatus, ExecutionReplanPlan, ReplacementStep } from "./types";
import { TaskPatchStore } from "./task-patch-store";

export class SqliteTaskPatchStore implements TaskPatchStore {
    private db: Database.Database;

    constructor(dbPath: string) {
        this.db = new Database(dbPath);
        this.db.pragma("journal_mode = WAL");
        this.initTables();
    }

    private initTables() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS task_patches (
                patch_id TEXT PRIMARY KEY,
                execution_id TEXT NOT NULL,
                failed_step_id TEXT NOT NULL,
                patch_type TEXT NOT NULL,
                replacement_steps TEXT,
                reasoning TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'draft',
                created_at_ms INTEGER NOT NULL,
                applied_at_ms INTEGER
            );

            CREATE TABLE IF NOT EXISTS execution_replan_plans (
                plan_id TEXT PRIMARY KEY,
                execution_id TEXT NOT NULL,
                original_trace_node_id TEXT NOT NULL,
                completed_step_ids TEXT NOT NULL,
                remaining_step_ids TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'draft',
                created_at_ms INTEGER NOT NULL,
                updated_at_ms INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_tp_exec
            ON task_patches(execution_id);
        `);
    }

    insertPatch(patch: TaskPatch): void {
        this.db.prepare(`
            INSERT INTO task_patches (
                patch_id, execution_id, failed_step_id, patch_type,
                replacement_steps, reasoning, status, created_at_ms, applied_at_ms
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            patch.patchId,
            patch.executionId,
            patch.failedStepId,
            patch.patchType,
            patch.replacementSteps ? JSON.stringify(patch.replacementSteps) : null,
            patch.reasoning,
            patch.status,
            patch.createdAtMs,
            patch.appliedAtMs ?? null,
        );
    }

    updatePatchStatus(patchId: string, status: PatchStatus, appliedAtMs?: number): void {
        const now = appliedAtMs ?? Date.now();
        if (status === "applied") {
            this.db.prepare(
                "UPDATE task_patches SET status = ?, applied_at_ms = ? WHERE patch_id = ?"
            ).run(status, now, patchId);
        } else {
            this.db.prepare(
                "UPDATE task_patches SET status = ? WHERE patch_id = ?"
            ).run(status, patchId);
        }
    }

    getPatch(patchId: string): TaskPatch | undefined {
        const row = this.db.prepare(
            "SELECT * FROM task_patches WHERE patch_id = ?"
        ).get(patchId) as any;
        return row ? this.mapPatch(row) : undefined;
    }

    queryPatches(executionId?: string, status?: PatchStatus): TaskPatch[] {
        let sql = "SELECT * FROM task_patches WHERE 1 = 1";
        const params: unknown[] = [];
        if (executionId) {
            sql += " AND execution_id = ?";
            params.push(executionId);
        }
        if (status) {
            sql += " AND status = ?";
            params.push(status);
        }
        sql += " ORDER BY created_at_ms DESC";
        const rows = this.db.prepare(sql).all(...params) as any[];
        return rows.map((row: any) => this.mapPatch(row));
    }

    insertPlan(plan: ExecutionReplanPlan): void {
        this.db.prepare(`
            INSERT INTO execution_replan_plans (
                plan_id, execution_id, original_trace_node_id,
                completed_step_ids, remaining_step_ids, status,
                created_at_ms, updated_at_ms
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            plan.planId,
            plan.executionId,
            plan.originalTraceNodeId,
            JSON.stringify(plan.completedStepIds),
            JSON.stringify(plan.remainingStepIds),
            plan.status,
            plan.createdAtMs,
            plan.updatedAtMs,
        );
    }

    updatePlanStatus(planId: string, status: ExecutionReplanPlan["status"]): void {
        this.db.prepare(
            "UPDATE execution_replan_plans SET status = ?, updated_at_ms = ? WHERE plan_id = ?"
        ).run(status, Date.now(), planId);
    }

    getPlan(planId: string): ExecutionReplanPlan | undefined {
        const row = this.db.prepare(
            "SELECT * FROM execution_replan_plans WHERE plan_id = ?"
        ).get(planId) as any;
        return row ? this.mapPlan(row) : undefined;
    }

    queryPlans(executionId?: string): ExecutionReplanPlan[] {
        let sql = "SELECT * FROM execution_replan_plans WHERE 1 = 1";
        const params: unknown[] = [];
        if (executionId) {
            sql += " AND execution_id = ?";
            params.push(executionId);
        }
        sql += " ORDER BY created_at_ms DESC";
        const rows = this.db.prepare(sql).all(...params) as any[];
        return rows.map((row: any) => this.mapPlan(row));
    }

    private mapPatch(row: any): TaskPatch {
        return {
            patchId: row.patch_id,
            executionId: row.execution_id,
            failedStepId: row.failed_step_id,
            patchType: row.patch_type,
            replacementSteps: row.replacement_steps ? JSON.parse(row.replacement_steps) : undefined,
            reasoning: row.reasoning,
            status: row.status,
            createdAtMs: row.created_at_ms,
            appliedAtMs: row.applied_at_ms ?? undefined,
        };
    }

    private mapPlan(row: any): ExecutionReplanPlan {
        return {
            planId: row.plan_id,
            executionId: row.execution_id,
            originalTraceNodeId: row.original_trace_node_id,
            patches: [],
            completedStepIds: JSON.parse(row.completed_step_ids),
            remainingStepIds: JSON.parse(row.remaining_step_ids),
            status: row.status,
            createdAtMs: row.created_at_ms,
            updatedAtMs: row.updated_at_ms,
        };
    }
}
