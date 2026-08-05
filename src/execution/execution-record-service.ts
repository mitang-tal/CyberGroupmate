import { ExecutionRecord, ExecutionStatus, ExecutionTreeNode, ExecutionTimeline, ExecutionAnalytics, SourceAnalytics, MethodAnalytics, SlowExecution, ExecutionAlert, CreateAlertPayload, AlertStatus, AlertRuleType, AlertSeverity, ExecutionHealingAction, HealingStrategy, HealingActionStatus, FailureCategoryCode } from "./execution-record.types";
import { ExecutionRecordStore, type ExecutionStats } from "./execution-record-store";
import type { AlertStore } from "./alert-store";
import type { HealingStore } from "./healing-store";
import { HealingPolicyEngine } from "./healing-policy-engine";
import type { ExecutionAnomalyDetector } from "./execution-anomaly-detector";
import type { FailureExtractor } from "../experience/failure-extractor";
import type { FailureCategory } from "../experience/types";

const MAX_ERROR_MESSAGE_LENGTH = 2000;
const MAX_ERROR_TYPE_LENGTH = 200;

const SENSITIVE_METHODS = new Set([
    "runtime.env.get",
    "runtime.env.set",
    "runtime.env.delete",
    "runtime.env.list",
]);

const TERMINAL_STATUSES: ReadonlySet<ExecutionStatus> = new Set([
    "success",
    "failure",
    "interrupted",
    "policy_denied",
    "timed_out",
]);

const VALID_TRANSITIONS: Record<ExecutionStatus, ExecutionStatus[]> = {
    pending: ["running", "policy_denied"],
    running: ["success", "failure", "interrupted", "timed_out", "policy_denied"],
    success: [],
    failure: [],
    interrupted: [],
    policy_denied: [],
    timed_out: [],
};

export class ExecutionRecordService {
    private healingEngine?: HealingPolicyEngine;
    private anomalyDetector?: ExecutionAnomalyDetector;
    private failureExtractor?: FailureExtractor;

    constructor(
        private store: ExecutionRecordStore,
        private alertStore?: AlertStore,
        private healingStore?: HealingStore,
    ) {
        if (this.healingStore) {
            this.healingEngine = new HealingPolicyEngine(this.healingStore, this);
        }
    }

    // ──────────────────────────────────────────────
    //  Audit Fix Phase 1.1 / 2.1：运行时依赖注入
    // ──────────────────────────────────────────────

    /** 注入异常检测器：执行完成后自动检测异常并生成 Alert */
    setAnomalyDetector(detector: ExecutionAnomalyDetector): void {
        this.anomalyDetector = detector;
    }

    /** 注入失败经验提取器：真实失败自动进入经验库（policy_denied 被过滤） */
    setFailureExtractor(extractor: FailureExtractor): void {
        this.failureExtractor = extractor;
    }

    /** 注入真实重试执行器（Phase 2.2：禁止伪造成功） */
    setRetryExecutor(executor: (record: ExecutionRecord, action: ExecutionHealingAction) => Promise<{ status: "success" | "failure"; error?: string; durationMs?: number }>): void {
        this.healingEngine?.setRetryExecutor(executor);
    }

    // ──────────────────────────────────────────────
    //  Lifecycle methods
    // ──────────────────────────────────────────────

    start(params: {
        runId?: string;
        sessionId?: string;
        taskId?: string;
        agentId?: string;

        parentId?: string;
        sequence?: number;

        source: ExecutionRecord["source"];
        method: string;

        timeoutMs?: number;
    }): string {
        const id = crypto.randomUUID();

        this.store.insert({
            id,
            runId: params.runId,
            sessionId: params.sessionId,
            taskId: params.taskId,
            agentId: params.agentId,

            parentId: params.parentId,
            sequence: params.sequence,

            source: params.source,
            method: params.method,

            status: "pending",

            timeoutMs: params.timeoutMs,

            createdAtMs: Date.now(),
        });

        return id;
    }

    markRunning(id: string): void {
        const record = this.store.getById(id);
        if (!record) return;

        this.transition(record, "running");
        this.store.update(id, { status: "running", startedAtMs: Date.now() });
    }

