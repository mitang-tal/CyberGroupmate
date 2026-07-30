/**
 * Agent Evolution 数据模型
 */

export interface SpecializationTag {
    tagId: string;
    name: string;
    category: string;
    confidence: number;
    identifiedAtMs: number;
}

export interface EvolutionProposal {
    proposalId: string;
    agentId: string;
    agentName: string;

    /** 当前专业化标签 */
    currentTags: SpecializationTag[];

    /** 建议新增的标签 */
    suggestedTags: SpecializationTag[];

    /** 建议移除的低效标签 */
    deprecatedTags: string[];

    /** 分析依据 */
    analysis: {
        sampleSize: number;
        samplingPeriodDays: number;
        topCapability: string;
        topMastery: number;
        worstCapability: string;
        worstMastery: number;
        globalAvgMastery: number;
    };

    status: "pending_approval" | "approved" | "rejected" | "expired";
    createdAtMs: number;
    coolingDeadlineMs: number;  // 冷却期到期时间
    approvedAtMs?: number;
    rejectedAtMs?: number;
}

export interface EvolutionHistoryEntry {
    agentId: string;
    proposalId: string;
    tagsApplied: SpecializationTag[];
    appliedAtMs: number;
}
