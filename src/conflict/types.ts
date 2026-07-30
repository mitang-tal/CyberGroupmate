/**
 * Conflict Resolver 数据模型
 */

export type AgentTier = "meta_council" | "primary_worker" | "fallback_worker";

export interface Proposal {
    proposalId: string;
    agentId: string;
    agentName: string;
    tier: AgentTier;
    actionType: string;
    actionParams: Record<string, unknown>;
    trustScore: number;
    riskScore: number;
    submittedAtMs: number;
}

export interface ArbitrationVerdict {
    verdictId: string;
    conflictCaseId: string;
    winner: Proposal;
    reasoning: string;
    tieBreakerUsed: "reputation" | "risk" | "tier" | "timestamp" | "llm_fallback";
    ruledAtMs: number;
}

export interface ConflictCase {
    conflictCaseId: string;
    resourceId: string;
    conflictType: string;
    proposals: Proposal[];
    verdict?: ArbitrationVerdict;
    createdAtMs: number;
    resolvedAtMs?: number;
    complexContext?: boolean;
}
