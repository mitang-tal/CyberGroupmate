/**
 * ReputationEvaluator — 多维 Agent 声誉评估引擎（Phase 7.3 review 增强）
 *
 * 指标：
 * - 能力掌握度 (mastery): 贝叶斯收缩 + 冷启动先验（#19）
 * - 全局可靠性 (reliability): 指数半衰期时间衰减 + 延迟成本加权（#21 / #20）
 * - 风险概率 (riskProbability): alert 数 / 总执行数
 * - 平均延迟 (avgLatencyMs): 执行耗时均值
 * - 重复犯错惩罚（#20 抗 gaming）
 *
 * 信任状态机带滞回窗（#22）。
 * probation 行为：不硬排除、路由降权（dispatcher），另记 shadow 观察（#23）。
 */

import { AgentReputation, TrustState, ReputationEvaluationInput } from "./types";
import type { ReputationStore } from "./reputation-store";
import { calculateCapabilityScores } from "./capability-scorer";
import { calculateReliability, calculateTrustScore, determineTrustState } from "./trust-scorer";

const PROBATION_PERIOD_MS = 24 * 3600_000; // 24h
const HYSTERESIS_DEFAULT = 0.05;

export interface ReputationConfig {
    /** 冷启动先验（#19），默认 0.5 */
    prior?: number;
    /** 先验等效样本数（贝叶斯收缩强度），默认 2 */
    priorWeight?: number;
    /** 时间半衰期（#21），默认 7 天 */
    halfLifeMs?: number;
    /** 滞回窗宽（#22），默认 0.05 */
    hysteresis?: number;
    /** 成本加权强度（#20），默认 0.3 */
    costWeight?: number;
    /** latency 归一化基准 ms，默认 2000 */
    latencyScaleMs?: number;
    /** 风险罚权，默认 0.3 */
    riskWeight?: number;
    /** 重复犯错罚权（#20），默认 0.15 */
    repeatErrorWeight?: number;
    /** 胜任度权重（#19 融合），默认 0.4；reliability 权重 = 1 - masteryWeight */
    masteryWeight?: number;
    /** probation shadow mode（#23），默认 true */
    shadowEnabled?: boolean;
}

interface ShadowEntry {
    agentId: string;
    observedAtMs: number;
    trustScore: number;
    trustState: TrustState;
}

const DEFAULT_CONFIG: Required<ReputationConfig> = {
    prior: 0.5,
    priorWeight: 2,
    halfLifeMs: 7 * 24 * 3600_000,
    hysteresis: HYSTERESIS_DEFAULT,
    costWeight: 0.3,
    latencyScaleMs: 2000,
    riskWeight: 0.3,
    repeatErrorWeight: 0.15,
    masteryWeight: 0.4,
    shadowEnabled: true,
};

export class ReputationEvaluator {
    private store: ReputationStore;
    private cfg: Required<ReputationConfig>;
    private shadowLog: ShadowEntry[] = [];

    constructor(store: ReputationStore, config: ReputationConfig = {}) {
        this.store = store;
        this.cfg = { ...DEFAULT_CONFIG, ...config };
    }

