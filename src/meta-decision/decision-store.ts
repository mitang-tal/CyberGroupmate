import { MetaDecision, DecisionStatus, DecisionType, DecisionTriggerEventType, DecisionVerificationResult } from "./types";

export interface DecisionStatusUpdate {
    executedAtMs?: number;
    executionResult?: string;
    executionId?: string;
    verificationResult?: DecisionVerificationResult;
}

export interface DecisionStore {
    insert(decision: MetaDecision): void;
    updateStatus(decisionId: string, status: DecisionStatus, meta?: DecisionStatusUpdate): void;
    getById(decisionId: string): MetaDecision | undefined;
    query(options: {
        decisionType?: DecisionType;
        status?: DecisionStatus;
        triggerEventType?: DecisionTriggerEventType;
        targetComponent?: string;
        limit?: number;
        offset?: number;
    }): MetaDecision[];
    getRecentByTarget(targetComponent: string, windowMs: number): MetaDecision[];
    countByStatus(status: DecisionStatus): number;
}
