/**
 * Meta 自主决策引擎数据模型
 */

export type DecisionTriggerEventType = "alert_raised" | "system_overload" | "capacity_drop";

export type DecisionType = "switch_policy" | "redispatch" | "degrade" | "scale_agent";

export type DecisionStatus = "proposed" | "approved" | "executing" | "executed" | "verified" | "rejected" | "failed";

/** 决策执行验证结果（真实回读 ExecutionRecord 后产出，非标志位） */
export interface DecisionVerificationResult {
    verifiedAtMs: number;
    executionId: string;
    /** ExecutionRecord 实际状态（从 store 回读） */
    executionStatus: string;
    verified: boolean;
    detail: string;
}

/** 决策执行结果（engine 返回给调用方） */
export interface DecisionExecutionOutcome {
    ok: boolean;
    decisionId: string;
    status: DecisionStatus;
    executionId?: string;
}

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
    /** 执行决策时绑定的真实 ExecutionRecord id（decision_id → execution_id 链路） */
    executionId?: string;
    /** 真实执行产出（JSON 字符串，来自实际执行结果） */
    executionResult?: string;
    /** 执行后验证结果（真实回读 ExecutionRecord 后产出） */
    verificationResult?: DecisionVerificationResult;
    /** 非法状态迁移尝试的记录（store 层写入） */
    transitionError?: string;
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
