/**
 * ConflictResolver — 确定性冲突仲裁引擎
 *
 * Tie-Breaker 矩阵（严格按顺序 fallback）：
 * 1. Reputation: trustScore 最高者胜出
 * 2. Risk: riskScore 最低者胜出
 * 3. Tier: meta_council > primary_worker > fallback_worker
 * 4. Timestamp: 先提交者胜出
 * 5. LLM Fallback: 仅当 complexContext=true 且前 4 步仍平票时，允许 1 次 LLM 建议（1000ms 硬超时）
 *
 * 8.3：真实 LLM 仲裁。构造注入 { callLLM, llmConfig }；未注入或超时/失败/解析失败
 * 一律返回 null → 走确定性兑底，保证零活锁。
 */

import crypto from "node:crypto";
import { ConflictCase, Proposal, ArbitrationVerdict, AgentTier } from "./types";
import type { ChatMessage, LLMResponse } from "../core/llm/types.js";
import type { LLMConfig } from "../core/config.js";
import type { LLMCallOptions } from "../core/llm.js";
import { callLLM as coreCallLLM } from "../core/llm.js";

const TIER_ORDER: Record<AgentTier, number> = {
    meta_council: 0,
    primary_worker: 1,
    fallback_worker: 2,
};

const LLM_TIMEOUT_MS = 1000;

/** 8.3 真实 LLM 仲裁依赖（均可选；缺省时 LLM 路径退化为确定性兑底） */
export interface ConflictLLMDeps {
    /** LLM 调用函数（自带 profile/fallback 逻辑） */
    callLLM?: (messages: ChatMessage[], options?: LLMCallOptions) => Promise<LLMResponse>;
    /** LLM 配置（callLLM 未注入时用 core callLLM 直接调用） */
    llmConfig?: LLMConfig;
    /** 硬超时 ms，默认 1000 */
    llmTimeoutMs?: number;
}

export class ConflictResolver {
    private history: ArbitrationVerdict[] = [];
    private llmDeps: ConflictLLMDeps;

    constructor(llmDeps: ConflictLLMDeps = {}) {
        this.llmDeps = llmDeps;
    }

    /**
     * 解决冲突：输入 ConflictCase，输出 ArbitrationVerdict（8.3：async，含真实 LLM 路径）
     */
    async resolve(conflictCase: ConflictCase): Promise<ArbitrationVerdict> {
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
            const llmResult = await this.tryLlmFallback(conflictCase, byTime);
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
     * 批量解决冲突（8.3：async，顺序遍历，每个 case 独立 LLM 超时）
     */
    async resolveBatch(cases: ConflictCase[]): Promise<ArbitrationVerdict[]> {
        const results: ArbitrationVerdict[] = [];
        for (const c of cases) {
            results.push(await this.resolve(c));
        }
        return results;
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
     * 8.3 真实 LLM 仲裁：构造仲裁 prompt → Promise.race([callLLM, 硬超时])。
     * 超时 / 调用失败 / 解析失败 → 返回 null（由调用方走确定性兑底，零活锁）。
     */
    private async tryLlmFallback(conflictCase: ConflictCase, tiedProposals: Proposal[]): Promise<Proposal | null> {
        const { callLLM, llmConfig } = this.llmDeps;
        if (!callLLM && !llmConfig) return null;

        const system = "You are a deterministic conflict arbiter in a multi-agent system. "
            + "Pick the best proposal for the given conflict using your judgment. "
            + 'Respond with ONLY a JSON object: {"winnerProposalId": "<proposalId>"}.';
        const user = JSON.stringify({
            conflictCase: {
                conflictCaseId: conflictCase.conflictCaseId,
                resourceId: conflictCase.resourceId,
                conflictType: conflictCase.conflictType,
            },
            candidates: tiedProposals.map((p) => ({
                proposalId: p.proposalId,
                agentId: p.agentId,
                agentName: p.agentName,
                tier: p.tier,
                actionType: p.actionType,
                actionParams: p.actionParams,
                trustScore: p.trustScore,
                riskScore: p.riskScore,
                submittedAtMs: p.submittedAtMs,
            })),
            instruction: 'Return {"winnerProposalId": "<proposalId>"} selecting one of the candidate proposalIds.',
        });
        const messages: ChatMessage[] = [
            { role: "system", content: system },
            { role: "user", content: user },
        ];

        try {
            const result = await Promise.race([
                callLLM
                    ? callLLM(messages, { caller: "conflict-arbitration", maxTokens: 256, temperature: 0 })
                    : coreCallLLM(messages, llmConfig!, { caller: "conflict-arbitration", maxTokens: 256, temperature: 0 }),
                this.llmTimeout(),
            ]);
            if (!result) return null; // 硬超时
            return this.parseLlmWinner(result.content, tiedProposals);
        } catch {
            return null; // 调用失败 / 解析失败 → 确定性兑底
        }
    }

    private llmTimeout(): Promise<null> {
        const ms = this.llmDeps.llmTimeoutMs ?? LLM_TIMEOUT_MS;
        return new Promise((resolve) => {
            const t = setTimeout(() => resolve(null), ms);
            if (t.unref) t.unref();
        });
    }

    private parseLlmWinner(content: string, tiedProposals: Proposal[]): Proposal | null {
        if (!content) return null;
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return null;
        try {
            const parsed = JSON.parse(jsonMatch[0]) as { winnerProposalId?: string; proposalId?: string; winner?: string };
            const winnerId = parsed.winnerProposalId ?? parsed.proposalId ?? parsed.winner;
            return tiedProposals.find((p) => p.proposalId === winnerId) ?? null;
        } catch {
            return null;
        }
    }
}
