/**
 * FederationSync — 联邦库跨进程同步封装
 *
 * 拓扑（决策 1）：单机多进程 + 共享同一 SQLite（experience.db，WAL 已开）。
 * - promote 写路径用 BEGIN IMMEDIATE 事务加应用层写锁（跨进程由 SQLite 文件锁 + busy_timeout 兜底）
 * - 全网读取走 FederationStore.getSharedFederatedItems（读共享库无需锁）
 */

import type { ExperienceItem } from "../experience/types";
import type { ExperienceStore } from "../experience/experience-store";
import type { FederationStore, PromoteResult } from "./federation-store";

/** 支持 BEGIN IMMEDIATE 事务写锁的存储（SqliteExperienceStore 实现） */
export interface TransactionalStore {
    withTransaction<T>(fn: () => T): T;
}

export class FederationSync {
    private federationStore: FederationStore;
    private store: ExperienceStore & Partial<TransactionalStore>;

    constructor(federationStore: FederationStore, store: ExperienceStore & Partial<TransactionalStore>) {
        this.federationStore = federationStore;
        this.store = store;
    }

    /**
     * 锁内晋升：BEGIN IMMEDIATE 事务串行化多步写路径（validated → federated），
     * 避免跨进程半程状态与 last-write-wins；存储不支持事务时退化为直接调用。
     */
    promote(experienceId: string, agentId?: string): PromoteResult {
        if (this.store.withTransaction) {
            return this.store.withTransaction(() => this.federationStore.promote(experienceId, agentId));
        }
        return this.federationStore.promote(experienceId, agentId);
    }

    /** 全网读取：给 Dispatcher/Replan 拉取 federated 经验（共享库直接可读） */
    getSharedFederatedItems(agentId?: string): ExperienceItem[] {
        return this.federationStore.getSharedFederatedItems(agentId);
    }
}
