/**
 * Phase 7.4 Meta Self-Test — review 验收脚本
 *
 * 覆盖：
 * 1. #25 健康分权重分级：guardrail/kill_switch 失败权重大于 deadlock/rigidity
 * 2. #27 探针串行隔离：Self-Kill 探针不污染后续探针（kill switch 状态恢复）
 * 3. #26 cron 定时自动触发（按 cron 表达式）
 * 4. #28 自检失败自动响应（critical → 事件告警）
 */
import { MetaSelfTestEngine } from "../src/meta-test/meta-self-test-engine.js";
import type {
    MetaSelfTestReport,
    MetaSelfTestProbeResult,
    HealthStatus,
    ProbeCategory,
} from "../src/meta-test/types.js";
import type { SelfTestStore } from "../src/meta-test/self-test-store.js";

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

class MemSelfTestStore implements SelfTestStore {
    private reports: MetaSelfTestReport[] = [];
    insertReport(r: MetaSelfTestReport): void { this.reports.push(r); }
    getLatestReport(): MetaSelfTestReport | undefined { return this.reports[this.reports.length - 1]; }
    queryHistory(limit = 20): MetaSelfTestReport[] { return this.reports.slice(-limit); }
}

function main() {
    // ─── [1] #25 健康分权重分级 ───
    console.log("\n[1] #25 健康分权重分级");
    {
        const store = new MemSelfTestStore();
        const engine = new MetaSelfTestEngine(store);
        // 构造探针结果：guardrail 与 kill_switch 失败(0.3)，deadlock/rigidity 通过(1.0)
        const probes: MetaSelfTestProbeResult[] = [
            mkProbe("p1", "deadlock", 1.0, true),
            mkProbe("p2", "guardrail", 0.3, false),
            mkProbe("p3", "rigidity", 1.0, true),
            mkProbe("p4", "kill_switch", 0.3, false),
        ];
        // 默认权重：guardrail/kill=1.5，deadlock/rigidity=1.0
        // weighted = (1.0 + 0.45 + 1.0 + 0.45) / (1.0+1.5+1.0+1.5) = 2.9/5 = 0.58
        const report = engine.buildReport(probes);
        check("加权健康分 0.58（而非简单平均 0.65）", report.overallHealthScore === 0.58,
            String(report.overallHealthScore));

        // 自定义权重：全部 1.0 → 回到简单平均 0.65
        const engine2 = new MetaSelfTestEngine(new MemSelfTestStore(), {
            healthWeights: { deadlock: 1, guardrail: 1, rigidity: 1, kill_switch: 1 },
        });
        const report2 = engine2.buildReport(probes);
        check("自定义全 1.0 权重时退化为平均分 0.65", report2.overallHealthScore === 0.65,
            String(report2.overallHealthScore));

        // guardrail 单独失败 → 加权后比 deadlock 单独失败更严重
        const gFail = engine.buildReport([mkProbe("p1", "deadlock", 1.0, true), mkProbe("p2", "guardrail", 0.3, false)]);
        const dFail = engine.buildReport([mkProbe("p1", "deadlock", 0.3, false), mkProbe("p2", "guardrail", 1.0, true)]);
        check("guardrail 失败比 deadlock 失败更严重", gFail.overallHealthScore < dFail.overallHealthScore,
            `g=${gFail.overallHealthScore} d=${dFail.overallHealthScore}`);
    }

    // ─── [2] #27 探针串行隔离：kill switch 中途异常也恢复 ───
    console.log("\n[2] #27 探针串行隔离");
    {
        // 构造会在 evaluateGuardrails 抛错的 guardrail mock，验证 kill switch 状态被 finally 恢复
        const states: boolean[] = [];
        const guardrail = {
            isKillSwitchActive: () => states[states.length - 1] ?? false,
            toggleKillSwitch: (active: boolean) => { states.push(active); },
            evaluateGuardrails: () => { throw new Error("simulated mid-probe crash"); },
            getReplanCounterProvider: () => undefined,
            setReplanCounterProvider: (_p?: unknown) => undefined,
        } as any;

        const engine = new MetaSelfTestEngine(new MemSelfTestStore(), { guardrail });
        engine.runFullSuite();

        // toggleKillSwitch 序列：self-kill 先 engage(true) → finally 恢复(prev=false)
        // guardrail 探针在 kill test 前 crash，但它的 finally 也会触发 toggle(prev=false)
        const last = states[states.length - 1];
        check("探针异常后 kill switch 状态恢复为 false", last === false, `last=${last}, seq=${JSON.stringify(states)}`);
        check("无 kill switch 泄漏（无残留 true）", states.every((s) => s === false) || states[states.length - 1] === false,
            JSON.stringify(states));
    }

    // ─── [3] #26 cron 定时自动触发 ───
    console.log("\n[3] #26 cron 定时自动触发");
    {
        const engine = new MetaSelfTestEngine(new MemSelfTestStore());
        const stop = engine.startAutoRun("*/1 * * * *", 1000);
        check("startAutoRun 注册成功", stop !== null && engine.isAutoRunEnabled());
        stop!();
        check("stopAutoRun 清理成功", !engine.isAutoRunEnabled());

        // runAutoCheck：cron 命中 → 跑全套自检返回报告；未命中 → undefined
        const engine2 = new MetaSelfTestEngine(new MemSelfTestStore());
        engine2.startAutoRun("0 3 * * *", 1000); // 每日 3:00
        const hit = engine2.runAutoCheck(new Date(2026, 0, 1, 3, 0, 0)); // 命中
        const miss = engine2.runAutoCheck(new Date(2026, 0, 1, 12, 0, 0)); // 未命中
        check("cron 命中时触发全套自检", hit !== undefined && hit.overallHealthScore >= 0);
        check("cron 未命中时不触发", miss === undefined);
        const hit2 = engine2.runAutoCheck(new Date(2026, 0, 1, 3, 0, 30)); // 同一分钟再去重
        check("同一分钟只触发一次（去重）", hit2 === undefined);
        engine2.stopAutoRun();
    }

    // ─── [4] #28 自检失败自动响应（告警） ───
    console.log("\n[4] #28 自检失败自动响应");
    {
        const alerts: Array<{ status: HealthStatus; changed: boolean }> = [];
        const engine = new MetaSelfTestEngine(new MemSelfTestStore(), {
            alertEmitter: (report, changed) => { alerts.push({ status: report.status, changed }); },
        });

        // 健康 → 不告警
        engine.buildReport([mkProbe("p1", "deadlock", 1.0, true)]);
        check("healthy 不触发告警", alerts.length === 0, String(alerts.length));

        // 全部失败 → critical → 告警（changed=false，首次）
        engine.buildReport([
            mkProbe("p1", "deadlock", 0.1, false),
            mkProbe("p2", "guardrail", 0.1, false),
            mkProbe("p3", "rigidity", 0.1, false),
            mkProbe("p4", "kill_switch", 0.1, false),
        ]);
        check("critical 触发告警", alerts.length === 1 && alerts[0].status === "critical",
            JSON.stringify(alerts));

        // 继续 critical → 告警但 changed=false（持续故障）
        engine.buildReport([
            mkProbe("p1", "deadlock", 0.1, false),
            mkProbe("p2", "guardrail", 0.1, false),
            mkProbe("p3", "rigidity", 0.1, false),
            mkProbe("p4", "kill_switch", 0.1, false),
        ]);
        check("持续 critical 仍告警（changed=false）", alerts.length === 2 && alerts[1].changed === false,
            JSON.stringify(alerts));

        // 恢复 healthy → 不告警
        engine.buildReport([mkProbe("p1", "deadlock", 1.0, true)]);
        check("恢复 healthy 后不告警", alerts.length === 2, String(alerts.length));

        // 再次 critical → 状态转移告警（changed=true）
        engine.buildReport([
            mkProbe("p1", "deadlock", 0.1, false),
            mkProbe("p2", "guardrail", 0.1, false),
            mkProbe("p3", "rigidity", 0.1, false),
            mkProbe("p4", "kill_switch", 0.1, false),
        ]);
        check("状态转移（healthy→critical）告警 changed=true", alerts.length === 3 && alerts[2].changed === true,
            JSON.stringify(alerts));
    }

    console.log(`\n结果: ${pass} passed, ${fail} failed`);
    if (fail > 0) process.exit(1);
}

function mkProbe(id: string, category: ProbeCategory, score: number, passed: boolean): MetaSelfTestProbeResult {
    return { probeId: id, probeName: id, category, passed, score, details: "", executedAtMs: Date.now() };
}

main();
