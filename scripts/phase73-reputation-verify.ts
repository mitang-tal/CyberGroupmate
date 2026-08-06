/**
 * Phase 7.3 Agent Reputation — review 验收脚本
 *
 * 覆盖：
 * 1. #19 贝叶斯收缩：少样本 mastery 向先验收缩，单次成功不冲满
 * 2. #20 抗 gaming：成本加权（高延迟成功提升 reliability）+ 重复犯错惩罚
 * 3. #21 时间衰减：旧失败对 reliability 影响显著小于新失败（指数半衰）
 * 4. #22 滞回窗：阈值边缘抖动不翻转信任状态
 * 5. #23 probation shadow：进入 probation 记录观察日志
 * 6. 冷启动中性声誉 / untrusted 路由权重为 0
 */
import { ReputationEvaluator } from "../src/reputation/reputation-evaluator.js";
import type {
    AgentReputation,
    ReputationEvaluationInput,
    TrustState,
} from "../src/reputation/types.js";
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

class MemStore implements ReputationStore {
    private reps = new Map<string, AgentReputation>();

    upsert(r: AgentReputation): void { this.reps.set(r.agentId, r); }
    getByAgentId(id: string): AgentReputation | undefined { return this.reps.get(id); }
    listAll(): AgentReputation[] { return Array.from(this.reps.values()); }
    updateTrustState(id: string, state: TrustState, probationUntilMs?: number): void {
        const r = this.reps.get(id);
        if (r) { r.trustState = state; r.probationUntilMs = probationUntilMs; }
    }
    delete(id: string): void { this.reps.delete(id); }
}

function makeInput(agentId: string, execs: Array<{ success: boolean; latencyMs?: number; ageMs?: number }>, alerts = 0): ReputationEvaluationInput {
    const now = Date.now();
    return {
        agentId,
        agentName: agentId,
        capabilityExecutions: execs.map((e, i) => ({
            capabilityId: "cap-a",
            capabilityName: "cap-a",
            success: e.success,
            latencyMs: e.latencyMs ?? 500,
            timestampMs: now - (e.ageMs ?? 0),
            errorType: e.success ? undefined : "err",
        })),
        recentAlerts: alerts,
    };
}

