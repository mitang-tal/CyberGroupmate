/**
 * NegotiationEngine — 结构化 Contract-Net 密封出价引擎
 *
 * 流程：
 * 1. Meta 发布 TaskProposal
 * 2. Agent 在竞标窗口内提交 AgentBid（密封结构化 JSON，无自由文本）
 * 3. 评标：UtilityScore = confidence*0.5 + (1-cost/maxCost)*0.3 + (1-latency/slaLatency)*0.2
 * 4. 最多 2 轮（Round 1 初报，Round 2 修正）
 * 5. 500ms 硬超时 → 回退 Dispatcher / ConflictResolver
 */

import crypto from "node:crypto";
import { TaskProposal, AgentBid, ContractAward, NegotiationRound } from "./types";
import type { CapabilityDispatcher } from "../capability-registry/capability-dispatcher";
import type { ConflictResolver } from "../conflict/conflict-resolver";
import type { ConflictCase } from "../conflict/types";

const BID_TIMEOUT_MS = 500;  // 500ms per round
const MAX_ROUNDS = 2;

export class NegotiationEngine {
    private dispatcher?: CapabilityDispatcher;
    private conflictResolver?: ConflictResolver;
    private history: ContractAward[] = [];

    constructor(deps: {
        dispatcher?: CapabilityDispatcher;
        conflictResolver?: ConflictResolver;
    }) {
        this.dispatcher = deps.dispatcher;
        this.conflictResolver = deps.conflictResolver;
    }

    /**
     * 发布标案并运行完整协商（2 轮密封出价 + 500ms 超时）
     */
    async runNegotiation(proposal: TaskProposal): Promise<ContractAward> {
        const allBids: AgentBid[] = [];

        // Round 1: 初报
        const round1 = await this.runRound(proposal, 1);
        allBids.push(...round1.bids);

        if (round1.bids.length === 0) {
            return this.fallbackToDispatcher(proposal, "No bids received in round 1.");
        }

        // Round 2: 修正（最多 2 轮）
        if (round1.bids.length > 0 && MAX_ROUNDS >= 2) {
            const round2 = await this.runRound(proposal, 2);
            allBids.push(...round2.bids);
        }

        // 评标
        return this.evaluateBids(proposal, allBids);
    }

    /**
     * 手动提交竞标（由 Agent 调用）
     */
    submitBid(proposal: TaskProposal, bid: Omit<AgentBid, "bidId" | "submittedAtMs">): AgentBid {
        const fullBid: AgentBid = {
            ...bid,
            bidId: crypto.randomUUID(),
            submittedAtMs: Date.now(),
        };

        // Validate bid against proposal constraints
        if (fullBid.costEstimateToken > proposal.maxCostToken) {
            throw new Error(`Bid cost ${fullBid.costEstimateToken} exceeds max ${proposal.maxCostToken}`);
        }
        if (fullBid.latencyEstimateMs > proposal.slaLatencyMs) {
            throw new Error(`Bid latency ${fullBid.latencyEstimateMs} exceeds SLA ${proposal.slaLatencyMs}`);
        }

        return fullBid;
    }

    /**
     * 获取协商历史
     */
    getHistory(limit = 50): ContractAward[] {
        return this.history.slice(-limit).reverse();
    }

    /**
     * 获取统计
     */
    getStats(): { totalNegotiations: number; avgUtilityScore: number; round1Settled: number; round2Settled: number } {
        const total = this.history.length;
        if (total === 0) return { totalNegotiations: 0, avgUtilityScore: 0, round1Settled: 0, round2Settled: 0 };

        const avgScore = this.history.reduce((s, a) => s + a.utilityScore, 0) / total;
        const r1 = this.history.filter((a) => a.roundSettled === 1).length;
        const r2 = this.history.filter((a) => a.roundSettled === 2).length;

        return {
            totalNegotiations: total,
            avgUtilityScore: Math.round(avgScore * 100) / 100,
            round1Settled: r1,
            round2Settled: r2,
        };
    }

    // ─── Private ───

    /**
     * 运行一轮竞标（带 500ms 超时）
     */
    private async runRound(proposal: TaskProposal, round: 1 | 2): Promise<NegotiationRound> {
        const startedAt = Date.now();
        const deadline = startedAt + BID_TIMEOUT_MS;

        // 在实际系统中，这里会向所有符合条件的 Agent 广播标案
        // 并等待他们在 deadline 前提交竞标
        // 当前实现模拟竞标窗口

        await this.sleep(BID_TIMEOUT_MS);

        const closedAt = Date.now();
        return {
            round,
            bids: [], // 实际系统中由 Agent 回调填充
            startedAtMs: startedAt,
            closedAtMs: closedAt,
        };
    }

