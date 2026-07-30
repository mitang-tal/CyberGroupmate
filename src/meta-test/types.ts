/**
 * Meta Self-Test 数据模型
 */

export type ProbeCategory = "deadlock" | "guardrail" | "rigidity" | "kill_switch";

export type HealthStatus = "healthy" | "degraded" | "critical";

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
