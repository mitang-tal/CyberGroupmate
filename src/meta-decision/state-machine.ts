/**
 * Meta Decision 状态机 — Phase 3.1 唯一权威定义
 *
 * 合法状态流：
 *   proposed → approved → executing → executed → verified
 *   proposed → rejected
 *   proposed → failed（护栏拦截 / 执行前置失败）
 *   approved → failed
 *   executing → failed（执行真实失败）
 *   executed → failed（验证失败：ExecutionRecord 非 success / 记录缺失）
 *
 * executed 状态强制绑定 execution_id（store 层校验）。
 * 违规 transition 抛错，并由 store 层记录到 decision.transitionError。
 */
import { DecisionStatus } from "./types";

export const VALID_TRANSITIONS: Record<DecisionStatus, DecisionStatus[]> = {
    proposed: ["approved", "rejected", "failed"],
    approved: ["executing", "failed"],
    executing: ["executed", "failed"],
    executed: ["verified", "failed"],
    verified: [],
    rejected: [],
    failed: [],
};

export class IllegalDecisionTransitionError extends Error {
    constructor(
        public readonly decisionId: string,
        public readonly from: DecisionStatus,
        public readonly to: DecisionStatus,
    ) {
        super(`illegal decision transition: ${from} → ${to} (decision ${decisionId})`);
        this.name = "IllegalDecisionTransitionError";
    }
}

/** 校验 transition，非法时抛 IllegalDecisionTransitionError */
export function assertTransition(decisionId: string, from: DecisionStatus, to: DecisionStatus): void {
    if (!VALID_TRANSITIONS[from].includes(to)) {
        throw new IllegalDecisionTransitionError(decisionId, from, to);
    }
}
