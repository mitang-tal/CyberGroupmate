/**
 * MetaDecisionEngine — Meta 自主决策引擎
 *
 * 消费 Alert Context + Capability Topology，进行多维度决策：
 * - 策略切换 (switch_policy): 连续错误时切换严格模式
 * - 路由重定向 (redispatch): 高负载/离线时重新分发
 * - 服务降级 (degrade): 基础服务异常时屏蔽能力
 * - 节点扩缩 (scale_agent): 容量不足时建议扩容
 */

import crypto from "node:crypto";
import { MetaDecision, MetaPolicyState, DecisionTriggerEvent, DecisionType, DecisionStatus, DecisionVerificationResult, DecisionExecutionOutcome } from "./types";
import { assertTransition } from "./state-machine";
import type { DecisionStore } from "./decision-store";
import type { CapabilityRegistry } from "../capability-registry/capability-registry";
import type { CapabilityDispatcher } from "../capability-registry/capability-dispatcher";
import type { ExecutionRecordService } from "../execution/execution-record-service";

const DECISION_COOLDOWN_MS = 120_000; // 2 min cooldown for same target
const CONFIDENCE_THRESHOLD = 0.4;

export class MetaDecisionEngine {
    private decisionStore: DecisionStore;
    private registry?: CapabilityRegistry;
    private dispatcher?: CapabilityDispatcher;
    private service?: ExecutionRecordService;

    private globalPolicyState: MetaPolicyState = {
        activeDecisions: [],
        degradedComponents: [],
        circuitBrokenComponents: [],
        lastEvaluatedAtMs: 0,
    };

    constructor(
        decisionStore: DecisionStore,
        deps: {
            capabilityRegistry?: CapabilityRegistry;
            capabilityDispatcher?: CapabilityDispatcher;
            executionRecordService?: ExecutionRecordService;
        },
    ) {
        this.decisionStore = decisionStore;
        this.registry = deps.capabilityRegistry;
        this.dispatcher = deps.capabilityDispatcher;
        this.service = deps.executionRecordService;
    }

    /**
     * 主动触发：收到 Alert 后自动评估
     */
    onAlertRaised(alertId: string): MetaDecision | undefined {
        const ctx = this.service?.getAlertContext(alertId);
        if (!ctx) return undefined;

        const c = ctx as Record<string, unknown>;
        const sourceComponent = c.sourceComponent as string || "unknown";

        // Check cooldown
        const recent = this.decisionStore.getRecentByTarget(sourceComponent, DECISION_COOLDOWN_MS);
        if (recent.length > 0) return undefined;

        const severity = c.severity as string || "medium";
        const isCritical = severity === "critical" || severity === "high";

        let decision: MetaDecision | undefined;

        // Critical alerts → consider degrade decision
        if (isCritical) {
            decision = this.decideDegrade(sourceComponent, alertId);
        }

        // High failure → consider redispatch
        if (!decision && (c.ruleType === "CONTINUOUS_FAILURE" || c.ruleType === "FAILURE_RATE_SPIKE")) {
            decision = this.decideRedispatch(sourceComponent, alertId);
        }

        // Timeout → consider switch policy
        if (!decision && c.ruleType === "EXECUTION_TIMEOUT") {
            decision = this.decideSwitchPolicy(sourceComponent, alertId);
        }

        // Fallback: degrade if nothing else matched
        if (!decision) {
            decision = this.decideDegrade(sourceComponent, alertId);
        }

        if (decision) {
            this.decisionStore.insert(decision);
        }

        return decision;
    }

    /**
     * 全局状态评估：扫描系统负载和能力拓扑
     */
    evaluateSystemState(): MetaDecision[] {
        const decisions: MetaDecision[] = [];
        const now = Date.now();
        this.globalPolicyState.lastEvaluatedAtMs = now;

        // Check capacity: if too many agents offline, suggest scale
        const agents = this.registry?.listAgents() ?? [];
        const online = agents.filter((a) => a.status === "online" || a.status === "busy").length;
        const total = agents.length;

        if (total > 0 && online < Math.ceil(total * 0.5)) {
            const decision = this.createDecision(
                { eventType: "capacity_drop", sourceId: "system", detail: `Only ${online}/${total} agents online` },
                "scale_agent",
                "system",
                { onlineCount: online, totalCount: total, suggestedScaleUp: total - online },
                0.7,
                `Capacity drop detected: only ${online} of ${total} agents online. Recommend scaling up.`,
            );
            this.decisionStore.insert(decision);
            decisions.push(decision);
        }

        // Check overloaded agents
        for (const agent of agents) {
            if (agent.activeTaskCount > 5) {
                const decision = this.createDecision(
                    { eventType: "system_overload", sourceId: agent.agentId, detail: `Agent ${agent.name} has ${agent.activeTaskCount} active tasks` },
                    "redispatch",
                    agent.name,
                    { agentId: agent.agentId, activeTaskCount: agent.activeTaskCount, overloadThreshold: 5 },
                    0.5,
                    `Agent ${agent.name} is overloaded with ${agent.activeTaskCount} tasks. Recommend re-routing.`,
                );
                this.decisionStore.insert(decision);
                decisions.push(decision);
            }
        }

        return decisions;
    }

