/**
 * Simulation 数据模型
 */

export interface SimulationOption {
    optionId: string;
    name: string;
    actionType: string;
    params: Record<string, unknown>;
    predictedSuccessRate: number;
    estimatedCostToken: number;
    estimatedLatencyMs: number;
    matchedExperienceIds: string[];
    overallScore: number;
    riskFactors: string[];
}

export interface SimulationResult {
    simulationId: string;
    triggerContext: string;
    optionsEvaluated: SimulationOption[];
    selectedOptionId: string;
    reasoningText: string;
    createdAtMs: number;
}

export type SimulationMode = "full" | "fast";

export interface SimulationWeights {
    success: number;
    cost: number;
    risk: number;
}

export interface SimulationRunOptions {
    /**
     * #17 决策推演延迟分档：high-stakes 走 full（完整多方案），low-risk 走 fast（快速单候选）。
     * 默认 full。可在配置层通过 decideMode(stakes) 辅助换算。
     */
    mode?: SimulationMode;
}

export interface ExperienceHitRecord {
    hitId: string;
    experienceId: string;
    simulationId: string;
    matched: boolean;
    avoidedError: boolean;
    createdAtMs: number;
}