    complete(id: string, status: ExecutionStatus, extra?: {
        durationMs?: number;
        error?: { type?: string; message?: string };
    }): void {
        const record = this.store.getById(id);
        if (!record) return;

        // ═══ completeOnce protection: only running/pending can complete ═══
        if (record.status !== "running" && record.status !== "pending") {
            return;
        }

        const now = Date.now();
        const patch: Partial<ExecutionRecord> = {
            completedAtMs: now,
        };

        if (extra?.durationMs !== undefined) {
            patch.durationMs = extra.durationMs;
        } else {
            // Auto-calculate from startedAtMs if available
            if (record.startedAtMs !== undefined) {
                patch.durationMs = now - record.startedAtMs;
            }
        }

        if (extra?.error) {
            patch.error = {
                type: extra.error.type?.slice(0, MAX_ERROR_TYPE_LENGTH),
                message: extra.error.message?.slice(0, MAX_ERROR_MESSAGE_LENGTH),
            };
        }

        // ═══ Audit Fix Phase 1.1：失败分类（policy_denied 与真实执行错误严格区分） ═══
        patch.failureCategory = this.classifyFailure(status, patch.error?.type, patch.error?.message);

        this.transition(record, status);
        this.store.update(id, { ...patch, status });

        // ═══ Audit Fix Phase 2.1：执行完成 → 异常检测 → Alert ═══
        const completed = this.store.getById(id);
        if (completed) {
            try {
                this.anomalyDetector?.onExecutionCompleted(completed);
            } catch (err) {
                console.warn(`ExecutionRecordService: anomaly detection failed for ${id}:`, err);
            }
        }

        // ═══ Audit Fix Phase 1.1：真实失败 → 失败经验（policy_denied 不进入经验库） ═══
        this.extractFailureExperience(id);
    }

    /**
     * 端到端闭环：把 Meta 决策标识与真实验证结果补写进 ExecutionRecord
     * （decisionId + verificationResult 随执行记录落库，可从记录直接回溯决策）
     */
    attachDecisionMeta(
        id: string,
        decisionId: string,
        verificationResult?: ExecutionRecord["verificationResult"],
    ): void {
        if (!id) return;
        const patch: Partial<ExecutionRecord> = { decisionId };
        if (verificationResult) {
            patch.verificationResult = verificationResult;
        }
        this.store.update(id, patch);
    }

    /**
     * 失败分类：
     * - policy_denied: 治理拦截（Kill Switch / 护栏）
     * - timeout: 超时
     * - capability_error: 能力/方法不存在或不可用
     * - execution_error: 其他真实执行错误
     */
    private classifyFailure(status: ExecutionStatus, errorType?: string, errorMessage?: string): FailureCategoryCode | undefined {
        if (status !== "failure" && status !== "timed_out" && status !== "policy_denied") {
            return undefined;
        }
        if (status === "policy_denied") return "policy_denied";
        if (status === "timed_out") return "timeout";

        // status === "failure"：按错误类型细分
        if (errorType === "GuardrailDenied" || errorType === "PolicyViolation") {
            return "policy_denied";
        }
        if (errorType === "UnsupportedMethod" || errorType === "CapabilityError") {
            return "capability_error";
        }
        if (errorType === "Timeout" || (errorMessage && /timed?out/i.test(errorMessage))) {
            return "timeout";
        }
        return "execution_error";
    }

    /**
     * 真实失败 → 失败经验。policy_denied 是治理拦截，不是执行失败，不进入经验库。
     * 经验库提取全程 try/catch，绝不阻断执行链路。
     */
    private extractFailureExperience(id: string): void {
        if (!this.failureExtractor) return;
        try {
            const record = this.store.getById(id);
            if (!record) return;
            if (record.failureCategory === "policy_denied") return;
            if (record.status !== "failure" && record.status !== "timed_out") return;
            if (!record.error?.type) return;

            this.failureExtractor.extractFromFailure({
                triggerContext: record.method,
                symptom: record.error.type,
                rootCause: record.error.message ?? record.error.type,
                category: this.mapToExperienceCategory(record),
                sourceAlertId: undefined,
                tool: record.method,
                agentId: record.agentId,
            });
        } catch (err) {
            console.warn(`ExecutionRecordService: failure experience extraction failed for ${id}:`, err);
        }
    }

    private mapToExperienceCategory(record: ExecutionRecord): FailureCategory {
        switch (record.failureCategory) {
            case "timeout":
                return "resource_exhausted";
            case "capability_error":
                return "tool_capability_mismatch";
            default:
                return "tool_capability_mismatch";
        }
    }

    private transition(current: ExecutionRecord, to: ExecutionStatus): void {
        const allowed = VALID_TRANSITIONS[current.status];
        if (!allowed || !allowed.includes(to)) {
            console.warn(
                `ExecutionRecordService: invalid transition ${current.status} -> ${to} for ${current.id}`
            );
            return;
        }
    }

    // ──────────────────────────────────────────────
    //  Convenience methods (old-style, now using lifecycle)
    // ──────────────────────────────────────────────

