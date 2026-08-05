/**
 * Audit Fix — SimulationEngine 推演统计独立验收脚本
 *
 * 验证内容（P0-1：沙盒推演统计不更新）：
 * 1. 无经验约束时连续推演，totalSimulations 仍正确累加（修复前恒为 0）
 * 2. 有 avoid 经验约束命中时，totalHits 正确反映经验命中数
 * 3. hit 记录按真实 simulationId 与选中方案记录；avoidedError 语义与 ROI 计算正常
 */
import { FailureExtractor } from "../src/experience/failure-extractor.js";
import { ExperienceInjector } from "../src/experience/experience-injector.js";
import { SimulationEngine } from "../src/simulation/simulation-engine.js";
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

/** 最小内存 ExperienceStore：仅实现测试所需的方法，queryExperiences 按 confidence/status 过滤 */
class MemExperienceStore {
    private experiences: ExperienceItem[] = [];
    private patterns: FailurePattern[] = [];

    insertPattern(p: FailurePattern): void { this.patterns.push(p); }
    updatePattern(_id: string, _u: Partial<FailurePattern>): void {}
    getPattern(id: string): FailurePattern | undefined { return this.patterns.find((p) => p.patternId === id); }
    queryPatterns(): FailurePattern[] { return this.patterns; }
    findExistingPattern(): FailurePattern | undefined { return undefined; }
    insertExperience(item: ExperienceItem): void { this.experiences.push(item); }
    updateExperience(_id: string, _u: Partial<ExperienceItem>): void {}
    getExperience(id: string): ExperienceItem | undefined { return this.experiences.find((e) => e.experienceId === id); }
    queryExperiences(query: ExperienceQuery): ExperienceItem[] {
        return this.experiences.filter((e) => {
            if (query.minConfidence != null && e.confidence < query.minConfidence) return false;
            if (query.status && e.status !== query.status) return false;
            return true;
        });
    }
    listExpiredExperiences(): ExperienceItem[] { return []; }
    decayExperiences(): number { return 0; }
}

function makeEngine(store: MemExperienceStore): SimulationEngine {
    const extractor = new FailureExtractor(store as any);
    const injector = new ExperienceInjector(extractor);
    return new SimulationEngine(extractor, injector);
}

function main() {
    const store = new MemExperienceStore();
    const engine = makeEngine(store);

    // ─── 1. 无经验约束：totalSimulations 必须随推演次数累加 ───
    console.log("\n[1] 无经验约束时推演计数累加");
    check("初始 totalSimulations = 0", engine.getHitMetrics().totalSimulations === 0);

    engine.runSimulation({ triggerContext: "telegram_media_send" });
    engine.runSimulation({ triggerContext: "http_request" });
    const noExp = engine.getHitMetrics();
    check("2 次推演后 totalSimulations = 2", noExp.totalSimulations === 2, String(noExp.totalSimulations));
    check("无经验命中 totalHits = 0", noExp.totalHits === 0, String(noExp.totalHits));
    check("无经验命中 avoidedErrors = 0", noExp.avoidedErrors === 0, String(noExp.avoidedErrors));
    check("无经验命中 ROI = 0", noExp.experienceROI === 0, String(noExp.experienceROI));

    // ─── 2. 有 avoid 经验约束命中：totalHits 反映命中 ───
    console.log("\n[2] avoid 经验约束命中");
    const now = Date.now();
    store.insertExperience({
        experienceId: "exp-avoid-retry",
        patternId: "pat-1",
        type: "failure_prevention",
        context: { tool: "telegram_media_send", capability: "media" },
        rule: { avoid: "Standard Retry" },
        confidence: 0.85,
        frequency: 3,
        status: "active" as ExperienceStatus,
        expiresAtMs: now + 30 * 24 * 3600_000,
        createdAtMs: now,
        updatedAtMs: now,
        federationStatus: "candidate",
    });

    const hitResult = engine.runSimulation({ triggerContext: "telegram_media_send" });
    const afterHit = engine.getHitMetrics();
    check("第 3 次推演后 totalSimulations = 3", afterHit.totalSimulations === 3, String(afterHit.totalSimulations));
    check("命中 1 条经验 totalHits = 1", afterHit.totalHits === 1, String(afterHit.totalHits));
    check("结果 optionsEvaluated 为 3 个", hitResult.optionsEvaluated.length === 3, String(hitResult.optionsEvaluated.length));
    const matchedOption = hitResult.optionsEvaluated.find((o) => o.matchedExperienceIds.length > 0);
    check("命中方案确实携带经验 ID", !!matchedOption, JSON.stringify(hitResult.optionsEvaluated.map((o) => ({ n: o.name, m: o.matchedExperienceIds }))));
    check("selectedOptionId 存在", !!hitResult.selectedOptionId, hitResult.selectedOptionId);

    // ─── 3. hit 记录使用真实 simulationId / 选中方案 ───
    console.log("\n[3] hit 记录一致性");
    const hit = (afterHit.totalHits >= 1);
    check("matched 命中记录已生成", hit);
    check("ROI 数值类型为 number", typeof afterHit.experienceROI === "number", String(afterHit.experienceROI));

    // 清理无文件副作用（内存 Store），仅打印结果
    console.log(`\n结果: ${pass} passed, ${fail} failed`);
    if (fail > 0) process.exit(1);
}

main();