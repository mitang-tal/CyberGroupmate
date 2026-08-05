/**
 * Phase 7.2 Sandbox Simulation — review 验收脚本
 *
 * 覆盖：
 * 1. 热路径缓存（#11 cache 漏项）：TTLQueryCache 命中，且经验变更后 invalidate 生效
 * 2. 分档推演（#17）：full 生成 3 候选 / fast 生成 1 候选
 * 3. 状态虚拟化（#15）：SandboxStateVirtualizer 快照/恢复；engine 推演前后状态一致（无副作用）
 * 4. 可配 scorer（#14）：StaticWeightedScorer 权重可注入，命中 avoid 的候选风险升高、分数下降
 * 5. 经验命中与 ROI 指标可测
 */
import { FailureExtractor } from "../src/experience/failure-extractor.js";
import { TTLQueryCache } from "../src/experience/query-cache.js";
import { ExperienceInjector } from "../src/experience/experience-injector.js";
import { SimulationEngine } from "../src/simulation/simulation-engine.js";
import { StaticWeightedScorer, DEFAULT_WEIGHTS } from "../src/simulation/scorer.js";
import { SandboxStateVirtualizer } from "../src/simulation/state-virtualizer.js";
import type {
    ExperienceItem,
    FailurePattern,
    ExperienceQuery,
    ExperienceStatus,
} from "../src/experience/types.js";

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

class MemExperienceStore {
    private experiences: ExperienceItem[] = [];
    private patterns: FailurePattern[] = [];
    queryCount = 0;

    insertPattern(p: FailurePattern): void { this.patterns.push(p); }
    updatePattern(_id: string, _u: Partial<FailurePattern>): void {}
    getPattern(id: string): FailurePattern | undefined { return this.patterns.find((p) => p.patternId === id); }
    queryPatterns(): FailurePattern[] { return this.patterns; }
    findExistingPattern(): FailurePattern | undefined { return undefined; }
    insertExperience(item: ExperienceItem): void { this.experiences.push(item); }
    updateExperience(_id: string, _u: Partial<ExperienceItem>): void {}
    getExperience(id: string): ExperienceItem | undefined { return this.experiences.find((e) => e.experienceId === id); }
    queryExperiences(query: ExperienceQuery): ExperienceItem[] {
        this.queryCount += 1;
        return this.experiences.filter((e) => {
            if (query.minConfidence != null && e.confidence < query.minConfidence) return false;
            if (query.status && e.status !== query.status) return false;
            return true;
        });
    }
    listExpiredExperiences(): ExperienceItem[] { return []; }
    decayExperiences(): number { return 0; }
}

function makeExtractor(store: MemExperienceStore, cache: TTLQueryCache): FailureExtractor {
    return new FailureExtractor(store as any, cache);
}

function addAvoidExperience(store: MemExperienceStore, tool: string, avoid: string, confidence = 0.85): void {
    const now = Date.now();
    store.insertExperience({
        experienceId: `exp-${Math.random().toString(36).slice(2, 8)}`,
        patternId: "pat-avoid",
        type: "failure_prevention",
        context: { tool, capability: "media" },
        rule: { avoid },
        confidence,
        frequency: 3,
        status: "active" as ExperienceStatus,
        expiresAtMs: now + 30 * 24 * 3600_000,
        createdAtMs: now,
        updatedAtMs: now,
        federationStatus: "candidate",
    });
}