    /**
     * 评标: UtilityScore = confidence*0.5 + (1-cost/maxCost)*0.3 + (1-latency/slaLatency)*0.2
     */
    private evaluateBids(proposal: TaskProposal, bids: AgentBid[]): ContractAward {
        if (bids.length === 0) {
            return this.fallbackToDispatcher(proposal, "No bids received across all rounds.");
        }

        const scored = bids.map((bid) => {
            const costRatio = proposal.maxCostToken > 0 ? bid.costEstimateToken / proposal.maxCostToken : 1;
            const latencyRatio = proposal.slaLatencyMs > 0 ? bid.latencyEstimateMs / proposal.slaLatencyMs : 1;

            const score = (bid.confidenceScore * 0.5)
                + ((1 - Math.min(costRatio, 1)) * 0.3)
                + ((1 - Math.min(latencyRatio, 1)) * 0.2);

            return { bid, score };
        });

        scored.sort((a, b) => b.score - a.score);
        const winner = scored[0];

        const award: ContractAward = {
            awardId: crypto.randomUUID(),
            proposalId: proposal.proposalId,
            winnerBid: winner.bid,
            utilityScore: Math.round(winner.score * 1000) / 1000,
            roundSettled: this.determineSettledRound(bids, winner.bid),
            reasoning: `Winner selected by UtilityScore ${winner.score.toFixed(3)}: confidence ${winner.bid.confidenceScore}, cost ${winner.bid.costEstimateToken}/${proposal.maxCostToken}, latency ${winner.bid.latencyEstimateMs}/${proposal.slaLatencyMs}ms.`,
            awardedAtMs: Date.now(),
        };

        this.history.push(award);
        return award;
    }

    /**
     * 超时/弃标 Fallback: 回退到 Dispatcher 或 ConflictResolver
     */
    private fallbackToDispatcher(proposal: TaskProposal, reason: string): ContractAward {
        // Try Dispatcher first
        if (this.dispatcher) {
            const match = this.dispatcher.dispatch({
                taskType: proposal.taskType,
                tags: proposal.tags,
                category: proposal.requiredCapability,
            });

            if (match) {
                const fallbackBid: AgentBid = {
                    bidId: crypto.randomUUID(),
                    proposalId: proposal.proposalId,
                    agentId: match.agentId,
                    agentName: match.agentName,
                    costEstimateToken: Math.round(proposal.maxCostToken * 0.8),
                    latencyEstimateMs: Math.round(proposal.slaLatencyMs * 0.8),
                    confidenceScore: match.confidence,
                    round: 1,
                    submittedAtMs: Date.now(),
                };

                const award: ContractAward = {
                    awardId: crypto.randomUUID(),
                    proposalId: proposal.proposalId,
                    winnerBid: fallbackBid,
                    utilityScore: 0.5,
                    roundSettled: 1,
                    reasoning: `Fallback to Dispatcher. ${reason} Matched ${match.agentName} via ${match.matchType} match.`,
                    awardedAtMs: Date.now(),
                };

                this.history.push(award);
                return award;
            }
        }

        // Last resort: no agent available
        const noBid: AgentBid = {
            bidId: crypto.randomUUID(),
            proposalId: proposal.proposalId,
            agentId: "none",
            agentName: "No Agent Available",
            costEstimateToken: 0,
            latencyEstimateMs: 0,
            confidenceScore: 0,
            round: 1,
            submittedAtMs: Date.now(),
        };

        const award: ContractAward = {
            awardId: crypto.randomUUID(),
            proposalId: proposal.proposalId,
            winnerBid: noBid,
            utilityScore: 0,
            roundSettled: 1,
            reasoning: `No bids received and no dispatcher fallback available. ${reason}`,
            awardedAtMs: Date.now(),
        };

        this.history.push(award);
        return award;
    }

    private determineSettledRound(allBids: AgentBid[], winnerBid: AgentBid): 1 | 2 {
        const winnerRound = winnerBid.round;
        const hasMultipleRounds = allBids.some((b) => b.round !== winnerRound);
        if (!hasMultipleRounds) return 1;
        return winnerRound;
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}
