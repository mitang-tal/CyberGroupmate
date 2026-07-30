import { ExecutionHealingAction, HealingStrategy, HealingActionStatus } from "./execution-record.types";

export interface HealingStore {
    insert(action: ExecutionHealingAction): void;
    updateStatus(actionId: string, status: HealingActionStatus, error?: string, completedAtMs?: number): void;
    getById(actionId: string): ExecutionHealingAction | undefined;
    query(options: {
        alertId?: string;
        executionId?: string;
        strategy?: HealingStrategy;
        status?: HealingActionStatus;
        limit?: number;
        offset?: number;
    }): ExecutionHealingAction[];
    /** 检查同一组件在时间窗口内的自愈次数（防爆闸） */
    countRecentBySource(executionId: string, windowMs: number): number;
}
