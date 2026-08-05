import { GovernancePolicy, GuardrailViolation, GuardrailRuleType, PolicyStatus, ViolationSourceType, ViolationAction } from "./types";

export interface GovernanceStore {
    // Policies
    listPolicies(ruleType?: GuardrailRuleType, status?: PolicyStatus): GovernancePolicy[];
    getPolicy(policyId: string): GovernancePolicy | undefined;
    upsertPolicy(policy: GovernancePolicy): void;
    updatePolicyStatus(policyId: string, status: PolicyStatus): void;

    // Violations
    insertViolation(violation: GuardrailViolation): void;
    queryViolations(options: {
        ruleType?: GuardrailRuleType;
        sourceType?: ViolationSourceType;
        actionTaken?: ViolationAction;
        limit?: number;
        offset?: number;
    }): GuardrailViolation[];
    countViolationsSince(windowMs: number, ruleType?: GuardrailRuleType): number;
}
