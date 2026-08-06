/**
 * NegotiationEngine — 结构化 Contract-Net 密封出价引擎
 *
 * 流程：
 * 1. Meta 发布 TaskProposal
 * 2. Agent 在竞标窗口内提交 AgentBid（密封结构化 JSON，无自由文本）
 * 3. 评标：UtilityScore = confidence*0.5 + (1-cost/maxCost)*0.3 + (1-latency/slaLatency)*0.2
 * 4. 最多 2 轮（Round 1 初报，Round 2 修正）
 * 5. 竞标窗口硬超时（默认 500ms，可由 Gov2 negotiationTimeoutMs 热更新）→ 回退 Dispatcher / ConflictResolver
 *
 * 8.2 C2：真实异步竞标。runRound 打开竞标窗口后，按 CapabilityRegistry 圈定 eligible
 * Agent，为每个 Agent 启动独立异步竞标线程（经 bidProvider 组价后通过 submitBid 密封提交）。
 * 窗口在「全部线程出价完成」或「超时」二者先到者关闭；无竞标则回退 Dispatcher。
 */

import crypto from "node:crypto";
import { TaskProposal, AgentBid, ContractAward, NegotiationRound, AgentBidProvider } from "./types";
import type { CapabilityDispatcher } from "../capability-registry/capability-dispatcher";
import type { CapabilityRegistry } from "../capability-registry/capability-registry";
import type { ConflictResolver } from "../conflict/conflict-resolver";
import type { ConflictCase } from "../conflict/types";

const BID_TIMEOUT_MS = 500;  // 500ms per round（无 Gov2 注入时的默认值）
const MAX_ROUNDS = 2;

/** 竞标窗口内的 Agent 引用 */
interface NegotiationAgentRef {
    agentId: string;
    agentName: string;
}

/** 一轮真实竞标窗口 */
interface BidWindow {
    proposal: TaskProposal;
    round: 1 | 2;
    bids: AgentBid[];
    openedAtMs: number;
    deadlineMs: number;
    settled: boolean;
}

export class NegotiationEngine {
    private dispatcher?: CapabilityDispatcher;
    private conflictResolver?: ConflictResolver;
    private capabilityRegistry?: CapabilityRegistry;
    private bidProvider?: AgentBidProvider;
    private timeoutMs: number = BID_TIMEOUT_MS;
    private history: ContractAward[] = [];
    private pendingRounds: Map<string, BidWindow> = new Map();

    constructor(deps: {
        dispatcher?: CapabilityDispatcher;
        conflictResolver?: ConflictResolver;
        capabilityRegistry?: CapabilityRegistry;
        bidProvider?: AgentBidProvider;
        timeoutMs?: number;
    }) {
        this.dispatcher = deps.dispatcher;
        this.conflictResolver = deps.conflictResolver;
        this.capabilityRegistry = deps.capabilityRegistry;
        this.bidProvider = deps.bidProvider;
        if (deps.timeoutMs != null && deps.timeoutMs > 0) this.timeoutMs = deps.timeoutMs;
    }

    /** 8.2 C2：Gov2 热更新竞标窗口超时 */
    setTimeoutMs(ms: number): void {
        if (typeof ms === "number" && ms > 0) this.timeoutMs = ms;
    }

