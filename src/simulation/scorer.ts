/**
 * Simulation Scorer — 沙盒推演评分器
 *
 * #14 决策：评分权重静态可配置（默认 Wsuccess=10 / Wcost=0.01 / Wrisk=5），
 * 并抽取为可替换的 SimulationScorer 接口，便于后续切换为动态 ROI 回归校准。
 */

import { SimulationOption, SimulationWeights } from "./types";
import type { InjectionResult } from "../experience/experience-injector";

export const DEFAULT_WEIGHTS: SimulationWeights = { success: 10.0, cost: 0.01, risk: 5.0 };

export interface SimulationScorer {
    score(options: SimulationOption[], constraints: InjectionResult): SimulationOption[];
}

export class StaticWeightedScorer implements SimulationScorer {
    private weights: SimulationWeights;

    constructor(weights: Partial<SimulationWeights> = {}) {
        this.weights = { ...DEFAULT_WEIGHTS, ...weights };
    }

    score(options: SimulationOption[], constraints: InjectionResult): SimulationOption[] {
        return options.map((opt) => {
            const matchedIds: string[] = [];
            const riskFactors = [...opt.riskFactors];
            let riskPenalty = 0;
            let predicted = opt.predictedSuccessRate;

            for (const exp of constraints.experiences) {
                if (exp.rule.avoid && opt.name.toLowerCase().includes(exp.rule.avoid.toLowerCase())) {
                    matchedIds.push(exp.experienceId);
                    riskPenalty += (1 - exp.confidence) * 2;
                    riskFactors.push(`Experience: avoid "${exp.rule.avoid}" (confidence ${Math.round(exp.confidence * 100)}%)`);
                }
                if (exp.rule.prefer) {
                    const preferOverrides = opt.params?.preferOverrides as string[] | undefined;
                    if (preferOverrides?.includes(exp.rule.prefer)) {
                        matchedIds.push(exp.experienceId);
                        predicted = Math.min(predicted + 0.1, 0.99);
                    }
                }
            }

            const riskScore = riskPenalty + riskFactors.length * 0.5;
            const score = predicted * this.weights.success
                - (opt.estimatedCostToken / 1000) * this.weights.cost
                - riskScore * this.weights.risk;

            return {
                ...opt,
                predictedSuccessRate: predicted,
                matchedExperienceIds: matchedIds,
                riskFactors,
                overallScore: Math.round(score * 100) / 100,
            };
        });
    }
}