    /**
     * 执行决策 — Phase 3.1：强制状态机 + execution_id 绑定 + 真实验证
     *
     * proposed → approved → executing → executed → verified
     * 执行动作并产出真实 ExecutionRecord；真实执行失败 → failed。
     * 验证阶段真实回读 ExecutionRecord 状态，产出 verificationResult。
     * 违规 transition / 无 execution_id 的 executed 均抛错（store 层同时强制）。
     */
    executeDecision(decisionId: string): DecisionExecutionOutcome {
        const decision = this.decisionStore.getById(decisionId);
        if (!decision) throw new Error(`decision not found: ${decisionId}`);
        assertTransition(decisionId, decision.status, "approved");

        const now = Date.now();

        this.decisionStore.updateStatus(decisionId, "approved");
        this.decisionStore.updateStatus(decisionId, "executing");

        // 真实执行：创建 ExecutionRecord 并真实完成（禁止伪造成功）
        if (!this.service) {
            throw new Error("meta decision engine has no executionRecordService — cannot execute");
        }
        const executionId = this.service.start({
            source: "system",
            method: `meta.${decision.decisionType}`,
            taskId: decision.targetComponent,
            parentId: decision.decisionId,
            timeoutMs: 30_000,
        });
        this.service.markRunning(executionId);

        const outcome = this.runAction(decision);

        this.service.complete(
            executionId,
            outcome.status === "success" ? "success" : "failure",
            {
                durationMs: Date.now() - now,
                error: outcome.error,
            },
        );

        const executionResult = JSON.stringify({
            outcome: outcome.status,
            detail: outcome.detail,
            executionId,
        });

        if (outcome.status !== "success") {
            this.decisionStore.updateStatus(decisionId, "failed", {
                executedAtMs: now,
                executionId,
                executionResult,
            });
            // 端到端闭环：失败执行记录同样落 decisionId（可回溯到哪笔决策）
            this.service.attachDecisionMeta(executionId, decisionId);
            return { ok: false, decisionId, status: "failed", executionId };
        }

        // executed：必须绑定 execution_id（store 层同步强制）
        this.decisionStore.updateStatus(decisionId, "executed", {
            executedAtMs: now,
            executionId,
            executionResult,
        });

        // 真实验证：重新从 store 回读 ExecutionRecord，确认 status=success（不是标志位）
        const record = this.service.getById(executionId);
        const verified = !!record && record.status === "success";
        const verificationResult: DecisionVerificationResult = {
            verifiedAtMs: Date.now(),
            executionId,
            executionStatus: record?.status ?? "missing",
            verified,
            detail: verified
                ? `execution record verified: status=success`
                : `execution record status=${record?.status ?? "missing"} (expected success)`,
        };

        this.decisionStore.updateStatus(decisionId, verified ? "verified" : "failed", {
            executedAtMs: now,
            executionId,
            executionResult,
            verificationResult,
        });

        // 端到端闭环：验证结果随执行记录落库（decisionId + verificationResult）
        this.service.attachDecisionMeta(executionId, decisionId, verificationResult);

        return {
            ok: verified,
            decisionId,
            status: verified ? "verified" : "failed",
            executionId,
        };
    }

    /**
     * 验证已执行决策（executed → verified / failed）
     * 真实回读 ExecutionRecord 状态；无 execution_id 视为验证失败。
     */
    verifyDecision(decisionId: string): DecisionVerificationResult {
        const decision = this.decisionStore.getById(decisionId);
        if (!decision) throw new Error(`decision not found: ${decisionId}`);
        assertTransition(decisionId, decision.status, "verified");

        if (!decision.executionId) {
            throw new Error(`cannot verify decision without execution_id: ${decisionId}`);
        }

        const record = this.service?.getById(decision.executionId);
        const verified = !!record && record.status === "success";
        const verificationResult: DecisionVerificationResult = {
            verifiedAtMs: Date.now(),
            executionId: decision.executionId,
            executionStatus: record?.status ?? "missing",
            verified,
            detail: verified
                ? `execution record verified: status=success`
                : `execution record status=${record?.status ?? "missing"} (expected success)`,
        };

        this.decisionStore.updateStatus(decisionId, verified ? "verified" : "failed", {
            executedAtMs: decision.executedAtMs ?? Date.now(),
            executionId: decision.executionId,
            executionResult: decision.executionResult,
            verificationResult,
        });

        return verificationResult;
    }