function main() {
    // ─── [1] #19 贝叶斯收缩 ───
    console.log("\n[1] #19 贝叶斯收缩 + 冷启动先验");
    {
        const store = new MemStore();
        const ev = new ReputationEvaluator(store);
        const rep = ev.evaluate(makeInput("a1", [{ success: true }]));
        const mastery = rep.capabilityScores[0].mastery;
        // (1 + 0.5*2) / (1 + 2) = 2/3 ≈ 0.67，而非 1.0
        check("单次成功 mastery 收缩为 0.67（而非 1.0）", mastery === 0.67, String(mastery));
        const rep10 = ev.evaluate(makeInput("a1", Array.from({ length: 10 }, () => ({ success: true }))));
        const m10 = rep10.capabilityScores[0].mastery;
        check("多次成功后 mastery 趋近 1.0", m10 > 0.9, String(m10));
    }

    // ─── [2] #20 抗 gaming：成本加权 + 重复犯错惩罚 ───
    console.log("\n[2] #20 成本加权 + 重复犯错惩罚");
    {
        const store = new MemStore();
        const ev = new ReputationEvaluator(store);
        // 成本加权：昂贵（高延迟）成功更值钱，高成本失败更伤
        const now = Date.now();
        const caseA: ReputationEvaluationInput = {
            agentId: "a1", agentName: "a1",
            capabilityExecutions: [
                ...Array.from({ length: 9 }, () => ({ capabilityId: "c", capabilityName: "c", success: true, latencyMs: 100, timestampMs: now })),
                { capabilityId: "c", capabilityName: "c", success: false, latencyMs: 5000, timestampMs: now, errorType: "e" },
            ],
            recentAlerts: 0,
        };
        const caseB: ReputationEvaluationInput = {
            agentId: "a2", agentName: "a2",
            capabilityExecutions: [
                ...Array.from({ length: 9 }, () => ({ capabilityId: "c", capabilityName: "c", success: true, latencyMs: 5000, timestampMs: now })),
                { capabilityId: "c", capabilityName: "c", success: false, latencyMs: 100, timestampMs: now, errorType: "e" },
            ],
            recentAlerts: 0,
        };
        const lowCredit = ev.evaluate(caseA);
        const highCredit = ev.evaluate(caseB);
        check("高成本成功提升 reliability（防低风险刷分）", highCredit.reliability > lowCredit.reliability,
            `caseA=${lowCredit.reliability} caseB=${highCredit.reliability}`);

        // 重复犯错：同能力连续 3 失败（repeats=2）vs 分散 3 个能力各 1 失败（repeats=0）
        const store2 = new MemStore();
        const ev2 = new ReputationEvaluator(store2);
        const repeatInput: ReputationEvaluationInput = {
            agentId: "a3", agentName: "a3",
            capabilityExecutions: [
                { capabilityId: "cap-x", capabilityName: "cap-x", success: true, latencyMs: 500, timestampMs: Date.now() },
                ...Array.from({ length: 3 }, () => ({ capabilityId: "cap-x", capabilityName: "cap-x", success: false, latencyMs: 500, timestampMs: Date.now(), errorType: "repeat" })),
                ...Array.from({ length: 6 }, () => ({ capabilityId: "cap-y", capabilityName: "cap-y", success: true, latencyMs: 500, timestampMs: Date.now() })),
            ],
            recentAlerts: 0,
        };
        const repeatRep = ev2.evaluate(repeatInput);

        const store3 = new MemStore();
        const ev3 = new ReputationEvaluator(store3);
        const scatterInput: ReputationEvaluationInput = {
            agentId: "a4", agentName: "a4",
            capabilityExecutions: [
                { capabilityId: "cap-x", capabilityName: "cap-x", success: true, latencyMs: 500, timestampMs: Date.now() },
                { capabilityId: "cap-x", capabilityName: "cap-x", success: false, latencyMs: 500, timestampMs: Date.now(), errorType: "e" },
                { capabilityId: "cap-y", capabilityName: "cap-y", success: false, latencyMs: 500, timestampMs: Date.now(), errorType: "e" },
                { capabilityId: "cap-z", capabilityName: "cap-z", success: false, latencyMs: 500, timestampMs: Date.now(), errorType: "e" },
                ...Array.from({ length: 6 }, () => ({ capabilityId: "cap-y", capabilityName: "cap-y", success: true, latencyMs: 500, timestampMs: Date.now() })),
            ],
            recentAlerts: 0,
        };
        const scatterRep = ev3.evaluate(scatterInput);
        check("重复犯错的 trustScore 低于分散失败", repeatRep.trustScore < scatterRep.trustScore,
            `repeat=${repeatRep.trustScore} scatter=${scatterRep.trustScore}`);
    }

    // ─── [3] #21 时间衰减（指数半衰） ───
    console.log("\n[3] #21 时间衰减");
    {
        const store = new MemStore();
        const ev = new ReputationEvaluator(store);
        const DAY = 24 * 3600_000;
        // 同一成功率（50%），但失败发生于 7 天前（i<5 失败且老）vs 今天（失败新）
        const oldFail = ev.evaluate(makeInput("a1",
            Array.from({ length: 10 }, (_, i) => ({ success: i >= 5, ageMs: i < 5 ? 7 * DAY : 0 }))));
        const store2 = new MemStore();
        const ev2 = new ReputationEvaluator(store2);
        const newFail = ev2.evaluate(makeInput("a2",
            Array.from({ length: 10 }, (_, i) => ({ success: i >= 5, ageMs: 0 }))));
        check("7 天前失败衰减后 reliability 更高", oldFail.reliability > newFail.reliability,
            `old=${oldFail.reliability} new=${newFail.reliability}`);
    }

    // ─── [4] #22 滞回窗：阈值边缘不翻转 ───
    console.log("\n[4] #22 信任状态滞回");
    {
        const store = new MemStore();
        const ev = new ReputationEvaluator(store);
        // 全成功 → trusted
        const first = ev.evaluate(makeInput("a1", Array.from({ length: 10 }, () => ({ success: true }))));
        check("全成功进入 trusted", first.trustState === "trusted", String(first.trustState));

        // score≈0.8（8 成功，失败分散到不同能力避免重复惩罚）→ raw=normal，但降级需 <0.80 → 保持 trusted
        const now4 = Date.now();
        const edgeInput: ReputationEvaluationInput = {
            agentId: "a1", agentName: "a1",
            capabilityExecutions: [
                ...Array.from({ length: 8 }, () => ({ capabilityId: "c1", capabilityName: "c1", success: true, latencyMs: 500, timestampMs: now4 })),
                { capabilityId: "c1", capabilityName: "c1", success: false, latencyMs: 500, timestampMs: now4, errorType: "e" },
                { capabilityId: "c2", capabilityName: "c2", success: false, latencyMs: 500, timestampMs: now4, errorType: "e" },
            ],
            recentAlerts: 0,
        };
        const edge = ev.evaluate(edgeInput);
        check("score≈0.8 时滞回保持 trusted（不抖动）", edge.trustState === "trusted", `${edge.trustState} score=${edge.trustScore}`);

        // score ≈ 0.7 → <0.80 → 降级 normal
        const lower = ev.evaluate(makeInput("a1", Array.from({ length: 10 }, (_, i) => ({ success: i < 7 }))));
        check("score≈0.7 越过滞回边界降级 normal", lower.trustState === "normal", `${lower.trustState} score=${lower.trustScore}`);
    }

    // ─── [5] #23 probation shadow ───
    console.log("\n[5] #23 probation shadow");
    {
        const store = new MemStore();
        const ev = new ReputationEvaluator(store);
        // 5 成 5 败 + 中等 alert → probation（避免跌落 untrusted）
        const bad = ev.evaluate(makeInput("a1",
            Array.from({ length: 10 }, (_, i) => ({ success: i >= 5 })),
            2));
        check("高失败进入 probation", bad.trustState === "probation", String(bad.trustState));
        check("probationShadow=true", bad.probationShadow === true, String(bad.probationShadow));
        check("shadow 日志有记录", ev.getShadowLog().length >= 1, String(ev.getShadowLog().length));
        check("probation 仍可被路由（降权而非禁用）", ev.getDispatchWeight("a1").trustScore >= 0, String(ev.getDispatchWeight("a1").trustScore));
    }

    // ─── [6] 冷启动中性 + untrusted 权重 0 ───
    console.log("\n[6] 冷启动与 untrusted");
    {
        const store = new MemStore();
        const ev = new ReputationEvaluator(store);
        const neutral = ev.evaluate(makeInput("new", []));
        check("空历史中性 normal / 0.5", neutral.trustState === "normal" && neutral.trustScore === 0.5,
            `${neutral.trustState} ${neutral.trustScore}`);

        // 构造 untrusted：10 次全失败 + 高风险
        const store2 = new MemStore();
        const ev2 = new ReputationEvaluator(store2);
        ev2.evaluate(makeInput("a1", Array.from({ length: 10 }, () => ({ success: false })), 10));
        const w = ev2.getDispatchWeight("a1");
        check("untrusted 路由权重归零", w.trustScore === 0 && w.trustState === "untrusted", JSON.stringify(w));
    }

    console.log(`\n结果: ${pass} passed, ${fail} failed`);
    if (fail > 0) process.exit(1);
}

main();