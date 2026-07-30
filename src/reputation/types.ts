/**
 * Agent Reputation 数据模型
 */

export type TrustState = "trusted" | "normal" | "probation" | "untrusted";

export interface CapabilityScore {
    capabilityId: string;
    capabilityName: string;
    /** 能力掌握度 (0-1): 基于该能力下的执行成功率 */
    mastery: number;
    /** 执行次数 */
    executionCount: number;
    /** 失败次数 */
    failureCount: number;
    /** 最近一次使用时间 */
    lastUsedAtMs: number;
}

export interface AgentReputation {
    agentId: string;
    agentName: string;

    /** 综合信任分 (0-1) */
    trustScore: number;
    /** 信任状态 */
    trustState: TrustState;

    /** 全局可靠性 (0-1): 所有能力的平均成功率 */
    reliability: number;
    /** 风险概率 (0-1): 触发 alert / 异常的频率 */
    riskProbability: number;
    /** 平均延迟 ms */
    avgLatencyMs: number;
    /** 总执行次数 */
    totalExecutions: number;
    /** 总失败次数 */
    totalFailures: number;

    /** 各能力评分 */
    capabilityScores: CapabilityScore[];

    /** 考察期到期时间（probation 状态下） */
    probationUntilMs?: number;
    /** 上次评估时间 */
    lastEvaluatedAtMs: number;
    /** 声誉分数最后更新 */
    updatedAtMs: number;
}

/** 声誉评估输入 */
export interface ReputationEvaluationInput {
    agentId: string;
    agentName: string;
    capabilityExecutions: {
        capabilityId: string;
        capabilityName: string;
        success: boolean;
        latencyMs: number;
        errorType?: string;
        timestampMs: number;
    }[];
    recentAlerts: number;
    recentFailures: number;
}
