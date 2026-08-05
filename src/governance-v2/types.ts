/**
 * Ecosystem Governance 数据模型
 */

export interface GovernancePolicyValues {
    federationMinTrustScore: number;
    negotiationTimeoutMs: number;
    evolutionCoolingDays: number;
    governorRateLimit: number;
    quarantineCategories: string[];
    /** 生态治理全局 Kill-Switch（唯一事实源，广播到 Guardrail 与 Governor） */
    killSwitch: boolean;
}

export interface PolicySnapshot {
    version: string;          // SemVer: "1.0.0", "1.1.0", "2.0.0"
    values: GovernancePolicyValues;
    changeDiff: string;       // 变更描述
    origin: string;            // 变更人/模块
    reason: string;            // 变更原因
    createdAtMs: number;
}

export interface GovernanceAuditLog {
    logId: string;
    action: "create" | "update" | "rollback" | "kill_switch";
    fromVersion?: string;
    toVersion: string;
    changeDiff: string;
    origin: string;
    reason: string;
    createdAtMs: number;
}

export const DEFAULT_POLICY_VALUES: GovernancePolicyValues = {
    federationMinTrustScore: 0.55,
    negotiationTimeoutMs: 500,
    evolutionCoolingDays: 14,
    governorRateLimit: 10,
    quarantineCategories: ["resource_exhausted", "logic_deadlock"],
    killSwitch: false,
};
