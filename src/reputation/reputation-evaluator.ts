/**
 * ReputationEvaluator — 多维 Agent 声誉评估引擎
 *
 * 指标：
 * - 能力掌握度 (mastery): 某能力下 success / total
 * - 全局可靠性 (reliability): 所有能力加权平均
 * - 风险概率 (riskProbability): alert 数 / 总执行数
 * - 平均延迟 (avgLatencyMs): 执行耗时滑动平均
 *
 * 信任状态机：
 *   trusted ←→ normal ←→ probation ←→ untrusted
 *
 * trusted:   trustScore ≥ 0.85, 高优先级调度
 * normal:    0.55 ≤ trustScore < 0.85, 正常调度
 * probation: 0.30 ≤ trustScore < 0.55, 低优先级, 考察期后可恢复
 * untrusted: trustScore < 0.30, 不被调度
 */

import crypto from "node:crypto";
import { AgentReputation, CapabilityScore, TrustState, ReputationEvaluationInput } from "./types";
import type { ReputationStore } from "./reputation-store";

const PROBATION_PERIOD_MS = 24 * 3600_000; // 24h

export class ReputationEvaluator {
    private store: ReputationStore;

    constructor(store: ReputationStore) {
        this.store = store;
    }

    /**
     * 评估单个 Agent 声誉
     */
    evaluate(input: ReputationEvaluationInput): AgentReputation {
        const now = Date.now();
        const total = input.capabilityExecutions.length;
        const existing = this.store.getByAgentId(input.agentId);

        // 无任何执行历史 → 中性声誉（normal / 0.5），
        // 避免全新 agent 因空数据被错误归类为 untrusted/probation。
        // 与 getDispatchWeight 无记录默认（normal / 0.5）保持一致。
        if (total === 0) {
            const neutral: AgentReputation = {
                agentId: input.agentId,
                agentName: input.agentName,
                trustScore: 0.5,
                trustState: "normal",
                reliability: 0.5,
                riskProbability: 0,
                avgLatencyMs: 0,
                totalExecutions: existing?.totalExecutions ?? 0,
                totalFailures: existing?.totalFailures ?? 0,
                capabilityScores: existing?.capabilityScores ?? [],
                probationUntilMs: undefined,
                lastEvaluatedAtMs: now,
                updatedAtMs: now,
            };
            this.store.upsert(neutral);
            return neutral;
        }

        const successes = input.capabilityExecutions.filter((e) => e.success).length;
        const failures = total - successes;

        // Per-capability scores
        const capMap = new Map<string, { name: string; success: number; total: number; totalLatency: number; lastTs: number }>();
        for (const exec of input.capabilityExecutions) {
            if (!capMap.has(exec.capabilityId)) {
                capMap.set(exec.capabilityId, { name: exec.capabilityName, success: 0, total: 0, totalLatency: 0, lastTs: 0 });
            }
            const entry = capMap.get(exec.capabilityId)!;
            entry.total++;
            if (exec.success) entry.success++;
            entry.totalLatency += exec.latencyMs;
            if (exec.timestampMs > entry.lastTs) entry.lastTs = exec.timestampMs;
        }

        const capabilityScores: CapabilityScore[] = Array.from(capMap.entries()).map(([id, data]) => ({
            capabilityId: id,
            capabilityName: data.name,
            mastery: data.total > 0 ? data.success / data.total : 0.5,
            executionCount: data.total,
            failureCount: data.total - data.success,
            lastUsedAtMs: data.lastTs,
        }));

        // Global metrics
        const reliability = total > 0 ? successes / total : 0.5;
        const riskProbability = total > 0 ? Math.min(input.recentAlerts / total, 1) : 0;
        const avgLatencyMs = total > 0
            ? input.capabilityExecutions.reduce((s, e) => s + e.latencyMs, 0) / total
            : 0;

        // Trust score: weighted composite
        const trustScore = this.calculateTrustScore(reliability, riskProbability, failures, total);

        // Determine trust state
        const trustState = this.determineTrustState(trustScore, input.agentId);
        const probationUntilMs = trustState === "probation" ? now + PROBATION_PERIOD_MS : undefined;

        // Check probation recovery
        if (existing?.trustState === "probation" && existing.probationUntilMs && now > existing.probationUntilMs) {
            // Probation period expired — check if behavior improved
            if (trustScore >= 0.55) {
                // Restore to normal
                this.store.updateTrustState(input.agentId, "normal");
            }
            // else stays in probation
        }

        const reputation: AgentReputation = {
            agentId: input.agentId,
            agentName: input.agentName,
            trustScore,
            trustState,
            reliability,
            riskProbability,
            avgLatencyMs,
            totalExecutions: (existing?.totalExecutions ?? 0) + total,
            totalFailures: (existing?.totalFailures ?? 0) + failures,
            capabilityScores,
            probationUntilMs,
            lastEvaluatedAtMs: now,
            updatedAtMs: now,
        };

        this.store.upsert(reputation);
        return reputation;
    }

