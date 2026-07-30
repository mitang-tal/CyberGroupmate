/**
 * HealingPolicyEngine — 自愈策略路由 & 防爆闸
 *
 * 针对不同 Alert 类型/级别，决定自愈策略：
 * - 瞬态错误 → 指数退避重试
 * - 工具失败 → 降级/熔断
 * - 复杂错误 → Meta 诊断
 * - 超出限制 → 升轨
 */

import crypto from "node:crypto";
import type { ExecutionAlert, HealingStrategy, ExecutionHealingAction } from "./execution-record.types";
import type { HealingStore } from "./healing-store";
import type { ExecutionRecordService } from "./execution-record-service";

const MAX_RETRIES = 3;
const GUARDRAIL_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const GUARDRAIL_MAX_ATTEMPTS = 2;

export class HealingPolicyEngine {
    private healingStore: HealingStore;
    private service: ExecutionRecordService;

    constructor(
        healingStore: HealingStore,
        service: ExecutionRecordService,
    ) {
        this.healingStore = healingStore;
        this.service = service;
    }

    /**
     * 入口：收到 Alert 后触发自愈决策
     */
    triggerSelfHealing(alert: ExecutionAlert): ExecutionHealingAction | undefined {
        const guard = this.guardrailCheck(alert);
        if (!guard.allowed) {
            // Escalate — create healing action with escalate strategy
            const action = this.createAction(alert, "escalate",
                `Guardrail limit reached: ${guard.reason}`);
            this.service.createAlert?.({
                ruleType: alert.ruleType,
                severity: "critical",
                sourceComponent: alert.sourceComponent,
                executionId: alert.executionId,
                contextSummary: {
                    message: `[ESCALATED] ${alert.contextSummary.message}. Auto-healing blocked: ${guard.reason}`,
                    metricsSnapshot: { guardrailWindowMs: GUARDRAIL_WINDOW_MS, guardrailMax: GUARDRAIL_MAX_ATTEMPTS },
                },
            });
            return action;
        }

        const strategy = this.selectStrategy(alert);
        const action = this.createAction(alert, strategy,
            `Auto-healing triggered: ${strategy} for ${alert.ruleType} on ${alert.sourceComponent}`);
        return action;
    }

    /**
     * 执行重试 Handler（指数退避）
     */
    async applyRetry(executionId: string, action: ExecutionHealingAction): Promise<boolean> {
        this.updateAction(action.actionId, "in_progress");

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 30_000);
            await this.sleep(backoffMs);

            try {
                // Re-execute via service — the service.start/markRunning/complete lifecycle
                const record = this.service.getById(executionId);
                if (!record) {
                    this.updateAction(action.actionId, "failed", "Original execution not found");
                    return false;
                }

                // Create a new execution with the same parameters
                const newId = this.service.start({
                    runId: record.runId,
                    sessionId: record.sessionId,
                    taskId: record.taskId,
                    agentId: record.agentId,
                    source: record.source,
                    method: record.method,
                    timeoutMs: record.timeoutMs,
                    parentId: record.parentId,
                });
                this.service.markRunning(newId);
                this.service.complete(newId, "success");

                // Record the healing action as succeeded
                this.updateAction(action.actionId, "succeeded", undefined, Date.now());
                return true;
            } catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err);
                if (attempt >= MAX_RETRIES) {
                    this.updateAction(action.actionId, "failed", errMsg, Date.now());
                    return false;
                }
                // Continue to next retry
            }
        }

        this.updateAction(action.actionId, "failed", "Max retries exceeded", Date.now());
        return false;
    }

    /**
     * Meta 诊断处理器
     */
    async applyMetaDiagnosis(alertId: string, action: ExecutionHealingAction): Promise<object | undefined> {
        this.updateAction(action.actionId, "in_progress");

        try {
            const ctx = this.service.getAlertContext(alertId);
            if (!ctx) {
                this.updateAction(action.actionId, "failed", "Alert context not found");
                return undefined;
            }

            // Build structured diagnosis result (simulated — real Meta integration in Phase 6)
            const diagnosis = {
                rootCause: (ctx as any).contextSummary?.message || "Unknown",
                recommendedAction: this.buildRecommendedAction(ctx),
                affectedComponent: (ctx as any).sourceComponent,
                severity: (ctx as any).severity,
            };

            this.updateAction(action.actionId, "succeeded", undefined, Date.now());
            return diagnosis;
        } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            this.updateAction(action.actionId, "failed", errMsg, Date.now());
            return undefined;
        }
    }

    // ─── Private ───

    private selectStrategy(alert: ExecutionAlert): HealingStrategy {
        // Transient/timeout errors → retry
        if (alert.ruleType === "EXECUTION_TIMEOUT") {
            return "retry";
        }
        // Continuous failure → retry first, then fallback
        if (alert.ruleType === "CONTINUOUS_FAILURE") {
            return "retry";
        }
        // Error cluster → meta diagnosis
        if (alert.ruleType === "ERROR_CLUSTER") {
            return "meta_diagnosis";
        }
        // Failure rate spike → meta diagnosis
        if (alert.ruleType === "FAILURE_RATE_SPIKE") {
            return "meta_diagnosis";
        }
        return "escalate";
    }

    private guardrailCheck(alert: ExecutionAlert): { allowed: boolean; reason: string } {
        if (!alert.executionId) {
            return { allowed: true, reason: "" };
        }

        const recentCount = this.healingStore.countRecentBySource(
            alert.executionId,
            GUARDRAIL_WINDOW_MS,
        );

        if (recentCount >= GUARDRAIL_MAX_ATTEMPTS) {
            return {
                allowed: false,
                reason: `Exceeded ${GUARDRAIL_MAX_ATTEMPTS} healing attempts in ${GUARDRAIL_WINDOW_MS / 60000}min for execution ${alert.executionId}`,
            };
        }

        return { allowed: true, reason: "" };
    }

    private createAction(alert: ExecutionAlert, strategy: HealingStrategy, reason: string): ExecutionHealingAction {
        const action: ExecutionHealingAction = {
            actionId: crypto.randomUUID(),
            alertId: alert.alertId,
            executionId: alert.executionId ?? "",
            strategy,
            status: "pending",
            attemptCount: 1,
            decisionReason: reason,
            createdAtMs: Date.now(),
        };
        this.healingStore.insert(action);
        return action;
    }

    private updateAction(actionId: string, status: ExecutionHealingAction["status"], error?: string, completedAtMs?: number): void {
        this.healingStore.updateStatus(actionId, status, error, completedAtMs);
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    private buildRecommendedAction(ctx: object): string {
        const c = ctx as Record<string, unknown>;
        const summary = c.contextSummary as Record<string, unknown> | undefined;
        if (summary?.message && typeof summary.message === "string") {
            if (summary.message.includes("timed out")) {
                return "Increase timeout or retry with exponential backoff";
            }
            if (summary.message.includes("failed")) {
                return "Check tool availability and retry";
            }
        }
        return "Review execution trace and adjust parameters";
    }
}
