/**
 * FailureExtractor — 失败模式归因提炼引擎
 *
 * 从 Alert / ExecutionRecord / Trace 中提取 FailurePattern。
 *
 * 置信度算法：
 * - frequency=1, confidence=0.35（偶发，不生成经验）
 * - frequency=2, confidence=0.55（出现两次，低置信度经验）
 * - frequency≥3, confidence=0.85（反复出现，高置信度）
 * - 跨多个来源（alert + trace + chaos），每多一个来源 +0.05
 */

import crypto from "node:crypto";
import { FailurePattern, FailureCategory, ExperienceItem, ExperienceStatus } from "./types";
import type { ExperienceStore } from "./experience-store";

const CONFIDENCE_BY_FREQUENCY = [0, 0.35, 0.55, 0.75, 0.85, 0.92, 0.96];
const EXPERIENCE_TTL_MS = 30 * 24 * 3600_000; // 30 days default
const MIN_CONFIDENCE_FOR_EXPERIENCE = 0.6;

export class FailureExtractor {
    private store: ExperienceStore;

    constructor(store: ExperienceStore) {
        this.store = store;
    }

    /**
     * 从报错上下文提取失败模式
     */
    extractFromFailure(params: {
        triggerContext: string;
        symptom: string;
        rootCause: string;
        category: FailureCategory;
        sourceAlertId?: string;
        tool?: string;
        capability?: string;
        agentId?: string;
    }): { pattern: FailurePattern; experience?: ExperienceItem } {
        const now = Date.now();

        // Check if pattern already exists
        const existing = this.store.findExistingPattern(params.triggerContext, params.symptom);

        if (existing) {
            // Update existing pattern
            const newFrequency = existing.frequency + 1;
            const sourceIds = existing.sourceAlertIds;
            if (params.sourceAlertId && !sourceIds.includes(params.sourceAlertId)) {
                sourceIds.push(params.sourceAlertId);
            }

            const confidence = this.calculateConfidence(newFrequency, sourceIds.length);
            const updatedPattern: Partial<FailurePattern> = {
                frequency: newFrequency,
                confidence,
                lastObservedAtMs: now,
                sourceAlertIds: sourceIds,
            };

            this.store.updatePattern(existing.patternId, updatedPattern);
            const pattern = { ...existing, ...updatedPattern };

            // If confidence crossed threshold, create/update experience
            if (confidence >= MIN_CONFIDENCE_FOR_EXPERIENCE) {
                const experience = this.ensureExperience(pattern, params);
                return { pattern, experience };
            }

            return { pattern };
        }

        // Create new pattern
        const pattern: FailurePattern = {
            patternId: crypto.randomUUID(),
            category: params.category,
            triggerContext: params.triggerContext,
            symptom: params.symptom,
            rootCause: params.rootCause,
            frequency: 1,
            confidence: CONFIDENCE_BY_FREQUENCY[1] ?? 0.35,
            firstObservedAtMs: now,
            lastObservedAtMs: now,
            sourceAlertIds: params.sourceAlertId ? [params.sourceAlertId] : [],
        };

        this.store.insertPattern(pattern);

        // Only create experience if confidence is high enough
        if (pattern.confidence >= MIN_CONFIDENCE_FOR_EXPERIENCE) {
            const experience = this.createExperience(pattern, params);
            return { pattern, experience };
        }

        return { pattern };
    }

    /**
     * 运行经验衰减
     */
    runDecay(): { expired: number; decayed: number } {
        const decayed = this.store.decayExperiences();
        const expired = this.store.listExpiredExperiences().length;
        return { expired, decayed };
    }

    /**
     * 为 Dispatcher/Replanner 查询相关经验
     */
    queryRelevantExperience(context: {
        tool?: string;
        capability?: string;
        agentId?: string;
        minConfidence?: number;
    }): ExperienceItem[] {
        return this.store.queryExperiences({
            tool: context.tool,
            capability: context.capability,
            agentId: context.agentId,
            minConfidence: context.minConfidence ?? MIN_CONFIDENCE_FOR_EXPERIENCE,
            status: "active",
        });
    }

