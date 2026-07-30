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
