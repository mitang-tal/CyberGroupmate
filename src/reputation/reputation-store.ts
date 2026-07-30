import { AgentReputation, CapabilityScore, TrustState } from "./types";

export interface ReputationStore {
    upsert(reputation: AgentReputation): void;
    getByAgentId(agentId: string): AgentReputation | undefined;
    listAll(): AgentReputation[];
    updateTrustState(agentId: string, state: TrustState, probationUntilMs?: number): void;
    delete(agentId: string): void;
}