    record(record: ExecutionRecord): void {
        const sanitized: ExecutionRecord = {
            ...record,
            error: record.error
                ? {
                    type: record.error.type
                        ?.slice(0, MAX_ERROR_TYPE_LENGTH),
                    message: record.error.message
                        ?.slice(0, MAX_ERROR_MESSAGE_LENGTH),
                }
                : undefined,
        };

        if (SENSITIVE_METHODS.has(record.method)) {
            // Reserved:
            // Do not add args/result fields without filtering these methods.
        }

        this.store.insert(sanitized);
    }

    recordHostCall(params: {
        runId?: string;
        sessionId?: string;
        taskId?: string;
        agentId?: string;

        method: string;

        status: ExecutionStatus;

        durationMs?: number;

        error?: {
            type?: string;
            message?: string;
        };
    }): void {
        this.record({
            id: crypto.randomUUID(),
            runId: params.runId,
            sessionId: params.sessionId,
            taskId: params.taskId,
            agentId: params.agentId,

            source: "sandbox",

            method: params.method,

            status: params.status,

            durationMs: params.durationMs,

            error: params.error,

            createdAtMs: Date.now(),
        });
    }

    recordAgentTurn(params: {
        sessionId?: string;
        runId?: string;
        taskId?: string;
        agentId?: string;

        status: ExecutionStatus;

        durationMs?: number;

        error?: {
            type?: string;
            message?: string;
        };
    }): void {
        this.record({
            id: crypto.randomUUID(),
            runId: params.runId,
            sessionId: params.sessionId,
            taskId: params.taskId,
            agentId: params.agentId,

            source: "agent",

            method: "agent.turn",

            status: params.status,

            durationMs: params.durationMs,

            error: params.error,

            createdAtMs: Date.now(),
        });
    }

    recordSandboxExecution(params: {
        sessionId?: string;
        runId?: string;
        taskId?: string;
        agentId?: string;

        status: ExecutionStatus;

        durationMs?: number;

        error?: {
            type?: string;
            message?: string;
        };
    }): void {
        this.record({
            id: crypto.randomUUID(),
            runId: params.runId,
            sessionId: params.sessionId,
            taskId: params.taskId,
            agentId: params.agentId,

            source: "sandbox",

            method: "sandbox.execute",

            status: params.status,

            durationMs: params.durationMs,

            error: params.error,

            createdAtMs: Date.now(),
        });
    }

    // ──────────────────────────────────────────────
    //  Analytics
    // ──────────────────────────────────────────────

    getAnalytics(): ExecutionAnalytics {
        return this.store.queryAnalytics();
    }

    getErrorSummary(): { errorType: string; count: number; lastOccurredAtMs: number }[] {
        const analytics = this.store.queryAnalytics();
        return analytics.errorRanking;
    }

    getSlowExecutions(limit = 10): SlowExecution[] {
        const analytics = this.store.queryAnalytics();
        return analytics.slowExecutions.slice(0, limit);
    }

    getSourceAnalytics(): SourceAnalytics[] {
        const analytics = this.store.queryAnalytics();
        return analytics.bySource;
    }

    getMethodAnalytics(): MethodAnalytics[] {
        const analytics = this.store.queryAnalytics();
        return analytics.byMethod;
    }

    // ──────────────────────────────────────────────
    //  Alerting
    // ──────────────────────────────────────────────

    createAlert(payload: CreateAlertPayload, cooldownMs?: number): ExecutionAlert | undefined {
        return this.alertStore?.insertOrUpdate(payload, cooldownMs);
    }

    queryAlerts(options: {
        status?: AlertStatus;
        severity?: AlertSeverity;
        ruleType?: AlertRuleType;
        sourceComponent?: string;
        limit?: number;
        offset?: number;
    }): ExecutionAlert[] {
        return this.alertStore?.query(options) ?? [];
    }

    updateAlertStatus(alertId: string, status: AlertStatus): void {
        this.alertStore?.updateStatus(alertId, status);
    }

    getAlertContext(alertId: string): object | undefined {
        const alert = this.alertStore?.getById(alertId);
        if (!alert) return undefined;

        // Build rich context for Meta consumption
        const context: Record<string, unknown> = {
            alertId: alert.alertId,
            ruleType: alert.ruleType,
            severity: alert.severity,
            status: alert.status,
            sourceComponent: alert.sourceComponent,
            occurrenceCount: alert.occurrenceCount,
            contextSummary: alert.contextSummary,
            createdAt: new Date(alert.createdAtMs).toISOString(),
            lastObservedAt: new Date(alert.lastObservedAtMs).toISOString(),
        };

        // Attach related execution if available
        if (alert.executionId) {
            const record = this.store.getById(alert.executionId);
            if (record) {
                context.relatedExecution = {
                    id: record.id,
                    source: record.source,
                    method: record.method,
                    status: record.status,
                    durationMs: record.durationMs,
                    error: record.error,
                };
                // Also attach trace tree
                try {
                    const tree = this.getTrace(alert.executionId);
                    if (tree) {
                        context.executionTrace = tree;
                    }
                } catch {
                    // Silently skip if trace fails
                }
            }
        }

        return context;
    }

