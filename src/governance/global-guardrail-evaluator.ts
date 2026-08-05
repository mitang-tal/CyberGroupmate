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

/** 环境变量阈值（优先级低于 governance policy config） */
const ENV_MAX_REPLAN = "CG_MAX_REPLAN_PER_EXECUTION";

/** 默认 replan 阈值 */
const DEFAULT_MAX_REPLAN = 3;

export class GlobalGuardrailEvaluator {
    private store: GovernanceStore;
    private killSwitchEngaged: boolean = false;
    /** Phase 3.3：系统侧 replan 计数提供者（execution_id → 真实 replan 事件次数） */
    private replanCounterProvider?: (executionId: string) => number;

    constructor(store: GovernanceStore) {
        this.store = store;
    }

    /**
     * Phase 3.3：注入系统侧 replan 计数提供者。
     * 计数必须来自系统记录（如 ReplanPlan / ExecutionRecord history），不可信任调用方自报。
     */
    setReplanCounterProvider(provider: ((executionId: string) => number) | undefined): void {
        this.replanCounterProvider = provider;
    }

    /** 当前 replan 计数提供者（供自检探针保存/恢复） */
    getReplanCounterProvider(): ((executionId: string) => number) | undefined {
        return this.replanCounterProvider;
    }

    /**
     * 当前 replan 阈值（policy config > 环境变量 > 默认 3）
     */
    getLoopPreventionLimit(): number {
        const policies = this.store.listPolicies("loop_prevention", "active");
        if (policies.length > 0) {
            const fromPolicy = this.resolveMaxReplan(policies[0]);
            if (fromPolicy.priority === "policy") return fromPolicy.value;
        }
        return this.resolveMaxReplan().value;
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
        // 内存状态与持久化状态必须一致（Audit Fix Phase 1.1）
        // 重启后 killSwitchEngaged 会重置为 false，但持久化的 policy config 仍可能是 active，
        // 若只返回内存状态，会出现 UI 显示 inactive 但 evaluateGuardrails 实际仍在阻断。
        if (this.killSwitchEngaged) return true;
        const policies = this.store.listPolicies("kill_switch");
        return policies.some((p) => p.config.isKillSwitchActive === true);
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
        payload: { sourceType: ViolationSourceType; sourceId: string; executionId?: string },
    ): GuardrailViolation | undefined {
        // Phase 3.3：replan 计数由系统维护，忽略调用方传入值（payload 类型已移除 replanCount）
        const maxReplan = this.resolveMaxReplan(policy).value;
        const currentCount =
            payload.executionId && this.replanCounterProvider
                ? this.replanCounterProvider(payload.executionId)
                : 0;

        if (currentCount >= maxReplan) {
            return this.createViolation(policy, payload.sourceType, payload.sourceId, "terminated",
                `Loop prevention triggered: ${currentCount} replans detected for execution ${payload.executionId || "unknown"} (max ${maxReplan}). Replanning terminated.`);
        }

        return undefined;
    }

    /**
     * 阈值解析：governance policy config > 环境变量 > 默认 3
     */
    private resolveMaxReplan(policy?: GovernancePolicy): { value: number; priority: "policy" | "env" | "default" } {
        if (policy && typeof policy.config.maxReplanPerExecution === "number" && policy.config.maxReplanPerExecution > 0) {
            return { value: policy.config.maxReplanPerExecution, priority: "policy" };
        }
        const fromEnv = Number(process.env[ENV_MAX_REPLAN]);
        if (Number.isFinite(fromEnv) && fromEnv > 0) {
            return { value: fromEnv, priority: "env" };
        }
        return { value: DEFAULT_MAX_REPLAN, priority: "default" };
    }

    private evaluateRateLimit(
        policy: GovernancePolicy,
        payload: { sourceType: ViolationSourceType; sourceId: string },
    ): GuardrailViolation | undefined {
        const cooldown = (policy.config.cooldownPeriodSec ?? 60) * 1000;
        // 只统计同类型（rate_limit）违规，避免 kill_switch/loop_prevention 违规级联触发限流
        const recent = this.store.countViolationsSince(cooldown, policy.ruleType);

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
