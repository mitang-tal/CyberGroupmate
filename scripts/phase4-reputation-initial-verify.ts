/**
 * Audit Fix P0-3 — Agent 声誉初始状态核验 独立验收脚本
 *
 * 验证内容：
 * 1. 无执行历史 evaluate() → 中性声誉（normal / 0.5），不再错误归类为 untrusted / 0.25
 *    （根因：空数据时 calculateTrustScore 算出 0.25，determineTrustState 判为 untrusted，
 *      与 getDispatchWeight 无记录默认 normal / 0.5 不一致）
 * 2. 已污染的 untrusted 行被空数据重新评估后覆盖为中性（保留累计执行/失败数）
 * 3. 有真实数据时走完整评分路径（回归：early-return 不误伤有数据场景）
 * 4. getDispatchWeight 无记录默认仍为 normal / 0.5（既有行为不变）
 */
import { ReputationEvaluator } from "../src/reputation/reputation-evaluator.js";
import type { AgentReputation, TrustState } from "../src/reputation/types.js";
import type { ReputationStore } from "../src/reputation/reputation-store.js";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string) {
    if (cond) {
        pass++;
        console.log(`  ✅ ${name}`);
    } else {
        fail++;
        console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
    }
}

/** 最小内存 ReputationStore：仅实现接口方法 */
class MemReputationStore implements ReputationStore {
    private rows = new Map<string, AgentReputation>();
    upsert(r: AgentReputation): void { this.rows.set(r.agentId, r); }
    getByAgentId(agentId: string): AgentReputation | undefined { return this.rows.get(agentId); }
    listAll(): AgentReputation[] { return [...this.rows.values()]; }
    updateTrustState(agentId: string, state: TrustState, probationUntilMs?: number): void {
        const r = this.rows.get(agentId);
        if (r) { r.trustState = state; if (probationUntilMs !== undefined) r.probationUntilMs = probationUntilMs; }
    }
    delete(agentId: string): void { this.rows.delete(agentId); }
}