function main() {
    // ─── 1. 热路径缓存（cache 命中 + 失效） ───
    console.log("\n[1] TTLQueryCache 热路径缓存");
    {
        const store = new MemExperienceStore();
        const cache = new TTLQueryCache();
        const extractor = makeExtractor(store, cache);

        extractor.queryRelevantExperience({ tool: "telegram", minConfidence: 0.6 });
        extractor.queryRelevantExperience({ tool: "telegram", minConfidence: 0.6 });
        check("首次查询触发 store（queryCount=1）", store.queryCount === 1, `queryCount=${store.queryCount}`);
        check("第二次查询命中缓存（hits>=1）", cache.stats().hits >= 1, JSON.stringify(cache.stats()));
        check("命中后未再触库（queryCount 仍=1）", store.queryCount === 1, String(store.queryCount));
        check("缓存条目存在", cache.stats().size >= 1, String(cache.stats().size));

        addAvoidExperience(store, "telegram", "Standard Retry");
        cache.invalidate();
        extractor.queryRelevantExperience({ tool: "telegram", minConfidence: 0.6 });
        check("失效后重新触达 store（queryCount=2）", store.queryCount === 2, String(store.queryCount));
    }

    // ─── [2] 分档推演（full vs fast） ───
    console.log("\n[2] 分档推演 #17");
    {
        const store = new MemExperienceStore();
        const cache = new TTLQueryCache();
        const engine = new SimulationEngine(
            makeExtractor(store, cache),
            new ExperienceInjector(makeExtractor(store, cache)),
        );
        const full = engine.runSimulation({ triggerContext: "dispatch" });
        const fast = engine.runSimulation({ triggerContext: "dispatch" }, { mode: "fast" });
        check("full 生成 3 候选", full.optionsEvaluated.length === 3, String(full.optionsEvaluated.length));
        check("fast 生成 1 候选", fast.optionsEvaluated.length === 1, String(fast.optionsEvaluated.length));
        check("full 高耗候选成本更高", full.optionsEvaluated[0].estimatedCostToken > fast.optionsEvaluated[0].estimatedCostToken);
        check("fast reasoning 标注 [fast]", fast.reasoningText.includes("[fast]"), fast.reasoningText);
    }

    // ─── [3] 状态虚拟化（#15：纯逻辑 + 快照/恢复，无副作用） ───
    console.log("\n[3] Sandbox 状态虚拟化 #15");
    {
        const v = new SandboxStateVirtualizer();
        v.set("running", "active");
        const snap = v.snapshot();
        v.set("running", "mutated");
        v.restore(snap);
        check("快照/恢复接口生效", v.get("running") === "active", JSON.stringify(v.readAll()));

        const store = new MemExperienceStore();
        const cache = new TTLQueryCache();
        const engine = new SimulationEngine(
            makeExtractor(store, cache),
            new ExperienceInjector(makeExtractor(store, cache)),
            { virtualizer: v },
        );
        v.set("running", "before-run");
        addAvoidExperience(store, "dispatch", "Standard Retry");
        engine.runSimulation({ triggerContext: "dispatch" });
        check("engine 推演前后虚拟状态一致（无副作用）", v.get("running") === "before-run", JSON.stringify(v.readAll()));
    }

    // ─── [4] 可配 scorer / 权重（#14） + 经验避免生效 ───
    console.log("\n[4] 可配 scorer / 权重 #14");
    {
        const store = new MemExperienceStore();
        const cache = new TTLQueryCache();
        const defaultEngine = new SimulationEngine(makeExtractor(store, cache), new ExperienceInjector(makeExtractor(store, cache)));
        const highRiskEngine = new SimulationEngine(
            makeExtractor(store, cache),
            new ExperienceInjector(makeExtractor(store, cache)),
            { scorer: new StaticWeightedScorer({ risk: 50.0 }) },
        );

        addAvoidExperience(store, "dispatch", "Standard Retry");
        const def = defaultEngine.runSimulation({ triggerContext: "dispatch" });
        const high = highRiskEngine.runSimulation({ triggerContext: "dispatch" });

        const hitDef = def.optionsEvaluated.find((o) => o.matchedExperienceIds.length > 0);
        const hitHigh = high.optionsEvaluated.find((o) => o.matchedExperienceIds.length > 0);
        check("默认权重下命中候选分数>高权重 risk 场景", hitDef && hitHigh && hitDef.overallScore > hitHigh.overallScore,
            `def=${hitDef?.overallScore} high=${hitHigh?.overallScore}`);
        check("命中 avoid 的候选被标风险因子", !!hitDef && hitDef.riskFactors.some((r) => r.includes("avoid")), JSON.stringify(hitDef?.riskFactors));
        check("scorer 接口可替换（默认权重存在）", DEFAULT_WEIGHTS.success === 10.0, String(DEFAULT_WEIGHTS.success));
        check("full 命中后仍有 3 个候选", def.optionsEvaluated.length === 3, String(def.optionsEvaluated.length));
    }

    // ─── [5] ROI 指标 ───
    console.log("\n[5] 经验 ROI 指标");
    {
        const store = new MemExperienceStore();
        const cache = new TTLQueryCache();
        const engine = new SimulationEngine(
            makeExtractor(store, cache),
            new ExperienceInjector(makeExtractor(store, cache)),
        );
        addAvoidExperience(store, "dispatch", "Standard Retry");
        engine.runSimulation({ triggerContext: "dispatch" });
        engine.runSimulation({ triggerContext: "dispatch" });
        const m = engine.getHitMetrics();
        check("totalSimulations>=2", m.totalSimulations >= 2, String(m.totalSimulations));
        check("totalHits>=1", m.totalHits >= 1, String(m.totalHits));
        check("ROI 为 number", typeof m.experienceROI === "number", String(m.experienceROI));
    }

    console.log(`\n结果: ${pass} passed, ${fail} failed`);
    if (fail > 0) process.exit(1);
}

main();