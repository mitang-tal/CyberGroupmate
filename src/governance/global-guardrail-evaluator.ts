/**
 * GlobalGuardrailEvaluator — 全局安全护栏评估引擎
 *
 * 规则：
 * - budget_limit: 配额控制（预留，未实现具体 Token 预算）
 * - rate_limit: 频率控制（窗口内违规次数上限）
 * - loop_prevention: 同节点重规划次数上限 + 死锁检测
 * - kill_switch: 全局熔断
 */

import crypto from "node:crypto";
import {
    GovernancePolicy,
    GuardrailViolation,
    GuardrailEvaluation,
    ViolationSourceType,
    ViolationAction,
    GuardrailRuleType,
    PolicyStatus,
} from "./types";
import type { GovernanceStore } from "./governance-store";

const VIOLATION_WINDOW_MS = 300_000; // 5 min window for rate limit

export class GlobalGuardrailEvaluator {
    private store: GovernanceStore;
    private killSwitchEngaged: boolean = false;

    constructor(store: GovernanceStore) {
        this.store = store;
    }

    /**
     * 前置评估：所有决策 / Patch / Dispatch 执行前调用
     */
    evaluateGuardrails(
        payload: {
            sourceType: ViolationSourceType;
            sourceId: string;
            executionId?: string;
            stepId?: string;
            replanCount?: number;
        },
    ): GuardrailEvaluation {
        const violations: GuardrailViolation[] = [];
        const policies = this.store.listPolicies(undefined, "active");

        for (const policy of policies) {
            const violation = this.evaluatePolicy(policy, payload);
            if (violation) {
                this.store.insertViolation(violation);
                violations.push(violation);
            }
        }

        if (violations.length > 0) {
            return {
                allowed: false,
                violatedPolicies: violations,
                reasoning: violations.map((v) => v.reasoning).join("; "),
            };
        }

        return {
            allowed: true,
            violatedPolicies: [],
            reasoning: "All guardrails passed",
        };
    }

    /**
     * Kill Switch 控制
     */
    toggleKillSwitch(active: boolean): void {
        this.killSwitchEngaged = active;
        // Update policy in store
        const policies = this.store.listPolicies("kill_switch");
        for (const p of policies) {
            p.config.isKillSwitchActive = active;
            p.updatedAtMs = Date.now();
            this.store.upsertPolicy(p);
        }
    }

    isKillSwitchActive(): boolean {
        return this.killSwitchEngaged;
    }

    /**
     * 获取循环/死锁风险评估（供外部调用）
     */
    getLoopRisk(executionId: string, stepId: string): { riskLevel: "low" | "medium" | "high"; replanCount: number } {
        const patches = this.store.queryViolations({
            ruleType: "loop_prevention",
            limit: 100,
        });

        const relevant = patches.filter(
            (v) => v.sourceId === executionId || v.sourceId.includes(stepId),
        );

        const count = relevant.length;
        if (count >= 3) return { riskLevel: "high", replanCount: count };
        if (count >= 2) return { riskLevel: "medium", replanCount: count };
        return { riskLevel: "low", replanCount: count };
    }

    // ─── Private ───

    private evaluatePolicy(
        policy: GovernancePolicy,
        payload: {
            sourceType: ViolationSourceType;
            sourceId: string;
            executionId?: string;
            stepId?: string;
            replanCount?: number;
        },
    ): GuardrailViolation | undefined {
        switch (policy.ruleType) {
            case "kill_switch":
                return this.evaluateKillSwitch(policy, payload);
            case "loop_prevention":
                return this.evaluateLoopPrevention(policy, payload);
            case "rate_limit":
                return this.evaluateRateLimit(policy, payload);
            case "budget_limit":
                // Reserved for future budget tracking
                return undefined;
            default:
                return undefined;
        }
    }

    private evaluateKillSwitch(
        policy: GovernancePolicy,
        payload: { sourceType: ViolationSourceType; sourceId: string },
    ): GuardrailViolation | undefined {
        if (this.killSwitchEngaged || policy.config.isKillSwitchActive) {
            return this.createViolation(policy, payload.sourceType, payload.sourceId, "blocked",
                `Kill switch is active. All autonomous operations are suspended.`);
        }
        return undefined;
    }

    private evaluateLoopPrevention(
        policy: GovernancePolicy,
        payload: { sourceType: ViolationSourceType; sourceId: string; executionId?: string; replanCount?: number },
    ): GuardrailViolation | undefined {
        const maxReplan = policy.config.maxReplanPerExecution ?? 3;
        const currentCount = payload.replanCount ?? 0;

        if (currentCount >= maxReplan) {
            return this.createViolation(policy, payload.sourceType, payload.sourceId, "terminated",
                `Loop prevention triggered: ${currentCount} replans detected (max ${maxReplan}). Execution ${payload.executionId || "unknown"} terminated.`);
        }

        // Check recent violations for the same executionId
        if (payload.executionId) {
            const recent = this.store.queryViolations({
                ruleType: "loop_prevention",
                limit: 10,
            });
            const sameExec = recent.filter((v) => v.sourceId === payload.executionId);
            if (sameExec.length >= maxReplan) {
                return this.createViolation(policy, payload.sourceType, payload.sourceId, "terminated",
                    `Loop prevention: ${sameExec.length} violations for execution ${payload.executionId}. Auto-terminated.`);
            }
        }

        return undefined;
    }

    private evaluateRateLimit(
        policy: GovernancePolicy,
        payload: { sourceType: ViolationSourceType; sourceId: string },
    ): GuardrailViolation | undefined {
        const cooldown = (policy.config.cooldownPeriodSec ?? 60) * 1000;
        const recent = this.store.countViolationsSince(cooldown);

        // Rate limit: if more than 10 violations in the cooldown window, block
        if (recent > 10) {
            return this.createViolation(policy, payload.sourceType, payload.sourceId, "blocked",
                `Rate limit exceeded: ${recent} violations in last ${cooldown / 1000}s.`);
        }

        return undefined;
    }

    // ─── Passthrough queries ───

    listPolicies(ruleType?: GuardrailRuleType, status?: PolicyStatus): GovernancePolicy[] {
        return this.store.listPolicies(ruleType, status);
    }

    queryViolations(options: {
        ruleType?: GuardrailRuleType;
        sourceType?: ViolationSourceType;
        actionTaken?: ViolationAction;
        limit?: number;
        offset?: number;
    }): GuardrailViolation[] {
        return this.store.queryViolations(options);
    }

    private createViolation(
        policy: GovernancePolicy,
        sourceType: ViolationSourceType,
        sourceId: string,
        actionTaken: ViolationAction,
        reasoning: string,
    ): GuardrailViolation {
        return {
            violationId: crypto.randomUUID(),
            policyId: policy.policyId,
            ruleType: policy.ruleType,
            sourceType,
            sourceId,
            actionTaken,
            reasoning,
            createdAtMs: Date.now(),
        };
    }
}
