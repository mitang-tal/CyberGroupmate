/**
 * CostGuard — 成本护栏（Token / API 调用预算）
 *
 * 连接 Phase 5.4 Analytics 和 Phase 6.4 Guardrails。
 * 在 Execution start 前检查预算，超出则拦截。
 */

import type { LLMResponse } from "../core/llm.js";

export interface CostBudget {
    /** 24h Token 上限（input+output） */
    maxTokenBudget24h: number;
    /** 单次 Execution Token 上限 */
    maxTokenPerExecution: number;
    /** 24h API 调用次数上限 */
    maxApiCalls24h: number;
    /** 每日费用上限（USD cents） */
    maxDailyCostCents: number;
}

export interface CostUsage {
    tokenUsed24h: number;
    apiCalls24h: number;
    dailyCostCents: number;
    lastResetAtMs: number;
}

export interface CostCheckResult {
    allowed: boolean;
    reason?: string;
    usage: CostUsage;
    budget: CostBudget;
}

const DEFAULT_BUDGET: CostBudget = {
    maxTokenBudget24h: 10_000_000,   // 10M tokens/day
    maxTokenPerExecution: 500_000,   // 500K tokens/call
    maxApiCalls24h: 10_000,          // 10K API calls/day
    maxDailyCostCents: 5000,         // $50/day
};

export class CostGuard {
    private budget: CostBudget;
    private usage: CostUsage;
    private resetInterval: ReturnType<typeof setInterval> | null = null;

    constructor(budget?: Partial<CostBudget>) {
        this.budget = { ...DEFAULT_BUDGET, ...budget };
        this.usage = {
            tokenUsed24h: 0,
            apiCalls24h: 0,
            dailyCostCents: 0,
            lastResetAtMs: Date.now(),
        };

        // Auto-reset every 24h
        this.resetInterval = setInterval(() => this.reset(), 24 * 3600_000);
    }

    /**
     * 在执行前检查预算
     */
    checkExecution(tokenEstimated: number): CostCheckResult {
        if (tokenEstimated > this.budget.maxTokenPerExecution) {
            return {
                allowed: false,
                reason: `Token limit per execution: ${tokenEstimated} > ${this.budget.maxTokenPerExecution}`,
                usage: { ...this.usage },
                budget: { ...this.budget },
            };
        }

        if (this.usage.tokenUsed24h + tokenEstimated > this.budget.maxTokenBudget24h) {
            return {
                allowed: false,
                reason: `24h token budget exhausted: ${this.usage.tokenUsed24h + tokenEstimated} > ${this.budget.maxTokenBudget24h}`,
                usage: { ...this.usage },
                budget: { ...this.budget },
            };
        }

        if (this.usage.apiCalls24h + 1 > this.budget.maxApiCalls24h) {
            return {
                allowed: false,
                reason: `24h API call limit: ${this.usage.apiCalls24h + 1} > ${this.budget.maxApiCalls24h}`,
                usage: { ...this.usage },
                budget: { ...this.budget },
            };
        }

        return { allowed: true, usage: { ...this.usage }, budget: { ...this.budget } };
    }

    /**
     * 记录执行后的实际消耗
     */
    recordUsage(tokenUsed: number, costCents: number): void {
        this.usage.tokenUsed24h += tokenUsed;
        this.usage.apiCalls24h += 1;
        this.usage.dailyCostCents += costCents;
    }

    /**
     * 记录一次真实 LLM 调用的 token 用量。
     * 免费模型（无 pricing）也计数 token 与调用次数，costCents 传 0。
     */
    recordLLMUsage(usage: LLMResponse["usage"], costCents = 0): void {
        if (!usage) return;
        const tokenUsed =
            (usage.promptTokens ?? 0)
            + (usage.completionTokens ?? 0)
            + (usage.cachedTokens ?? 0)
            + (usage.cacheCreationTokens ?? 0);
        this.recordUsage(tokenUsed, costCents);
    }

    /**
     * 获取当前使用情况
     */
    getUsage(): CostUsage & { budgetUtilization: { tokenPct: number; apiPct: number; costPct: number } } {
        return {
            ...this.usage,
            budgetUtilization: {
                tokenPct: Math.round((this.usage.tokenUsed24h / this.budget.maxTokenBudget24h) * 10000) / 100,
                apiPct: Math.round((this.usage.apiCalls24h / this.budget.maxApiCalls24h) * 10000) / 100,
                costPct: Math.round((this.usage.dailyCostCents / this.budget.maxDailyCostCents) * 10000) / 100,
            },
        };
    }

    /**
     * 重置计数器（每日自动调用）
     */
    reset(): void {
        this.usage = {
            tokenUsed24h: 0,
            apiCalls24h: 0,
            dailyCostCents: 0,
            lastResetAtMs: Date.now(),
        };
    }

    /**
     * 更新预算配置
     */
    updateBudget(budget: Partial<CostBudget>): void {
        this.budget = { ...this.budget, ...budget };
    }

    destroy(): void {
        if (this.resetInterval) {
            clearInterval(this.resetInterval);
            this.resetInterval = null;
        }
    }
}
