/**
 * EvolutionAnalyzer — 离线 Agent 演化分析引擎
 *
 * 流水线：
 * 1. 采样过去 30 天声誉数据 (capabilityScores)
 * 2. 计算特化指数：某能力 mastery 高出全局平均 ≥20% 且执行 >20 次
 * 3. 检查 14 天 Cooling Window: lastEvolvedAt + 14d > now → 拒绝
 * 4. 产出 EvolutionProposal (status: pending_approval)
 * 5. 审批通过后写入 AgentRegistration.metadata
 */

import crypto from "node:crypto";
import { EvolutionProposal, SpecializationTag } from "./types";
import type { ReputationEvaluator } from "../reputation/reputation-evaluator";
import type { CapabilityRegistry } from "../capability-registry/capability-registry";
import { matchesCron } from "../core/cron-matcher.js";

const SAMPLING_DAYS = 30;
const DEFAULT_COOLING_DAYS = 14;
const MIN_EXECUTIONS = 20;
const SPECIALIZATION_THRESHOLD = 0.2; // 高出全局平均 20%

export class EvolutionAnalyzer {
    private reputationEvaluator: ReputationEvaluator;
    private capabilityRegistry?: CapabilityRegistry;
    private proposals: EvolutionProposal[] = [];
    private history: Map<string, number> = new Map(); // agentId → lastEvolvedAtMs
    private coolingDays: number = DEFAULT_COOLING_DAYS;
    private autoRunTimer: ReturnType<typeof setInterval> | null = null;
    private autoRunSchedule = "";
    private autoRunLastFiredKey = "";

    constructor(
        reputationEvaluator: ReputationEvaluator,
        deps: { capabilityRegistry?: CapabilityRegistry } = {},
    ) {
        this.reputationEvaluator = reputationEvaluator;
        this.capabilityRegistry = deps.capabilityRegistry;
    }

    /**
     * 8.4 C4 cron 定时触发：按 5 字段 cron 表达式周期性跑全量演化分析。
     * 每 checkIntervalMs（默认 60s）检查一次，同一分钟只触发一次（避免重复）。
     * @returns 停止函数（或在未启用时返回 null）
     */
    startAutoRun(schedule: string, checkIntervalMs = 60_000): (() => void) | null {
        this.stopAutoRun();
        this.autoRunSchedule = schedule;
        if (!schedule) return null;

        const timer = setInterval(() => {
            try {
                this.runAutoCheck(new Date());
            } catch (err) {
                console.error("[evolution] auto run failed:", err instanceof Error ? err.message : String(err));
            }
        }, checkIntervalMs);
        if (timer.unref) timer.unref();
        this.autoRunTimer = timer;
        return () => this.stopAutoRun();
    }

    /** 8.4 C4 单次 cron 检查：命中则跑全量分析并返回提案；未命中返回 undefined */
    runAutoCheck(now: Date): EvolutionProposal[] | undefined {
        if (!this.autoRunSchedule || !matchesCron(this.autoRunSchedule, now)) return undefined;
        const key = now.toISOString().slice(0, 16); // 按分钟去重
        if (key === this.autoRunLastFiredKey) return undefined;
        this.autoRunLastFiredKey = key;
        const proposals = this.analyzeAll();
        console.log(`[evolution] cron auto run fired: ${proposals.length} proposal(s)`);
        return proposals;
    }

    /** 8.4 C4 停止 cron 自动触发 */
    stopAutoRun(): void {
        if (this.autoRunTimer) {
            clearInterval(this.autoRunTimer);
            this.autoRunTimer = null;
        }
        this.autoRunLastFiredKey = "";
    }

    /** 是否已启用 cron 自动触发 */
    isAutoRunEnabled(): boolean {
        return this.autoRunTimer !== null;
    }

    /** Gov2 热更新：演化冷却窗口天数 */
    setCoolingDays(days: number): void {
        if (typeof days === "number" && days > 0) this.coolingDays = days;
    }

