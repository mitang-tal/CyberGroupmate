/**
 * Meta 自主决策引擎数据模型
 */

export type DecisionTriggerEventType = "alert_raised" | "system_overload" | "capacity_drop";

export type DecisionType = "switch_policy" | "redispatch" | "degrade" | "scale_agent";

export type DecisionStatus = "proposed" | "executed" | "rejected" | "failed";

export interface DecisionTriggerEvent {
    eventType: DecisionTriggerEventType;
    sourceId: string;
    detail?: string;
}

export interface MetaDecision {
    decisionId: string;
    triggerEvent: DecisionTriggerEvent;
    decisionType: DecisionType;
    targetComponent: string;
    actionParams: Record<string, unknown>;
    confidenceScore: number;
    reasoningText: string;
    status: DecisionStatus;
    createdAtMs: number;
    executedAtMs?: number;
}

/** 全局政策状态 */
export interface MetaPolicyState {
    activeDecisions: {
        decisionId: string;
        decisionType: DecisionType;
        targetComponent: string;
        appliedAtMs: number;
    }[];
    degradedComponents: string[];
    circuitBrokenComponents: string[];
    lastEvaluatedAtMs: number;
}