    /**
     * 全量评估所有已知 Agent（由 CapabilityRegistry 提供列表）
     */
    evaluateAll(getAgentIds: () => { agentId: string; name: string }[]): AgentReputation[] {
        const agents = getAgentIds();
        const results: AgentReputation[] = [];

        for (const agent of agents) {
            const existing = this.store.getByAgentId(agent.agentId);
            if (existing) {
                // Re-evaluate with existing data as baseline
                const input: ReputationEvaluationInput = {
                    agentId: agent.agentId,
                    agentName: agent.name,
                    capabilityExecutions: existing.capabilityScores.map((c) => ({
                        capabilityId: c.capabilityId,
                        capabilityName: c.capabilityName,
                        success: c.mastery > 0.5,
                        latencyMs: existing.avgLatencyMs,
                        timestampMs: c.lastUsedAtMs,
                    })),
                    recentAlerts: Math.round(existing.riskProbability * existing.totalExecutions),
                    recentFailures: existing.totalFailures,
                };
                results.push(this.evaluate(input));
            }
        }

        return results;
    }

    /**
     * 列出所有 Agent 声誉
     */
    listAll(): AgentReputation[] {
        return this.store.listAll();
    }

    /**
     * 获取代理的声誉摘要（供 Dispatcher 使用）
     */
    getDispatchWeight(agentId: string): { trustScore: number; trustState: TrustState; reliability: number } {
        const rep = this.store.getByAgentId(agentId);
        if (!rep) return { trustScore: 0.5, trustState: "normal", reliability: 0.5 };
        if (rep.trustState === "untrusted") return { trustScore: 0, trustState: "untrusted", reliability: 0 };
        return { trustScore: rep.trustScore, trustState: rep.trustState, reliability: rep.reliability };
    }

    // ─── Private ───

    private calculateTrustScore(reliability: number, riskProbability: number, failures: number, total: number): number {
        if (total === 0) return 0.5; // 无历史数据 → 中性分数，避免空数据算成 0.25

        const relScore = reliability;                        // reliability 满分基数 1.0
        const riskPenalty = riskProbability * 0.3;           // risk 最高扣 -30%
        const failureRatePenalty = (failures / total) * 0.2; // failure rate 最高扣 -20%

        const score = relScore - riskPenalty - failureRatePenalty;
        return Math.max(0, Math.min(1, Math.round(score * 100) / 100));
    }

    private determineTrustState(trustScore: number, agentId: string): TrustState {
        const existing = this.store.getByAgentId(agentId);

        if (trustScore >= 0.85) return "trusted";
        if (trustScore >= 0.55) return "normal";
        if (trustScore >= 0.30) return "probation";

        // untrusted: if previously trusted/normal, check if probation expired first
        if (existing && (existing.trustState === "trusted" || existing.trustState === "normal")) {
            // Direct drop to untrusted only if risk is very high
            if (existing.riskProbability > 0.8) return "untrusted";
            return "probation";
        }

        return "untrusted";
    }
}
