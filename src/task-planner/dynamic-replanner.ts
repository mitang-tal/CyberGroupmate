/**
 * DynamicReplanner — 动态任务重规划引擎
 *
 * 1. 断点分析：从 Trace Tree 中定位失败的 Step
 * 2. Patch 生成：根据失败原因生成 replace / skip / insert / truncate 策略
 * 3. Hot-Swap 应用：将 Patch 写入存储，生成 ReplanPlan
 */

import crypto from "node:crypto";
import { TaskPatch, ExecutionReplanPlan, ReplacementStep, PatchType } from "./types";
import type { TaskPatchStore } from "./task-patch-store";
import type { ExecutionRecordService } from "../execution/execution-record-service";
import type { CapabilityDispatcher } from "../capability-registry/capability-dispatcher";

export class DynamicReplanner {
    private patchStore: TaskPatchStore;
    private service: ExecutionRecordService;
    private dispatcher?: CapabilityDispatcher;

    constructor(
        patchStore: TaskPatchStore,
        service: ExecutionRecordService,
        dispatcher?: CapabilityDispatcher,
    ) {
        this.patchStore = patchStore;
        this.service = service;
        this.dispatcher = dispatcher;
    }

    /**
     * 分析 Trace 断点，生成 Task Patch
     */
    generateTaskPatch(executionId: string, failedStepId: string): TaskPatch | undefined {
        const trace = this.service.getTrace(executionId);
        if (!trace) return undefined;

        // Locate the failed step in the trace tree
        const failedStep = this.findNodeById(trace, failedStepId);
        if (!failedStep) return undefined;

        const record = failedStep.record;
        const status = record.status;
        const errorType = record.error?.type || "UnknownError";

        // Choose patch strategy based on error and context
        const patchType = this.selectPatchType(status, errorType, record.source);
        const completedSteps = this.collectCompletedSteps(trace, failedStepId);

        const patch: TaskPatch = {
            patchId: crypto.randomUUID(),
            executionId,
            failedStepId,
            patchType,
            reasoning: this.buildReasoning(patchType, record, completedSteps.length),
            status: "draft",
            createdAtMs: Date.now(),
        };

        // Generate replacement steps for replace / insert strategies
        if (patchType === "replace_step" || patchType === "insert_fallback_step") {
            const replacement = this.generateReplacementSteps(record, patchType);
            if (replacement.length > 0) {
                patch.replacementSteps = replacement;
            }
        }

        this.patchStore.insertPatch(patch);
        return patch;
    }

    /**
     * 应用 Task Patch，生成 ReplanPlan
     */
    applyTaskPatch(patchId: string): ExecutionReplanPlan | undefined {
        const patch = this.patchStore.getPatch(patchId);
        if (!patch || patch.status !== "draft") return undefined;

        const trace = this.service.getTrace(patch.executionId);
        if (!trace) return undefined;

        const completedIds = this.collectCompletedStepIds(trace, patch.failedStepId);
        const remainingIds = this.extractRemainingStepIds(trace, patch.failedStepId);

        const plan: ExecutionReplanPlan = {
            planId: crypto.randomUUID(),
            executionId: patch.executionId,
            originalTraceNodeId: patch.failedStepId,
            patches: [patch],
            completedStepIds: completedIds,
            remainingStepIds: remainingIds,
            status: "active",
            createdAtMs: Date.now(),
            updatedAtMs: Date.now(),
        };

        // Update patch status
        this.patchStore.updatePatchStatus(patchId, "applied");

        // Store the plan
        this.patchStore.insertPlan(plan);

        return plan;
    }

    // ─── Public queries ───

    getReplanningHistory(executionId: string): {
        patches: TaskPatch[];
        plans: ExecutionReplanPlan[];
    } {
        return {
            patches: this.patchStore.queryPatches(executionId),
            plans: this.patchStore.queryPlans(executionId),
        };
    }

    getPatch(patchId: string): TaskPatch | undefined {
        return this.patchStore.getPatch(patchId);
    }

    getPlan(planId: string): ExecutionReplanPlan | undefined {
        return this.patchStore.getPlan(planId);
    }

    // ─── Private ───

