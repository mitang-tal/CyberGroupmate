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

export class CapabilityDispatcher {
    constructor(private registry: CapabilityRegistry) {}

    /**
     * 根据任务需求分发到最合适的 Agent
     */
    dispatch(request: DispatchRequest): DispatchMatch | undefined {
        const agents = this.registry.listAgents().filter(
            (a) => a.status === "online" || a.status === "busy",
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
        const agents = this.registry.listAgents().filter(
            (a) => a.status === "online" || a.status === "busy",
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

        // Sort by confidence desc, then by active task count asc
        results.sort((a, b) => {
            if (b.confidence !== a.confidence) return b.confidence - a.confidence;
            const agentA = this.registry.getAgent(a.agentId);
            const agentB = this.registry.getAgent(b.agentId);
            return (agentA?.activeTaskCount ?? 0) - (agentB?.activeTaskCount ?? 0);
        });

        return results;
    }

    // ─── Private ───

    private tryExactMatch(agents: AgentRegistration[], tags: string[]): DispatchMatch | undefined {
        for (const agent of agents) {
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
        // Sort by active task count ascending (least loaded first)
        const sorted = [...agents].sort(
            (a, b) => a.activeTaskCount - b.activeTaskCount,
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
        const sorted = [...agents].sort(
            (a, b) => a.activeTaskCount - b.activeTaskCount,
        );

        for (const agent of sorted) {
            // Find the capability whose name best matches the task type
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

        // Last resort: any online agent, first capability
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

    private similarityScore(a: string, b: string): number {
        const al = a.toLowerCase();
        const bl = b.toLowerCase();
        if (al === bl) return 1;
        if (al.includes(bl) || bl.includes(al)) return 0.8;
        // Simple word overlap
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
