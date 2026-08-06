/**
 * TrustScorer — trustScore 融合器（Phase 7.3 #20/#21/#22）
 *
 * - reliability：#20 延迟成本加权 + #21 指数半衰期时间衰减
 * - repeatRatio：#20 重复犯错（同能力二次及以后失败）占比
 * - trustScore = reliability - 风险罚分 - 重复犯错罚分
 * - determineTrustState：#22 带滞回窗的信任状态机（防阈值抖动）
 */

import { TrustState } from "./types";

export interface TrustScorerOptions {
    prior?: number;
    halfLifeMs?: number;
    costWeight?: number;
    latencyScaleMs?: number;
    riskWeight?: number;
    repeatErrorWeight?: number;
    hysteresis?: number;
}

const TRUST_BOUNDS: Record<"probation" | "normal" | "trusted", number> = {
    probation: 0.3,
    normal: 0.55,
    trusted: 0.85,
};
const TRUST_ORDER: TrustState[] = ["untrusted", "probation", "normal", "trusted"];

export interface ReliabilityResult {
    reliability: number;
    repeatRatio: number;
}

/** #20 + #21：指数半衰衰减 + 延迟成本加权后的可靠性；并统计重复犯错占比 */
export function calculateReliability(
    executions: {
        success: boolean;
        latencyMs?: number;
        timestampMs: number;
        capabilityId: string;
    }[],
    now: number,
    opts: TrustScorerOptions = {},
): ReliabilityResult {
    const prior = opts.prior ?? 0.5;
    const halfLifeMs = opts.halfLifeMs ?? 7 * 24 * 3600_000;
    const costWeight = opts.costWeight ?? 0.3;
    const latencyScaleMs = opts.latencyScaleMs ?? 2000;

    let wSum = 0;
    let wSucc = 0;
    const failCounts = new Map<string, number>();

    for (const exec of executions) {
        const age = Math.max(0, now - exec.timestampMs);
        const timeWeight = Math.pow(2, -age / halfLifeMs); // 2^(-age/halfLife)
        const latencyWeight = 1 + costWeight * Math.min(1, (exec.latencyMs || 0) / latencyScaleMs);
        const w = timeWeight * latencyWeight;
        wSum += w;
        if (exec.success) {
            wSucc += w;
        } else {
            failCounts.set(exec.capabilityId, (failCounts.get(exec.capabilityId) ?? 0) + 1);
        }
    }

    if (wSum === 0) return { reliability: prior, repeatRatio: 0 };

    const reliability = wSucc / wSum;

    let repeats = 0;
    for (const count of failCounts.values()) {
        if (count > 1) repeats += count - 1;
    }
    const repeatRatio = Math.min(repeats / executions.length, 1);

    return { reliability, repeatRatio };
}

/** trustScore = reliability - 风险罚分 - 重复犯错罚分 */
export function calculateTrustScore(
    reliability: number,
    riskProbability: number,
    repeatRatio: number,
    opts: TrustScorerOptions = {},
): number {
    const riskWeight = opts.riskWeight ?? 0.3;
    const repeatErrorWeight = opts.repeatErrorWeight ?? 0.15;
    const riskPenalty = riskProbability * riskWeight;          // max -30%
    const repeatPenalty = repeatRatio * repeatErrorWeight;     // 重复犯错惩罚
    const score = reliability - riskPenalty - repeatPenalty;
    return Math.max(0, Math.min(1, Math.round(score * 100) / 100));
}

/** #22：带滞回窗的信任状态机 */
export function determineTrustState(
    trustScore: number,
    currentState: TrustState | undefined,
    hysteresis = 0.05,
): TrustState {
    const raw = rawState(trustScore);
    if (!currentState || raw === currentState) return raw;

    const h = hysteresis;
    const rawRank = TRUST_ORDER.indexOf(raw);
    const curRank = TRUST_ORDER.indexOf(currentState);

    if (rawRank > curRank) {
        // 升级：需超过当前档上界 + 滞回余量，防止刚到阈值又回退
        const need = currentState === "untrusted" ? TRUST_BOUNDS.probation + h : TRUST_BOUNDS[currentState] + h;
        return trustScore >= need ? raw : currentState;
    }
    // 降级：需跌破当前档下界 - 滞回余量
    const boundKey = currentState as "probation" | "normal" | "trusted";
    const need = TRUST_BOUNDS[boundKey] - h;
    return trustScore < need ? raw : currentState;
}

export function rawState(score: number): TrustState {
    if (score >= TRUST_BOUNDS.trusted) return "trusted";
    if (score >= TRUST_BOUNDS.normal) return "normal";
    if (score >= TRUST_BOUNDS.probation) return "probation";
    return "untrusted";
}