/**
 * Meta Self-Test 数据模型
 */

export type ProbeCategory = "deadlock" | "guardrail" | "rigidity" | "kill_switch";

export type HealthStatus = "healthy" | "degraded" | "critical";

/** #25 健康分探针权重：安全关键探针（guardrail/kill_switch）失败应比常规探针更严重 */
export interface HealthWeights {
    deadlock?: number;
    guardrail?: number;
    rigidity?: number;
    kill_switch?: number;
}

export interface MetaSelfTestProbeResult {
    probeId: string;
    probeName: string;
    category: ProbeCategory;
    passed: boolean;
    score: number;
    details: string;
    errorContext?: Record<string, unknown>;
    executedAtMs: number;
}

export interface MetaSelfTestReport {
    reportId: string;
    overallHealthScore: number;
    status: HealthStatus;
    probeResults: MetaSelfTestProbeResult[];
    recommendations: string[];
    createdAtMs: number;
}
