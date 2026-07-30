/**
 * EcosystemGovernance — 生态治理策略版本控制引擎
 *
 * 功能：
 * - SemVer 版本管理（自动递增 major/minor/patch）
 * - 快照生成与持久化
 * - 变更差异计算
 * - 原子一键回滚
 * - 审计日志
 */

import crypto from "node:crypto";
import { GovernancePolicyValues, PolicySnapshot, GovernanceAuditLog, DEFAULT_POLICY_VALUES } from "./types";

export class EcosystemGovernance {
    private currentValues: GovernancePolicyValues;
    private snapshots: PolicySnapshot[] = [];
    private auditLogs: GovernanceAuditLog[] = [];

    constructor() {
        this.currentValues = { ...DEFAULT_POLICY_VALUES };
        // Create initial snapshot
        const initial: PolicySnapshot = {
            version: "1.0.0",
            values: { ...this.currentValues },
            changeDiff: "Initial governance policy",
            origin: "system",
            reason: "System initialization",
            createdAtMs: Date.now(),
        };
        this.snapshots.push(initial);
        this.auditLogs.push({
            logId: crypto.randomUUID(),
            action: "create",
            toVersion: "1.0.0",
            changeDiff: "Initial governance policy",
            origin: "system",
            reason: "System initialization",
            createdAtMs: Date.now(),
        });
    }

    /**
     * 获取当前策略
     */
    getCurrent(): { version: string; values: GovernancePolicyValues } {
        const latest = this.snapshots[this.snapshots.length - 1];
        return { version: latest.version, values: { ...this.currentValues } };
    }

    /**
     * 更新策略：自动生成新版本快照
     */
    update(
        patch: Partial<GovernancePolicyValues>,
        origin: string,
        reason: string,
    ): PolicySnapshot {
        const oldValues = { ...this.currentValues };
        const newValues = { ...this.currentValues, ...patch };
        const changeDiff = this.computeDiff(oldValues, newValues);

        const newVersion = this.bumpVersion(changeDiff);
        this.currentValues = newValues;

        const snapshot: PolicySnapshot = {
            version: newVersion,
            values: { ...newValues },
            changeDiff,
            origin,
            reason,
            createdAtMs: Date.now(),
        };

        this.snapshots.push(snapshot);
        this.auditLogs.push({
            logId: crypto.randomUUID(),
            action: "update",
            fromVersion: this.snapshots.length > 1 ? this.snapshots[this.snapshots.length - 2].version : undefined,
            toVersion: newVersion,
            changeDiff,
            origin,
            reason,
            createdAtMs: Date.now(),
        });

        return snapshot;
    }

    /**
     * 一键回滚到指定版本
     */
    rollback(targetVersion: string, origin: string, reason: string): PolicySnapshot | undefined {
        const target = this.snapshots.find((s) => s.version === targetVersion);
        if (!target) return undefined;

        const oldVersion = this.snapshots[this.snapshots.length - 1].version;
        if (target.version === oldVersion) {
            return undefined; // Already at this version
        }

        const oldValues = { ...this.currentValues };
        this.currentValues = { ...target.values };

        const changeDiff = `Rollback from ${oldVersion} to ${target.version}: ${reason}`;

        const snapshot: PolicySnapshot = {
            version: `${target.version}-rollback-${Date.now()}`,
            values: { ...this.currentValues },
            changeDiff,
            origin,
            reason: `Rollback: ${reason}`,
            createdAtMs: Date.now(),
        };

        this.snapshots.push(snapshot);
        this.auditLogs.push({
            logId: crypto.randomUUID(),
            action: "rollback",
            fromVersion: oldVersion,
            toVersion: target.version,
            changeDiff,
            origin,
            reason: `Rollback: ${reason}`,
            createdAtMs: Date.now(),
        });

        return snapshot;
    }

    /**
     * 获取快照历史
     */
    getSnapshots(limit = 50): PolicySnapshot[] {
        return this.snapshots.slice(-limit).reverse();
    }

    /**
     * 获取审计日志
     */
    getAuditLogs(limit = 100): GovernanceAuditLog[] {
        return this.auditLogs.slice(-limit).reverse();
    }

    /**
     * 将当前策略同步到下游组件
     */
    syncToComponents(targets: {
        governor?: { setRateLimit: (limit: number) => void };
        federationStore?: any;
        negotiationEngine?: any;
        evolutionAnalyzer?: any;
    }): void {
        if (targets.governor) {
            targets.governor.setRateLimit(this.currentValues.governorRateLimit);
        }
        // Other sync as needed
    }

    // ─── Private ───

    private computeDiff(oldValues: GovernancePolicyValues, newValues: GovernancePolicyValues): string {
        const changes: string[] = [];
        const keys = Object.keys(oldValues) as (keyof GovernancePolicyValues)[];

        for (const key of keys) {
            const oldVal = JSON.stringify(oldValues[key]);
            const newVal = JSON.stringify(newValues[key]);
            if (oldVal !== newVal) {
                changes.push(`${key}: ${oldVal} → ${newVal}`);
            }
        }

        return changes.length > 0 ? changes.join("; ") : "No changes";
    }

    private bumpVersion(changeDiff: string): string {
        const latest = this.snapshots[this.snapshots.length - 1];
        const parts = latest.version.split(".").map(Number);
        let [major, minor, patch] = parts;

        // Major bump for breaking changes
        if (changeDiff.includes("quarantineCategories") || changeDiff.includes("federationMinTrustScore")) {
            major++;
            minor = 0;
            patch = 0;
        }
        // Minor bump for behavioral changes
        else if (changeDiff.includes("negotiationTimeoutMs") || changeDiff.includes("evolutionCoolingDays")) {
            minor++;
            patch = 0;
        }
        // Patch bump for threshold adjustments
        else if (changeDiff.includes("governorRateLimit")) {
            patch++;
        } else {
            patch++;
        }

        return `${major}.${minor}.${patch}`;
    }
}
