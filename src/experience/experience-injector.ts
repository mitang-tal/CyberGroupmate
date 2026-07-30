/**
 * ExperienceInjector — 经验规则前置注入器
 *
 * 在 Capability Dispatch 和 Task Re-planning 前调用，
 * 自动加载相关经验约束，注入 avoid/prefer 规则。
 */

import { ExperienceItem, ExperienceQuery } from "./types";
import type { FailureExtractor } from "./failure-extractor";

export interface InjectionResult {
    experiences: ExperienceItem[];
    constraints: {
        avoid: string[];
        prefer: string[];
        rules: Record<string, unknown>[];
    };
}

export class ExperienceInjector {
    private extractor: FailureExtractor;

    constructor(extractor: FailureExtractor) {
        this.extractor = extractor;
    }

    /**
     * 在 Dispatch 前调用，获取约束
     */
    getConstraintsForDispatch(context: {
        taskType: string;
        tags?: string[];
        category?: string;
    }): InjectionResult {
        const experiences = this.extractor.queryRelevantExperience({
            tool: context.taskType,
            capability: context.category,
            minConfidence: 0.6,
        });

        return this.buildResult(experiences);
    }

    /**
     * 在 Re-planning 前调用，获取约束
     */
    getConstraintsForReplan(context: {
        executionId: string;
        failedStepMethod: string;
        failedStepSource: string;
    }): InjectionResult {
        const experiences = this.extractor.queryRelevantExperience({
            tool: context.failedStepMethod,
            capability: context.failedStepSource,
            minConfidence: 0.5, // Lower threshold for replanning (better safe than sorry)
        });

        return this.buildResult(experiences);
    }

    /**
     * 直接注入规则到目标
     */
    injectToTarget(experience: ExperienceItem, target: Record<string, unknown>): void {
        if (experience.rule.avoid) {
            target.avoidMethods = target.avoidMethods || [];
            (target.avoidMethods as string[]).push(experience.rule.avoid);
        }
        if (experience.rule.prefer) {
            target.preferMethods = target.preferMethods || [];
            (target.preferMethods as string[]).push(experience.rule.prefer);
        }
        if (experience.rule.constraints) {
            target.experienceConstraints = target.experienceConstraints || [];
            (target.experienceConstraints as Record<string, unknown>[]).push(experience.rule.constraints);
        }
    }

    private buildResult(experiences: ExperienceItem[]): InjectionResult {
        const avoid = new Set<string>();
        const prefer = new Set<string>();
        const rules: Record<string, unknown>[] = [];

        for (const exp of experiences) {
            if (exp.rule.avoid) avoid.add(exp.rule.avoid);
            if (exp.rule.prefer) prefer.add(exp.rule.prefer);
            if (exp.rule.constraints) rules.push(exp.rule.constraints);
        }

        return {
            experiences,
            constraints: {
                avoid: Array.from(avoid),
                prefer: Array.from(prefer),
                rules,
            },
        };
    }
}