    /**
     * 触发全量离线演化分析
     */
    analyzeAll(getAgentIds?: () => { agentId: string; name: string }[]): EvolutionProposal[] {
        const agents = getAgentIds ? getAgentIds() : this.defaultAgentIds();
        const proposals: EvolutionProposal[] = [];

        for (const agent of agents) {
            const proposal = this.analyzeAgent(agent.agentId, agent.name);
            if (proposal) {
                proposals.push(proposal);
            }
        }

        return proposals;
    }

    /**
     * 分析单个 Agent 的演化方向
     */
    analyzeAgent(agentId: string, agentName: string): EvolutionProposal | undefined {
        // 1. 获取声誉数据
        const rep = this.reputationEvaluator.getDispatchWeight(agentId);
        // 从 store 获取完整画像
        const fullRep = this.reputationEvaluator.listAll().find((r) => r.agentId === agentId);

        if (!fullRep || fullRep.capabilityScores.length === 0) {
            return undefined;
        }

        // 2. 计算全局平均 mastery
        const scores = fullRep.capabilityScores;
        const globalAvgMastery = scores.reduce((s, c) => s + c.mastery, 0) / scores.length;

        // 3. 识别优势领域
        const suggestedTags: SpecializationTag[] = [];
        const deprecatedNames: string[] = [];

        for (const cap of scores) {
            // 执行次数达到安全样本
            if (cap.executionCount < MIN_EXECUTIONS) continue;

            // 特化指数：mastery 高出全局平均 ≥ 20%
            const specializationRatio = cap.mastery / (globalAvgMastery || 0.01);
            if (specializationRatio >= 1 + SPECIALIZATION_THRESHOLD) {
                const tagName = this.generateTagName(cap.capabilityName, cap.mastery);
                suggestedTags.push({
                    tagId: crypto.randomUUID(),
                    name: tagName,
                    category: cap.capabilityName,
                    confidence: Math.round(cap.mastery * 100) / 100,
                    identifiedAtMs: Date.now(),
                });
            }

            // 标记低效领域（mastery < 0.5 且有一定执行量）
            if (cap.mastery < 0.5 && cap.executionCount > MIN_EXECUTIONS) {
                deprecatedNames.push(cap.capabilityName);
            }
        }

        if (suggestedTags.length === 0 && deprecatedNames.length === 0) {
            return undefined;
        }

        // 4. Cooling Window 检查
        const lastEvolvedAt = this.history.get(agentId);
        if (lastEvolvedAt) {
            const coolingDeadline = lastEvolvedAt + this.coolingDays * 24 * 3600_000;
            if (Date.now() < coolingDeadline) {
                return undefined; // 冷却期内跳过
            }
        }

        // 5. 排序：按置信度降序
        suggestedTags.sort((a, b) => b.confidence - a.confidence);

        // 6. Top capability / worst capability
        const sortedByMastery = [...scores].sort((a, b) => b.mastery - a.mastery);
        const top = sortedByMastery[0];
        const worst = sortedByMastery[sortedByMastery.length - 1];

        const proposal: EvolutionProposal = {
            proposalId: crypto.randomUUID(),
            agentId,
            agentName,
            currentTags: this.readAppliedTags(agentId),
            suggestedTags,
            deprecatedTags: deprecatedNames,
            analysis: {
                sampleSize: scores.reduce((s, c) => s + c.executionCount, 0),
                samplingPeriodDays: SAMPLING_DAYS,
                topCapability: top?.capabilityName || "none",
                topMastery: Math.round((top?.mastery || 0) * 100) / 100,
                worstCapability: worst?.capabilityName || "none",
                worstMastery: Math.round((worst?.mastery || 0) * 100) / 100,
                globalAvgMastery: Math.round(globalAvgMastery * 100) / 100,
            },
            status: "pending_approval",
            createdAtMs: Date.now(),
            coolingDeadlineMs: (lastEvolvedAt || 0) + this.coolingDays * 24 * 3600_000,
        };

        this.proposals.push(proposal);
        return proposal;
    }

    /**
     * 批准演化建议
     */
    approveProposal(proposalId: string): EvolutionProposal | undefined {
        const proposal = this.proposals.find((p) => p.proposalId === proposalId);
        if (!proposal || proposal.status !== "pending_approval") return undefined;

        proposal.status = "approved";
        proposal.approvedAtMs = Date.now();

        // 8.4 C1：批准后实际回写 AgentRegistration.metadata，演化闸门真生效
        proposal.currentTags = this.applyTagsToRegistry(proposal);

        // 记录演化时间（冷却窗口以此为起点）
        this.history.set(proposal.agentId, Date.now());

        return proposal;
    }

