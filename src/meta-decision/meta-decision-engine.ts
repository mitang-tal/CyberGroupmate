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
import { MetaDecision, MetaPolicyState, DecisionTriggerEvent, DecisionType, DecisionStatus } from "./types";
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
     * 执行决策
     */
    executeDecision(decisionId: string): boolean {
        const decision = this.decisionStore.getById(decisionId);
        if (!decision || decision.status !== "proposed") return false;

        const now = Date.now();

        switch (decision.decisionType) {
            case "degrade":
                this.applyDegrade(decision.targetComponent);
                break;
            case "redispatch":
                // Redispatch is advisory — the caller re-calls dispatcher with different params
                break;
            case "switch_policy":
                this.applyPolicySwitch(decision.targetComponent, decision.actionParams);
                break;
            case "scale_agent":
                // Scale is advisory — logged for human intervention
                break;
        }

        this.decisionStore.updateStatus(decisionId, "executed", now);

        // Update global policy state
        this.globalPolicyState.activeDecisions.push({
            decisionId: decision.decisionId,
            decisionType: decision.decisionType,
            targetComponent: decision.targetComponent,
            appliedAtMs: now,
        });
        this.globalPolicyState.lastEvaluatedAtMs = now;

        return true;
    }

    /**
     * 拒绝决策
     */
    rejectDecision(decisionId: string): boolean {
        const decision = this.decisionStore.getById(decisionId);
        if (!decision || decision.status !== "proposed") return false;
        this.decisionStore.updateStatus(decisionId, "rejected");
        return true;
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

    private applyDegrade(component: string): void {
        if (!this.globalPolicyState.degradedComponents.includes(component)) {
            this.globalPolicyState.degradedComponents.push(component);
        }
    }

    private applyPolicySwitch(component: string, params: Record<string, unknown>): void {
        // Policy switch is recorded in the decision log
        // Actual policy change is handled by the component's policy manager
    }
}
