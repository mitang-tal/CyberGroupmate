/**
 * CapabilityRegistry — Agent 能力注册、心跳、状态管理
 */

import crypto from "node:crypto";
import {
    AgentRegistration,
    AgentCapability,
    AgentRuntimeStatus,
} from "./types";

const HEARTBEAT_TIMEOUT_MS = 60_000; // 1 minute without heartbeat → offline

export class CapabilityRegistry {
    private agents: Map<string, AgentRegistration> = new Map();
    private heartbeatTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

    /**
     * 注册 Agent
     */
    register(params: {
        name: string;
        capabilities: Omit<AgentCapability, "capabilityId">[];
        metadata?: Record<string, unknown>;
    }): AgentRegistration {
        const agentId = crypto.randomUUID();
        const now = Date.now();

        const capabilities: AgentCapability[] = params.capabilities.map((c) => ({
            ...c,
            capabilityId: crypto.randomUUID(),
        }));

        const agent: AgentRegistration = {
            agentId,
            name: params.name,
            capabilities,
            status: "online",
            metadata: params.metadata,
            lastHeartbeatAtMs: now,
            registeredAtMs: now,
            activeTaskCount: 0,
        };

        this.agents.set(agentId, agent);
        this.startHeartbeatCheck(agentId);
        return agent;
    }

    /**
     * 更新 Agent 状态
     */
    updateStatus(agentId: string, status: AgentRuntimeStatus): boolean {
        const agent = this.agents.get(agentId);
        if (!agent) return false;
        agent.status = status;
        return true;
    }

    /**
     * 收到心跳
     */
    heartbeat(agentId: string): boolean {
        const agent = this.agents.get(agentId);
        if (!agent) return false;
        agent.lastHeartbeatAtMs = Date.now();
        if (agent.status === "offline") {
            agent.status = "online";
        }
        this.resetHeartbeatCheck(agentId);
        return true;
    }

    /**
     * 反注册 Agent
     */
    unregister(agentId: string): boolean {
        const timer = this.heartbeatTimers.get(agentId);
        if (timer) clearTimeout(timer);
        this.heartbeatTimers.delete(agentId);
        return this.agents.delete(agentId);
    }

    /**
     * 获取 Agent 注册信息
     */
    getAgent(agentId: string): AgentRegistration | undefined {
        return this.agents.get(agentId);
    }

    /**
     * 列出所有 Agent（支持按状态筛选）
     */
    listAgents(status?: AgentRuntimeStatus): AgentRegistration[] {
        const all = Array.from(this.agents.values());
        if (status) return all.filter((a) => a.status === status);
        return all;
    }

    /**
     * 增加活跃任务计数
     */
    incrementTaskCount(agentId: string): boolean {
        const agent = this.agents.get(agentId);
        if (!agent) return false;
        agent.activeTaskCount++;
        if (agent.activeTaskCount > 0 && agent.status === "online") {
            agent.status = "busy";
        }
        return true;
    }

    /**
     * 减少活跃任务计数
     */
    decrementTaskCount(agentId: string): boolean {
        const agent = this.agents.get(agentId);
        if (!agent) return false;
        agent.activeTaskCount = Math.max(0, agent.activeTaskCount - 1);
        if (agent.activeTaskCount === 0 && agent.status === "busy") {
            agent.status = "online";
        }
        return true;
    }

    /**
     * 获取能力拓扑（所有 Agent 的能力分布）
     */
    getCapabilityTopology(): { category: string; capabilities: { name: string; agentCount: number }[] }[] {
        const byCategory = new Map<string, Map<string, number>>();

        for (const agent of this.agents.values()) {
            if (agent.status === "offline" || agent.status === "maintenance") continue;
            for (const cap of agent.capabilities) {
                if (!byCategory.has(cap.category)) {
                    byCategory.set(cap.category, new Map());
                }
                const categoryMap = byCategory.get(cap.category)!;
                categoryMap.set(cap.name, (categoryMap.get(cap.name) ?? 0) + 1);
            }
        }

        return Array.from(byCategory.entries()).map(([category, caps]) => ({
            category,
            capabilities: Array.from(caps.entries()).map(([name, agentCount]) => ({
                name,
                agentCount,
            })),
        }));
    }

    // ─── Private ───

    private startHeartbeatCheck(agentId: string): void {
        const timer = setTimeout(() => {
            const agent = this.agents.get(agentId);
            if (agent && agent.status !== "offline" && agent.status !== "maintenance") {
                const elapsed = Date.now() - agent.lastHeartbeatAtMs;
                if (elapsed > HEARTBEAT_TIMEOUT_MS) {
                    agent.status = "offline";
                }
            }
            this.heartbeatTimers.delete(agentId);
        }, HEARTBEAT_TIMEOUT_MS + 5000);
        this.heartbeatTimers.set(agentId, timer);
    }

    private resetHeartbeatCheck(agentId: string): void {
        const existing = this.heartbeatTimers.get(agentId);
        if (existing) clearTimeout(existing);
        this.startHeartbeatCheck(agentId);
    }
}
