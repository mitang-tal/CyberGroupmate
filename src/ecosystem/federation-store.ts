/**
 * FederationStore — 经验联邦提纯服务
 *
 * 提纯流水线：
 * candidate/quarantined
 *   → Governor.canPromote() 许可检查
 *   → Sandbox Replay Validation (Phase 7.2)
 *   → validated
 *   → federated (全局可读)
 */

import type { ExperienceItem, FederationStatus } from "../experience/types";
import type { ExperienceStore } from "../experience/experience-store";
import type { EcosystemGovernor } from "./ecosystem-governor";
import type { SimulationEngine } from "../simulation/simulation-engine";

export interface PromoteResult {
    success: boolean;
    experience?: ExperienceItem;
    federationStatus: FederationStatus;
    validationScore: number;
    reason: string;
}

export class FederationStore {
    private experienceStore: ExperienceStore;
    private governor: EcosystemGovernor;
    private simulationEngine?: SimulationEngine;

    constructor(
        experienceStore: ExperienceStore,
        governor: EcosystemGovernor,
        simulationEngine?: SimulationEngine,
    ) {
        this.experienceStore = experienceStore;
        this.governor = governor;
        this.simulationEngine = simulationEngine;
    }

    /**
     * 晋升流水线：experienceId → 沙盒验证 → validated → federated
     */
    promote(experienceId: string, agentId?: string): PromoteResult {
        const experience = this.experienceStore.getExperience(experienceId);
        if (!experience) {
            return { success: false, federationStatus: "candidate", validationScore: 0, reason: "Experience not found" };
        }

        // Step 1: Governor 许可检查
        const permit = this.governor.canPromote(agentId ?? experience.context.agentId ?? "unknown", experience.federationStatus);
        if (!permit.allowed) {
            return { success: false, federationStatus: experience.federationStatus, validationScore: 0, reason: permit.reason ?? "Governor denied promotion" };
        }

        // Step 2: Sandbox Replay Validation
        const validation = this.runSandboxValidation(experience);

        if (!validation.passed) {
            // 降级为 quarantined
            this.experienceStore.updateExperience(experienceId, {
                federationStatus: "quarantined",
                updatedAtMs: Date.now(),
            } as Partial<ExperienceItem>);
            return {
                success: false,
                federationStatus: "quarantined",
                validationScore: validation.score,
                reason: validation.reason,
            };
        }

        // Step 3: validated
        this.experienceStore.updateExperience(experienceId, {
            federationStatus: "validated",
            updatedAtMs: Date.now(),
        } as Partial<ExperienceItem>);

        // Step 4: federated
        this.experienceStore.updateExperience(experienceId, {
            federationStatus: "federated",
            updatedAtMs: Date.now(),
        } as Partial<ExperienceItem>);

        const updated = this.experienceStore.getExperience(experienceId);
        return {
            success: true,
            experience: updated,
            federationStatus: "federated",
            validationScore: validation.score,
            reason: `Promoted to federated. Sandbox validation score: ${validation.score}. ${validation.reason}`,
        };
    }

    /**
     * 获取全局联邦经验列表
     */
    getFederatedItems(): ExperienceItem[] {
        return this.experienceStore.queryExperiences({
            minConfidence: 0,
        }).filter((e) => e.federationStatus === "federated");
    }

    /**
     * 获取隔离区经验
     */
    getQuarantinedItems(): ExperienceItem[] {
        return this.experienceStore.queryExperiences({
            minConfidence: 0,
        }).filter((e) => e.federationStatus === "quarantined");
    }

    /**
     * 获取待提纯候选经验
     */
    getCandidateItems(): ExperienceItem[] {
        return this.experienceStore.queryExperiences({
            minConfidence: 0,
        }).filter((e) => e.federationStatus === "candidate");
    }

    // ─── Private: Sandbox Replay Validation ───

    private runSandboxValidation(experience: ExperienceItem): { passed: boolean; score: number; reason: string } {
        if (!this.simulationEngine) {
            // No simulation engine available — fall back to confidence-based validation
            const baseScore = experience.confidence;
            if (baseScore >= 0.7) {
                return { passed: true, score: baseScore, reason: "Confidence-based validation passed (no simulation engine)." };
            }
            return { passed: false, score: baseScore, reason: `Confidence ${baseScore} below threshold 0.7 (no simulation engine).` };
        }

        // Run simulation to test the experience rule
        const simContext = {
            triggerContext: experience.context.tool ?? experience.rule.avoid ?? "unknown",
            taskType: experience.context.tool,
            category: experience.context.capability,
        };

        const simResult = this.simulationEngine.runSimulation(simContext);

        // Find the selected option and check if it aligns with the experience rule
        const selected = simResult.optionsEvaluated.find(
            (o) => o.optionId === simResult.selectedOptionId,
        );

        if (!selected) {
            return { passed: false, score: 0.3, reason: "Simulation produced no valid option." };
        }

        // The experience is validated if the simulation's preferred option
        // aligns with the experience's avoid/prefer rules
        let alignmentScore = selected.predictedSuccessRate;

        if (experience.rule.avoid) {
            // Check if selected option avoids the forbidden pattern
            const avoidsPattern = !selected.name.toLowerCase().includes(experience.rule.avoid.toLowerCase());
            if (avoidsPattern) {
                alignmentScore = Math.min(alignmentScore + 0.15, 1.0);
            } else {
                alignmentScore = Math.max(alignmentScore - 0.3, 0);
            }
        }

        if (experience.rule.prefer) {
            const prefersPattern = selected.name.toLowerCase().includes(experience.rule.prefer.toLowerCase());
            if (prefersPattern) {
                alignmentScore = Math.min(alignmentScore + 0.1, 1.0);
            }
        }

        const passed = alignmentScore >= 0.6;
        return {
            passed,
            score: Math.round(alignmentScore * 100) / 100,
            reason: passed
                ? `Simulation alignment score ${alignmentScore}. Rule validated.`
                : `Simulation alignment score ${alignmentScore} below 0.6 threshold. Rule rejected.`,
        };
    }
}
