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

export interface ExperienceHitRecord {
    hitId: string;
    experienceId: string;
    simulationId: string;
    matched: boolean;
    avoidedError: boolean;
    createdAtMs: number;
}
