/**
 * CapabilityDispatcher — 基于能力的智能路由引擎
 *
 * 匹配策略（按优先级）：
 * 1. Exact Match — tags 完全匹配
 * 2. Rule Match — category 匹配 + 最低活跃任务数
 * 3. Fallback Match — 任意在线 Agent
 */

import { CapabilityRegistry } from "./capability-registry";
import { DispatchRequest, DispatchMatch, AgentRegistration } from "./types";
import type { GuardrailEvaluatorLike } from "../governance/types.js";
import { createLogger } from "../core/logger.js";

const log = createLogger("capability-dispatcher");

/** #23 probation 过滤：#23 规定 probation agent 只接 low-stakes，priority ≥ 此值视为 high-stakes */
const HIGH_STAKES_PRIORITY = 7;

/**
 * #24 C9 推演联动：结构类型，避免与 simulation 模块产生依赖环。
 * 仅使用 runSimulation 的可观测结果（predictedSuccessRate）。
 */
export interface SimulationEngineLike {
    runSimulation(
        context: { triggerContext: string; taskType?: string; category?: string },
        opts?: { mode?: "full" | "fast" },
    ): { optionsEvaluated: { predictedSuccessRate: number; overallScore: number }[] };
}

export class CapabilityDispatcher {
    private reputationProvider?: (agentId: string) => { trustScore: number; trustState: string; reliability: number };
    private guardrailEvaluator?: GuardrailEvaluatorLike;
    private simulationEngine?: SimulationEngineLike;

    constructor(private registry: CapabilityRegistry) {}

    /** 注入声誉权重提供者 */
    setReputationProvider(
        provider: (agentId: string) => { trustScore: number; trustState: string; reliability: number },
    ): void {
        this.reputationProvider = provider;
    }

    /** #24 C9：注入推演引擎（决策前跑沙盒推演，按预测成功率收紧信任门槛） */
    setSimulationEngine(engine: SimulationEngineLike): void {
        this.simulationEngine = engine;
    }

    /** 注入护栏评估器（Audit Fix Phase 1：所有自主派发入口必须经过护栏） */
    setGuardrailEvaluator(evaluator: GuardrailEvaluatorLike): void {
        this.guardrailEvaluator = evaluator;
    }

    /**
     * 根据任务需求分发到最合适的 Agent
     */
    dispatch(request: DispatchRequest): DispatchMatch | undefined {
        // ═══ Guardrail Runtime Check (Phase 1) ═══
        // 任何自主派发入口必须经过护栏（Kill Switch / Loop Prevention / Rate Limit）
        if (this.guardrailEvaluator) {
            const evaluation = this.guardrailEvaluator.evaluateGuardrails({
                sourceType: "dispatch",
                sourceId: request.taskType,
                stepId: request.category ?? request.taskType,
            });
            if (!evaluation.allowed) {
                log.warn("dispatch blocked by guardrail", {
                    taskType: request.taskType,
                    category: request.category,
                    reasoning: evaluation.reasoning,
                });
                return undefined;
            }
        }

        // #24 C9：决策前跑推演，低预测成功率的任务要求更高 agent 信任分
        const simRequiredTrust = this.simulationRequiredTrust(request);

        const agents = this.registry.listAgents().filter(
            (a) => (a.status === "online" || a.status === "busy")
                && this.isDispatchEligible(a, request)
                && (simRequiredTrust === undefined || this.reputationScore(a) >= simRequiredTrust),
        );

        if (agents.length === 0) return undefined;

        // 1. Exact Match by tags
        if (request.tags && request.tags.length > 0) {
            const exact = this.tryExactMatch(agents, request.tags);
            if (exact) return exact;
        }

        // 2. Rule Match by category
        if (request.category) {
            const rule = this.tryRuleMatch(agents, request.category);
            if (rule) return rule;
        }

        // 3. Fallback Match
        return this.tryFallbackMatch(agents, request.taskType);
    }

