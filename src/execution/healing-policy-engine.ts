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
import type { ExecutionAlert, HealingStrategy, ExecutionHealingAction, ExecutionRecord } from "./execution-record.types";
import type { HealingStore } from "./healing-store";
import type { ExecutionRecordService } from "./execution-record-service";

const MAX_RETRIES = 3;
const GUARDRAIL_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const GUARDRAIL_MAX_ATTEMPTS = 2;

/**
 * 真实重试执行器契约（Audit Fix Phase 2.2）
 * 由宿主注入真实 executor，重新执行原 execution 路径并等待真实结果。
 * 返回真实结果状态——禁止把模拟执行标记为成功。
 */
export type RetryExecutor = (
    original: ExecutionRecord,
    action: ExecutionHealingAction,
) => Promise<{ status: "success" | "failure"; error?: string; durationMs?: number }>;

export class HealingPolicyEngine {
    private healingStore: HealingStore;
    private service: ExecutionRecordService;
    private retryExecutor?: RetryExecutor;

    constructor(
        healingStore: HealingStore,
        service: ExecutionRecordService,
    ) {
        this.healingStore = healingStore;
        this.service = service;
    }

    /** 注入真实重试执行器（无执行器时 retry 明确失败，绝不伪造成功） */
    setRetryExecutor(executor: RetryExecutor): void {
        this.retryExecutor = executor;
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
     *
     * Audit Fix Phase 2.2：禁止伪造成功。
     * 原实现 start → markRunning → complete(success) 没有任何真实执行，
     * 是假成功。现在必须通过注入的真实 executor 重新执行并等待真实结果：
     *
     *   pending → in_progress → succeeded / failed
     *
     * 没有注入 executor 时明确失败（不伪造），并说明原因。
     */
    async applyRetry(executionId: string, action: ExecutionHealingAction): Promise<boolean> {
        this.updateAction(action.actionId, "in_progress");

        const record = this.service.getById(executionId);
        if (!record) {
            this.updateAction(action.actionId, "failed", "Original execution not found", Date.now());
            return false;
        }

        if (!this.retryExecutor) {
            // 没有真实执行器：禁止伪造成功。真实重试需要持久化的调用参数与宿主 executor，
            // 未注入时宁可标记失败也不 fake success。
            this.updateAction(action.actionId, "failed",
                "Retry blocked: no real retry executor available. Original execution parameters are not persisted, cannot re-execute honestly.",
                Date.now());
            return false;
        }

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 30_000);
            await this.sleep(backoffMs);

            try {
                // 真实重试：executor 负责重新执行原 execution path 并返回真实结果
                const result = await this.retryExecutor(record, action);
                if (result.status === "success") {
                    this.updateAction(action.actionId, "succeeded", undefined, Date.now());
                    return true;
                }
                if (attempt >= MAX_RETRIES) {
                    this.updateAction(action.actionId, "failed", result.error ?? "Retry failed", Date.now());
                    return false;
                }
                // 失败但未到上限 → 继续退避重试
            } catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err);
                if (attempt >= MAX_RETRIES) {
                    this.updateAction(action.actionId, "failed", errMsg, Date.now());
                    return false;
                }
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

            // Build structured diagnosis result
            // Audit Fix Phase 2.3：当前为关键词/上下文启发式诊断（真实 Meta 推理在后续 Phase），
            // 必须显式标记 diagnosisSource，禁止 Dashboard 把 heuristic 显示成真实诊断。
            const diagnosis = {
                diagnosisSource: "heuristic" as "heuristic" | "meta" | "llm",
                rootCause: (ctx as any).contextSummary?.message || "Unknown",
                recommendedAction: this.buildRecommendedAction(ctx),
                affectedComponent: (ctx as any).sourceComponent,
                severity: (ctx as any).severity,
                executionContext: (ctx as any).contextSummary,
            };

            const actionDetails = {
                diagnosis,
                contextSummary: (ctx as any).contextSummary,
                sourceComponent: (ctx as any).sourceComponent,
                executionId: action.executionId,
            };
            this.updateAction(action.actionId, "succeeded", undefined, Date.now(), actionDetails);
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

    private updateAction(actionId: string, status: ExecutionHealingAction["status"], error?: string, completedAtMs?: number, actionDetails?: Record<string, unknown>): void {
        this.healingStore.updateStatus(actionId, status, error, completedAtMs, actionDetails);
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