    /**
     * 拒绝演化建议
     */
    rejectProposal(proposalId: string): EvolutionProposal | undefined {
        const proposal = this.proposals.find((p) => p.proposalId === proposalId);
        if (!proposal || proposal.status !== "pending_approval") return undefined;

        proposal.status = "rejected";
        proposal.rejectedAtMs = Date.now();

        return proposal;
    }

    /**
     * 获取演化建议列表
     */
    getProposals(status?: string): EvolutionProposal[] {
        if (status) {
            return this.proposals.filter((p) => p.status === status).reverse();
        }
        return [...this.proposals].reverse();
    }

    /**
     * 获取演化历史
     */
    getEvolutionHistory(): { agentId: string; proposalId: string; tagsApplied: SpecializationTag[]; appliedAtMs: number }[] {
        return this.proposals
            .filter((p) => p.status === "approved")
            .map((p) => ({
                agentId: p.agentId,
                proposalId: p.proposalId,
                tagsApplied: p.suggestedTags,
                appliedAtMs: p.approvedAtMs ?? p.createdAtMs,
            }));
    }

    /**
     * 获取冷却状态
     */
    getCoolingStatus(agentId: string): { inCooling: boolean; coolingDeadlineMs?: number; remainingDays?: number } {
        const lastEvolvedAt = this.history.get(agentId);
        if (!lastEvolvedAt) {
            return { inCooling: false };
        }

        const coolingDeadline = lastEvolvedAt + this.coolingDays * 24 * 3600_000;
        const now = Date.now();

        if (now < coolingDeadline) {
            const remainingMs = coolingDeadline - now;
            return {
                inCooling: true,
                coolingDeadlineMs: coolingDeadline,
                remainingDays: Math.ceil(remainingMs / (24 * 3600_000)),
            };
        }

        return { inCooling: false };
    }

    // ─── Private ───

    /**
     * 8.4 C4：未显式传 getAgentIds 时，从 CapabilityRegistry 枚举全部 Agent（供 cron 全量触发）
     */
    private defaultAgentIds(): { agentId: string; name: string }[] {
        if (!this.capabilityRegistry) return [];
        return this.capabilityRegistry.listAgents().map((a) => ({ agentId: a.agentId, name: a.name }));
    }

    /**
     * 从 AgentRegistration.metadata 读取已生效的特化标签
     */
    private readAppliedTags(agentId: string): SpecializationTag[] {
        const agent = this.capabilityRegistry?.getAgent(agentId);
        const meta = agent?.metadata;
        if (!meta || !Array.isArray(meta.specializationTags)) return [];
        return meta.specializationTags as SpecializationTag[];
    }

    /**
     * 批准后把 suggestedTags 合并写入 AgentRegistration.metadata.specializationTags，
     * 同时记录 lastEvolvedAtMs（冷却窗口持久化起点）。返回合并后的全部标签。
     */
    private applyTagsToRegistry(proposal: EvolutionProposal): SpecializationTag[] {
        const agent = this.capabilityRegistry?.getAgent(proposal.agentId);
        if (!agent) return proposal.currentTags;

        const metadata = agent.metadata ?? {};
        const existing = Array.isArray(metadata.specializationTags)
            ? (metadata.specializationTags as SpecializationTag[])
            : [];

        const merged = [...existing];
        for (const tag of proposal.suggestedTags) {
            const idx = merged.findIndex((t) => t.category === tag.category);
            if (idx >= 0) merged[idx] = tag;
            else merged.push(tag);
        }

        metadata.specializationTags = merged;
        metadata.lastEvolvedAtMs = proposal.approvedAtMs;
        agent.metadata = metadata;

        return merged;
    }

    private generateTagName(capabilityName: string, mastery: number): string {
        const prefix = mastery >= 0.9 ? "domain_expert" : mastery >= 0.75 ? "specialist" : "practitioner";
        return `${prefix}:${capabilityName}`;
    }
}