    /**
     * 批量评估可用的 Agent 列表（按匹配度排序）
     */
    listCandidates(request: DispatchRequest): DispatchMatch[] {
        // #24 C9：与 dispatch 一致的推演信任门槛
        const simRequiredTrust = this.simulationRequiredTrust(request);

        const agents = this.registry.listAgents().filter(
            (a) => (a.status === "online" || a.status === "busy")
                && this.isDispatchEligible(a, request)
                && (simRequiredTrust === undefined || this.reputationScore(a) >= simRequiredTrust),
        );

        const results: DispatchMatch[] = [];

        for (const agent of agents) {
            for (const cap of agent.capabilities) {
                let matchType: DispatchMatch["matchType"] | null = null;
                let confidence = 0;

                // Exact tag match
                if (request.tags && request.tags.some((t) => cap.tags.includes(t))) {
                    matchType = "exact";
                    confidence = 1.0;
                }
                // Category match
                else if (request.category && cap.category === request.category) {
                    matchType = "rule";
                    confidence = 0.7;
                }
                // Task type name match
                else if (cap.name.toLowerCase().includes(request.taskType.toLowerCase()) ||
                         request.taskType.toLowerCase().includes(cap.name.toLowerCase())) {
                    matchType = "rule";
                    confidence = 0.5;
                }

                if (matchType) {
                    results.push({
                        agentId: agent.agentId,
                        agentName: agent.name,
                        capabilityId: cap.capabilityId,
                        matchType,
                        confidence,
                    });
                }
            }
        }

        // Sort by confidence desc, then by reputation weight desc, then by active task count asc
        results.sort((a, b) => {
            if (b.confidence !== a.confidence) return b.confidence - a.confidence;
            const weightA = this.getReputationWeight(a.agentId);
            const weightB = this.getReputationWeight(b.agentId);
            if (weightB !== weightA) return weightB - weightA;
            const agentA = this.registry.getAgent(a.agentId);
            const agentB = this.registry.getAgent(b.agentId);
            return (agentA?.activeTaskCount ?? 0) - (agentB?.activeTaskCount ?? 0);
        });

        return results;
    }

    // ─── Private ───

    private tryExactMatch(agents: AgentRegistration[], tags: string[]): DispatchMatch | undefined {
        for (const agent of agents) {
            // Phase 3.2 硬过滤：untrusted agent 不允许通过 exact match 获得任务
            if (!this.isTrustedAgent(agent)) continue;
            for (const cap of agent.capabilities) {
                const hasAllTags = tags.every((t) => cap.tags.includes(t));
                if (hasAllTags) {
                    return {
                        agentId: agent.agentId,
                        agentName: agent.name,
                        capabilityId: cap.capabilityId,
                        matchType: "exact",
                        confidence: 1.0,
                    };
                }
            }
        }
        return undefined;
    }

    private tryRuleMatch(agents: AgentRegistration[], category: string): DispatchMatch | undefined {
        // Phase 3.2 硬过滤：untrusted agent 不允许通过 rule match 获得任务
        const trusted = agents.filter((a) => this.isTrustedAgent(a));
        if (trusted.length === 0) return undefined;

        // Sort by reputation weight desc, then active task count asc
        const sorted = [...trusted].sort(
            (a, b) => {
                const wa = this.getReputationWeight(a.agentId);
                const wb = this.getReputationWeight(b.agentId);
                if (wb !== wa) return wb - wa;
                return a.activeTaskCount - b.activeTaskCount;
            },
        );

        for (const agent of sorted) {
            for (const cap of agent.capabilities) {
                if (cap.category === category) {
                    return {
                        agentId: agent.agentId,
                        agentName: agent.name,
                        capabilityId: cap.capabilityId,
                        matchType: "rule",
                        confidence: 0.7,
                    };
                }
            }
        }
        return undefined;
    }