    /**
     * 拒绝决策（proposed → rejected）
     */
    rejectDecision(decisionId: string): boolean {
        const decision = this.decisionStore.getById(decisionId);
        if (!decision) throw new Error(`decision not found: ${decisionId}`);
        assertTransition(decisionId, decision.status, "rejected");
        this.decisionStore.updateStatus(decisionId, "rejected");
        return true;
    }

    /**
     * 获取单个决策
     */
    getDecision(decisionId: string): MetaDecision | undefined {
        return this.decisionStore.getById(decisionId);
    }

    /**
     * 获取全局政策状态
     */
    getPolicyState(): MetaPolicyState {
        return { ...this.globalPolicyState };
    }

    /**
     * 获取决策历史
     */
    getDecisionHistory(options: {
        decisionType?: DecisionType;
        status?: DecisionStatus;
        limit?: number;
        offset?: number;
    }): MetaDecision[] {
        return this.decisionStore.query(options);
    }

    // ─── Private: Decision Logic ───

    private decideDegrade(component: string, alertId: string): MetaDecision {
        return this.createDecision(
            { eventType: "alert_raised", sourceId: alertId, detail: "Critical alert triggered degrade" },
            "degrade",
            component,
            { degraded: true, severity: "high", reason: "Auto-degrade due to critical alert" },
            0.6,
            `Component "${component}" triggered critical alert. Auto-degrading to prevent cascading failures.`,
        );
    }

    private decideRedispatch(component: string, alertId: string): MetaDecision | undefined {
        // Check if there are alternative agents for this capability
        const agents = this.registry?.listAgents("online") ?? [];
        const alternatives = agents.filter((a) =>
            a.capabilities.some((c) => c.name === component),
        );

        if (alternatives.length === 0) {
            // No alternatives → escalate to degrade
            return undefined;
        }

        return this.createDecision(
            { eventType: "alert_raised", sourceId: alertId, detail: "Continuous failure triggered redispatch" },
            "redispatch",
            component,
            { alternatives: alternatives.map((a) => ({ agentId: a.agentId, name: a.name })) },
            0.7,
            `Component "${component}" has ${alternatives.length} alternative agents. Re-routing traffic.`,
        );
    }

    private decideSwitchPolicy(component: string, alertId: string): MetaDecision {
        return this.createDecision(
            { eventType: "alert_raised", sourceId: alertId, detail: "Timeout pattern detected" },
            "switch_policy",
            component,
            { newPolicy: "strict_mode", reason: "Timeout threshold exceeded" },
            0.5,
            `Component "${component}" exceeded timeout threshold. Switching to strict mode with extended timeout and retry limit.`,
        );
    }

    private createDecision(
        trigger: DecisionTriggerEvent,
        type: DecisionType,
        target: string,
        params: Record<string, unknown>,
        confidence: number,
        reasoning: string,
    ): MetaDecision {
        return {
            decisionId: crypto.randomUUID(),
            triggerEvent: trigger,
            decisionType: type,
            targetComponent: target,
            actionParams: params,
            confidenceScore: confidence,
            reasoningText: reasoning,
            status: "proposed",
            createdAtMs: Date.now(),
        };
    }

    /**
     * 执行决策动作 — 产出真实执行结果（禁止伪造成功）
     */
    private runAction(decision: MetaDecision): {
        status: "success" | "failure";
        detail: string;
        error?: { type: string; message: string };
    } {
        switch (decision.decisionType) {
            case "redispatch": {
                // 真实重新派发：经过 dispatcher（含 Phase 1 guardrail + Phase 3.2 trust gate）
                const match = this.dispatcher?.dispatch({ taskType: decision.targetComponent });
                if (!match) {
                    return {
                        status: "failure",
                        detail: "no trusted online agent matched for redispatch",
                        error: {
                            type: "NoSuitableAgent",
                            message: `redispatch failed: no trusted online agent matched for "${decision.targetComponent}"`,
                        },
                    };
                }
                return {
                    status: "success",
                    detail: `redispatch target: ${match.agentName} (${match.capabilityId}) via ${match.matchType}`,
                };
            }
            case "degrade":
            case "switch_policy":
            case "scale_agent":
                // 当前无真实执行器 → 真实失败，禁止伪造成功
                return {
                    status: "failure",
                    detail: `no real executor wired for decision type "${decision.decisionType}"`,
                    error: {
                        type: "NoExecutor",
                        message: `decision type ${decision.decisionType} has no real executor`,
                    },
                };
        }
    }
}