    // ─── Private ───

    private calculateConfidence(frequency: number, sourceCount: number): number {
        const freqIdx = Math.min(frequency, CONFIDENCE_BY_FREQUENCY.length - 1);
        const baseConfidence = CONFIDENCE_BY_FREQUENCY[freqIdx];
        const sourceBonus = Math.min((sourceCount - 1) * 0.05, 0.15);
        return Math.min(Math.round((baseConfidence + sourceBonus) * 100) / 100, 0.99);
    }

    private ensureExperience(pattern: FailurePattern, params: {
        tool?: string; capability?: string; agentId?: string;
    }): ExperienceItem {
        // Check if experience already exists for this pattern
        const existing = this.store.queryExperiences({
            tool: params.tool,
            minConfidence: 0,
        }).find((e) => e.patternId === pattern.patternId);

        if (existing) {
            const updates: Partial<ExperienceItem> = {
                frequency: existing.frequency + 1,
                confidence: pattern.confidence,
                updatedAtMs: Date.now(),
            };
            // Extend TTL on reinforcement
            updates.expiresAtMs = Date.now() + EXPERIENCE_TTL_MS;
            if (existing.status === "decayed") {
                updates.status = "active";
            }
            this.store.updateExperience(existing.experienceId, updates);
            return { ...existing, ...updates };
        }

        return this.createExperience(pattern, params);
    }

    private createExperience(pattern: FailurePattern, params: {
        tool?: string; capability?: string; agentId?: string;
    }): ExperienceItem {
        const now = Date.now();
        const experience: ExperienceItem = {
            experienceId: crypto.randomUUID(),
            patternId: pattern.patternId,
            type: "failure_prevention",
            context: {
                tool: params.tool ?? pattern.triggerContext,
                capability: params.capability,
                agentId: params.agentId,
            },
            rule: this.inferRule(pattern),
            confidence: pattern.confidence,
            frequency: pattern.frequency,
            status: "active",
            expiresAtMs: now + EXPERIENCE_TTL_MS,
            createdAtMs: now,
            updatedAtMs: now,
            originAgentId: params.agentId,
            originTrustScore: undefined,
            federationStatus: "candidate",
        };

        this.store.insertExperience(experience);
        return experience;
    }

    private inferRule(pattern: FailurePattern): { avoid?: string; prefer?: string; constraints?: Record<string, unknown> } {
        switch (pattern.category) {
            case "tool_capability_mismatch":
                return {
                    avoid: pattern.symptom,
                    prefer: this.inferPreferredAlternative(pattern),
                    constraints: { confidence: pattern.confidence, reason: pattern.rootCause },
                };
            case "parameter_invalid":
                return {
                    avoid: pattern.triggerContext,
                    constraints: { validParams: "check documentation", reason: pattern.rootCause },
                };
            case "resource_exhausted":
                return {
                    constraints: { rateLimit: true, backoffRecommended: true, reason: pattern.rootCause },
                };
            case "logic_deadlock":
                return {
                    avoid: pattern.triggerContext,
                    constraints: { maxRetries: 0, reason: pattern.rootCause },
                };
            default:
                return { avoid: pattern.symptom };
        }
    }

    private inferPreferredAlternative(pattern: FailurePattern): string {
        // Simple heuristic: if symptom is a method name, derive alternative
        const s = pattern.symptom.toLowerCase();
        if (s.includes("sendphoto") || s.includes("send_photo")) return "sendMedia";
        if (s.includes("sendmessage") || s.includes("send_message")) return "sendText";
        if (s.includes("execute") && s.includes("timeout")) return `${pattern.triggerContext} with longer timeout`;
        return pattern.triggerContext;
    }
}