    getActiveAlertCount(): number {
        return this.alertStore?.getActiveAlertCount() ?? 0;
    }

    // ──────────────────────────────────────────────
    //  Self-Healing
    // ──────────────────────────────────────────────

    triggerSelfHealing(alertId: string): ExecutionHealingAction | undefined {
        const alert = this.alertStore?.getById(alertId);
        if (!alert || !this.healingEngine) return undefined;
        return this.healingEngine.triggerSelfHealing(alert);
    }

    queryHealingActions(options: {
        alertId?: string;
        executionId?: string;
        strategy?: HealingStrategy;
        status?: HealingActionStatus;
        limit?: number;
        offset?: number;
    }): ExecutionHealingAction[] {
        return this.healingStore?.query(options) ?? [];
    }

    getHealingAction(actionId: string): ExecutionHealingAction | undefined {
        return this.healingStore?.getById(actionId);
    }

    /**
     * Meta 诊断接口：获取 Alert 上下文 + 诊断建议
     */
    async diagnoseExecution(alertId: string): Promise<object | undefined> {
        const alert = this.alertStore?.getById(alertId);
        if (!alert || !this.healingEngine) return undefined;

        const action = this.healingEngine.triggerSelfHealing(alert);
        if (!action) return undefined;

        const diagnosis = await this.healingEngine.applyMetaDiagnosis(alertId, action);
        return {
            alertId,
            actionId: action.actionId,
            diagnosis,
            strategy: action.strategy,
            status: action.status,
        };
    }

    getById(id: string): ExecutionRecord | undefined {
        return this.store.getById(id);
    }

    getActive(): ExecutionRecord[] {
        return this.store.queryActive();
    }

    getTrace(id: string): ExecutionTreeNode | undefined {
        const record = this.store.getById(id);
        if (!record) return undefined;

        // If this record has a parent, return the full tree from the root
        if (record.parentId) {
            return this.store.getExecutionTree(record.parentId);
        }

        return this.store.getExecutionTree(id);
    }

    getTimeline(id: string): ExecutionTimeline | undefined {
        const record = this.store.getById(id);
        if (!record) return undefined;

        const events: ExecutionTimeline["events"] = [
            { type: "created", atMs: record.createdAtMs, label: "Execution created" },
        ];

        if (record.startedAtMs !== undefined) {
            events.push({ type: "started", atMs: record.startedAtMs, label: "Execution started" });
        }

        if (record.completedAtMs !== undefined) {
            events.push({ type: "completed", atMs: record.completedAtMs, label: "Execution completed" });
        }

        events.sort((a, b) => a.atMs - b.atMs);

        const timeline: ExecutionTimeline = {
            id: record.id,
            events,
        };

        if (record.startedAtMs !== undefined) {
            timeline.queueTimeMs = record.startedAtMs - record.createdAtMs;
        }

        if (record.startedAtMs !== undefined && record.completedAtMs !== undefined) {
            timeline.runTimeMs = record.completedAtMs - record.startedAtMs;
        }

        if (record.completedAtMs !== undefined) {
            timeline.totalTimeMs = record.completedAtMs - record.createdAtMs;
        }

        return timeline;
    }

    listByTask(taskId: string): ExecutionRecord[] {
        return this.store.query({
            taskId,
        });
    }

    listByRun(runId: string): ExecutionRecord[] {
        return this.store.query({
            runId,
        });
    }

    listBySession(sessionId: string): ExecutionRecord[] {
        return this.store.query({
            sessionId,
        });
    }

    listRecent(params: {
        limit?: number;
        offset?: number;
        source?: string;
        status?: ExecutionStatus;
        method?: string;
    }): ExecutionRecord[] {
        return this.store.query({
            source: params.source,
            status: params.status,
            method: params.method,
            limit: params.limit,
            offset: params.offset,
        });
    }

    getStats(): ExecutionStats {
        return this.store.queryStats();
    }

    listFailures(limit = 50): ExecutionRecord[] {
        return this.store.query({
            status: "failure",
        }).slice(0, limit);
    }

    listByMethod(method: string): ExecutionRecord[] {
        return this.store.query({
            method,
        });
    }
}