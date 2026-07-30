/**
 * Failure Intelligence 数据模型
 */

export type FailureCategory =
    | "tool_capability_mismatch"
    | "parameter_invalid"
    | "resource_exhausted"
    | "logic_deadlock";

export type ExperienceType = "failure_prevention" | "performance_optimization";

export type ExperienceStatus = "active" | "decayed" | "expired" | "revoked";

export interface FailurePattern {
    patternId: string;
    category: FailureCategory;
    triggerContext: string;    // e.g. "telegram_media_send"
    symptom: string;           // e.g. "unknown_method"
    rootCause: string;         // e.g. "agent selected deprecated interface"
    frequency: number;
    confidence: number;        // 0.0 ~ 1.0
    firstObservedAtMs: number;
    lastObservedAtMs: number;
    sourceAlertIds: string[];
}

export interface ExperienceItem {
    experienceId: string;
    patternId: string;
    type: ExperienceType;
    context: {
        tool?: string;
        capability?: string;
        agentId?: string;
    };
    rule: {
        avoid?: string;
        prefer?: string;
        constraints?: Record<string, unknown>;
    };
    confidence: number;
    frequency: number;
    status: ExperienceStatus;
    expiresAtMs: number;
    createdAtMs: number;
    updatedAtMs: number;
}

export interface ExperienceQuery {
    tool?: string;
    capability?: string;
    agentId?: string;
    minConfidence?: number;
    status?: ExperienceStatus;
}
