/**
 * EcosystemGovernor — 生态级安全防护网
 *
 * 职责：
 * - Rate Limiter: 单 Agent 提交 candidate 经验限频
 * - Quarantine Zone: 低信任/高风险经验自动隔离
 * - Kill-Switch: 全局冻结联邦写入与 A2A 协议
 */

import type { FederationStatus } from "../experience/types";

interface RateLimitEntry {
    count: number;
    windowStartMs: number;
}

const DEFAULT_RATE_LIMIT = 10; // 10 submissions per minute per agent
const RATE_WINDOW_MS = 60_000;
const QUARANTINE_TRUST_THRESHOLD = 0.55;

export class EcosystemGovernor {
    private rateLimitMap: Map<string, RateLimitEntry> = new Map();
    private rateLimitPerMinute: number;
    private killSwitchEngaged: boolean = false;
    private quarantineCategories: Set<string> = new Set(["resource_exhausted", "logic_deadlock"]);

    constructor(rateLimitPerMinute?: number) {
        this.rateLimitPerMinute = rateLimitPerMinute ?? DEFAULT_RATE_LIMIT;
    }

    /**
     * 检查 Agent 是否可以提交 candidate 经验
     */
    checkSubmitPermission(agentId: string): { allowed: boolean; reason?: string } {
        if (this.killSwitchEngaged) {
            return { allowed: false, reason: "Ecosystem kill switch is active. Federation writes suspended." };
        }

        const now = Date.now();
        const entry = this.rateLimitMap.get(agentId);

        if (!entry || now - entry.windowStartMs > RATE_WINDOW_MS) {
            // New window
            this.rateLimitMap.set(agentId, { count: 1, windowStartMs: now });
            return { allowed: true };
        }

        if (entry.count >= this.rateLimitPerMinute) {
            const resetIn = Math.ceil((RATE_WINDOW_MS - (now - entry.windowStartMs)) / 1000);
            return { allowed: false, reason: `Rate limit exceeded. Reset in ${resetIn}s.` };
        }

        entry.count++;
        return { allowed: true };
    }

    /**
     * 评估 candidate 经验是否应进入隔离区
     */
    evaluateCandidate(params: {
        originTrustScore?: number;
        category: string;
        frequency: number;
        confidence: number;
    }): { federationStatus: FederationStatus; reason?: string } {
        // Quarantine: low trust score
        if (params.originTrustScore !== undefined && params.originTrustScore < QUARANTINE_TRUST_THRESHOLD) {
            return {
                federationStatus: "quarantined",
                reason: `Origin trust score ${params.originTrustScore} below threshold ${QUARANTINE_TRUST_THRESHOLD}`,
            };
        }

        // Quarantine: high-risk category
        if (this.quarantineCategories.has(params.category)) {
            return {
                federationStatus: "quarantined",
                reason: `Category "${params.category}" is high-risk and auto-quarantined`,
            };
        }

        // Quarantine: low confidence with high frequency (suspicious pattern)
        if (params.confidence < 0.6 && params.frequency > 5) {
            return {
                federationStatus: "quarantined",
                reason: `Suspicious pattern: confidence=${params.confidence} but frequency=${params.frequency}`,
            };
        }

        // Pass through as candidate
        return { federationStatus: "candidate" };
    }

    /**
     * 晋升许可检查：candidate/quarantined → validated
     */
    canPromote(agentId: string, federationStatus: string): { allowed: boolean; reason?: string } {
        if (this.killSwitchEngaged) {
            return { allowed: false, reason: "Ecosystem kill switch is active. Federation suspended." };
        }

        if (federationStatus === "federated") {
            return { allowed: false, reason: "Experience is already federated." };
        }

        if (federationStatus === "candidate" || federationStatus === "quarantined") {
            return { allowed: true };
        }

        return { allowed: false, reason: `Invalid federation status: ${federationStatus}` };
    }

    /**
     * 审批隔离区经验进入联邦
     */
    approveQuarantine(federationStatus: FederationStatus): FederationStatus {
        if (federationStatus === "quarantined") return "validated";
        return federationStatus;
    }

    /**
     * 最终联邦发布
     */
    federate(federationStatus: FederationStatus): FederationStatus {
        if (federationStatus === "validated" || federationStatus === "candidate") return "federated";
        return federationStatus;
    }

    // ─── Kill Switch ───

    engageKillSwitch(): void {
        this.killSwitchEngaged = true;
    }

    disengageKillSwitch(): void {
        this.killSwitchEngaged = false;
    }

    isKillSwitchActive(): boolean {
        return this.killSwitchEngaged;
    }

    // ─── Quarantine categories ───

    addQuarantineCategory(category: string): void {
        this.quarantineCategories.add(category);
    }

    removeQuarantineCategory(category: string): void {
        this.quarantineCategories.delete(category);
    }

    getQuarantineCategories(): string[] {
        return Array.from(this.quarantineCategories);
    }

    // ─── Rate limit management ───

    setRateLimit(limit: number): void {
        this.rateLimitPerMinute = limit;
    }

    getRateLimit(): number {
        return this.rateLimitPerMinute;
    }

    /** 获取全部分数限流状态（用于自检探针） */
    getRateLimitStatus(): { activeAgents: number; totalSubmissions: number } {
        let totalSubmissions = 0;
        for (const entry of this.rateLimitMap.values()) {
            const now = Date.now();
            if (now - entry.windowStartMs <= RATE_WINDOW_MS) {
                totalSubmissions += entry.count;
            }
        }
        return { activeAgents: this.rateLimitMap.size, totalSubmissions };
    }

    /** 重置所有限流和隔离状态 */
    reset(): void {
        this.rateLimitMap.clear();
        this.quarantineCategories = new Set(["resource_exhausted", "logic_deadlock"]);
        this.killSwitchEngaged = false;
    }
}