    /**
     * 发布标案并运行完整协商（2 轮密封出价 + 硬超时）
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
     * 手动提交竞标（由 Agent / Agent 竞标线程调用）
     * 8.2 C2：若对应竞标窗口仍开启，出价会写入窗口参与评标；窗口关闭/无窗口时仅返回密封出价。
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

        // 写入真实竞标窗口（若仍开启）
        const window = this.pendingRounds.get(this.windowKey(proposal.proposalId, fullBid.round));
        if (window && !window.settled && Date.now() <= window.deadlineMs) {
            window.bids.push(fullBid);
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
     * 运行一轮竞标（8.2 C2：真实异步竞标窗口 + 硬超时）
     */
    private async runRound(proposal: TaskProposal, round: 1 | 2): Promise<NegotiationRound> {
        const openedAtMs = Date.now();
        const deadlineMs = openedAtMs + this.timeoutMs;

        // 圈定 eligible Agents（CapabilityRegistry + 状态过滤 + 能力匹配）
        const agents = this.eligibleAgents(proposal);

        // 打开竞标窗口
        const window: BidWindow = {
            proposal,
            round,
            bids: [],
            openedAtMs,
            deadlineMs,
            settled: false,
        };
        const key = this.windowKey(proposal.proposalId, round);
        this.pendingRounds.set(key, window);

        // 启动 Agent 侧真实异步竞标线程
        const agentThreads = agents.map((agent) => this.runAgentBidThread(window, agent));

        // 等待窗口关闭：全部线程出价完成 或 硬超时，二者先到者生效
        const timeout = new Promise<void>((resolve) => {
            const t = setTimeout(resolve, Math.max(0, deadlineMs - Date.now()));
            if (t.unref) t.unref();
        });
        await Promise.race([Promise.all(agentThreads), timeout]);

        window.settled = true;
        this.pendingRounds.delete(key);

        const closedAtMs = Date.now();
        return {
            round,
            bids: window.bids,
            startedAtMs: openedAtMs,
            closedAtMs,
        };
    }

    /**
     * 单个 Agent 的异步竞标线程：模拟组价/思考延迟后，经 submitBid 密封提交。
     * 线程失败或迟到视为该 Agent 本轮弃标，不影响其他 Agent。
     */
    private async runAgentBidThread(window: BidWindow, agent: NegotiationAgentRef): Promise<void> {
        try {
            const budgetMs = Math.max(0, window.deadlineMs - Date.now());
            if (budgetMs <= 0 || window.settled) return;

            // Agent 侧异步处理延迟（模拟线程思考 + 组价）
            const thinkMs = Math.floor(Math.random() * Math.min(budgetMs, 120));
            await this.sleep(thinkMs);

            if (window.settled || Date.now() > window.deadlineMs) return;

            const bid = await this.bidProvider?.({
                proposal: window.proposal,
                round: window.round,
                agent,
            });
            if (!bid) return;
            if (Date.now() > window.deadlineMs) return; // 迟到弃标

            this.submitBid(window.proposal, {
                ...bid,
                proposalId: window.proposal.proposalId,
                agentId: agent.agentId,
                agentName: agent.agentName,
                round: window.round,
            });
        } catch (err) {
            // 该 Agent 本轮弃标
            console.error(`[negotiation] agent bid thread failed (${agent.agentId}):`, err instanceof Error ? err.message : String(err));
        }
    }

    /**
     * 8.2 C2：按 CapabilityRegistry 圈定 eligible Agents：
     * 状态 online/busy + 能力满足 taskType / tags / requiredCapability（category）任一匹配。
     */
    private eligibleAgents(proposal: TaskProposal): NegotiationAgentRef[] {
        if (!this.capabilityRegistry) return [];

        const task = proposal.taskType.toLowerCase();
        const tags = proposal.tags ?? [];
        const category = proposal.requiredCapability;

        return this.capabilityRegistry
            .listAgents()
            .filter((a) => a.status === "online" || a.status === "busy")
            .filter((a) =>
                a.capabilities.some(
                    (cap) =>
                        (tags.length > 0 && cap.tags.some((t) => tags.includes(t)))
                        || (category !== "" && cap.category === category)
                        || (task !== "" && (cap.name.toLowerCase().includes(task) || task.includes(cap.name.toLowerCase()))),
                ),
            )
            .map((a) => ({ agentId: a.agentId, agentName: a.name }));
    }

    private windowKey(proposalId: string, round: 1 | 2): string {
        return `${proposalId}:${round}`;
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
