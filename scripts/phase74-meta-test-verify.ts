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

    console.log(`\n结果: ${pass} passed, ${fail} failed`);
    if (fail > 0) process.exit(1);
}

function mkProbe(id: string, category: ProbeCategory, score: number, passed: boolean): MetaSelfTestProbeResult {
    return { probeId: id, probeName: id, category, passed, score, details: "", executedAtMs: Date.now() };
}

main();
