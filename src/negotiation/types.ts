/**
 * Contract-Net Negotiation 数据模型
 */

export interface TaskProposal {
    proposalId: string;
    taskType: string;
    requiredCapability: string;
    slaLatencyMs: number;
    maxCostToken: number;
    tags?: string[];
    publishedAtMs: number;
    bidDeadlineMs: number;
}

export interface AgentBid {
    bidId: string;
    proposalId: string;
    agentId: string;
    agentName: string;
    costEstimateToken: number;
    latencyEstimateMs: number;
    confidenceScore: number;
    round: 1 | 2;
    submittedAtMs: number;
}

export interface ContractAward {
    awardId: string;
    proposalId: string;
    winnerBid: AgentBid;
    utilityScore: number;
    roundSettled: 1 | 2;
    reasoning: string;
    awardedAtMs: number;
}

export interface NegotiationRound {
    round: 1 | 2;
    bids: AgentBid[];
    startedAtMs: number;
    closedAtMs: number;
}

/** 8.2 C2 Agent 侧竞标输入（引擎补全 bidId/proposalId/agentId/agentName/round/submittedAtMs） */
export type AgentBidInput = Omit<AgentBid, "bidId" | "proposalId" | "agentId" | "agentName" | "round" | "submittedAtMs">;

/** 8.2 C2 Agent 侧异步出价提供者：每个 eligible Agent 线程调用，返回出价或弃标（undefined） */
export type AgentBidProvider = (
    ctx: { proposal: TaskProposal; round: 1 | 2; agent: { agentId: string; agentName: string } },
) => Promise<AgentBidInput | undefined> | AgentBidInput | undefined;
