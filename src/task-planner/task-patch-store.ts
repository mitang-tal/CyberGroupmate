import { TaskPatch, PatchType, PatchStatus, ExecutionReplanPlan } from "./types";

export interface TaskPatchStore {
    insertPatch(patch: TaskPatch): void;
    updatePatchStatus(patchId: string, status: PatchStatus, appliedAtMs?: number): void;
    getPatch(patchId: string): TaskPatch | undefined;
    queryPatches(executionId?: string, status?: PatchStatus): TaskPatch[];

    insertPlan(plan: ExecutionReplanPlan): void;
    updatePlanStatus(planId: string, status: ExecutionReplanPlan["status"]): void;
    getPlan(planId: string): ExecutionReplanPlan | undefined;
    queryPlans(executionId?: string): ExecutionReplanPlan[];
}
