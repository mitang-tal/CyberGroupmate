/**
 * Task Planner 数据模型
 */

export type PatchType = "replace_step" | "skip_step" | "insert_fallback_step" | "truncate_and_complete";

export type PatchStatus = "draft" | "applied" | "discarded";

export interface ReplacementStep {
    stepName: string;
    targetCapability: string;
    inputParams: Record<string, unknown>;
    expectedOutputHint?: string;
}

export interface TaskPatch {
    patchId: string;
    executionId: string;
    failedStepId: string;
    patchType: PatchType;
    replacementSteps?: ReplacementStep[];
    reasoning: string;
    status: PatchStatus;
    createdAtMs: number;
    appliedAtMs?: number;
}

export interface ExecutionReplanPlan {
    planId: string;
    executionId: string;
    originalTraceNodeId: string;
    patches: TaskPatch[];
    completedStepIds: string[];
    remainingStepIds: string[];
    status: "draft" | "active" | "completed" | "failed";
    createdAtMs: number;
    updatedAtMs: number;
}
