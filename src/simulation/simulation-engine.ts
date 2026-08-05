/**
 * SimulationEngine — 沙盒推演引擎
 *
 * 流程：
 * 1. 生成候选方案（full: 3 方案 / fast: 单候选）
 * 2. 加载 7.1 经验过滤（经 ExperienceInjector，共享热路径缓存）
 * 3. 评分：Score = (P * Ws) - (C * Wc) - (R * Wr)，scorer 可替换、权重可配置
 * 4. 选最优方案；推演在内存沙盒内 apply，最后由 StateVirtualizer 整体 restore 保持无副作用
 */

import crypto from "node:crypto";
import { SimulationOption, SimulationResult, ExperienceHitRecord, SimulationRunOptions, SimulationWeights } from "./types";
import type { FailureExtractor } from "../experience/failure-extractor";
import type { ExperienceInjector, InjectionResult } from "../experience/experience-injector";
import type { SimulationScorer } from "./scorer";
import { StaticWeightedScorer } from "./scorer";
import type { SandboxStateVirtualizer } from "./state-virtualizer";

export interface SimulationEngineConfig {
    scorer?: SimulationScorer;
    weights?: Partial<SimulationWeights>;
    virtualizer?: SandboxStateVirtualizer;
}

export class SimulationEngine {
    private extractor: FailureExtractor;
    private injector: ExperienceInjector;
    private scorer: SimulationScorer;
    private virtualizer?: SandboxStateVirtualizer;
    private hitRecords: ExperienceHitRecord[] = [];
    private totalSimulations = 0;

    constructor(extractor: FailureExtractor, injector: ExperienceInjector, config: SimulationEngineConfig = {}) {
        this.extractor = extractor;
        this.injector = injector;
        this.scorer = config.scorer ?? new StaticWeightedScorer(config.weights);
        this.virtualizer = config.virtualizer;
    }

    /**
     * 推演入口：传入决策上下文，生成方案并评分。
     * mode：full 完整多方案；fast 单候选快速路径（low-risk 决策）。
     */
    runSimulation(
        context: {
            triggerContext: string;
            taskType?: string;
            category?: string;
            failedComponent?: string;
        },
        runOptions: SimulationRunOptions = {},
    ): SimulationResult {
        const mode: "full" | "fast" = runOptions.mode ?? "full";
        const snapshot = this.virtualizer?.snapshot();

        try {
            // 1. 加载经验约束（走共用热路径缓存）
            const experienceConstraints = this.injector.getConstraintsForDispatch({
                taskType: context.taskType || context.triggerContext,
                category: context.category,
            });

            // 2. 生成候选方案
            const options = mode === "fast"
                ? this.generateFastOption(context, experienceConstraints)
                : this.generateOptions(context, experienceConstraints);

            // 3. 评分（scorer 可替换 / 权重可配置）
            const scored = this.scorer.score(options, experienceConstraints);

            // 4. 选择最优
            scored.sort((a, b) => b.overallScore - a.overallScore);
            const selected = scored[0];

            // 5. 构建推演结果
            const result: SimulationResult = {
                simulationId: crypto.randomUUID(),
                triggerContext: context.triggerContext,
                optionsEvaluated: scored,
                selectedOptionId: selected.optionId,
                reasoningText: this.buildReasoning(scored, selected, experienceConstraints, mode),
                createdAtMs: Date.now(),
            };

            // 6. 记录经验命中（按真实 simulationId 与选中方案）
            this.recordHits(scored, selected, result.simulationId);

            // 7. 仅在即将成功返回前累加推演计数，避免中途 throw / early return 被误计入
            this.totalSimulations += 1;

            return result;
        } finally {
            // 8. 沙盒推演对真实运行态无副作用：restore 到推演前状态
            if (this.virtualizer && snapshot) {
                this.virtualizer.restore(snapshot);
            }
        }
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
        const totalHits = this.hitRecords.filter((r) => r.matched).length;
        const avoidedErrors = this.hitRecords.filter((r) => r.avoidedError).length;

        return {
            totalSimulations: this.totalSimulations,
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

    private generateFastOption(context: {
        triggerContext: string;
        taskType?: string;
        category?: string;
        failedComponent?: string;
    }, constraints: InjectionResult): SimulationOption[] {
        const base = context.triggerContext;
        const hasAvoid = constraints.constraints.avoid.length > 0;

        // 快速路径：仅评估基准 retry，命中经验则直接规避
        return [{
            optionId: crypto.randomUUID(),
            name: `Option A: Expedited Retry — ${base}`,
            actionType: "retry",
            params: { strategy: "fast", target: base, maxRetries: hasAvoid ? 0 : 3 },
            predictedSuccessRate: hasAvoid ? 0.4 : 0.7,
            estimatedCostToken: 2500,
            estimatedLatencyMs: 800,
            matchedExperienceIds: [],
            overallScore: 0,
            riskFactors: hasAvoid ? ["History indicates this approach has failed before"] : [],
        }];
    }

    private buildReasoning(
        options: SimulationOption[],
        selected: SimulationOption,
        constraints: InjectionResult,
        mode: "full" | "fast",
    ): string {
        const parts: string[] = [];
        parts.push(`[${mode}] Evaluated ${options.length} option(s) for "${selected.actionType}".`);
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

    private recordHits(options: SimulationOption[], selected: SimulationOption, simulationId: string): void {
        for (const opt of options) {
            for (const expId of opt.matchedExperienceIds) {
                this.hitRecords.push({
                    hitId: crypto.randomUUID(),
                    experienceId: expId,
                    simulationId,
                    matched: true,
                    avoidedError: opt.optionId === selected.optionId,
                    createdAtMs: Date.now(),
                });
            }
        }
    }
}