    private selectPatchType(status: string, errorType: string, source: string): PatchType {
        // Timeout / transient → replace step
        if (status === "timed_out" || errorType === "TimeoutError") {
            return "replace_step";
        }
        // Policy denied → skip step
        if (status === "policy_denied") {
            return "skip_step";
        }
        // Source is host_call with failure → fallback
        if (source === "host_call" && status === "failure") {
            return "insert_fallback_step";
        }
        // Terminal failure for non-critical path → truncate
        if (status === "failure" || status === "interrupted") {
            // If many steps completed, truncate; otherwise replace
            return "replace_step";
        }
        return "replace_step";
    }

    private buildReasoning(patchType: PatchType, record: any, completedCount: number): string {
        const base = `Step "${record.method}" (${record.source}) failed with status "${record.status}"`;
        switch (patchType) {
            case "replace_step":
                return `${base}. Replacing step with alternative implementation. ${completedCount} preceding steps preserved.`;
            case "skip_step":
                return `${base}. Step is non-critical, skipping to continue execution chain.`;
            case "insert_fallback_step":
                return `${base}. Inserting fallback handler to recover from host call failure.`;
            case "truncate_and_complete":
                return `${base}. Truncating remaining chain. ${completedCount} completed steps are sufficient.`;
        }
    }

    private generateReplacementSteps(record: any, patchType: PatchType): ReplacementStep[] {
        const method = record.method || "unknown";
        const steps: ReplacementStep[] = [];

        if (patchType === "replace_step") {
            // Try to dispatch to an alternative capability
            const candidate = this.dispatcher?.dispatch({
                taskType: method,
                category: record.source,
            });

            steps.push({
                stepName: `${method} (retry)`,
                targetCapability: candidate?.capabilityId || method,
                inputParams: {
                    originalMethod: method,
                    originalSource: record.source,
                    retryStrategy: "alternative",
                },
                expectedOutputHint: "Same output as original step via alternative path",
            });
        }

        if (patchType === "insert_fallback_step") {
            steps.push({
                stepName: `${method} (fallback)`,
                targetCapability: "fallback_handler",
                inputParams: {
                    failedMethod: method,
                    fallbackMode: "cached_default",
                },
                expectedOutputHint: "Safe default value or cached result",
            });
        }

        return steps;
    }

    private findNodeById(node: any, id: string): any {
        if (node.record?.id === id) return node;
        if (node.children) {
            for (const child of node.children) {
                const found = this.findNodeById(child, id);
                if (found) return found;
            }
        }
        return undefined;
    }

    private collectCompletedSteps(node: any, failedId: string): any[] {
        const completed: any[] = [];
        this.traverseCompleted(node, failedId, completed);
        return completed;
    }

    private traverseCompleted(node: any, failedId: string, completed: any[]): boolean {
        if (node.record?.id === failedId) return true; // Stop at failed step
        if (node.record?.status === "success" || node.record?.status === "completed") {
            completed.push(node.record);
        }
        if (node.children) {
            for (const child of node.children) {
                const found = this.traverseCompleted(child, failedId, completed);
                if (found) return true;
            }
        }
        return false;
    }

    private collectCompletedStepIds(node: any, failedId: string): string[] {
        const ids: string[] = [];
        this.traverseIds(node, failedId, ids, true);
        return ids;
    }

    private extractRemainingStepIds(node: any, failedId: string): string[] {
        const ids: string[] = [];
        this.traverseIds(node, failedId, ids, false);
        return ids;
    }

    private traverseIds(node: any, failedId: string, ids: string[], collectBefore: boolean): boolean {
        if (node.record?.id === failedId) {
            if (!collectBefore) ids.push(node.record.id);
            return true;
        }
        if (collectBefore) {
            ids.push(node.record.id);
        }
        if (node.children) {
            for (const child of node.children) {
                const found = this.traverseIds(child, failedId, ids, collectBefore);
                if (found && !collectBefore && node.children) {
                    // Also add siblings after the failed node
                    const idx = node.children.indexOf(child);
                    for (let i = idx + 1; i < node.children.length; i++) {
                        this.collectAllIds(node.children[i], ids);
                    }
                }
                if (found) return true;
            }
        }
        return false;
    }

    private collectAllIds(node: any, ids: string[]): void {
        ids.push(node.record?.id);
        if (node.children) {
            for (const child of node.children) {
                this.collectAllIds(child, ids);
            }
        }
    }
}
