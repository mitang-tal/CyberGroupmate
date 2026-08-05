/**
 * Governance v2 — 持久化 Store 契约
 *
 * 仅持久化当前策略状态与审计日志；快照历史保留在内存（EcosystemGovernance）。
 */
import { GovernancePolicyValues, GovernanceAuditLog } from "./types";

export interface GovernanceV2State {
    version: string;
    values: GovernancePolicyValues;
    updatedAtMs: number;
}

export interface GovernanceV2Store {
    loadState(): GovernanceV2State | undefined;
    saveState(version: string, values: GovernancePolicyValues): void;
    insertAudit(log: GovernanceAuditLog): void;
    listAudit(limit?: number): GovernanceAuditLog[];
}
