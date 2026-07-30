/**
 * SimulationEngine — 沙盒推演引擎
 *
 * 流程：
 * 1. 生成候选方案 (≥2 个)
 * 2. 加载 7.1 经验过滤
 * 3. 评分：Score = (P * Ws) - (C * Wc) - (R * Wr)
 * 4. 选最优方案
 */

import crypto from "node:crypto";
import { SimulationOption, SimulationResult, ExperienceHitRecord } from "./types";
import type { FailureExtractor } from "../experience/failure-extractor";
import type { ExperienceInjector, InjectionResult } from "../experience/experience-injector";

// 权重配置
const W_SUCCESS = 10.0;
const W_COST = 0.01;
const W_RISK = 5.0;

export class SimulationEngine {
    private extractor: FailureExtractor;
    private injector: ExperienceInjector;
    private hitRecords: ExperienceHitRecord[] = [];

    constructor(extractor: FailureExtractor, injector: ExperienceInjector) {
        this.extractor = extractor;
        this.injector = injector;
    }

    /**
     * 推演入口：传入决策上下文，生成方案并评分
     */
    runSimulation(context: {
        triggerContext: string;
        taskType?: string;
        category?: string;
        failedComponent?: string;
    }): SimulationResult {
        // 1. 加载经验约束
        const experienceConstraints = this.injector.getConstraintsForDispatch({
            taskType: context.taskType || context.triggerContext,
            category: context.category,
        });

        // 2. 生成候选方案
        const options = this.generateOptions(context, experienceConstraints);

        // 3. 评分
        const scored = this.scoreOptions(options, experienceConstraints);

        // 4. 选择最优
        scored.sort((a, b) => b.overallScore - a.overallScore);
        const selected = scored[0];

        // 5. 记录经验命中
        this.recordHits(scored, context.triggerContext);

        const result: SimulationResult = {
            simulationId: crypto.randomUUID(),
            triggerContext: context.triggerContext,
            optionsEvaluated: scored,
            selectedOptionId: selected.optionId,
            reasoningText: this.buildReasoning(scored, selected, experienceConstraints),
            createdAtMs: Date.now(),
        };

        return result;
    }

    /**
     * 获取经验命中统计
     */
    getHitMetrics(): {
        totalSimulations: number;
        totalHits: number;
        avoidedErrors: number;
        experienceROI: number;
    } {
        const totalSims = new Set(this.hitRecords.map((r) => r.simulationId)).size;
        const totalHits = this.hitRecords.filter((r) => r.matched).length;
        const avoidedErrors = this.hitRecords.filter((r) => r.avoidedError).length;

        return {
            totalSimulations: totalSims,
            totalHits,
            avoidedErrors,
            experienceROI: totalHits > 0 ? Math.round((avoidedErrors / totalHits) * 10000) / 100 : 0,
        };
    }

    // ─── Private ───

    private generateOptions(context: {
        triggerContext: string;
        taskType?: string;
        category?: string;
        failedComponent?: string;
    }, constraints: InjectionResult): SimulationOption[] {
        const base = context.triggerContext;
        const hasAvoid = constraints.constraints.avoid.length > 0;

        const options: SimulationOption[] = [];

        // Option A: Standard retry (baseline)
        options.push({
            optionId: crypto.randomUUID(),
            name: `Option A: Standard Retry — ${base}`,
            actionType: "retry",
            params: { strategy: "standard", target: base, maxRetries: 3 },
            predictedSuccessRate: hasAvoid ? 0.4 : 0.7,
            estimatedCostToken: 5000,
            estimatedLatencyMs: 5000,
            matchedExperienceIds: [],
            overallScore: 0,
            riskFactors: hasAvoid ? ["History indicates this approach has failed before"] : [],
        });

        // Option B: Alternative routing via dispatcher
        options.push({
            optionId: crypto.randomUUID(),
            name: `Option B: Alternative Routing — ${base}`,
            actionType: "redispatch",
            params: { strategy: "alternative", target: base, preferOverrides: constraints.constraints.prefer },
            predictedSuccessRate: 0.85,
            estimatedCostToken: 3000,
            estimatedLatencyMs: 3000,
            matchedExperienceIds: [],
            overallScore: 0,
            riskFactors: [],
        });

        // Option C: Degrade with fallback
        options.push({
            optionId: crypto.randomUUID(),
            name: `Option C: Fallback Degrade — ${base}`,
            actionType: "degrade",
            params: { strategy: "fallback", target: base, useCachedData: true },
            predictedSuccessRate: 0.95,
            estimatedCostToken: 500,
            estimatedLatencyMs: 500,
            matchedExperienceIds: [],
            overallScore: 0,
            riskFactors: ["May return stale data"],
        });

        return options;
    }

    private scoreOptions(
        options: SimulationOption[],
        constraints: InjectionResult,
    ): SimulationOption[] {
        return options.map((opt) => {
            const matchedIds: string[] = [];
            const riskFactors = [...opt.riskFactors];
            let riskPenalty = 0;

            // Check each experience constraint against this option
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
                        opt.predictedSuccessRate = Math.min(opt.predictedSuccessRate + 0.1, 0.99);
                    }
                }
            }

            const riskScore = riskPenalty + riskFactors.length * 0.5;
            const score = (opt.predictedSuccessRate * W_SUCCESS)
                - (opt.estimatedCostToken / 1000 * W_COST)
                - (riskScore * W_RISK);

            return {
                ...opt,
                matchedExperienceIds: matchedIds,
                riskFactors,
                overallScore: Math.round(score * 100) / 100,
            };
        });
    }

    private recordHits(options: SimulationOption[], simulationTrigger: string): void {
        const simulationId = crypto.randomUUID();
        let bestOptionId = options[0]?.optionId || "";

        for (const opt of options) {
            for (const expId of opt.matchedExperienceIds) {
                this.hitRecords.push({
                    hitId: crypto.randomUUID(),
                    experienceId: expId,
                    simulationId,
                    matched: true,
                    avoidedError: opt.optionId === bestOptionId,
                    createdAtMs: Date.now(),
                });
            }
        }
    }

    private buildReasoning(
        options: SimulationOption[],
        selected: SimulationOption,
        constraints: InjectionResult,
    ): string {
        const parts: string[] = [];
        parts.push(`Evaluated ${options.length} options for "${selected.actionType}".`);
        parts.push(`Selected: "${selected.name}" (score=${selected.overallScore}, success=${Math.round(selected.predictedSuccessRate * 100)}%, cost=${selected.estimatedCostToken}tokens).`);

        if (constraints.experiences.length > 0) {
            parts.push(`${constraints.experiences.length} experience rules applied.`);
            const avoided = constraints.constraints.avoid;
            if (avoided.length > 0) {
                parts.push(`Avoided known failure patterns: ${avoided.join(", ")}.`);
            }
        }

        if (selected.matchedExperienceIds.length > 0) {
            parts.push(`${selected.matchedExperienceIds.length} experiences matched this option.`);
        }

        return parts.join(" ");
    }
}
