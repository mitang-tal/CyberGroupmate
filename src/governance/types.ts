/**
 * Governance 数据模型
 */

export type GuardrailRuleType = "budget_limit" | "rate_limit" | "loop_prevention" | "kill_switch";

export type PolicyStatus = "active" | "disabled";

export type ViolationSourceType = "meta_decision" | "task_patch" | "dispatch" | "host_call";

export type ViolationAction = "blocked" | "escalated_to_human" | "terminated";

export interface GovernancePolicy {
    policyId: string;
    name: string;
    ruleType: GuardrailRuleType;
    config: {
        maxReplanPerExecution?: number;
        maxTokenBudget?: number;
        cooldownPeriodSec?: number;
        isKillSwitchActive?: boolean;
    };
    status: PolicyStatus;
    createdAtMs: number;
    updatedAtMs: number;
}

export interface GuardrailViolation {
    violationId: string;
    policyId: string;
    ruleType: GuardrailRuleType;
    sourceType: ViolationSourceType;
    sourceId: string;
    actionTaken: ViolationAction;
    reasoning: string;
    createdAtMs: number;
}

export interface GuardrailEvaluation {
    allowed: boolean;
    violatedPolicies: GuardrailViolation[];
    reasoning: string;
}

export interface GuardrailEvaluationPayload {
    sourceType: ViolationSourceType;
    sourceId: string;
    executionId?: string;
    stepId?: string;
    /**
     * Phase 3.3：replan 计数由系统维护（execution_id → ExecutionRecord/ReplanPlan history），
     * 不再接受调用方传入的 replanCount（该字段已从类型中移除，调用方无法编译期传入）。
     */
}

/** 护栏评估器最小契约（由 Agent Runtime 外层注入，供派发 / host-call / 执行入口共用） */
export interface GuardrailEvaluatorLike {
    evaluateGuardrails(payload: GuardrailEvaluationPayload): GuardrailEvaluation;
}
