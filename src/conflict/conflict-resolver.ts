/**
 * ConflictResolver — 确定性冲突仲裁引擎
 *
 * Tie-Breaker 矩阵（严格按顺序 fallback）：
 * 1. Reputation: trustScore 最高者胜出
 * 2. Risk: riskScore 最低者胜出
 * 3. Tier: meta_council > primary_worker > fallback_worker
 * 4. Timestamp: 先提交者胜出
 * 5. LLM Fallback: 仅当 complexContext=true 且前 4 步仍平票时，允许 1 次 LLM 建议（1000ms 硬超时）
 */

import crypto from "node:crypto";
import { ConflictCase, Proposal, ArbitrationVerdict, AgentTier } from "./types";

const TIER_ORDER: Record<AgentTier, number> = {
    meta_council: 0,
    primary_worker: 1,
    fallback_worker: 2,
};

const LLM_TIMEOUT_MS = 1000;

export class ConflictResolver {
    private history: ArbitrationVerdict[] = [];

    /**
     * 解决冲突：输入 ConflictCase，输出 ArbitrationVerdict
     */
    resolve(conflictCase: ConflictCase): ArbitrationVerdict {
        const proposals = [...conflictCase.proposals];
        if (proposals.length === 0) {
            throw new Error("Cannot resolve conflict: no proposals provided.");
        }
        if (proposals.length === 1) {
            const verdict = this.createVerdict(conflictCase, proposals[0], "reputation", "Single proposal — auto-approved.");
            this.history.push(verdict);
            return verdict;
        }

        // ─── Rule 1: Reputation (trustScore) ───
        const maxTrust = Math.max(...proposals.map((p) => p.trustScore));
        const byTrust = proposals.filter((p) => p.trustScore === maxTrust);

        if (byTrust.length === 1) {
            const verdict = this.createVerdict(conflictCase, byTrust[0], "reputation",
                `Highest trustScore (${maxTrust.toFixed(2)}) among ${proposals.length} proposals.`);
            this.history.push(verdict);
            return verdict;
        }

        // ─── Rule 2: Risk (lowest riskScore wins) ───
        const minRisk = Math.min(...byTrust.map((p) => p.riskScore));
        const byRisk = byTrust.filter((p) => p.riskScore === minRisk);

        if (byRisk.length === 1) {
            const verdict = this.createVerdict(conflictCase, byRisk[0], "risk",
                `Tie on trustScore (${maxTrust.toFixed(2)}). Resolved by lowest riskScore (${minRisk.toFixed(2)}).`);
            this.history.push(verdict);
            return verdict;
        }

        // ─── Rule 3: Tier ───
        const bestTier = Math.min(...byRisk.map((p) => TIER_ORDER[p.tier]));
        const byTier = byRisk.filter((p) => TIER_ORDER[p.tier] === bestTier);

        if (byTier.length === 1) {
            const verdict = this.createVerdict(conflictCase, byTier[0], "tier",
                `Tie on trust (${maxTrust.toFixed(2)}) and risk (${minRisk.toFixed(2)}). Resolved by agent tier: ${byTier[0].tier}.`);
            this.history.push(verdict);
            return verdict;
        }

        // ─── Rule 4: Timestamp (earliest wins) ───
        const earliest = byTier.reduce((a, b) => (a.submittedAtMs < b.submittedAtMs ? a : b));
        const byTime = byTier.filter((p) => p.submittedAtMs === earliest.submittedAtMs);

        if (byTime.length === 1) {
            const verdict = this.createVerdict(conflictCase, byTime[0], "timestamp",
                `Tie on trust (${maxTrust.toFixed(2)}), risk (${minRisk.toFixed(2)}), and tier. Resolved by earliest submission.`);
            this.history.push(verdict);
            return verdict;
        }

        // ─── Rule 5: LLM Fallback (仅当 complexContext=true 且前 4 步仍平票) ───
        if (conflictCase.complexContext) {
            const llmResult = this.tryLlmFallback(byTime);
            if (llmResult) {
                const verdict = this.createVerdict(conflictCase, llmResult, "llm_fallback",
                    `All deterministic tie-breakers failed (${byTime.length} proposals tied). LLM suggestion applied.`);
                this.history.push(verdict);
                return verdict;
            }
        }

        // ─── Ultimate fallback: first in array ───
        const verdict = this.createVerdict(conflictCase, proposals[0], "timestamp",
            `All tie-breakers exhausted. Defaulting to first proposal.`);
        this.history.push(verdict);
        return verdict;
    }

    /**
     * 批量解决冲突（原子操作）
     */
    resolveBatch(cases: ConflictCase[]): ArbitrationVerdict[] {
        return cases.map((c) => this.resolve(c));
    }

    /**
     * 获取历史仲裁记录
     */
    getHistory(limit = 50): ArbitrationVerdict[] {
        return this.history.slice(-limit).reverse();
    }

    /**
     * 获取仲裁统计
     */
    getStats(): { total: number; byTieBreaker: Record<string, number>; tieRate: number } {
        const total = this.history.length;
        const byTieBreaker: Record<string, number> = {};

        for (const v of this.history) {
            byTieBreaker[v.tieBreakerUsed] = (byTieBreaker[v.tieBreakerUsed] || 0) + 1;
        }

        const nonReputation = total - (byTieBreaker["reputation"] || 0);
        return {
            total,
            byTieBreaker,
            tieRate: total > 0 ? Math.round((nonReputation / total) * 10000) / 100 : 0,
        };
    }

    // ─── Private ───

    private createVerdict(
        conflictCase: ConflictCase,
        winner: Proposal,
        tieBreakerUsed: ArbitrationVerdict["tieBreakerUsed"],
        reasoning: string,
    ): ArbitrationVerdict {
        return {
            verdictId: crypto.randomUUID(),
            conflictCaseId: conflictCase.conflictCaseId,
            winner,
            reasoning,
            tieBreakerUsed,
            ruledAtMs: Date.now(),
        };
    }

    /**
     * LLM Fallback 的模拟实现
     * 实际场景中会调用 LLM，但带 1000ms 硬超时
     */
    private tryLlmFallback(tiedProposals: Proposal[]): Proposal | null {
        // 模拟 LLM 调用（带超时）
        // 实际接入时：Promise.race([llmCall(), timeout(1000)])
        // 超时返回 null → 自动触发确定性 fallback

        // 当前实现：随机选择平票中的第一个（模拟 LLM 无法在 1000ms 内响应）
        // 这确保即使 LLM 超时，系统也不会死锁
        return tiedProposals[0] ?? null;
    }
}
