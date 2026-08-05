/**
 * EcosystemGovernance — 生态治理策略版本控制引擎
 *
 * 功能：
 * - SemVer 版本管理（自动递增 major/minor/patch）
 * - 快照生成（内存）
 * - 变更差异计算
 * - 原子一键回滚
 * - 审计日志（sqlite 持久化，复用 governance.db）
 * - Kill-Switch 唯一事实源，广播到 Guardrail / Governor（syncToComponents）
 */

import crypto from "node:crypto";
import { GovernancePolicyValues, PolicySnapshot, GovernanceAuditLog, DEFAULT_POLICY_VALUES } from "./types";
import type { GovernanceV2Store } from "./governance-v2-store";

/** 下游同步目标（Guardrail / Governor 执行器） */
export interface GovernanceSyncTargets {
    governor?: {
        setRateLimit: (limit: number) => void;
        setQuarantineCategories?: (categories: string[]) => void;
        setKillSwitch?: (active: boolean) => void;
    };
    guardrail?: {
        setKillSwitch: (active: boolean) => void;
    };
    federationStore?: any;
    negotiationEngine?: any;
    evolutionAnalyzer?: any;
}

export class EcosystemGovernance {
    private currentValues: GovernancePolicyValues;
    private snapshots: PolicySnapshot[] = [];
    private auditLogs: GovernanceAuditLog[] = [];
    private store?: GovernanceV2Store;
    private targets?: GovernanceSyncTargets;

    constructor(store?: GovernanceV2Store) {
        this.store = store;

        const restored = store?.loadState();
        if (restored) {
            // 从持久化恢复当前策略（killSwitch / quarantineCategories 等一并恢复）
            this.currentValues = { ...DEFAULT_POLICY_VALUES, ...restored.values };
            const initial: PolicySnapshot = {
                version: restored.version,
                values: { ...this.currentValues },
                changeDiff: "Restored from persisted governance state",
                origin: "system",
                reason: "Governance v2 state restored from store",
                createdAtMs: restored.updatedAtMs,
            };
            this.snapshots.push(initial);
            return;
        }

        this.currentValues = { ...DEFAULT_POLICY_VALUES };
        const initial: PolicySnapshot = {
            version: "1.0.0",
            values: { ...this.currentValues },
            changeDiff: "Initial governance policy",
            origin: "system",
            reason: "System initialization",
            createdAtMs: Date.now(),
        };
        this.snapshots.push(initial);

        this.pushAudit({
            action: "create",
            toVersion: "1.0.0",
            changeDiff: "Initial governance policy",
            origin: "system",
            reason: "System initialization",
        });
        store?.saveState("1.0.0", this.currentValues);
    }

    /**
     * 获取当前策略
     */
    getCurrent(): { version: string; values: GovernancePolicyValues } {
        const latest = this.snapshots[this.snapshots.length - 1];
        return { version: latest.version, values: { ...this.currentValues } };
    }

    /**
     * 更新策略：自动生成新版本快照 + 持久化 + 广播下游
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
        this.store?.saveState(newVersion, newValues);
        this.pushAudit({
            action: "update",
            fromVersion: this.snapshots.length > 1 ? this.snapshots[this.snapshots.length - 2].version : undefined,
            toVersion: newVersion,
            changeDiff,
            origin,
            reason,
        });

        this.syncToComponents();
        return snapshot;
    }

    /**
     * Kill-Switch 唯一事实源：切换并产生 kill_switch 审计 + 广播 Guardrail / Governor
     */
    setKillSwitch(active: boolean, origin: string, reason: string): PolicySnapshot {
        const oldValues = { ...this.currentValues };
        const newValues = { ...this.currentValues, killSwitch: active };
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
        this.store?.saveState(newVersion, newValues);
        this.pushAudit({
            action: "kill_switch",
            fromVersion: this.snapshots.length > 1 ? this.snapshots[this.snapshots.length - 2].version : undefined,
            toVersion: newVersion,
            changeDiff,
            origin,
            reason,
        });

        this.syncToComponents();
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
        this.store?.saveState(snapshot.version, this.currentValues);
        this.pushAudit({
            action: "rollback",
            fromVersion: oldVersion,
            toVersion: target.version,
            changeDiff,
            origin,
            reason: `Rollback: ${reason}`,
        });

        this.syncToComponents();
        return snapshot;
    }

    /**
     * 获取快照历史
     */
    getSnapshots(limit = 50): PolicySnapshot[] {
        return this.snapshots.slice(-limit).reverse();
    }

    /**
     * 获取审计日志（持久化优先，无 store 退化为内存）
     */
    getAuditLogs(limit = 100): GovernanceAuditLog[] {
        if (this.store) return this.store.listAudit(limit);
        return this.auditLogs.slice(-limit).reverse();
    }

    // ─── 下游同步 ───

    /**
     * 绑定下游执行器（Guardrail / Governor 等），状态变更后自动广播
     */
    attachTargets(targets: GovernanceSyncTargets): void {
        this.targets = targets;
        this.syncToComponents();
    }

    /**
     * 将当前策略同步到下游组件（热更新：kill-switch / rate limit / quarantine）
     */
    syncToComponents(targets?: GovernanceSyncTargets): void {
        const t = targets ?? this.targets;
        if (!t) return;

        const v = this.currentValues;

        if (t.governor) {
            t.governor.setRateLimit(v.governorRateLimit);
            t.governor.setQuarantineCategories?.(v.quarantineCategories);
            t.governor.setKillSwitch?.(v.killSwitch);
        }
        if (t.guardrail) {
            t.guardrail.setKillSwitch(v.killSwitch);
        }
        // federationStore / negotiationEngine / evolutionAnalyzer 预留（Phase 4.1 后接线）
    }

    // ─── Private ───

    private pushAudit(log: Omit<GovernanceAuditLog, "logId" | "createdAtMs">): void {
        const entry: GovernanceAuditLog = {
            ...log,
            logId: crypto.randomUUID(),
            createdAtMs: Date.now(),
        };
        this.auditLogs.push(entry);
        this.store?.insertAudit(entry);
    }

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