function main() {
    const store = new MemReputationStore();
    const ev = new ReputationEvaluator(store);

    // ─── 1. 无执行历史 evaluate → 中性 ───
    console.log("\n[1] 空历史 evaluate 应返回中性（normal / 0.5）");
    const neutral = ev.evaluate({ agentId: "main-agent", agentName: "main-agent", capabilityExecutions: [], recentAlerts: 0, recentFailures: 0 });
    check("trustState = normal", neutral.trustState === "normal", neutral.trustState);
    check("trustScore = 0.5", neutral.trustScore === 0.5, String(neutral.trustScore));
    check("reliability = 0.5", neutral.reliability === 0.5, String(neutral.reliability));
    check("totalExecutions = 0", neutral.totalExecutions === 0, String(neutral.totalExecutions));
    check("totalFailures = 0", neutral.totalFailures === 0, String(neutral.totalFailures));
    check("已持久化（store 可查）", store.getByAgentId("main-agent")?.trustState === "normal");

    const neutral2 = ev.evaluate({ agentId: "subagent-worker", agentName: "subagent-worker", capabilityExecutions: [], recentAlerts: 0, recentFailures: 0 });
    check("第二个 agent 同样中性", neutral2.trustState === "normal" && neutral2.trustScore === 0.5, `${neutral2.trustState}/${neutral2.trustScore}`);

    // ─── 2. 已污染 untrusted 行被空数据重评覆盖为中性 ───
    console.log("\n[2] 已污染 untrusted 行 → 空数据重评 → 中性");
    const polluted: AgentReputation = {
        agentId: "main-agent",
        agentName: "main-agent",
        trustScore: 0.25,
        trustState: "untrusted",
        reliability: 0.5,
        riskProbability: 0,
        avgLatencyMs: 0,
        totalExecutions: 0,
        totalFailures: 0,
        capabilityScores: [],
        lastEvaluatedAtMs: Date.now() - 1000,
        updatedAtMs: Date.now() - 1000,
    };
    store.upsert(polluted);
    const reEval = ev.evaluate({ agentId: "main-agent", agentName: "main-agent", capabilityExecutions: [], recentAlerts: 0, recentFailures: 0 });
    check("untrusted/0.25 被覆盖为 normal/0.5", reEval.trustState === "normal" && reEval.trustScore === 0.5, `${reEval.trustState}/${reEval.trustScore}`);
    check("覆盖后持久化一致", store.getByAgentId("main-agent")?.trustState === "normal");

    // ─── 3. 有真实数据：走完整评分路径，且四档（trusted/normal/probation/untrusted）阈值可达 ───
    console.log("\n[3] 有真实数据时评分路径正常，四档阈值可达");
    // Case A — 全成功、无告警：reliability=1，score = 1 - 0 - 0 = 1.0 → trusted（原公式满分仅 0.5，trusted 不可达）
    const caseA = ev.evaluate({
        agentId: "agent-a", agentName: "agent-a",
        capabilityExecutions: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => (
            { capabilityId: "code_execution", capabilityName: "code_execution", success: true, latencyMs: 100, timestampMs: Date.now() - i }
        )),
        recentAlerts: 0, recentFailures: 0,
    });
    check("全成功 → trustScore = 1.0", caseA.trustScore === 1, String(caseA.trustScore));
    check("全成功 → trusted", caseA.trustState === "trusted", caseA.trustState);

    // Case B — 8/10 成功、无告警：reliability=0.8，failureRate=0.2→-0.04，score=0.76 → normal
    const caseB = ev.evaluate({
        agentId: "agent-b", agentName: "agent-b",
        capabilityExecutions: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => (
            { capabilityId: "code_execution", capabilityName: "code_execution", success: i < 8, latencyMs: 100, timestampMs: Date.now() - i }
        )),
        recentAlerts: 0, recentFailures: 2,
    });
    check("8/10 成功 → trustScore = 0.76", caseB.trustScore === 0.76, String(caseB.trustScore));
    check("8/10 成功 → normal", caseB.trustState === "normal", caseB.trustState);

    // Case C — 5/10 成功、1 告警：reliability=0.5，risk=0.1→-0.03，failureRate=0.5→-0.1，score=0.37 → probation
    const caseC = ev.evaluate({
        agentId: "agent-c", agentName: "agent-c",
        capabilityExecutions: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => (
            { capabilityId: "code_execution", capabilityName: "code_execution", success: i < 5, latencyMs: 100, timestampMs: Date.now() - i }
        )),
        recentAlerts: 1, recentFailures: 5,
    });
    check("5/10 成功 + 1 告警 → trustScore = 0.37", caseC.trustScore === 0.37, String(caseC.trustScore));
    check("5/10 成功 + 1 告警 → probation", caseC.trustState === "probation", caseC.trustState);

    // Case D — 1/10 成功、2 告警：reliability=0.1，risk=0.2→-0.06，failureRate=0.9→-0.18，score<0 → 0 → untrusted
    const caseD = ev.evaluate({
        agentId: "agent-d", agentName: "agent-d",
        capabilityExecutions: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => (
            { capabilityId: "code_execution", capabilityName: "code_execution", success: i < 1, latencyMs: 100, timestampMs: Date.now() - i }
        )),
        recentAlerts: 2, recentFailures: 9,
    });
    check("1/10 成功 + 2 告警 → trustScore = 0（clamp）", caseD.trustScore === 0, String(caseD.trustScore));
    check("1/10 成功 + 2 告警 → untrusted", caseD.trustState === "untrusted", caseD.trustState);

    // ─── 4. getDispatchWeight 无记录默认不变 ───
    console.log("\n[4] getDispatchWeight 无记录默认（既有行为）");
    const fresh = ev.getDispatchWeight("never-seen-agent");
    check("无记录默认 trustState = normal", fresh.trustState === "normal", fresh.trustState);
    check("无记录默认 trustScore = 0.5", fresh.trustScore === 0.5, String(fresh.trustScore));
    store.upsert({ ...polluted, agentId: "untrusted-agent", agentName: "untrusted-agent" });
    const untrustedWeight = ev.getDispatchWeight("untrusted-agent");
    check("untrusted 返回信任分 0（准入拦截）", untrustedWeight.trustState === "untrusted" && untrustedWeight.trustScore === 0, JSON.stringify(untrustedWeight));

    console.log(`\n结果: ${pass} passed, ${fail} failed`);
    if (fail > 0) process.exit(1);
}

main();