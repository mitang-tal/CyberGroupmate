import { MetaDecision, DecisionStatus, DecisionType, DecisionTriggerEventType } from "./types";

export interface DecisionStore {
    insert(decision: MetaDecision): void;
    updateStatus(decisionId: string, status: DecisionStatus, executedAtMs?: number): void;
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
