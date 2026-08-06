/**
 * CapabilityScorer — 能力掌握度计算器（Phase 7.3 #19）
 *
 * 采用贝叶斯收缩 + 冷启动先验：
 *   mastery = (success + prior*priorWeight) / (total + priorWeight)
 * 少样本（如单次执行）时向先验（0.5）收缩，避免少量成功/失败冲到极端；
 * 样本量增大后收敛到观测成功率。
 */

import { CapabilityScore } from "./types";

export interface CapabilityScorerOptions {
    /** 冷启动先验（默认 0.5） */
    prior?: number;
    /** 先验等效样本数（默认 2，收缩强度） */
    priorWeight?: number;
}

export function calculateCapabilityScores(
    executions: {
        capabilityId: string;
        capabilityName: string;
        success: boolean;
        timestampMs: number;
    }[],
    options: CapabilityScorerOptions = {},
): CapabilityScore[] {
    const prior = options.prior ?? 0.5;
    const priorWeight = options.priorWeight ?? 2;

    const capMap = new Map<string, { name: string; success: number; total: number; lastTs: number }>();
    for (const exec of executions) {
        const entry = capMap.get(exec.capabilityId) ?? { name: exec.capabilityName, success: 0, total: 0, lastTs: 0 };
        entry.total += 1;
        if (exec.success) entry.success += 1;
        if (exec.timestampMs > entry.lastTs) entry.lastTs = exec.timestampMs;
        capMap.set(exec.capabilityId, entry);
    }

    return Array.from(capMap.entries()).map(([id, d]) => {
        const posterior = (d.success + prior * priorWeight) / (d.total + priorWeight);
        return {
            capabilityId: id,
            capabilityName: d.name,
            mastery: Math.round(Math.max(0, Math.min(1, posterior)) * 100) / 100,
            executionCount: d.total,
            failureCount: d.total - d.success,
            lastUsedAtMs: d.lastTs,
        };
    });
}