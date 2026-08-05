/**
 * LoopPreventionError — 重规划次数超限时由 replan 入口抛出（Phase 3.3）
 */
export class LoopPreventionError extends Error {
    constructor(
        public readonly executionId: string,
        public readonly replanCount: number,
        public readonly maxReplan: number,
    ) {
        super(
            `loop prevention triggered: ${replanCount} replans for execution ${executionId} (max ${maxReplan})`,
        );
        this.name = "LoopPreventionError";
    }
}