    private tryFallbackMatch(agents: AgentRegistration[], taskType: string): DispatchMatch | undefined {
        // Phase 3.2 硬过滤：untrusted agent 不允许通过 fallback match 获得任务
        const trusted = agents.filter((a) => this.isTrustedAgent(a));
        if (trusted.length === 0) return undefined;

        const sorted = [...trusted].sort(
            (a, b) => {
                const wa = this.getReputationWeight(a.agentId);
                const wb = this.getReputationWeight(b.agentId);
                if (wb !== wa) return wb - wa;
                return a.activeTaskCount - b.activeTaskCount;
            },
        );

        for (const agent of sorted) {
            let bestCap: (typeof agent.capabilities)[0] | undefined;
            let bestScore = 0;

            for (const cap of agent.capabilities) {
                const score = this.similarityScore(cap.name, taskType);
                if (score > bestScore) {
                    bestScore = score;
                    bestCap = cap;
                }
            }

            if (bestCap) {
                return {
                    agentId: agent.agentId,
                    agentName: agent.name,
                    capabilityId: bestCap.capabilityId,
                    matchType: "fallback",
                    confidence: 0.3,
                };
            }
        }

        const first = sorted[0];
        if (first && first.capabilities.length > 0) {
            return {
                agentId: first.agentId,
                agentName: first.name,
                capabilityId: first.capabilities[0].capabilityId,
                matchType: "fallback",
                confidence: 0.2,
            };
        }

        return undefined;
    }

    /**
     * Phase 3.2 硬过滤：untrusted agent 直接排除，不允许通过任何匹配路径获得任务。
     * trustState 来源：reputationProvider（main.ts 注入，按 agentId 查询）。
     * 未注入 reputationProvider 时保持原行为（不启用过滤，避免误伤无信任系统的环境）。
     */
    private isTrustedAgent(agent: AgentRegistration): boolean {
        if (!this.reputationProvider) return true;
        const rep = this.reputationProvider(agent.agentId);
        return rep.trustState !== "untrusted";
    }

    /**
     * #23 probation：probation agent 只接 low-stakes（priority < HIGH_STAKES_PRIORITY）。
     * high-stakes 任务直接排除 probation，防止重权重任务落到降级中的 agent。
     */
    private isDispatchEligible(agent: AgentRegistration, request: DispatchRequest): boolean {
        if (!this.isTrustedAgent(agent)) return false;
        if (!this.reputationProvider) return true;
        const rep = this.reputationProvider(agent.agentId);
        if (rep.trustState !== "probation") return true;
        return (request.priority ?? 0) < HIGH_STAKES_PRIORITY;
    }

    /**
     * #24 C9：决策前跑沙盒推演。取最优方案 predictedSuccessRate，
     * 成功率越低 → 要求 agent 信任分越高（requiredTrust = 0.3 + (1-sim)*0.7）。
     * 未注入推演引擎时返回 undefined（不收紧门槛，保持原行为）。
     */
    private simulationRequiredTrust(request: DispatchRequest): number | undefined {
        if (!this.simulationEngine) return undefined;
        try {
            const mode = (request.priority ?? 0) >= HIGH_STAKES_PRIORITY ? "full" : "fast";
            const result = this.simulationEngine.runSimulation(
                { triggerContext: request.taskType, category: request.category },
                { mode },
            );
            const top = result.optionsEvaluated[0];
            const sim = top ? top.predictedSuccessRate : 0.5;
            return Math.min(1, 0.3 + (1 - sim) * 0.7);
        } catch (err) {
            log.warn("simulation gate failed, skip trust tightening", { taskType: request.taskType, error: err });
            return undefined;
        }
    }

    /** 取 agent 的信任分；未注入 reputationProvider 时按中性 0.5 */
    private reputationScore(agent: AgentRegistration): number {
        if (!this.reputationProvider) return 0.5;
        return this.reputationProvider(agent.agentId).trustScore;
    }

    private getReputationWeight(agentId: string): number {
        if (!this.reputationProvider) return 0.5;
        const rep = this.reputationProvider(agentId);
        if (rep.trustState === "untrusted") return 0;
        if (rep.trustState === "probation") return rep.trustScore * 0.5;
        return rep.trustScore;
    }

    private similarityScore(a: string, b: string): number {
        const al = a.toLowerCase();
        const bl = b.toLowerCase();
        if (al === bl) return 1;
        if (al.includes(bl) || bl.includes(al)) return 0.8;
        const aWords = new Set(al.split(/[_\s.-]+/));
        const bWords = new Set(bl.split(/[_\s.-]+/));
        let common = 0;
        for (const w of aWords) {
            if (bWords.has(w)) common++;
        }
        const maxWords = Math.max(aWords.size, bWords.size);
        return maxWords > 0 ? common / maxWords : 0;
    }
}