    evaluate(input: ReputationEvaluationInput): AgentReputation {
        const now = Date.now();
        const total = input.capabilityExecutions.length;
        const existing = this.store.getByAgentId(input.agentId);
        const failures = input.capabilityExecutions.filter((e) => !e.success).length;

        // 无任何执行历史 → 中性声誉（normal / prior），避免空数据被误判
        if (total === 0) {
            const neutral: AgentReputation = {
                agentId: input.agentId,
                agentName: input.agentName,
                trustScore: this.cfg.prior,
                trustState: "normal",
                reliability: this.cfg.prior,
                riskProbability: 0,
                avgLatencyMs: 0,
                totalExecutions: existing?.totalExecutions ?? 0,
                totalFailures: 0,
                capabilityScores: existing?.capabilityScores ?? [],
                probationUntilMs: undefined,
                lastEvaluatedAtMs: now,
                updatedAtMs: now,
            };
            this.store.upsert(neutral);
            return neutral;
        }

        const meanLatency = input.capabilityExecutions.reduce((s, e) => s + e.latencyMs, 0) / total;

        // 能力分：#19 贝叶斯收缩（capability-scorer 独立计算器）
        const capabilityScores = calculateCapabilityScores(input.capabilityExecutions, {
            prior: this.cfg.prior,
            priorWeight: this.cfg.priorWeight,
        });

        // 可靠性（#20 加权 + #21 衰减）与重复犯错占比（trust-scorer）
        const { reliability, repeatRatio } = calculateReliability(input.capabilityExecutions, now, this.cfg);
        const riskProbability = Math.min(input.recentAlerts / total, 1);

        const trustScore = calculateTrustScore(reliability, riskProbability, repeatRatio, capabilityScores, this.cfg);
        const trustState = determineTrustState(trustScore, existing?.trustState, this.cfg.hysteresis);
        const probationUntilMs = trustState === "probation" ? now + PROBATION_PERIOD_MS : undefined;

        // #23 probation shadow 观察
        let probationShadow = false;
        if (trustState === "probation" && this.cfg.shadowEnabled) {
            probationShadow = true;
            this.shadowLog.push({ agentId: input.agentId, observedAtMs: now, trustScore, trustState });
        }

        const reputation: AgentReputation = {
            agentId: input.agentId,
            agentName: input.agentName,
            trustScore,
            trustState,
            reliability,
            riskProbability,
            avgLatencyMs: Math.round(meanLatency * 10) / 10,
            totalExecutions: (existing?.totalExecutions ?? 0) + total,
            totalFailures: (existing?.totalFailures ?? 0) + failures,
            capabilityScores,
            probationUntilMs,
            probationShadow,
            lastEvaluatedAtMs: now,
            updatedAtMs: now,
        };
        this.store.upsert(reputation);
        return reputation;
    }

    /** #23：probation shadow 观察日志 */
    getShadowLog(): ShadowEntry[] {
        return [...this.shadowLog];
    }

    evaluateAll(getAgentIds: () => { agentId: string; name: string }[]): AgentReputation[] {
        const results: AgentReputation[] = [];
        for (const agent of getAgentIds()) {
            const existing = this.store.getByAgentId(agent.agentId);
            if (!existing) continue;
            const timestampBase = existing.lastEvaluatedAtMs;
            const input: ReputationEvaluationInput = {
                agentId: agent.agentId,
                agentName: agent.name,
                capabilityExecutions: existing.capabilityScores.map((c) => ({
                    capabilityId: c.capabilityId,
                    capabilityName: c.capabilityName,
                    success: c.mastery > 0.5,
                    latencyMs: existing.avgLatencyMs || 0,
                    timestampMs: c.lastUsedAtMs || timestampBase,
                })),
                recentAlerts: Math.round((existing.riskProbability ?? 0) * (existing.totalExecutions ?? 0)),
                recentFailures: existing.totalFailures ?? 0,
            };
            results.push(this.evaluate(input));
        }
        return results;
    }

    listAll(): AgentReputation[] {
        return this.store.listAll();
    }

    getDispatchWeight(agentId: string): { trustScore: number; trustState: TrustState; reliability: number } {
        const rep = this.store.getByAgentId(agentId);
        if (!rep) return { trustScore: 0.5, trustState: "normal" as TrustState, reliability: 0.5 };
        if (rep.trustState === "untrusted") return { trustScore: 0, trustState: "untrusted", reliability: 0 };
        return { trustScore: rep.trustScore, trustState: rep.trustState, reliability: rep.reliability };
    }

    // ─── Private ───

    // ─── 评分逻辑已迁移至 trust-scorer / capability-scorer（独立计算器模块） ───
}