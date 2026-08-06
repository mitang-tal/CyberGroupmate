import { AgentReputation, CapabilityScore, TrustState, ShadowLogEntry } from "./types";

export interface ReputationStore {
    upsert(reputation: AgentReputation): void;
    getByAgentId(agentId: string): AgentReputation | undefined;
    listAll(): AgentReputation[];
    updateTrustState(agentId: string, state: TrustState, probationUntilMs?: number): void;
    delete(agentId: string): void;
    /** #23 probation shadow 观察日志：追加一条 */
    appendShadowLog(entry: ShadowLogEntry): void;
    /** #23 probation shadow 观察日志：按观察时间升序取回 */
    listShadowLog(): ShadowLogEntry[];
}
